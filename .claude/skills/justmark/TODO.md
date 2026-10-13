# TODO

- [x] Rename snarkymark → JustMark in the app and skill (2026-10-13). A new identifier moves the config dir and
      WebView2 data (settings, localStorage reset once).
- [ ] User: rename the local repo folder, the GitHub repo and the Claude memory dir (left alone: renaming them
      breaks paths). The old `%APPDATA%\io.github.snarkymark` and `%LOCALAPPDATA%\io.github.snarkymark` can go.
- [ ] User: HKCU Run still has a `snarkymark` Start-at-login value pointing at the old `snarkymark.exe` (the old
      build is still in `target/release`). Tick Start at login in JustMark's Settings, then remove the old value
      (Task Manager → Startup apps, or `reg delete HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v snarkymark`).
- [x] Editor features and Explorer right-click built (2026-10-13, branch `feat/2026-10-13-justmark-editor`).
- [ ] Hands-on: the right-click verb in a real Explorer menu (registry entries and the command line were verified,
      the menu itself wasn't opened); a .webp opened by it (bmp and gif were).
- [ ] Prune the fill patterns that prove useless (user, after trying them).
- [ ] Turning the right-click verb off leaves an empty `shell` key per extension (harmless).
- [ ] Each applied crop's PNG stays in memory for undo; a long re-crop session on a 4K snip could add tens of MB.
- [ ] User: turn off Snipping Tool notifications (Settings → System → Notifications) so its toast doesn't
      compete with JustMark; keep "Automatically save screenshots" on.
- [ ] Verify "Start at login" (now in the Settings window) by hand (not exercised in automation, to avoid
      writing HKCU Run).
- [ ] Settings hotkey recorder can't record the combination that is registered now (Windows delivers it as the
      hotkey, which opens the latest snip). Unregister while recording if this bites.
- [ ] Auto copy of a very large snip takes a moment to encode; a paste within that moment gets the old clipboard.
- [ ] Unsaved markup on window X close or tray Quit isn't protected (Esc is). Add a CloseRequested guard if
      it bites.
- [ ] Real-app check, not exercised: DPI sizing on a second monitor with a different scale (only one
      monitor, 150%, verified 2026-10-13); the early `onerror` show; a Screenshots folder Location > Move
      while running.
- [ ] Very large snips: end-marker wait has a 5 s cap; unmeasured for 4K multi-monitor snips.
- [ ] Default tool is Select (as in JustSave); consider starting on Arrow/Rect if the first drag doing
      nothing feels wrong.
- [ ] Real app icon (current one is a placeholder drawn with System.Drawing).
- [ ] `tauri build` (NSIS installer) not yet run; file associations untested until installed.
