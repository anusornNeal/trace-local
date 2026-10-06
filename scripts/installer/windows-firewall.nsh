!macro customInstall
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer\windows-firewall.ps1" -Action install -ProgramPath "$INSTDIR\Trace Local.exe" -ProxyPort 8888 -CaPort 8889'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer\windows-firewall.ps1" -Action uninstall -ProgramPath "$INSTDIR\Trace Local.exe" -ProxyPort 8888 -CaPort 8889'
!macroend
