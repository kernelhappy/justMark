#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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

/// Window label -> the image it edits, and when it arrived (for the startup timing on stderr).
#[derive(Default)]
struct Shots(Mutex<HashMap<String, (PathBuf, Instant)>>);

fn is_image(p: &Path) -> bool {
    p.extension().is_some_and(|e| ["png", "jpg", "jpeg"].iter().any(|x| e.eq_ignore_ascii_case(x)))
}

/// Snipping Tool creates the file before it has finished writing it: wait for the PNG or JPEG end marker.
fn wait_complete(p: &Path) {
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        let mut tail = [0u8; 8];
        let read = File::open(p).and_then(|mut f| {
            f.seek(SeekFrom::End(-8))?;
            f.read_exact(&mut tail)
        });
        if read.is_ok() && (tail == *b"IEND\xAEB`\x82" || tail[6..] == [0xFF, 0xD9]) {
            return;
        }
        sleep(Duration::from_millis(20));
    }
}

/// One hidden window per image; the page shows it once the image is laid out (see `ready`).
fn open(app: &AppHandle, path: PathBuf, t0: Instant) {
    static N: AtomicUsize = AtomicUsize::new(0);
    let label = format!("shot{}", N.fetch_add(1, Ordering::Relaxed));
    let name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    // The page reads its name from the hash, as JustSave's editor read its capture id.
    let hash: String = name
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    app.state::<Shots>().0.lock().unwrap().insert(label.clone(), (path, t0));
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(format!("index.html#{hash}").into()))
        .title(&name)
        .visible(false)
        .build();
    match built {
        Ok(_) => eprintln!("{label} window built {:?}", t0.elapsed()),
        Err(e) => eprintln!("{label} window failed: {e}"),
    }
}

/// Off the main thread (async): it can wait for the file, which the window started loading alongside.
#[tauri::command(async)]
fn shot(w: WebviewWindow, shots: State<Shots>) -> Result<Response, String> {
    let path = shots.0.lock().unwrap().get(w.label()).map(|s| s.0.clone()).ok_or("no image for this window")?;
    wait_complete(&path);
    std::fs::read(path).map(Response::new).map_err(|e| e.to_string())
}

/// Save: the Windows Save dialog, then the page's encoded bytes (the request body) go to the picked file.
/// Not showSaveFilePicker: WebView2 titles its dialog "Warning: this site can see edits you make", and once never showed it.
/// Returns the saved file's name, or None when the dialog was cancelled.
#[tauri::command(async)]
fn save(w: WebviewWindow, shots: State<Shots>, req: Request) -> Result<Option<String>, String> {
    let InvokeBody::Raw(bytes) = req.body() else { return Err("no image data".into()) };
    let ext = req.headers().get("ext").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let kind = match ext {
        "png" => "PNG image",
        "jpg" => "JPEG image",
        "pdf" => "PDF document",
        _ => return Err(format!("can't save as {ext:?}")),
    };
    let stem = shots.0.lock().unwrap().get(w.label()).and_then(|s| s.0.file_stem().map(|n| n.to_string_lossy().into_owned()));
    let Some(path) = rfd::FileDialog::new()
        .set_parent(&w)
        .set_file_name(format!("{}.{ext}", stem.unwrap_or_else(|| "snarkymark".into())))
        .add_filter(kind, &[ext])
        .save_file()
    else {
        return Ok(None);
    };
    // Write a side file and rename it over the target: no half-written file, and saving into the Screenshots
    // folder is a rename there, not a creation, so the watcher doesn't open the saved image again.
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let part = path.with_file_name(format!("{name}.part"));
    std::fs::write(&part, bytes).and_then(|_| std::fs::rename(&part, &path)).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        e.to_string()
    })?;
    Ok(Some(name))
}

#[tauri::command]
fn close(w: WebviewWindow) {
    let _ = w.destroy();
}

/// The page knows how big it wants to be (CSS px): size the window to that, within the work area of the
/// monitor under the cursor (where the snip was just taken), center it there and show it.
#[tauri::command]
fn ready(w: WebviewWindow, shots: State<Shots>, width: f64, height: f64) {
    if let Some((_, t0)) = shots.0.lock().unwrap().get(w.label()) {
        eprintln!("{} ready {:?}", w.label(), t0.elapsed());
    }
    let cursor = w.cursor_position().unwrap_or_default();
    let mon = w.monitor_from_point(cursor.x, cursor.y).ok().flatten().or_else(|| w.primary_monitor().ok().flatten());
    if let Some(m) = mon {
        let (area, s) = (m.work_area(), m.scale_factor());
        let size = PhysicalSize::new(
            ((width * s) as u32).min(area.size.width * 9 / 10),
            ((height * s) as u32).min(area.size.height * 9 / 10),
        );
        let _ = w.set_size(size);
        let _ = w.set_position(PhysicalPosition::new(
            area.position.x + (area.size.width - size.width) as i32 / 2,
            area.position.y + (area.size.height - size.height) as i32 / 2,
        ));
    }
    let _ = w.show();
    let _ = w.set_focus();
}

#[test]
fn wait_complete_waits_for_the_end_marker() {
    let p = std::env::temp_dir().join("snarkymark-wait-test.png");
    std::fs::write(&p, b"\x89PNG partial").unwrap();
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

fn main() {
    let app = tauri::Builder::default()
        // A second launch (e.g. "Open with") hands its files to the running tray instance.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _| {
            for a in argv.into_iter().skip(1) {
                open(app, a.into(), Instant::now());
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
            for a in std::env::args().skip(1) {
                open(&h, a.into(), Instant::now());
            }
            // Start at login is an HKCU Run entry for this exe, off until ticked here.
            let login = CheckMenuItem::with_id(app, "login", "Start at login", true, app.autolaunch().is_enabled()?, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit snarkymark", true, None::<&str>)?;
            let item = login.clone();
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("snarkymark")
                .menu(&Menu::with_items(app, &[&login, &quit])?)
                .on_menu_event(move |app, e| match e.id().as_ref() {
                    "quit" => app.exit(0),
                    "login" => {
                        // The click already flipped the tick; make the Run entry match, and show the truth if that failed.
                        let a = app.autolaunch();
                        let _ = if item.is_checked().unwrap_or(false) { a.enable() } else { a.disable() };
                        let _ = item.set_checked(a.is_enabled().unwrap_or(false));
                    }
                    _ => {}
                })
                .build(app)?;

            // Snipping Tool's auto-save lands here. Only creations count (see `save` for why that matters).
            let dir = known_folders::get_known_folder_path(known_folders::KnownFolder::Screenshots)
                .ok_or("no Screenshots folder")?;
            let mut watcher = notify::recommended_watcher(move |r: notify::Result<notify::Event>| {
                let Ok(e) = r else { return };
                if !matches!(e.kind, EventKind::Create(_)) {
                    return;
                }
                for p in e.paths.into_iter().filter(|p| is_image(p)) {
                    open(&h, p, Instant::now());
                }
            })?;
            watcher.watch(&dir, RecursiveMode::NonRecursive)?;
            std::mem::forget(watcher); // watches for the life of the process
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
