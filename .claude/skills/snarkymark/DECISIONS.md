# Decisions

- **2026-10-12 — Tauri 2 + vanilla JS, reuse JustSave's editor.** Least rework; WebView2 ships with Win 11.
  Rejected Electron (~150 MB bundle), WPF/WinUI (1–2 s .NET start), native rewrite (rebuild editor).
- **2026-10-12 — Keep Windows' capture.** Win+Shift+S can't be cleanly taken over; no reason to rebuild it.
- **2026-10-12 — Editor opens on every snip** (user: usually clicks the toast to edit; sometimes just pastes).
- **2026-10-12 — Option B (window per snip, nothing idle) first; A (pre-loaded hidden window) if laggy.**
  Measured B: ~2–4 MB idle, 0.6–0.8 s mouse-up → visible. A would cost ~100 MB idle.
- **2026-10-12 — Ingest via Screenshots folder watch.** Measured: file lands ~150 ms after the clipboard
  change. Clipboard listener would be ~150 ms faster but fires on any image copy (needs origin
  filtering). PrtScn → `ms-screenclip:` hotkey idea dropped once every snip opens the editor.
- **2026-10-12 — Window opens on the Create event; `shot` waits for the end marker.** Overlaps WebView2
  startup with Snipping Tool's write instead of serializing them (~60 ms+ saved, more for big snips).
- **2026-10-12 — Save via Rust `rfd` dialog, not `showSaveFilePicker`.** See TRIED-AND-FAILED.
- **2026-10-12 — Save writes `.part` then renames.** No half-written files, and a save into Screenshots
  is a rename there, so the watcher (creations only) doesn't reopen it.
- **2026-10-12 — No "Open file…" tray item.** "Open with" + file association covers it.
- **2026-10-12 — Identifier `io.github.snarkymark`** (working name; change before any release).
