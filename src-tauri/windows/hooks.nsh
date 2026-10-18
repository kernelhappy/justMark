; Uninstall drops the right-click verb the app writes under HKCU. The app re-writes it at start, so an
; upgrade that uninstalls first loses nothing. The Start-at-login Run entry is left alone: an upgrade
; that uninstalls first would otherwise turn it off for good.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.png\shell\JustMark"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.jpg\shell\JustMark"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.jpeg\shell\JustMark"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.bmp\shell\JustMark"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.gif\shell\JustMark"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.webp\shell\JustMark"
  ${EndIf}
!macroend
