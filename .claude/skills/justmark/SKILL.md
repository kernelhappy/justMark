---
name: justmark
description: Spec for JustMark (formerly snarkymark), a lightweight Windows screenshot markup editor (Tauri 2 tray app + JustSave's vanilla-JS SVG editor). Load before changing how snips get in, window/tray lifecycle, the editor port, Save/Copy/Print, or anything that affects startup time or idle memory.
---

# JustMark — spec

Replaces the Windows Snipping Tool's **editor**, not its capture. Win+Shift+S / PrtScn keep taking the
screenshot; JustMark opens every snip for markup. Lightness is the point: measure startup and idle RAM
when changing anything structural (see Budgets).

## Behavior

- **Every snip opens the editor automatically** (default; see Settings). Snipping Tool's auto-save must be
  on; the tray process watches the Screenshots known folder (`FOLDERID_Screenshots`) for **file
  creations** of `.png/.jpg/.jpeg`. Renames and modifications are ignored on purpose (see Save). The
  folder's parent is watched too, only to notice the folder being moved away (Location > Move, OneDrive
  backup of Pictures); the location is looked up again then, never on a timer.
- The snip is still on the clipboard, so the "just paste into an email" case is: snip, paste, Esc.
- **Esc**: steps back (cancel crop / finish text / drop selection / back to Select), and with nothing left
  to step back from, closes the editor. If markup or a crop exists that hasn't been Saved or Copied since,
  it asks first (`confirm`). The window's X closes without asking (explicit act).
- One window per image. It opens hidden, the page loads the image, then asks Rust to size it (image at
  actual size + chrome, min 960×480 CSS px, max 90% of the work area) on the monitor under the cursor,
  center it there and show it.
- **Open with / second launch**: argv files go to the running instance (single-instance plugin) and open
  like a snip. The NSIS bundle registers png/jpg/jpeg as "Editor" associations.
- **Tray**: "Settings…" (see Settings) and "Quit". Closing the last window never exits the process; only Quit does.
- **Save dialog errors look like Cancel** (known limit, accepted 2026-10-13): `rfd` maps a COM/dialog error to
  `None`. Fixing it means our own IFileDialog code; not worth it for a rare failure.

## Settings (built 2026-10-13)

A **Settings…** tray item opens a small settings window (`settings.html`; a WebView2 window like the
editor: ~100 MB only while open, nothing idle; one at a time, Esc closes it, not an editor so it never
counts toward Max windows). Every change applies at once, no Save button. Settings live in
`settings.json` in the app config dir (`%APPDATA%\io.github.justmark`), read by Rust (the
window-opening rules apply before any page exists); a missing file or field means the default.

| Setting | Default | Behavior |
|---|---|---|
| Auto open on snip | on | Off: snips only land in the folder. |
| Open latest snip hotkey | Shift+Alt+S | Global hotkey (Tauri global-shortcut plugin) opens the most recent snip (newest image in the Screenshots folder by creation time), whatever Auto open is set to. If it's already open, its window comes to the front instead. Otherwise it follows New snip opens a new window, like a snip. Recorded in the window (a modifier is required, bare F-keys aside), can be cleared to none or reset to the default; the window shows "taken" when registration fails. PrtScn is left to Windows (never offered). Stored as global-hotkey syntax with DOM key codes (`Shift+Alt+KeyS`). |
| New snip opens a new window | on | Off: the snip replaces the image in the last-focused editor if it has no unsaved work; otherwise a new window opens. The replaced editor keeps its size and position, and the new image is fit to it (the page reloads: undo history starts over). Open with always gets a new window. |
| Max windows | 5 | Opening one more closes the oldest-**opened** window **without** unsaved work; if every window has unsaved work, the oldest closes anyway, silently (user's call: bounds memory on bursts, e.g. bulk copies or OneDrive sync-down). Counts every editor, however it was opened. |
| Auto copy on focus loss | off | When an editor loses focus and has unsaved work, it copies the marked-up PNG (same as Copy, so Esc then closes without asking; but it still counts as unsaved work for Max windows and replace-in-place, since taking a snip is itself a focus loss). Not for focus lost to its own Save/Print dialog or close confirm. |
| Start at login | off | HKCU Run entry, quoted exe path, via the `auto-launch` crate in CurrentUser mode. The checkbox flips the entry's real state (Task Manager can change it behind the window). |

"Unsaved work" = the same check as Esc's confirm (markup or crop not Saved or Copied since), plus a text
being typed or a stroke being drawn. The page reports it to Rust (`dirty`) whenever it changes.

Auto copy can't use `navigator.clipboard` (Chromium refuses once the document isn't focused:
"Document is not focused"), so the page encodes the PNG plus a CF_DIB and Rust writes both (`clip`).
If anything was copied since the window lost focus (another app, or another editor left later whose
smaller image encoded first), Rust writes nothing and the markup stays unsaved: the newer copy wins.

## Architecture

- **Tauri 2, vanilla HTML/JS, no bundler.** `withGlobalTauri` → `window.__TAURI__.core.invoke`.
  Frontend is `src/` (served as `frontendDist`); Rust is `src-tauri/src/main.rs` (single file).
- **Option B lifecycle**: no window exists while idle — only the Rust event loop + tray + watcher.
  Each snip creates a WebView2 window; when the last closes, WebView2's processes exit. Option A
  (pre-loaded hidden window, ~100 MB idle, near-instant) is the fallback if B feels laggy.
- **Rust ↔ page contract** (app commands; no capabilities file needed):
  - `shot` (async) → raw bytes of this window's image (`Shots` map: window label → path). Waits for the
    PNG `IEND` / JPEG `FFD9` end marker first (watcher-created files only; Open with reads at once), so the window starts loading while Snipping Tool is
    still writing.
  - `ready(img, chrome, min)` → size/position/show. `img` = capture in image px; `chrome`, `min` in CSS px
    (Rust scales them by the target monitor's scale, not the hidden window's).
  - `save` → body = encoded bytes, header `ext` ∈ png|jpg|pdf. Rust shows the Windows Save dialog
    (`rfd`, parented to the editor), suggests `<image stem>.<ext>`, writes `<name>.part` then renames.
    Returns the file name or null on cancel.
  - `close` → destroy the window.
  - `dirty(d)` → this editor has unsaved work (see Settings). `clip` → body = PNG then CF_DIB, header
    `png` = the PNG's length; false when a newer copy happened (see Settings).
  - Settings window: `settings` → [settings, hotkey registered, Start at login on]; `set_settings(s)` →
    hotkey registered; `login` → flips Start at login, returns the real state.
  - Page name: the URL hash carries the image stem (percent-encoded), used for `document.title`.
- **Editor = JustSave's** (`markup.js`, `pdf.js` unchanged; `editor.js`/`index.html` from
  `result.js`/`result.html` at JustSave `5cece1b`). Shapes: highlighter, pen, line, arrow, rect, ellipse,
  cloud, text, callout; filled box redacts (burned in on every export); crop; zoom; Save (PNG/JPG/PDF),
  Copy (PNG, `navigator.clipboard.write`), Print (`print()` of the burned-in PNG). JustMark-only
  changes: capture comes from `invoke('shot')` (JPEG normalized to PNG at load), always in markup
  (JustSave's Markup toggle is gone), Ctrl+S/Ctrl+C, Esc-to-close, no browser context menu (except in
  the text editor), and the UI below.
- **UI layout** (redesign 2026-10-12, `index.html` only; no framework, no icon font — inline SVG sprite):
  - *Top bar*: tool segment (each tool has a one-letter key in `data-key`, which is also the binding:
    V H P L A R E C T B; X = Crop) · Crop · Undo / Redo · Copy · Save split button. Save's
    label shows the format Ctrl+S will write; its ▾ opens a popover (Format, Quality for JPG/PDF, Print).
  - *Style dock* (floating, bottom center): only what applies to the selected shape, else the current
    tool (`KINDS` in editor.js → `#props[data-k]`); hidden for Select with nothing selected. While
    cropping it becomes the crop bar (hint, Reset, Cancel, Apply).
  - *Zoom pill* (bottom right): −, % (click = actual size), +, Fit, Fit width.
  - *Status* is a toast above the dock; Saved/Copied fade after 2.5 s, errors stay until clicked.
  - Theme: system light/dark via `light-dark()` tokens on `:root`; violet accent so UI state never looks
    like ink (no swatch is violet). Tooltips are CSS (`aria-label` + `data-tip`), not `title`.
- **Tests**: `node test.mjs` (markup/pdf/editor tests carried from JustSave + JustMark's); `cargo test`
  in `src-tauri` (end-marker wait).

## Budgets (measured 2026-10-12, release build, Win 11, WebView2 154)

| | measured |
|---|---|
| Idle (tray only, no window) | 1.6–4.4 MB private working set (2026-10-13 with Settings + hotkey: 1.6 MB at start, 3.9 MB after the settings window or editors closed) |
| One editor window open | ~100–105 MB private WS (7 processes) |
| Watcher event → window shown | 0.44–0.60 s |
| Mouse-up → file created (Snipping Tool) | ~150–190 ms (clipboard is ~80–100 ms) |

So mouse-up → editor visible ≈ 0.6–0.8 s. Regressions past ~1 s or idle past ~10 MB need a reason.

## Editor features (decided 2026-10-13, not built yet)

- **Style per tool, remembered** (built). Each tool keeps its own colors, weight, fill/pattern, see-through and
  text size; restyling a selected shape updates its tool's style. Kept in localStorage (`style.<tool>`, screen px; shared by every
  editor window, like Save's format), so it carries to the next shape and the next window.
- **Weight − value +** replaces Thin/Medium/Thick: 1–16 screen px, step 1, default 4, for every tool
  with a weight (highlighter keeps its 4× drawn width; callout border). Holding − or + repeats: one step,
  then after 400 ms ~12 steps/s until release or the pointer leaves. Text size's −/+ repeat the same way.
  A held run on a selected shape is one undo step.
- **Callout tail stays drawn while its text is being typed** (built): the box and tail follow the editor live.
- **Polygon (G):** click adds a point; double-click, Enter or clicking the first point closes; Backspace
  drops the last point; Esc cancels the polygon in progress. Shift snaps the next edge to 45°. Weight,
  Fill and patterns as rect.
- **Fill = split button** (rect, ellipse, cloud, polygon; not the callout box). Click toggles the tool's
  last fill; ▾ opens a popover: none, solid, 13 patterns, and a density slider that scales every
  pattern's spacing. Patterns (SVG `<pattern>` in the fill color): `///`, `\\\`, `|||`, `===`, `###`
  grid, `×××` diagonal crosshatch, halftone light/medium/heavy (~15/35/60% dot coverage, by dot size),
  herringbone, running bond brick, checkerboard. The user will prune what proves useless.
- **See-through toggle** (pen, line, arrow, rect, ellipse, cloud, polygon; not text/callout): the whole
  shape at 40% opacity, as a group so a stroke over its own fill doesn't double. Same as the highlighter.
- **Covering, not redaction:** every export is flattened, so any opaque markup covers what's under it
  for good. See-through shapes and patterns don't. Fill's tooltip says "covers what's under it in every
  export" instead of naming black boxes.
- **Color targets:** a Line · Fill · Text segmented picker before the one swatch row; swatches set the
  chosen target and the picker shows each target's color. Callout: line (border + tail), fill (box,
  today #fff), text (today #111). Text: text + optional background fill. Rect, ellipse, cloud, polygon:
  Line · Fill, fill defaulting to the line color. The Fill target adds a "none" swatch.
- **Re-croppable crop** (built): a crop is a view of the original capture, never destructive. Crop again shows
  the whole original with the current crop as the box; the crop bar is Reset (whole capture) · Cancel ·
  Apply; each applied crop is one undo step. The Undo crop button goes.

## Explorer right-click (decided 2026-10-13, not built yet)

- Classic verb **JustMark** on png, jpg, jpeg, bmp, gif, webp:
  `HKCU\Software\Classes\SystemFileAssociations\.<ext>\shell\JustMark\command` = `"<exe>" "%1"`. The app
  writes it per a Settings toggle (on by default) and re-points it at startup, like Start at login. On
  Windows 11 it shows under Show more options. File associations get bmp/gif/webp too; the watcher stays
  png/jpg/jpeg. Revisit (NSIS uninstall hook, install-time option) once there's an installer.

## Non-goals

Own capture overlay; taking over Win+Shift+S; MSIX packaging / `ms-screenclip` redirect (only if the
folder watch proves unreliable); Electron/.NET. Native Rust (egui or Win32+Direct2D, resvg for export)
stays the fallback only if idle memory becomes a problem — with B it hasn't.
