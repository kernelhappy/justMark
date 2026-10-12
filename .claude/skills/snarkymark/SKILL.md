---
name: snarkymark
description: Spec for snarkymark, a lightweight Windows screenshot markup editor (Tauri 2 tray app + JustSave's vanilla-JS SVG editor). Load before changing how snips get in, window/tray lifecycle, the editor port, Save/Copy/Print, or anything that affects startup time or idle memory.
---

# snarkymark — spec

Replaces the Windows Snipping Tool's **editor**, not its capture. Win+Shift+S / PrtScn keep taking the
screenshot; snarkymark opens every snip for markup. Lightness is the point: measure startup and idle RAM
when changing anything structural (see Budgets).

## Behavior

- **Every snip opens the editor automatically.** Snipping Tool's auto-save must be on; the tray process
  watches the Screenshots known folder (`FOLDERID_Screenshots`, follows moves/OneDrive) for **file
  creations** of `.png/.jpg/.jpeg`. Renames and modifications are ignored on purpose (see Save).
- The snip is still on the clipboard, so the "just paste into an email" case is: snip, paste, Esc.
- **Esc**: steps back (cancel crop / finish text / drop selection / back to Select), and with nothing left
  to step back from, closes the editor. If markup or a crop exists that hasn't been Saved or Copied since,
  it asks first (`confirm`). The window's X closes without asking (explicit act).
- One window per image. It opens hidden, the page loads the image, then asks Rust to size it (image at
  actual size + chrome, min 960×480 CSS px, max 90% of the work area) on the monitor under the cursor,
  center it there and show it.
- **Open with / second launch**: argv files go to the running instance (single-instance plugin) and open
  like a snip. The NSIS bundle registers png/jpg/jpeg as "Editor" associations.
- **Tray**: "Start at login" (HKCU Run entry via autostart plugin, off by default) and "Quit". Closing the
  last window never exits the process; only Quit does.

## Architecture

- **Tauri 2, vanilla HTML/JS, no bundler.** `withGlobalTauri` → `window.__TAURI__.core.invoke`.
  Frontend is `src/` (served as `frontendDist`); Rust is `src-tauri/src/main.rs` (single file).
- **Option B lifecycle**: no window exists while idle — only the Rust event loop + tray + watcher.
  Each snip creates a WebView2 window; when the last closes, WebView2's processes exit. Option A
  (pre-loaded hidden window, ~100 MB idle, near-instant) is the fallback if B feels laggy.
- **Rust ↔ page contract** (app commands; no capabilities file needed):
  - `shot` (async) → raw bytes of this window's image (`Shots` map: window label → path). Waits for the
    PNG `IEND` / JPEG `FFD9` end marker first, so the window starts loading while Snipping Tool is
    still writing.
  - `ready(width, height)` → size/position/show (CSS px in).
  - `save` → body = encoded bytes, header `ext` ∈ png|jpg|pdf. Rust shows the Windows Save dialog
    (`rfd`, parented to the editor), suggests `<image stem>.<ext>`, writes `<name>.part` then renames.
    Returns the file name or null on cancel.
  - `close` → destroy the window.
  - Page name: the URL hash carries the image stem (percent-encoded), used for `document.title`.
- **Editor = JustSave's** (`markup.js`, `pdf.js` unchanged; `editor.js`/`index.html` from
  `result.js`/`result.html` at JustSave `5cece1b`). Shapes: highlighter, pen, line, arrow, rect, ellipse,
  cloud, text, callout; filled box redacts (burned in on every export); crop; zoom; Save (PNG/JPG/PDF),
  Copy (PNG, `navigator.clipboard.write`), Print (`print()` of the burned-in PNG). snarkymark-only
  changes: capture comes from `invoke('shot')` (JPEG normalized to PNG at load), always in markup
  (JustSave's Markup toggle is gone), Ctrl+S/Ctrl+C, Esc-to-close, no browser context menu (except in
  the text editor), and the UI below.
- **UI layout** (redesign 2026-10-12, `index.html` only; no framework, no icon font — inline SVG sprite):
  - *Top bar*: tool segment (each tool has a one-letter key in `data-key`, which is also the binding:
    V H P L A R E C T B; X = Crop) · Crop / Undo crop · Undo / Redo · Copy · Save split button. Save's
    label shows the format Ctrl+S will write; its ▾ opens a popover (Format, Quality for JPG/PDF, Print).
  - *Style dock* (floating, bottom center): only what applies to the selected shape, else the current
    tool (`KINDS` in editor.js → `#props[data-k]`); hidden for Select with nothing selected. While
    cropping it becomes the crop bar (hint, Cancel, Apply).
  - *Zoom pill* (bottom right): −, % (click = actual size), +, Fit, Fit width.
  - *Status* is a toast above the dock; Saved/Copied fade after 2.5 s, errors stay until clicked.
  - Theme: system light/dark via `light-dark()` tokens on `:root`; violet accent so UI state never looks
    like ink (no swatch is violet). Tooltips are CSS (`aria-label` + `data-tip`), not `title`.
- **Tests**: `node test.mjs` (markup/pdf/editor tests carried from JustSave + snarkymark's); `cargo test`
  in `src-tauri` (end-marker wait).

## Budgets (measured 2026-10-12, release build, Win 11, WebView2 154)

| | measured |
|---|---|
| Idle (tray only, no window) | 1.6–4.4 MB private working set |
| One editor window open | ~100–105 MB private WS (7 processes) |
| Watcher event → window shown | 0.44–0.60 s |
| Mouse-up → file created (Snipping Tool) | ~150–190 ms (clipboard is ~80–100 ms) |

So mouse-up → editor visible ≈ 0.6–0.8 s. Regressions past ~1 s or idle past ~10 MB need a reason.

## Non-goals

Own capture overlay; taking over Win+Shift+S; MSIX packaging / `ms-screenclip` redirect (only if the
folder watch proves unreliable); Electron/.NET. Native Rust (egui or Win32+Direct2D, resvg for export)
stays the fallback only if idle memory becomes a problem — with B it hasn't.
