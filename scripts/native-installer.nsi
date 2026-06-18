; Omega native desktop installer (WebView2 shell — no Electron).
; Build: node scripts/package-native-installer.mjs

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define APP_NAME "Omega"
!define APP_PUBLISHER "Omega"
!define APP_EXE "omega-desktop.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Omega"

; Version passed by /DPRODUCT_VERSION=...
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.1.0"
!endif

Name "${APP_NAME}"
OutFile "..\dist\native\Omega-${PRODUCT_VERSION}-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\Omega"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel user
Unicode true
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "${APP_NAME} Setup"
!define MUI_WELCOMEPAGE_TEXT "Install ${APP_NAME} — local AI operating system (native WebView2 shell).$\r$\n$\r$\nExisting Omega processes will be stopped before files are copied."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

!macro KillOmegaProcessesBody
  DetailPrint "Stopping Omega and bundled services..."
  ExecWait 'taskkill /IM omega-desktop.exe /T' $0
  ExecWait 'taskkill /IM omega-desktop.exe /F /T' $0
  ExecWait 'taskkill /IM omega-runtime.exe /F /T' $0
  ExecWait 'taskkill /IM omega-ollama.exe /F /T' $0
  ExecWait 'taskkill /IM omega-infer.exe /F /T' $0
  ExecWait 'taskkill /IM llama-server.exe /F /T' $0
  ExecWait 'taskkill /IM Omega.exe /F /T' $0
  Sleep 1500
!macroend

Function KillOmegaProcesses
  !insertmacro KillOmegaProcessesBody
FunctionEnd

Function un.KillOmegaProcesses
  !insertmacro KillOmegaProcessesBody
FunctionEnd

Section "Omega" SecMain
  SetOutPath "$INSTDIR"
  Call KillOmegaProcesses

  File /r "..\dist\native\Omega\*.*"

  CreateDirectory "$SMPROGRAMS\Omega"
  CreateShortCut "$SMPROGRAMS\Omega\Omega.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\icon.ico" 0
  CreateShortCut "$DESKTOP\Omega.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\icon.ico" 0

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$INSTDIR\Uninstall Omega.exe"
  WriteUninstaller "$INSTDIR\Uninstall Omega.exe"
SectionEnd

Section "Uninstall"
  Call un.KillOmegaProcesses
  Delete "$DESKTOP\Omega.lnk"
  Delete "$SMPROGRAMS\Omega\Omega.lnk"
  RMDir "$SMPROGRAMS\Omega"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd

Function .onInit
  Call KillOmegaProcesses
FunctionEnd

Function un.onInit
  Call un.KillOmegaProcesses
FunctionEnd
