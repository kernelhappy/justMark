# Tried and failed

- **`showSaveFilePicker` in Tauri's WebView2 (2026-10-12, WebView2 154).** Works in principle, but the
  native dialog is titled **"Warning: this site can see edits you make"**, and on the first attempt the
  picker went "active" (later calls: "File picker already active") with no dialog window anywhere.
  Replaced by the Rust `save` command (rfd). `navigator.clipboard.write` and `print()` work fine.
- **UIAutomation patterns on the Save dialog (test harness only).** From Windows PowerShell 5.1 every
  control showed as Pane with no Value/Invoke pattern; driving it with WM_SETTEXT + BM_CLICK to the
  controls' HWNDs works.
