# IPC permission inventory

The `main` WebView receives only the core window/event permissions in
`src-tauri/capabilities/default.json`. Application commands are grouped as follows:

- Read: `fs_list`, `fs_homedir`, `fs_drives`, `fs_is_dir`, `sites_list`,
  `sites_has_legacy_secret`, `sites_has_plaintext_secret`, `settings_get`, `tabs_get`,
  `vault_status`, `app_version`, `session_list`, `updater_check`.
- Write: `fs_mkdir`, `fs_rename`, `fs_copy_file`, `fs_create_file`, `sites_save`,
  `sites_save_folder`, `sites_apply_layout`, `settings_set`, `tabs_set`, `proxy_test`,
  session/transfer commands, logging, notifications and tray labels.
- Delete: `sites_delete`, `sites_delete_folder`, `tabs_clear`, `session_delete`.
- Vault management: `vault_setup`, `vault_unlock`, `vault_lock`, system-unlock commands,
  `vault_change_password`, `vault_use_system_protection`.
- Ordinary list/edit IPC returns only secret-presence flags. Explicit reveal commands require a one-use confirmation token; Stronghold mode additionally requires master-password reauthentication before the token is issued.
- Local path operations: `fs_reveal_path`, `fs_open_document`,
  `fs_execute_path`, `open_with_start`.
- Import/export: `app_import_settings`, `app_export_settings`.

The highest-risk commands (secret reveal, `vault_reset`, `fs_delete`, local
path operations, and settings import/export) live in the inlined `sensitive`
plugin. Its ACL is generated from `build.rs`; the main window has only the
individual command permissions. Every call requires a 30-second, one-use
backend token bound to the `main` window, exact operation, and canonical local
path (or exact logical target).

Secret reveal, vault reset, and executable content use an isolated backend-owned
confirmation window when required. Vault reset is always confirmed; secret
reveal also reauthenticates a configured Stronghold vault. Delete,
reveal-in-Explorer, ordinary document open, and import/export do not always
show a confirmation, so the token is a binding/replay control rather than proof
of user presence for those operations. Their path, schema, protected-target,
and native-dialog invariants are enforced independently in Rust.

Confirmation windows match `security-confirmation-*` and receive a separate capability
that can only read their own pending prompt and answer it. They cannot invoke the
sensitive operation, and the main window cannot invoke their approve command.

Calling an old top-level command cannot reach these handlers. Calling the plugin
without a valid token, from another window, for another target, after expiry, or a
second time returns `PermissionDenied`.
