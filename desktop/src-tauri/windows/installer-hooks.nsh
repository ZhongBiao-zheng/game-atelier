; Tauri NSIS hooks (docs/contracts/desktop-shell.md). The runtime root lives outside $INSTDIR,
; so the stock uninstaller neither stops its Python processes nor removes it.

!macro NSIS_HOOK_PREUNINSTALL
  ; The uninstaller only stops the shell's own exe; the server is a separate python.exe that
  ; keeps runtime files locked. Stop only processes started from this runtime root, never a
  ; server run by the zip bundle or the scheduled task.
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$root = Join-Path $$env:LOCALAPPDATA 'game-atelier\runtime'; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$root, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Not for the Tauri updater (unused). A GUI reinstall also runs this uninstaller first, so the
  ; next launch re-extracts the newer installer's seed. The data root is never touched.
  ${If} $UpdateMode <> 1
    RMDir /r "$LOCALAPPDATA\game-atelier\runtime"
  ${EndIf}
!macroend
