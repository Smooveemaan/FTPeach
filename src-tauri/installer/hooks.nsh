; NSIS hooks for the FTPeach installer.
;
; The Tauri uninstaller already offers a "delete the application data" checkbox
; on its confirm page, but the built-in cleanup only covers
; $APPDATA\<bundle id> and $LOCALAPPDATA\<bundle id>. FTPeach keeps settings,
; sites, known hosts, the saved session, logs and the password vault under
; %APPDATA%\FTPeach (see docs/storage.md), so leaving the checkbox to the
; template would tick a box that removes nothing the user cares about.
;
; The updater also keeps a downloaded installer under
; $LOCALAPPDATA\<bundle id>\updates until the next launch installs it. That
; belongs to the installation rather than to the user, so a real uninstall
; removes it whether or not the box is ticked.
;
; $DeleteAppDataCheckboxState and $UpdateMode are declared by the Tauri
; installer template; this macro is expanded inside its `Section Uninstall`,
; after the template's own app-data cleanup.

!macro NSIS_HOOK_POSTUNINSTALL
  ; An updater-driven uninstall runs while that very installer may be the
  ; file in the updates directory, and the new version clears it on launch.
  ${If} $UpdateMode <> 1
    SetShellVarContext current
    RMDir /r "$LOCALAPPDATA\${BUNDLEID}\updates"
  ${EndIf}

  ; The toast identity FTPeach registers at startup so Windows can put its
  ; name and icon on a notification (see runtime/notification.rs). It belongs
  ; to the installation, not to the user's data, and an update re-registers it
  ; on the next launch.
  ${If} $UpdateMode <> 1
    DeleteRegKey HKCU "Software\Classes\AppUserModelId\${BUNDLEID}"
  ${EndIf}

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
