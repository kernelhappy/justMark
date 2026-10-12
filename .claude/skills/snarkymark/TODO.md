# TODO

- [ ] User: live with B for a while; if 0.6–0.8 s feels laggy, build A (pre-loaded hidden window) and re-measure.
- [ ] User: turn off Snipping Tool notifications (Settings → System → Notifications) so its toast doesn't
      compete with snarkymark; keep "Automatically save screenshots" on.
- [ ] Verify "Start at login" toggle by hand (not exercised in automation, to avoid writing HKCU Run).
- [ ] Unsaved markup on window X close isn't protected (Esc is). Add a CloseRequested guard if it bites.
- [ ] Very large snips: end-marker wait has a 5 s cap; unmeasured for 4K multi-monitor snips.
- [ ] Default tool is Select (as in JustSave); consider starting on Arrow/Rect if the first drag doing
      nothing feels wrong.
- [ ] Real app icon (current one is a placeholder drawn with System.Drawing).
- [ ] `tauri build` (NSIS installer) not yet run; file associations untested until installed.
