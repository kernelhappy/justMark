#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Timing/diagnostic line to stderr. Unlike eprintln, a dead stderr (closed pipe) is ignored instead of panicking.
macro_rules! log {
    ($($t:tt)*) => {{ use std::io::Write; let _ = writeln!(std::io::stderr(), $($t)*); }};
}

use notify::{EventKind, RecursiveMode, Watcher};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread::sleep,
    time::{Duration, Instant},
};
use tauri::{
    ipc::{InvokeBody, Request, Response}, menu::{Menu, MenuItem}, tray::TrayIconBuilder, AppHandle, Manager, PhysicalPosition, PhysicalSize,
    RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// One editor window's image: the file, when it arrived (for the startup timing on stderr), whether the watcher saw
/// it created (only then can it still be being written), whether the page has unsaved work (see `dirty`), and when the
/// window was opened and last focused (sequence numbers; 0 = never focused), for where the next snip goes (see `place`).
struct Shot {
    path: PathBuf,
    t0: Instant,
    from_watcher: bool,
    dirty: bool,
    opened: usize,
    used: usize,
    /// The clipboard's sequence number when the window last lost focus (see `clip`).
    left: u32,
}

/// Window label -> its Shot. Only editors are here, so the settings window never counts toward Max windows.
#[derive(Default)]
struct Shots(Mutex<HashMap<String, Shot>>);

static SEQ: AtomicUsize = AtomicUsize::new(1);
fn seq() -> usize {
    SEQ.fetch_add(1, Ordering::Relaxed)
}

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

/// Where an incoming snip goes: into an existing editor, or a new window after closing these to stay within Max windows.
#[derive(Debug, PartialEq)]
enum Place {
    Replace(String),
    New(Vec<String>),
}

/// `reuse` (New snip opens a new window is off): the last-focused editor takes the snip unless it has unsaved work.
/// Otherwise a new window, closing the oldest-opened editors without unsaved work first, then the oldest anyway.
fn place(open: &HashMap<String, Shot>, reuse: bool, max: usize) -> Place {
    if reuse {
        if let Some((l, _)) = open.iter().filter(|(_, s)| s.used > 0).max_by_key(|(_, s)| s.used).filter(|(_, s)| !s.dirty) {
            return Place::Replace(l.clone());
        }
    }
    let mut by_age: Vec<_> = open.iter().collect();
    by_age.sort_by_key(|(_, s)| (s.dirty, s.opened));
    let over = (open.len() + 1).saturating_sub(max.max(1));
    Place::New(by_age.into_iter().take(over).map(|(l, _)| l.clone()).collect())
}

#[test]
fn place_reuses_the_last_used_clean_editor_and_closes_the_oldest_clean_one() {
    let shot = |opened, used, dirty| Shot { path: PathBuf::new(), t0: Instant::now(), from_watcher: false, dirty, opened, used, left: 0 };
    let open = |v: Vec<(&str, Shot)>| v.into_iter().map(|(l, s)| (l.to_string(), s)).collect::<HashMap<_, _>>();
    let three = || open(vec![("a", shot(1, 4, true)), ("b", shot(2, 5, false)), ("c", shot(3, 7, false))]);
    assert_eq!(place(&three(), true, 5), Place::Replace("c".into())); // c was focused last
    assert_eq!(place(&three(), false, 5), Place::New(vec![]));
    assert_eq!(place(&three(), false, 3), Place::New(vec!["b".into()])); // a is older but has unsaved work
    assert_eq!(place(&three(), false, 1), Place::New(vec!["b".into(), "c".into(), "a".into()]));
    // The last-focused editor has unsaved work: a new window, not the next one along.
    let busy = open(vec![("a", shot(1, 9, true)), ("b", shot(2, 5, false))]);
    assert_eq!(place(&busy, true, 2), Place::New(vec!["b".into()]));
    let all_dirty = open(vec![("a", shot(2, 0, true)), ("b", shot(1, 0, true))]);
    assert_eq!(place(&all_dirty, true, 2), Place::New(vec!["b".into()])); // never focused: no reuse; oldest goes anyway
}

/// `reuse`: whether this snip may go into an existing editor (watcher and hotkey yes, per the setting; Open with never).
fn open(app: &AppHandle, path: PathBuf, t0: Instant, from_watcher: bool, reuse: bool) {
    let label = format!("shot{}", seq());
    let name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    // The page reads its name from the hash, as JustSave's editor read its capture id.
    let hash: String = name
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    let (reuse, max) = {
        let s = app.state::<Config>();
        let s = s.0.lock().unwrap();
        (reuse && !s.new_window, s.max_windows)
    };
    let shots = app.state::<Shots>();
    let mut map = shots.0.lock().unwrap();
    // Decided and recorded under one lock, so a burst of snips can't each pick the same editor or each skip closing one.
    let close = match place(&map, reuse, max) {
        Place::Replace(l) => {
            let s = map.get_mut(&l).expect("place picks an open editor");
            (s.path, s.t0, s.from_watcher, s.dirty) = (path, t0, from_watcher, false);
            drop(map);
            // ponytail: a stroke started between place() and this reload is lost; the user is in the snip overlay then.
            if let Some(w) = app.get_webview_window(&l) {
                log!("{l} takes {name}");
                let _ = w.set_title(&name);
                // A fresh page: new image, empty undo history; `ready` keeps the window where it is (see there).
                let _ = w.eval(format!("history.replaceState(null, '', '#{hash}'); location.reload()"));
            }
            return;
        }
        Place::New(close) => close,
    };
    for l in &close {
        map.remove(l);
    }
    map.insert(label.clone(), Shot { path, t0, from_watcher, dirty: false, opened: seq(), used: 0, left: 0 });
    drop(map);
    // Silently, unsaved work or not (the user's call): Max windows bounds memory on bursts.
    for l in close {
        if let Some(w) = app.get_webview_window(&l) {
            log!("{l} closed for Max windows");
            let _ = w.destroy();
        }
    }
    let built = without_shot_on_error(&shots, &label, || {
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

/// The window's image is registered before it is built (the page asks for it at once); drop it if the build
/// fails: no window means no Destroyed event to remove it.
fn without_shot_on_error<W, E>(shots: &Shots, label: &str, build: impl FnOnce() -> Result<W, E>) -> Result<W, E> {
    let built = build();
    if built.is_err() {
        shots.0.lock().unwrap().remove(label);
    }
    built
}

#[test]
fn a_failed_window_build_leaves_no_shot() {
    let shots = Shots::default();
    for l in ["a", "b"] {
        shots.0.lock().unwrap().insert(l.into(), Shot { path: PathBuf::new(), t0: Instant::now(), from_watcher: false, dirty: false, opened: 0, used: 0, left: 0 });
    }
    assert!(without_shot_on_error(&shots, "a", || Err::<(), _>(())).is_err());
    assert!(without_shot_on_error(&shots, "b", || Ok::<_, ()>(())).is_ok());
    assert_eq!(shots.0.lock().unwrap().keys().collect::<Vec<_>>(), ["b"]);
}

/// The page's unsaved-work state (the check behind Esc's confirm), for `place`.
#[tauri::command]
fn dirty(w: WebviewWindow, shots: State<Shots>, d: bool) {
    if let Some(s) = shots.0.lock().unwrap().get_mut(w.label()) {
        s.dirty = d;
    }
}

/// Auto copy runs on focus loss, where the page's navigator.clipboard refuses ("Document is not focused"), so the page
/// hands over what Copy would write, a PNG (its byte length in header `png`) followed by a CF_DIB, and it goes on the
/// clipboard from here, owned by the editor window.
/// Returns false, writing nothing, when something was copied since the window lost focus (another app, or an editor
/// left later whose smaller image encoded first): that copy is newer, and the page keeps its markup unsaved.
#[tauri::command]
fn clip(w: WebviewWindow, shots: State<Shots>, req: Request<'_>) -> Result<bool, String> {
    use windows_sys::Win32::{Foundation::GlobalFree, System::{DataExchange::*, Memory::*}};
    let InvokeBody::Raw(bytes) = req.body() else { return Err("no image data".into()) };
    let n: usize = req.headers().get("png").and_then(|v| v.to_str().ok()?.parse().ok()).filter(|&n| n <= bytes.len()).ok_or("bad png length")?;
    let (png, dib) = bytes.split_at(n);
    let hwnd = w.hwnd().map_err(|e| e.to_string())?.0;
    // SAFETY: plain Win32 clipboard calls; each buffer is sized to what is copied into it, and is freed here unless the
    // clipboard took it.
    unsafe {
        // Another app can hold the clipboard for a moment.
        if !(0..20).any(|_| OpenClipboard(hwnd) != 0 || { sleep(Duration::from_millis(10)); false }) {
            return Err("the clipboard is busy".into());
        }
        if shots.0.lock().unwrap().get(w.label()).is_none_or(|s| s.left != GetClipboardSequenceNumber()) {
            CloseClipboard();
            return Ok(false);
        }
        EmptyClipboard();
        const CF_DIB: u32 = 8;
        let png_format = RegisterClipboardFormatW(windows_sys::w!("PNG"));
        let mut ok = true;
        for (format, data) in [(CF_DIB, dib), (png_format, png)] {
            let h = GlobalAlloc(GMEM_MOVEABLE, data.len());
            let p = GlobalLock(h);
            if p.is_null() {
                ok = false;
                continue;
            }
            std::ptr::copy_nonoverlapping(data.as_ptr(), p.cast(), data.len());
            GlobalUnlock(h);
            if SetClipboardData(format, h).is_null() {
                GlobalFree(h);
                ok = false;
            }
        }
        CloseClipboard();
        if ok { Ok(true) } else { Err("couldn't write the clipboard".into()) }
    }
}

/// Off the main thread (see `blocking`): it can wait for the file, which the window started loading alongside.
#[tauri::command]
async fn shot(w: WebviewWindow, shots: State<'_, Shots>) -> Result<Response, String> {
    let (path, from_watcher) = shots.0.lock().unwrap().get(w.label()).map(|s| (s.path.clone(), s.from_watcher)).ok_or("no image for this window")?;
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
    let p = std::env::temp_dir().join("justmark-trailer-test.jpg");
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
    let stem = shots.0.lock().unwrap().get(w.label()).and_then(|s| s.path.file_stem().map(|n| n.to_string_lossy().into_owned()));
    let file_name = format!("{}.{ext}", stem.unwrap_or_else(|| "JustMark".into()));
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
/// An editor that took a new snip (see `place`) is already showing: it keeps its size and place, and the page fits the image.
#[tauri::command]
fn ready(w: WebviewWindow, shots: State<Shots>, img: (f64, f64), chrome: (f64, f64), min: (f64, f64)) {
    if let Some(s) = shots.0.lock().unwrap().get(w.label()) {
        log!("{} ready {:?}", w.label(), s.t0.elapsed());
    }
    let cursor = w.cursor_position().unwrap_or_default();
    let mon = w.monitor_from_point(cursor.x, cursor.y).ok().flatten().or_else(|| w.primary_monitor().ok().flatten());
    if w.is_visible().unwrap_or(false) {
        let _ = w.unminimize();
    } else if let Some(m) = mon {
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
    let p = std::env::temp_dir().join("justmark-wait-test.png");
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
    retry: Duration,
    on_image: impl Fn(PathBuf) + Send + 'static,
) -> notify::Result<()> {
    // The folder can move while the tray runs (Properties > Location > Move, OneDrive backup of Pictures). notify says
    // nothing when a watched folder itself is renamed or deleted, so its parent is watched too: an event naming the
    // folder there means it went away, and only then is the location looked up again (no polling).
    let dir = Arc::new(Mutex::new(resolve().ok_or_else(|| notify::Error::generic("no Screenshots folder"))?));
    let (gone_tx, gone) = std::sync::mpsc::channel();
    let d = dir.clone();
    let mut watcher = notify::recommended_watcher(move |r: notify::Result<notify::Event>| {
        let Ok(e) = r else { return };
        let cur = d.lock().unwrap().clone();
        if e.paths.iter().any(|p| *p == cur) {
            let _ = gone_tx.send(());
        } else if matches!(e.kind, EventKind::Create(_)) {
            // The parent watch reports its own files too; only images in the folder itself count.
            for p in e.paths.into_iter().filter(|p| is_image(p) && p.parent() == Some(&*cur)) {
                on_image(p);
            }
        }
    })?;
    let watch = |w: &mut notify::RecommendedWatcher, dir: &Path| -> notify::Result<()> {
        w.watch(dir, RecursiveMode::NonRecursive)?;
        if let Some(parent) = dir.parent() {
            let _ = w.watch(parent, RecursiveMode::NonRecursive); // best effort: without it, a move needs a restart
        }
        Ok(())
    };
    let first = dir.lock().unwrap().clone();
    watch(&mut watcher, &first)?;
    std::thread::spawn(move || {
        while gone.recv().is_ok() {
            let old = dir.lock().unwrap().clone();
            // The new location may be registered a moment after the old folder goes: look a few times, then give up.
            let mut found = None;
            for _ in 0..30 {
                found = resolve().filter(|p| *p != old && p.is_dir());
                if found.is_some() {
                    break;
                }
                sleep(retry);
            }
            let Some(now) = found else { continue };
            let _ = watcher.unwatch(&old);
            if let Some(parent) = old.parent() {
                let _ = watcher.unwatch(parent);
            }
            *dir.lock().unwrap() = now.clone();
            if let Err(e) = watch(&mut watcher, &now) {
                log!("not watching {}: {e}", now.display());
            }
            while gone.try_recv().is_ok() {} // the rest of the old folder's events
        }
    });
    Ok(())
}

#[test]
fn watch_follows_the_folder_when_it_moves() {
    let base = std::env::temp_dir().join("justmark-move-test");
    let _ = std::fs::remove_dir_all(&base);
    let (a, b) = (base.join("pics").join("a"), base.join("b"));
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let cur = Arc::new(Mutex::new(a.clone()));
    let c = cur.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let tx = Mutex::new(tx);
    watch_images(move || Some(c.lock().unwrap().clone()), Duration::from_millis(50), move |p| {
        let _ = tx.lock().unwrap().send(p);
    })
    .unwrap();
    std::fs::write(a.join("1.png"), b"x").unwrap();
    assert!(rx.recv_timeout(Duration::from_secs(2)).is_ok_and(|p| p.ends_with("1.png")));
    std::fs::write(a.parent().unwrap().join("other.png"), b"x").unwrap(); // the parent's own files don't open
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err(), "a file in the parent folder opened");
    // Location > Move on the same drive: the folder is renamed away and the known folder points elsewhere.
    *cur.lock().unwrap() = b.clone();
    std::fs::rename(&a, base.join("pics").join("a-moved")).unwrap();
    sleep(Duration::from_millis(500));
    std::fs::write(b.join("2.png"), b"x").unwrap();
    assert!(rx.recv_timeout(Duration::from_secs(2)).is_ok_and(|p| p.ends_with("2.png")), "new folder not watched");
    // A move to another drive copies, then deletes the old folder.
    let c3 = base.join("c");
    std::fs::create_dir_all(&c3).unwrap();
    *cur.lock().unwrap() = c3.clone();
    std::fs::remove_dir_all(&b).unwrap();
    sleep(Duration::from_millis(500));
    std::fs::write(c3.join("3.png"), b"x").unwrap();
    assert!(rx.recv_timeout(Duration::from_secs(2)).is_ok_and(|p| p.ends_with("3.png")), "not watched after the old folder was deleted");
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

/// The Start-at-login entry: HKCU only (an elevated run must not land it in HKLM, where a normal run
/// can't clear it), and the exe path quoted so a space in it can't be split at login.
fn login_launcher(exe: &Path) -> auto_launch::AutoLaunch {
    auto_launch::AutoLaunchBuilder::new()
        .set_app_name("JustMark")
        .set_app_path(&format!("\"{}\"", exe.display()))
        .set_windows_enable_mode(auto_launch::WindowsEnableMode::CurrentUser)
        .build()
        .expect("app name and path are set")
}

#[test]
fn login_entry_quotes_exe_path() {
    let a = login_launcher(Path::new(r"C:\Users\John Smith\justmark.exe"));
    assert_eq!(a.get_app_path(), r#""C:\Users\John Smith\justmark.exe""#);
}

/// The Settings window's values (Start at login is the HKCU entry itself, not stored here).
/// Kept in `settings.json` in the app config dir; a missing or unreadable file, or a missing field, means the default.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    auto_open: bool,
    /// global-hotkey syntax with DOM key codes ("Shift+Alt+KeyS"); empty = no hotkey.
    hotkey: String,
    new_window: bool,
    max_windows: usize,
    auto_copy: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { auto_open: true, hotkey: "Shift+Alt+KeyS".into(), new_window: true, max_windows: 5, auto_copy: false }
    }
}

struct Config(Mutex<Settings>, PathBuf);

#[test]
fn settings_fill_missing_fields_with_defaults() {
    let s: Settings = serde_json::from_str(r#"{"autoOpen":false}"#).unwrap();
    assert!(!s.auto_open && s.new_window && s.max_windows == 5 && s.hotkey == "Shift+Alt+KeyS");
}

/// Registers the Open latest snip hotkey in place of the old one. False when it can't be had (another app holds it,
/// or it doesn't parse); the settings window then says "taken".
fn set_hotkey(app: &AppHandle, keys: &str) -> bool {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    keys.is_empty() || keys.parse::<Shortcut>().is_ok_and(|k| gs.register(k).is_ok())
}

fn hotkey_held(app: &AppHandle, keys: &str) -> bool {
    keys.is_empty() || keys.parse::<Shortcut>().is_ok_and(|k| app.global_shortcut().is_registered(k))
}

/// The newest image in the folder (what Open latest snip opens), by when it was created: a copy keeps its source's
/// modified time, and a Save over an old snip shouldn't make it the latest.
fn latest(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir).ok()?.flatten()
        .filter(|e| is_image(&e.path()) && e.file_type().is_ok_and(|t| t.is_file()))
        .max_by_key(|e| e.metadata().and_then(|m| m.created()).ok())
        .map(|e| e.path())
}

#[test]
fn latest_is_the_newest_image() {
    let d = std::env::temp_dir().join("justmark-latest-test");
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    for f in ["a.png", "b.jpg", "c.txt", "a.png"] {
        std::fs::write(d.join(f), b"x").unwrap(); // a.png again: written last, but created first
        sleep(Duration::from_millis(30));
    }
    assert_eq!(latest(&d), Some(d.join("b.jpg")));
    let _ = std::fs::remove_dir_all(d);
}

/// Open latest snip: an editor that already has it comes to the front; otherwise it opens as a new snip would.
fn open_latest(app: &AppHandle) {
    let Some(p) = screenshots().as_deref().and_then(latest) else { return };
    let have = app.state::<Shots>().0.lock().unwrap().iter().find(|(_, s)| s.path == p).map(|(l, _)| l.clone());
    match have.and_then(|l| app.get_webview_window(&l)) {
        Some(w) => {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        None => open(app, p, Instant::now(), true, true),
    }
}

fn screenshots() -> Option<PathBuf> {
    use known_folders::{get_known_folder_path, KnownFolder};
    screenshots_dir(get_known_folder_path(KnownFolder::Screenshots), get_known_folder_path(KnownFolder::Pictures))
}

/// Settings…: one settings window; a second click brings it back.
fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("JustMark settings")
        .inner_size(440.0, 340.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        .build();
    if let Err(e) = built {
        log!("settings window failed: {e}");
    }
}

/// The settings window's view: the settings, whether the hotkey is registered, and whether Start at login is on.
#[tauri::command]
fn settings(app: AppHandle, cfg: State<Config>) -> (Settings, bool, bool) {
    let s = cfg.0.lock().unwrap().clone();
    let held = hotkey_held(&app, &s.hotkey);
    (s, held, app.state::<auto_launch::AutoLaunch>().is_enabled().unwrap_or(false))
}

/// Applies and stores the settings window's values. Returns whether the hotkey could be registered.
/// Async: registering goes through the main thread and waits for it.
#[tauri::command]
async fn set_settings(app: AppHandle, cfg: State<'_, Config>, s: Settings) -> Result<bool, String> {
    let s = Settings { max_windows: s.max_windows.max(1), ..s };
    let json = serde_json::to_vec_pretty(&s).map_err(|e| e.to_string())?;
    // Stored under the lock, so the file always matches what is in force; the hotkey after it (it waits on the main thread).
    let old = {
        let mut cur = cfg.0.lock().unwrap();
        let part = part_path(&cfg.1);
        cfg.1.parent().map(std::fs::create_dir_all).transpose()
            .and_then(|_| std::fs::write(&part, json))
            .and_then(|_| std::fs::rename(&part, &cfg.1))
            .map_err(|e| format!("couldn't save settings: {e}"))?;
        std::mem::replace(&mut *cur, s.clone()).hotkey
    };
    Ok((old == s.hotkey && hotkey_held(&app, &old)) || set_hotkey(&app, &s.hotkey))
}

/// Start at login, flipped from the entry's real state, not the checkbox's: Task Manager can change it behind a stale
/// window. Returns the state it ends in.
#[tauri::command]
fn login(a: State<auto_launch::AutoLaunch>) -> bool {
    let _ = if login_target(a.is_enabled().unwrap_or(false)) { a.enable() } else { a.disable() };
    a.is_enabled().unwrap_or(false)
}

fn main() {
    let app = tauri::Builder::default()
        // A second launch (e.g. "Open with") hands its files to the running tray instance.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            for a in argv.into_iter().skip(1) {
                open(app, from_cwd(&cwd, a), Instant::now(), false, false);
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _, e| {
                    if e.state() == ShortcutState::Pressed {
                        open_latest(app);
                    }
                })
                .build(),
        )
        .manage(Shots::default())
        .invoke_handler(tauri::generate_handler![shot, ready, save, close, dirty, clip, settings, set_settings, login])
        .on_window_event(|w, e| match e {
            WindowEvent::Destroyed => drop(w.state::<Shots>().0.lock().unwrap().remove(w.label())),
            // The last-focused editor is where a snip goes when it doesn't get a new window.
            WindowEvent::Focused(true) => {
                if let Some(s) = w.state::<Shots>().0.lock().unwrap().get_mut(w.label()) {
                    s.used = seq();
                }
            }
            WindowEvent::Focused(false) => {
                if let Some(s) = w.state::<Shots>().0.lock().unwrap().get_mut(w.label()) {
                    // SAFETY: takes nothing, reads a counter.
                    s.left = unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() };
                }
            }
            _ => {}
        })
        .setup(|app| {
            let h = app.handle().clone();
            let file = app.path().app_config_dir()?.join("settings.json");
            let s: Settings = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).map_err(|e| log!("settings.json: {e}")).ok()).unwrap_or_default();
            if !set_hotkey(&h, &s.hotkey) {
                log!("hotkey {} is taken", s.hotkey);
            }
            app.manage(Config(Mutex::new(s), file));
            for a in std::env::args_os().skip(1) {
                open(&h, a.into(), Instant::now(), false, false);
            }
            // Start at login is an HKCU Run entry for this exe, off until ticked in Settings.
            // An entry left by another copy (dev build, moved exe) still reads as enabled, so re-point it here.
            let a = login_launcher(&std::env::current_exe()?);
            if a.is_enabled()? {
                let _ = a.enable();
            }
            app.manage(a);
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit JustMark", true, None::<&str>)?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("JustMark")
                .menu(&Menu::with_items(app, &[&settings, &quit])?)
                .on_menu_event(|app, e| match e.id().as_ref() {
                    "quit" => app.exit(0),
                    "settings" => open_settings(app),
                    _ => {}
                })
                .build(app)?;

            // Snipping Tool's auto-save lands here. Only creations count (see `save` for why that matters).
            // Not being able to watch it must not cost the tray and Open with.
            let on_image = move |p| {
                if h.state::<Config>().0.lock().unwrap().auto_open {
                    open(&h, p, Instant::now(), true, true);
                }
            };
            if let Err(e) = watch_images(screenshots, Duration::from_secs(1), on_image) {
                log!("not watching Screenshots: {e}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building JustMark");
    // Closing the last editor window leaves the tray running; only Quit exits.
    app.run(|_, e| {
        if let RunEvent::ExitRequested { api, code: None, .. } = e {
            api.prevent_exit();
        }
    });
}

#[test]
fn screenshots_dir_is_created_when_missing() {
    let pics = std::env::temp_dir().join("justmark-pictures-test");
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
