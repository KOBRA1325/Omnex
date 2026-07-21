; Omnex uninstall cleanup
; Removes all leftover files after the standard uninstaller runs

!macro customUnInstall
  ; Remove everything left in the install directory
  RMDir /r "$INSTDIR"

  ; Remove Start Menu folder if empty
  RMDir "$SMPROGRAMS\Omnex"

  ; Remove desktop shortcut
  Delete "$DESKTOP\Omnex.lnk"

  ; Remove registry entries
  DeleteRegKey HKCU "Software\Omnex"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\omnex"
!macroend
