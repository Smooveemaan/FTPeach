# IPC permission inventory

Every command the application registers is named in `build.rs`, which gives
Tauri an application manifest for them. Without that manifest Tauri leaves app
commands unpermissioned, and an unpermissioned command is reachable from every
window of the application. With it, each window reaches only what its capability
file grants: the `main` WebView receives the core window/event permissions and one
`allow-` permission per app command in `src-tauri/capabilities/default.json`, and
the confirmation window receives neither.

`npm run check:command-acl` compares the registered commands, the `build.rs`
lists and both capability files, so a new command cannot ship until someone
decides which window class may call it. The packaged smoke test then asks a live
confirmation window which commands it can still reach, and fails if it reaches
any. Application commands are grouped as follows:

Shutdown sends `app:flush-state` only to `main`. The acknowledgement command
`app_state_flushed` checks the invoking window label and the currently pending UUID;
it cannot initiate shutdown or change settings. Missing/failed replies are logged
after a three-second deadline when quitting, or a 400 ms one before hiding to the
tray, where nothing is lost by giving up on the handshake. The handler is installed before the main UI mounts.

- Read: `fs_list`, `fs_homedir`, `fs_drives`, `fs_is_dir`, `sites_list`,
  `sites_has_legacy_secret`, `sites_has_plaintext_secret`, `settings_get`, `tabs_get`,
  `vault_status`, `app_version`, `session_list`, `updater_status`, `updater_check`.
- Write: `fs_mkdir`, `fs_rename`, `fs_copy_file`, `fs_create_file`, `sites_save`,
  `sites_save_folder`, `sites_apply_layout`, `settings_set`, `tabs_set`, `proxy_test`,
  session/transfer commands, logging, notifications, `tray_set_model`, `tray_hide_window`
  and `app_quit`, which quits without asking about running transfers and without hiding to
  the tray; the window calls it for File → Exit when nothing is running, or once it has
  asked.
- Events to the renderer: `tray:action` goes only to the `main` window when a tray menu item
  is clicked. The backend maps the item ID to an action through its copy of the last
  `tray_set_model` model, so the payload never carries text read from the menu; the renderer
  runs the action through the same functions as the window's own controls. A speed limit
  comes from the model's presets and a connection names a saved site by the ID the model
  gave it; the renderer connects only to a site it still has. The backend
  also sends `quitRequested` when a quit from the tray or the window close button finds
  transfers running; if no model saying the question is open arrives within 10 seconds,
  it quits anyway, so a renderer that cannot answer never makes quitting impossible.
- Delete: `sites_delete`, `sites_delete_folder`, `tabs_clear`, `session_delete`.
- Vault management: `vault_setup`, `vault_unlock`, `vault_lock`, system-unlock commands,
  `vault_change_password`. `vault_use_system_protection` lives in the `sensitive` plugin and
  needs a token issued only after the confirmation window verified the master password.
  `vault_note_activity` takes no argument and only records that the window has seen the
  user; it can postpone the backend's idle lock but cannot disable it, and it has no effect
  on the lock that follows a Windows session lock or a hidden window.
- Ordinary list/edit IPC returns only secret-presence flags. Explicit reveal commands require a one-use confirmation token; Stronghold mode additionally requires master-password reauthentication before the token is issued.
- Local path operations: `fs_reveal_path`, `fs_open_document`,
  `fs_execute_path`, `open_with_start`.
- Open-with bookkeeping: `open_with_stop` and `open_with_mark_synced` (which records that the
  named revision of an open-with copy was uploaded) take only the ID the copy was opened
  under; an unknown ID or malformed revision changes nothing.
  `open_with_recovered_edits`, `open_with_reveal_recovered_edits` and
  `open_with_discard_recovered_edits` act only on the backend-owned recovery folder and
  accept no path from the renderer.
- Import/export: `app_import_settings`, `app_export_settings`.
- SSH host keys: `session_trust_host_key` lives in the `sensitive` plugin. Its token names
  the host, the port, the fingerprint trusted until now and the one being trusted, and the
  backend writes the new pin only if the stored one is still what the token named. There is
  no command that deletes a pin.
- Security settings: `settings_set_security` is the only command that applies
  `showSecurityConfirmations`, `vaultAutoLockMinutes` and `strictHostKeyCheck`, and it also carries the proxy's
  type, host, port, account and password; `settings_set` rejects a patch that would relax
  either setting or move the saved proxy password, and an import keeps the current values.
- Bookmarks: `sites_save` lives in the `sensitive` plugin. Its token names the bookmark and
  any move of its saved password to a new server, port, account or TLS policy; such a move
  is confirmed in the backend window first.

The highest-risk commands (secret reveal, `vault_reset`, `fs_delete`, local
path operations, and settings import/export) live in the inlined `sensitive`
plugin. Its ACL is generated from `build.rs`; the main window has only the
individual command permissions. Every call requires a one-use backend token
bound to the `main` window, exact operation, and canonical local path (or exact
logical target). A token lives 30 seconds, except a `settings_set_security`
token, which lives 15 minutes: the settings dialog confirms a relaxed
protection when the user makes the change and applies it only on Save.

Secret reveal, vault reset, and executable content use an isolated backend-owned
confirmation window when required. Vault reset and relaxing security settings are
always confirmed; secret reveal and relaxing security settings also reauthenticate a
configured Stronghold vault. An Open with token names the connection, remote path, local
name and program, and a program not chosen before is confirmed on first use. Unused
tokens are withdrawn when the security policy changes, and tokens issued before the
vault was last locked are refused. Delete,
reveal-in-Explorer, ordinary document open, and import/export do not always
show a confirmation, so the token is a binding/replay control rather than proof
of user presence for those operations. Their path, schema, protected-target,
and native-dialog invariants are enforced independently in Rust.

Confirmation windows match `security-confirmation-*` and receive a separate capability
that can only read their own pending prompt and answer it. They cannot invoke the
sensitive operation, no application command and no other plugin command, and the main
window cannot invoke their approve command.

Calling an old top-level command cannot reach these handlers. Calling the plugin
without a valid token, from another window, for another target, after expiry, or a
second time returns `PermissionDenied`.
