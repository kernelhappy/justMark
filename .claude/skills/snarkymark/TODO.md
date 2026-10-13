# TODO

- [ ] Rename snarkymark → JustMark (product name, identifier, tray tooltip, skill/memory names, repo) once
      Settings merges. A new identifier moves the config dir and WebView2 data (settings, localStorage reset).
- [ ] User: turn off Snipping Tool notifications (Settings → System → Notifications) so its toast doesn't
      compete with snarkymark; keep "Automatically save screenshots" on.
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
