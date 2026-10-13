<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logos/justMark_logo_dark.png">
    <img alt="justMark" src="assets/brand/logos/justMark_logo_light.png" width="420">
  </picture>
</p>

A lightweight screenshot markup editor for Windows 11. It replaces the Snipping Tool's **editor**, not its capture:
Win+Shift+S and PrtScn work as always, and every snip opens in justMark, ready to mark up.

- **Every snip opens on its own.** Snip, mark it up, Copy or Save, Esc.
- **Still on the clipboard.** Just pasting into an email? Snip, paste, Esc.
- **Light.** Idle, it's a tray icon using about 2–4 MB of RAM; no window exists until a snip arrives. Mouse-up to editor on screen is under a second.

## Requirements

- Windows 11 with the WebView2 runtime (built in).
- Snipping Tool's **Automatically save screenshots** turned on (Snipping Tool > Settings). justMark watches the
  Screenshots folder for new snips; it follows the folder if it moves (e.g. OneDrive backup of Pictures).

## Editing

| Tool | Key | | Tool | Key |
|---|---|---|---|---|
| Select | V | | Ellipse | E |
| Highlighter | H | | Cloud | C |
| Pen | P | | Polyline / Polygon | G |
| Line | L | | Text | T |
| Arrow | A | | Callout | B |
| Rectangle | R | | Crop | X |

- **Ctrl+S** saves (PNG, JPG or PDF; the Save button shows which), **Ctrl+C** copies a PNG, Print is under Save's ▾.
- **Ctrl+Z / Ctrl+Y** undo and redo. **Esc** steps back (cancel crop, finish text, deselect), then closes; it asks
  first if there's markup you haven't saved or copied.
- Each tool remembers its own style: line, fill and text colors, weight, fill pattern, see-through opacity.
- Fills come solid or in patterns (hatches, grid, halftones, brick, checkerboard…) with a density slider.
- Crop is never destructive: crop again to see the whole capture and adjust, or Reset.
- Markup is burned into every export, so an opaque shape covers what's under it for good.

## Other ways in

- **Open with** justMark, or **right-click an image > justMark** in Explorer (Windows 11: under Show more options).
  Works for png, jpg, bmp, gif and webp.
- **Shift+Alt+S** reopens the most recent snip.

## Settings

Right-click the tray icon > **Settings…**. Changes apply at once.

| Setting | Default | |
|---|---|---|
| Auto open on snip | on | Off: snips just land in the folder. |
| Open latest snip | Shift+Alt+S | Global hotkey; record another, or clear it. |
| New snip opens a new window | on | Off: the snip goes into the last-used editor unless it has unsaved markup. |
| Max windows | 5 | One more closes the oldest, preferring one without unsaved markup. |
| Auto copy on focus loss | off | Leaving an editor with unsaved markup copies it. |
| Right-click "justMark" in Explorer | on | |
| Start at login | off | |

Settings are kept in `%APPDATA%\io.github.justmark\settings.json`.

## Building

Needs [Node.js](https://nodejs.org) and [Rust](https://rustup.rs).

```sh
npm install
npx tauri build --no-bundle   # → src-tauri/target/release/justmark.exe
```

`build-release.cmd` does the same with a double-click: quits the running tray, builds, starts the new exe.
Drop `--no-bundle` for an NSIS installer, which also registers the file associations.

Tests: `node test.mjs` (editor) and `cargo test` in `src-tauri` (Rust side).

## How it's built

Tauri 2 with a vanilla HTML/JS editor, no bundler, no framework. The Rust side (`src-tauri/src/main.rs`) owns
the tray, the folder watcher, windows and file I/O; the editor (`src/`) is an SVG markup editor shared with
JustSave. Each snip gets its own window, and when the last one closes, WebView2's processes exit, which is why idle
memory stays tiny.
