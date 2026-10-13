#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Timing/diagnostic line to stderr. Unlike eprintln, a dead stderr (closed pipe) is ignored instead of panicking.
macro_rules! log {
    ($($t:tt)*) => {{ use std::io::Write; let _ = writeln!(std::io::stderr(), $($t)*); }};
}

use notify::{EventKind, RecursiveMode, Watcher};
use tauri_plugin_autostart::ManagerExt;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    thread::sleep,
    time::{Duration, Instant},
};
use tauri::{
    ipc::{InvokeBody, Request, Response}, menu::{CheckMenuItem, Menu, MenuItem}, tray::TrayIconBuilder, AppHandle, Manager, PhysicalPosition, PhysicalSize,
    RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

/// Window label -> the image it edits, when it arrived (for the startup timing on stderr),
/// and whether the watcher saw it created (only then can it still be being written).
#[derive(Default)]
struct Shots(Mutex<HashMap<String, (PathBuf, Instant, bool)>>);

fn is_image(p: &Path) -> bool {
    p.extension().is_some_and(|e| ["png", "jpg", "jpeg"].iter().any(|x| e.eq_ignore_ascii_case(x)))
}

/// Snipping Tool creates the file before it has finished writing it: wait for the PNG or JPEG end marker.
fn wait_complete(p: &Path) {
    let end = Instant::now() + Duration::from_secs(5);
    let png = p.extension().is_some_and(|e| e.eq_ignore_ascii_case("png"));
    while Instant::now() < end {
        let mut tail = [0u8; 8];
        let read = File::open(p).and_then(|mut f| {
            f.seek(SeekFrom::End(-8))?;
            f.read_exact(&mut tail)
        });
        if read.is_ok() && (if png { tail == *b"IEND\xAEB`\x82" } else { tail[6..] == [0xFF, 0xD9] }) {
            return;
        }
        sleep(Duration::from_millis(20));
    }
}

/// Blocking work (a modal dialog, waiting on a file) runs on the blocking pool: the async runtime has about one
/// worker per core, and with them all blocked a new window's `shot` never runs and it stays hidden.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[test]
fn blocking_work_leaves_the_async_runtime_free() {
    use tauri::async_runtime::spawn;
    let n = std::thread::available_parallelism().map_or(4, |n| n.get()) + 1;
    for _ in 0..n {
        spawn(blocking(|| sleep(Duration::from_secs(3))));
    }
    sleep(Duration::from_millis(100));
    let (tx, rx) = std::sync::mpsc::channel();
    spawn(async move { tx.send(()) });
    assert!(rx.recv_timeout(Duration::from_secs(1)).is_ok(), "runtime starved by {n} blocking calls");
}

/// One hidden window per image; the page shows it once the image is laid out (see `ready`).
/// A second launch's relative path means relative to where it ran, not to the tray's cwd.
fn from_cwd(cwd: &str, arg: String) -> PathBuf {
    Path::new(cwd).join(arg)
}

#[test]
fn second_launch_paths_resolve_against_its_cwd() {
    assert_eq!(from_cwd(r"C:\shots", "a.png".into()), PathBuf::from(r"C:\shots\a.png"));
    assert_eq!(from_cwd(r"C:\shots", r"D:\b.png".into()), PathBuf::from(r"D:\b.png"));
}

#[test]
fn a_window_the_page_never_readied_is_shown_anyway() {
    let shown = std::cell::Cell::new(0);
    show_if_stuck(Ok::<_, ()>(false), || shown.set(shown.get() + 1));
    show_if_stuck(Ok::<_, ()>(true), || shown.set(shown.get() + 1));
    show_if_stuck(Err(()), || shown.set(shown.get() + 1)); // already closed
    assert_eq!(shown.get(), 1);
}

fn show_if_stuck<E>(visible: Result<bool, E>, show: impl FnOnce()) {
    if let Ok(false) = visible {
        show();
    }
}

fn open(app: &AppHandle, path: PathBuf, t0: Instant, from_watcher: bool) {
    static N: AtomicUsize = AtomicUsize::new(0);
    let label = format!("shot{}", N.fetch_add(1, Ordering::Relaxed));
    let name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    // The page reads its name from the hash, as JustSave's editor read its capture id.
    let hash: String = name
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    let built = with_shot(&app.state::<Shots>(), &label, (path, t0, from_watcher), || {
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App(format!("index.html#{hash}").into()))
            .title(&name)
            .visible(false)
            .build()
    });
    match built {
        Ok(w) => {
            log!("{label} window built {:?}", t0.elapsed());
            // If the page dies before calling ready (script error, failed navigation), show it anyway so it can be closed,
            // rather than leaving a hidden window and its WebView2 processes alive until Quit.
            std::thread::spawn(move || {
                sleep(Duration::from_secs(10));
                show_if_stuck(w.is_visible().map_err(|_| ()), || drop(w.show()));
            });
        }
        Err(e) => log!("{label} window failed: {e}"),
    }
}

/// Registers the window's image before building it (the page asks for it at once), and drops it if the build
/// fails: no window means no Destroyed event to remove it.
fn with_shot<W, E>(shots: &Shots, label: &str, shot: (PathBuf, Instant, bool), build: impl FnOnce() -> Result<W, E>) -> Result<W, E> {
    shots.0.lock().unwrap().insert(label.into(), shot);
    let built = build();
    if built.is_err() {
        shots.0.lock().unwrap().remove(label);
    }
    built
}

#[test]
fn a_failed_window_build_leaves_no_shot() {
    let shots = Shots::default();
    let shot = || (PathBuf::new(), Instant::now(), false);
    assert!(with_shot(&shots, "a", shot(), || Err::<(), _>(())).is_err());
    assert!(with_shot(&shots, "b", shot(), || Ok::<_, ()>(())).is_ok());
    assert_eq!(shots.0.lock().unwrap().keys().collect::<Vec<_>>(), ["b"]);
}

/// Off the main thread (see `blocking`): it can wait for the file, which the window started loading alongside.
#[tauri::command]
async fn shot(w: WebviewWindow, shots: State<'_, Shots>) -> Result<Response, String> {
    let (path, from_watcher) = shots.0.lock().unwrap().get(w.label()).map(|s| (s.0.clone(), s.2)).ok_or("no image for this window")?;
    blocking(move || load(&path, from_watcher)).await?.map(Response::new).map_err(|e| e.to_string())
}

/// Files from argv are already complete, and may not end in IEND/FFD9 (e.g. a Motion Photo): only wait for the watcher's.
fn load(p: &Path, from_watcher: bool) -> std::io::Result<Vec<u8>> {
    if from_watcher {
        wait_complete(p);
    }
    std::fs::read(p)
}

#[test]
fn opened_files_are_read_without_waiting_for_an_end_marker() {
    // A Motion Photo: a complete JPEG with an MP4 after its FFD9.
    let p = std::env::temp_dir().join("snarkymark-trailer-test.jpg");
    std::fs::write(&p, b"\xFF\xD8jpeg\xFF\xD9ftypmp4 trailer").unwrap();
    let t = Instant::now();
    load(&p, false).unwrap();
    assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
    let _ = std::fs::remove_file(p);
}

/// Save: the Windows Save dialog, then the page's encoded bytes (the request body) go to the picked file.
/// Not showSaveFilePicker: WebView2 titles its dialog "Warning: this site can see edits you make", and once never showed it.
/// Returns the saved file's name, or None when the dialog was cancelled.
#[tauri::command]
async fn save(w: WebviewWindow, shots: State<'_, Shots>, req: Request<'_>) -> Result<Option<String>, String> {
    let InvokeBody::Raw(bytes) = req.body() else { return Err("no image data".into()) };
    let ext = req.headers().get("ext").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let kind = match ext {
        "png" => "PNG image",
        "jpg" => "JPEG image",
        "pdf" => "PDF document",
        _ => return Err(format!("can't save as {ext:?}")),
    };
    let stem = shots.0.lock().unwrap().get(w.label()).and_then(|s| s.0.file_stem().map(|n| n.to_string_lossy().into_owned()));
    let file_name = format!("{}.{ext}", stem.unwrap_or_else(|| "snarkymark".into()));
    let filter = ext.to_owned();
    let Some(path) = blocking(move || rfd::FileDialog::new().set_parent(&w).set_file_name(file_name).add_filter(kind, &[filter]).save_file()).await?
    else {
        return Ok(None);
    };
    let path = with_ext(path, ext);
    // Write a side file and rename it over the target: no half-written file, and saving into the Screenshots
    // folder is a rename there, not a creation, so the watcher doesn't open the saved image again.
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let part = part_path(&path);
    std::fs::write(&part, bytes).and_then(|_| std::fs::rename(&part, &path)).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        e.to_string()
    })?;
    Ok(Some(name))
}

/// `<name>.part`, with the name cut so the component stays within NTFS's 255 UTF-16 units.
fn part_path(path: &std::path::Path) -> PathBuf {
    let mut n = 0;
    let name: String = path.file_name().unwrap_or_default().to_string_lossy().chars().take_while(|c| {
        n += c.len_utf16();
        n <= 250
    }).collect();
    path.with_file_name(format!("{name}.part"))
}

#[test]
fn part_name_fits_ntfs() {
    let long = format!("{}.png", "a".repeat(248));
    assert_eq!(part_path(&PathBuf::from(&long)).file_name().unwrap().len(), 255);
    assert_eq!(part_path(&PathBuf::from("d/foo.png")), PathBuf::from("d/foo.png.part"));
}

/// The dialog keeps a typed extension even when it isn't the format's, so add the right one rather than put
/// PNG bytes in foo.jpg.
fn with_ext(path: PathBuf, ext: &str) -> PathBuf {
    let typed = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase());
    if typed.as_deref() == Some(ext) || (ext == "jpg" && typed.as_deref() == Some("jpeg")) {
        return path;
    }
    let mut s = path.into_os_string();
    s.push(format!(".{ext}"));
    s.into()
}

#[test]
fn saved_files_get_the_formats_extension() {
    assert_eq!(with_ext("a/foo.jpg".into(), "png"), PathBuf::from("a/foo.jpg.png"));
    assert_eq!(with_ext("a/foo.PNG".into(), "png"), PathBuf::from("a/foo.PNG"));
    assert_eq!(with_ext("a/foo.jpeg".into(), "jpg"), PathBuf::from("a/foo.jpeg"));
}

#[tauri::command]
fn close(w: WebviewWindow) {
    let _ = w.destroy();
}

/// Inner size: the capture at actual size (`img`, physical px) plus the page's chrome (CSS px at the monitor's scale `s`),
/// at least `min` CSS px, at most 90% of the work area.
fn fit(img: (f64, f64), chrome: (f64, f64), min: (f64, f64), s: f64, area: PhysicalSize<u32>) -> PhysicalSize<u32> {
    let side = |i: f64, c: f64, m: f64, a: u32| ((i + c * s).max(m * s) as u32).min(a * 9 / 10);
    PhysicalSize::new(side(img.0, chrome.0, min.0, area.width), side(img.1, chrome.1, min.1, area.height))
}

#[test]
fn fit_shows_the_capture_at_actual_size_on_another_dpi() {
    // Snip on a 150% monitor, whatever the scale where the hidden window was made: a 2000 px capture plus 48 CSS px of chrome.
    assert_eq!(fit((2000.0, 600.0), (48.0, 160.0), (960.0, 480.0), 1.5, PhysicalSize::new(3840, 2160)).width, 2000 + 72);
}

/// The page knows how big it wants to be: size the window to that, within the work area of the
/// monitor under the cursor (where the snip was just taken), center it there and show it.
#[tauri::command]
fn ready(w: WebviewWindow, shots: State<Shots>, img: (f64, f64), chrome: (f64, f64), min: (f64, f64)) {
    if let Some((_, t0, _)) = shots.0.lock().unwrap().get(w.label()) {
        log!("{} ready {:?}", w.label(), t0.elapsed());
    }
    let cursor = w.cursor_position().unwrap_or_default();
    let mon = w.monitor_from_point(cursor.x, cursor.y).ok().flatten().or_else(|| w.primary_monitor().ok().flatten());
    if let Some(m) = mon {
        let area = m.work_area();
        // Onto that monitor before sizing: crossing to another scale rescales the window (WM_DPICHANGED), undoing the size.
        let _ = w.set_position(area.position);
        let size = fit(img, chrome, min, m.scale_factor(), area.size);
        let _ = w.set_size(size);
        // set_size is the inner size but set_position places the frame: center the outer size.
        let outer = w.outer_size().unwrap_or(size);
        let _ = w.set_position(PhysicalPosition::new(
            area.position.x + (area.size.width as i32 - outer.width as i32) / 2,
            area.position.y + (area.size.height as i32 - outer.height as i32) / 2,
        ));
    }
    let _ = w.show();
    let _ = w.set_focus();
}

/// SHGetKnownFolderPath (as known_folders calls it) fails while the Screenshots folder doesn't exist yet,
/// so fall back to its default place under Pictures and create it, so Snipping Tool's later saves are still seen.
fn screenshots_dir(known: Option<PathBuf>, pictures: Option<PathBuf>) -> Option<PathBuf> {
    let dir = known.or_else(|| Some(pictures?.join("Screenshots")))?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

#[test]
fn wait_complete_waits_for_the_end_marker() {
    let p = std::env::temp_dir().join("snarkymark-wait-test.png");
    std::fs::write(&p, b"\x89PNG partial\xFF\xD9").unwrap(); // IDAT bytes can end in the JPEG marker
    let (p2, t) = (p.clone(), Instant::now());
    let writer = std::thread::spawn(move || {
        sleep(Duration::from_millis(150));
        std::fs::write(&p2, b"\x89PNG done\0\0\0\0IEND\xAEB`\x82").unwrap();
    });
    wait_complete(&p);
    assert!((150..2000).contains(&t.elapsed().as_millis()), "{:?}", t.elapsed());
    writer.join().unwrap();
    let _ = std::fs::remove_file(p);
}

/// Calls `on_image` for each image created in the folder `resolve` names, for the life of the process.
fn watch_images(
    resolve: impl Fn() -> Option<PathBuf> + Send + 'static,
    every: Duration,
    on_image: impl Fn(PathBuf) + Send + 'static,
) -> notify::Result<()> {
    let mut watcher = notify::recommended_watcher(move |r: notify::Result<notify::Event>| {
        let Ok(e) = r else { return };
        if !matches!(e.kind, EventKind::Create(_)) {
            return;
        }
        for p in e.paths.into_iter().filter(|p| is_image(p)) {
            on_image(p);
        }
    })?;
    let mut dir = resolve().ok_or_else(|| notify::Error::generic("no Screenshots folder"))?;
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;
    // The folder can move while the tray runs (Properties > Location, OneDrive backup of Pictures), and notify
    // drops a deleted folder's watch without an event: re-resolve it now and then and watch the new place.
    std::thread::spawn(move || loop {
        sleep(every);
        match resolve() {
            Some(now) if now != dir => {
                let _ = watcher.unwatch(&dir);
                if let Err(e) = watcher.watch(&now, RecursiveMode::NonRecursive) {
                    log!("not watching {}: {e}", now.display());
                }
                dir = now;
            }
            _ => {}
        }
    });
    Ok(())
}

#[test]
fn watch_follows_the_folder_when_it_moves() {
    let base = std::env::temp_dir().join("snarkymark-move-test");
    let _ = std::fs::remove_dir_all(&base);
    let (a, b) = (base.join("a"), base.join("b"));
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let cur = std::sync::Arc::new(Mutex::new(a.clone()));
    let c = cur.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let tx = Mutex::new(tx);
    watch_images(move || Some(c.lock().unwrap().clone()), Duration::from_millis(50), move |p| {
        let _ = tx.lock().unwrap().send(p);
    })
    .unwrap();
    std::fs::write(a.join("1.png"), b"x").unwrap();
    assert!(rx.recv_timeout(Duration::from_secs(2)).is_ok_and(|p| p.ends_with("1.png")));
    *cur.lock().unwrap() = b.clone();
    sleep(Duration::from_millis(300));
    std::fs::write(b.join("2.png"), b"x").unwrap();
    assert!(rx.recv_timeout(Duration::from_secs(2)).is_ok_and(|p| p.ends_with("2.png")), "new folder not watched");
    let _ = std::fs::remove_dir_all(base);
}

/// What a Start-at-login click should make the entry: the opposite of what it really is now.
fn login_target(enabled_now: bool) -> bool {
    !enabled_now
}

#[test]
fn login_click_flips_real_state() {
    // Tick stale-checked, entry disabled in Task Manager: the click must enable.
    assert!(login_target(false));
    assert!(!login_target(true));
}

fn main() {
    let app = tauri::Builder::default()
        // A second launch (e.g. "Open with") hands its files to the running tray instance.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            for a in argv.into_iter().skip(1) {
                open(app, from_cwd(&cwd, a), Instant::now(), false);
            }
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .manage(Shots::default())
        .invoke_handler(tauri::generate_handler![shot, ready, save, close])
        .on_window_event(|w, e| {
            if let WindowEvent::Destroyed = e {
                w.state::<Shots>().0.lock().unwrap().remove(w.label());
            }
        })
        .setup(|app| {
            let h = app.handle().clone();
            for a in std::env::args_os().skip(1) {
                open(&h, a.into(), Instant::now(), false);
            }
            // Start at login is an HKCU Run entry for this exe, off until ticked here.
            // An entry left by another copy (dev build, moved exe) still reads as enabled, so re-point it here.
            let on = app.autolaunch().is_enabled()?;
            if on {
                let _ = app.autolaunch().enable();
            }
            let login = CheckMenuItem::with_id(app, "login", "Start at login", true, on, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit snarkymark", true, None::<&str>)?;
            let item = login.clone();
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("snarkymark")
                .menu(&Menu::with_items(app, &[&login, &quit])?)
                .on_menu_event(move |app, e| match e.id().as_ref() {
                    "quit" => app.exit(0),
                    "login" => {
                        // Flip the real state, not the tick: Task Manager can change it behind a stale tick.
                        let a = app.autolaunch();
                        let _ = if login_target(a.is_enabled().unwrap_or(false)) { a.enable() } else { a.disable() };
                        let _ = item.set_checked(a.is_enabled().unwrap_or(false));
                    }
                    _ => {}
                })
                .build(app)?;

            // Snipping Tool's auto-save lands here. Only creations count (see `save` for why that matters).
            // Not being able to watch it must not cost the tray and Open with.
            let resolve = || {
                use known_folders::{get_known_folder_path, KnownFolder};
                screenshots_dir(get_known_folder_path(KnownFolder::Screenshots), get_known_folder_path(KnownFolder::Pictures))
            };
            if let Err(e) = watch_images(resolve, Duration::from_secs(3), move |p| open(&h, p, Instant::now(), true)) {
                log!("not watching Screenshots: {e}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building snarkymark");
    // Closing the last editor window leaves the tray running; only Quit exits.
    app.run(|_, e| {
        if let RunEvent::ExitRequested { api, code: None, .. } = e {
            api.prevent_exit();
        }
    });
}

#[test]
fn screenshots_dir_is_created_when_missing() {
    let pics = std::env::temp_dir().join("snarkymark-pictures-test");
    let _ = std::fs::remove_dir_all(&pics);
    let dir = screenshots_dir(None, Some(pics.clone())).unwrap();
    assert!(dir == pics.join("Screenshots") && dir.is_dir());
    let _ = std::fs::remove_dir_all(pics);
}

#[test]
fn launch_paths_need_not_be_unicode() {
    // std::env::args panics on a path with an unpaired surrogate; libtest reads args too, so check the source.
    assert!(!include_str!("main.rs").contains(concat!("env::args", "()")));
}

#[test]
fn logging_survives_a_closed_stderr_pipe() {
    // Child: log into a pipe whose reader is gone. Parent: re-run just this test that way and expect success.
    if std::env::var_os("SM_LOG_CHILD").is_some() {
        sleep(Duration::from_millis(300));
        for _ in 0..4 { log!("timing line"); }
        return;
    }
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["logging_survives_a_closed_stderr_pipe", "--exact", "--nocapture"])
        .env("SM_LOG_CHILD", "1")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn().unwrap();
    drop(child.stderr.take());
    assert!(child.wait().unwrap().success());
}
