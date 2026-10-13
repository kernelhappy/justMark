# Decisions

- **2026-10-12 — Tauri 2 + vanilla JS, reuse JustSave's editor.** Least rework; WebView2 ships with Win 11.
  Rejected Electron (~150 MB bundle), WPF/WinUI (1–2 s .NET start), native rewrite (rebuild editor).
- **2026-10-12 — Keep Windows' capture.** Win+Shift+S can't be cleanly taken over; no reason to rebuild it.
- **2026-10-12 — Editor opens on every snip** (user: usually clicks the toast to edit; sometimes just pastes).
- **2026-10-12 — Option B (window per snip, nothing idle) first; A (pre-loaded hidden window) if laggy.**
  Measured B: ~2–4 MB idle, 0.6–0.8 s mouse-up → visible. A would cost ~100 MB idle.
- **2026-10-12 — B confirmed after trying it:** user finds the 0.6–0.8 s open lag acceptable for now.
  Revisit A only if that changes.
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
- **2026-10-12 — UI redesign: top bar + contextual floating dock + zoom pill** (handsoff; user to review).
  Rejected: left tool rail (three surfaces to scan), keeping the 2-row header (everything always visible,
  most of it irrelevant to the current tool). Markup toggle dropped: the window only exists to mark up.
  Format/Quality/Print moved into Save's menu (set once, rarely changed). Select stays the default tool so
  "snip, paste, Esc" is still one Esc.
- **2026-10-13 — Bughunt morning list** (`reports/bughunt-2026-10-12.md`):
  - rust-r4-1 (Save dialog error looks like Cancel): accepted as a known limit; our own IFileDialog isn't
    worth ~50 lines of unsafe code for a rare failure.
  - rust-r1-5 (one window per Create, bursts): handled by the Max windows setting, not a burst cap.
  - Only Copy queues while an export runs; Save/Print presses while busy are dropped (a double-click on
    Save queued a second dialog).
  - Accepted: Fit width settles ~15 px narrower at the sizes that used to oscillate; `foo.jpg` saved as PNG
    becomes `foo.jpg.png` (an existing one is overwritten without a prompt).
  - Folder moves are rare one-time events, so no 3 s poll "for eternity": the parent folder is watched and
    the location re-resolved only when the Screenshots folder goes away. Probed: notify reports nothing
    when a watched folder itself is renamed or deleted, hence the parent watch.
  - A page that breaks before `ready` shows at once (inline `onerror`), not after the 10 s watchdog.
- **2026-10-13 — Settings window** (see SKILL.md Settings). A real window rather than tray check items
  (user's choice). Auto copy fires on focus loss, not on every change. Hotkey default Shift+Alt+S, next to
  Win+Shift+S in muscle memory. Rejected: Ctrl+Alt+S (JetBrains/Visual Studio; it's AltGr+S on Polish and
  other layouts), Ctrl+Win+S (Windows Speech Recognition). PrtScn stays Windows' (user: leave it alone).
  Max windows: prefer closing a window without unsaved work; with none, close the oldest anyway (user).
- **2026-10-13 — Settings gaps** (asked before building):
  - Max windows' "oldest" = opened first, not least recently used (user's choice).
  - A snip replacing an editor's image keeps that window's size and position and fits the image to it (user),
    rather than re-fitting and re-centering like a new window.
  - Open latest snip follows the New-window rule like a snip (user); Open with always gets a new window.
  - Defaults accepted without discussion: latest = newest image in Screenshots (by creation time: a copied
    file keeps its source's modified time); already open → focus it; hotkey clearable; settings apply live;
    one settings window, Esc closes it, not counted in Max windows; JSON via serde (already in the tree).
- **2026-10-13 — Auto copy writes the clipboard from Rust** (found while building): `navigator.clipboard.write`
  rejects after focus loss ("Document is not focused", probed in WebView2 154). The page sends PNG + CF_DIB;
  Rust writes them with `windows-sys` (already in the tree; only features added). A copy is dropped, and the
  markup stays unsaved, when the clipboard changed since the window lost focus (sequence number), so a slow
  large encode can't overwrite a newer copy (seen in testing: a 3612×1913 encode finished after a later
  257×215 one). Rejected: copying on every change (the decided trigger is focus loss).
- **2026-10-13 — Auto copy doesn't make a window disposable** (user's hands-on try): with Auto copy on,
  Win+Shift+S blurred the editor, the auto copy counted as saved, and Max windows closed it as clean.
  An auto copy now only spares Esc's confirm; Max windows and replace-in-place still treat the markup as
  unsaved until a pressed Save or Copy. Hotkey recorder gets a Default button next to Clear (user).
- **2026-10-13 — Editor wishlist designed** (see SKILL.md Editor features, Explorer right-click):
  - Weight is linear 1–16 (user), not a stepped list; hold-to-repeat makes linear quick. Text size repeats too.
  - Style per tool, not one shared style: a black filled box would otherwise turn the next arrow black.
  - Polygon closes three ways (double-click, Enter, first point); key G (P is Pen).
  - No separate redaction: exports are flattened, so any opaque markup covers (user). A real redaction
    tool only matters if PDF export ever keeps live markup objects (WISHLIST).
  - Fill patterns: user's list plus `\\\`, `×××`, checkerboard; skipped zigzag/waves (busy when dense).
    Not on the callout box (hatching under text). Fill is a split button like Save, not a dock strip.
  - See-through = 40% opacity like the highlighter, not multiply: multiply vanishes on dark screenshots and
    can't blend with the capture while the ink is one SVG drawn over it.
  - Colors: one swatch row plus a Line · Fill · Text target picker (user: try it), over three rows. Fillable
    shapes get Line · Fill too.
  - Undo crop removed (user hadn't noticed it); Crop again reopens over the original, crops are undoable.
  - Right-click verb labelled just "JustMark"; app-managed HKCU toggle because dev runs the bare exe.
    Windows 11 top-level menu needs IExplorerCommand + a signed sparse package: deferred to installer/signing.
- **2026-10-13 — Rename to JustMark** (user), to show its relation to JustSave. After Settings merges.
- **2026-10-13 — Rename as built** (handsoff, spec silent on these): identifier `io.github.justmark`; Cargo
  package `justmark`, so the exe is `justmark.exe` (Cargo's lowercase convention; Windows ignores case);
  file-association ProgID `JustMark.Image`; Start at login's Run value is named `JustMark`. Nothing migrates the old
  config dir or an old `snarkymark` Run value (none existed on the dev box).
