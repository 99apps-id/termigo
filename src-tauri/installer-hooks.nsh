; "Open in Termigo" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTermigo" "" "Open in Termigo"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTermigo" "Icon" '"$INSTDIR\termigo.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTermigo" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTermigo\command" "" '"$INSTDIR\termigo.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTermigo" "" "Open in Termigo"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTermigo" "Icon" '"$INSTDIR\termigo.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTermigo" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTermigo\command" "" '"$INSTDIR\termigo.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTermigo" "" "Open in Termigo"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTermigo" "Icon" '"$INSTDIR\termigo.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTermigo" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTermigo\command" "" '"$INSTDIR\termigo.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInTermigo"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInTermigo"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInTermigo"
!macroend
