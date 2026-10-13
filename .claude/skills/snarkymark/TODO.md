# TODO

- [ ] User: turn off Snipping Tool notifications (Settings → System → Notifications) so its toast doesn't
      compete with snarkymark; keep "Automatically save screenshots" on.
- [ ] Verify "Start at login" toggle by hand (not exercised in automation, to avoid writing HKCU Run).
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
