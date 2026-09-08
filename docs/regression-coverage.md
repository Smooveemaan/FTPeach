# Audit regression coverage

These are permanent suites included by npm test or npm run rust:test. The local audit harness asserted the old bugs; it is not an acceptance suite. P2 moved recursive execution to Rust, so backend tests now own traversal and destructive-phase assertions.

| Audit | Observable assertion | Permanent suite |
| --- | --- | --- |
| A01 | Public copy/create/mkdir/delete refuse isolated protected APPDATA; ordinary user files remain manageable | [fs command tests](../src-tauri/src/commands/fs.rs), [Windows path tests](../src-tauri/src/local_fs/filesystem_safety.rs) |
| A02 | User backup names survive; failed replacement and interrupted commit retain old destination | [transfer_file tests](../src-tauri/src/protocol/transfer_file.rs) |
| A03 | Inaccessible/deep scans and failed copy/mkdir preserve source; empty directories move successfully | [recursive transfer tests](../src-tauri/src/application/recursive_transfer/tests.rs), [scan](../src-tauri/src/application/recursive_transfer/scan.rs) |
| A04 | Self/descendant and junction targets are rejected before writes | [filesystem safety](../src-tauri/src/local_fs/filesystem_safety.rs), [recursive transfer tests](../src-tauri/src/application/recursive_transfer/tests.rs) |
| A05 | Queued/active stop and pause-stop never delete destination; failed relay does not commit staging | [frontend lifecycle](../test/component/transfers/useTransfers.test.tsx), [staging tests](../src-tauri/src/application/transfer_service_tests.rs) |
| A06 | Changed endpoint/path/version cannot adopt partial; unchanged identity resumes | [transfer_file tests](../src-tauri/src/protocol/transfer_file.rs) |
| A07 | Hardlinked artifacts cannot write their target; competing paths cannot reserve concurrently | [transfer_file tests](../src-tauri/src/protocol/transfer_file.rs), [local filesystem](../src-tauri/src/local_fs/) |
| A08 | Fixed(1) same-pool relay starts neither leg; paired stream exceeds pipe capacity; cancellation releases both workers | [transfer_pool tests](../src-tauri/src/transfer/transfer_pool.rs) |
| A09 | Replacement failure resolves all waiters and rejects closed-pool/duplicate admission | [transfer_pool tests](../src-tauri/src/transfer/transfer_pool.rs) |
| A10 | Immediate retry cannot overlap cancelling attempt; late events cannot settle replacement | [frontend lifecycle](../test/component/transfers/useTransfers.test.tsx) |
| A11 | Nested Skip preserves existing content and move source; a racing target survives no-replace commit | [recursive transfer tests](../src-tauri/src/application/recursive_transfer/tests.rs), [transfer_file tests](../src-tauri/src/protocol/transfer_file.rs) |
| A12 | Damaged, unreadable or unsupported trust state cannot pin a new key | [known_hosts tests](../src-tauri/src/store/known_hosts.rs) |
| A13 | Stalled GET body and PUT response return typed timeout | [WebDAV fixtures](../src-tauri/src/protocol/webdav_tests.rs) |
| A14 | Stalled LIST and exhausted byte/entry budgets return failure, not partial success | [FTP fixtures](../src-tauri/src/protocol/ftp_tests.rs) |
| A15 | PROPFIND 403/500 never issue empty PUT | [WebDAV fixtures](../src-tauri/src/protocol/webdav_tests.rs) |
| A16 | Invalid Windows names are rejected before constructing destinations | [filesystem safety](../src-tauri/src/local_fs/filesystem_safety.rs), [recursive manifest](../src-tauri/src/application/recursive_transfer/manifest.rs) |
| A17 | IPC/import reject invalid settings, preserve supported zero values and inherited unlimited concurrency | [settings commands](../src-tauri/src/commands/app_settings_transfer_tests.rs), [session service](../src-tauri/src/application/session_service.rs) |
| A18 | Persistence failure retains the settings draft and permits retry | [settings component suite](../test/component/settings/settingsDialog.test.tsx), [store tests](../src-tauri/src/store/tests.rs) |

A07's file-symlink fixture is ignored by default because it requires Windows Developer Mode or SeCreateSymbolicLinkPrivilege. UNC fixtures must be explicitly required with FTPEACH_REQUIRE_UNC_FIXTURES=1 to prevent an unavailable administrative share from being treated as coverage. These limitations remain separate from passing ordinary unit tests. Native and real-server outcomes are recorded in [native validation](native-validation.md).

P3 additionally ran the Windows symlink fixture explicitly and required UNC public-command fixtures successfully. The default ignored annotation remains portable to unprivileged hosts. Docker regressions now exercise foreign legacy partial preservation and real cancellation/Range resume against third-party servers.
