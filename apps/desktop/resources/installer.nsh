; Omega NSIS hooks (legacy; native installer uses scripts/native-installer.nsi). ASCII only.
; IMPORTANT: do not use $env:... in strings — NSIS treats $ as variable syntax (use $$ for PowerShell $).

!ifndef BUILD_UNINSTALLER
  !define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE OmegaInstFilesPre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW OmegaInstFilesShow

  Function OmegaInstFilesPre
    SetDetailsPrint both
  FunctionEnd

  Function OmegaInstFilesShow
    SetDetailsPrint both
  FunctionEnd
!endif

!macro omegaKillBundledChildren
  DetailPrint "Omega Setup: stopping Omega and background services..."
  nsExec::ExecToLog 'taskkill /IM Omega.exe /T'
  Pop $0
  Sleep 500
  nsExec::ExecToLog 'taskkill /IM Omega.exe /F /T'
  Pop $0
  nsExec::ExecToLog 'taskkill /IM omega-runtime.exe /F /T'
  Pop $0
  nsExec::ExecToLog 'taskkill /IM omega-ollama.exe /F /T'
  Pop $0
  nsExec::ExecToLog 'taskkill /IM omega-infer.exe /F /T'
  Pop $0
  nsExec::ExecToLog 'taskkill /IM llama-server.exe /F /T'
  Pop $0
  ; Python / Omega under default install roots (no $env: — NSIS-safe PowerShell)
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $$roots = @([IO.Path]::Combine([Environment]::GetFolderPath(''LocalApplicationData''), ''Programs'', ''Omega'')); $$pf = [Environment]::GetFolderPath(''ProgramFiles''); if ($$pf) { $$roots += [IO.Path]::Combine($$pf, ''Omega'') }; foreach ($$root in $$roots) { if (Test-Path $$root) { Get-CimInstance Win32_Process -EA 0 | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$root, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -EA 0 } } } }"'
  Pop $0
  StrCmp $INSTDIR "" +3 0
  nsExec::ExecToLog "powershell -NoProfile -ExecutionPolicy Bypass -Command \"Get-CimInstance Win32_Process -EA 0 | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -EA 0 }\""
  Pop $0
  Sleep 2000
!macroend

; customInit runs once in .onInit (do not also use preInit — duplicate labels).
!macro customInit
  !insertmacro omegaKillBundledChildren
!macroend

!macro customUnInit
  !insertmacro omegaKillBundledChildren
!macroend

; Do not define customCheckAppRunning — it breaks NSIS GetProcessInfo includes.
; preInit + customInit run omegaKillBundledChildren before install/close.

!macro customUnInstallCheck
  DetailPrint "Omega Setup: previous uninstall finished (or skipped); continuing upgrade."
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro customUnInstallCheck
!macroend

!macro customInstall
  DetailPrint " "
  DetailPrint "  OMEGA - Local AI Operating System"
  DetailPrint " "
  DetailPrint "[ok] Omega desktop files deployed"
  DetailPrint "[ok] Inference runtime registered"
  DetailPrint "[ok] Content Studio bundle linked"
  DetailPrint "[ok] Claw3D office resources (if bundled)"
  DetailPrint "[>>] Finalizing shortcuts and registry..."
!macroend
