!macro customCheckAppRunning
  !insertmacro nsProcess::FindProcess "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    DetailPrint `Closing ${PRODUCT_NAME} and its background processes.`
    nsExec::Exec `"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}"`
    Pop $0
    Sleep 1000

    StrCpy $R1 0
    customCloseChatTarayiciLoop:
      nsExec::Exec `"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
      Pop $0
      Sleep 500
      !insertmacro nsProcess::FindProcess "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 0
        IntOp $R1 $R1 + 1
        ${if} $R1 < 2
          Goto customCloseChatTarayiciLoop
        ${endif}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY customCloseChatTarayiciLoop
        Quit
      ${endif}
  ${endif}
!macroend
