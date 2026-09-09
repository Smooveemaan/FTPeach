; NSIS hooks for the FTPeach installer.
;
; The Tauri uninstaller already offers a "delete the application data" checkbox
; on its confirm page, but the built-in cleanup only covers
; $APPDATA\<bundle id> and $LOCALAPPDATA\<bundle id>. FTPeach keeps settings,
; sites, known hosts, the saved session, logs and the password vault under
; %APPDATA%\FTPeach (see docs/storage.md), so leaving the checkbox to the
; template would tick a box that removes nothing the user cares about.
;
; $DeleteAppDataCheckboxState and $UpdateMode are declared by the Tauri
; installer template; this macro is expanded inside its `Section Uninstall`,
; after the template's own app-data cleanup.

!macro NSIS_HOOK_POSTUNINSTALL
  ; Unticked, or an updater-driven uninstall: keep the user's data. A silent
  ; uninstall (/P) skips the confirm page entirely, so the state stays empty
  ; and compares as 0 -- data is kept unless somebody asked for it to go.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; The template switches to the per-user context for the same reason: the
    ; data lives in the roaming profile, not in the all-users location.
    SetShellVarContext current
    RMDir /r "$APPDATA\FTPeach"
  ${EndIf}
!macroend
