# Verification matrix

Green mock and component suites do not prove how real servers, NTFS, UNC
shares, Explorer, Windows Hello or the installer behave. This page lists what
each lane proves, which checks the default run skips and why, and what a
release has to record by hand. A check that could not run counts as NOT RUN,
never as a pass.

## Lanes

| Lane | Runs | Where |
| --- | --- | --- |
| default | `npm run check` (Rust: `npm run rust:check`, `npm run rust:clippy`, `npm run rust:test`) | every push, CI `rust-test` and `lint-test-build` on Windows |
| compatibility | `src-tauri/tests/docker/docker-compose.yml`, then `scripts/with-libsodium.ps1 -Command compatibility` | CI `protocol-compatibility`: weekly, on Cargo changes and as a release gate |
| server matrix | `npm run servers:up -- all`, then `npm run servers:test` ([how](test-server-matrix.md)) | CI `server-matrix`: weekly and on demand, by profile, not a gate; by hand before a release; IIS targets need `scripts/test-servers/iis.ps1 install` |
| packaged smoke | `npm run build:packaged-smoke`, then `npm run test:packaged-smoke` | CI `packaged-smoke`, a release gate |
| fuzz | `src-tauri/fuzz`, 60 s per target | weekly `security-audit`; saved inputs replay in the default lane |
| native | one command per test below, on a host that has the prerequisite | by hand |
| manual | a person, following the release matrix below | before each release |

The three Rust steps of the default lane compile different things:

- `npm run rust:check` lints the application with its default features, the
  configuration that ships, so code that only builds with `test-utils` fails
  here, and so does a compiler warning such as code nothing uses. CI's
  `rust-test` job runs the same step before Clippy.
- `npm run rust:clippy` lints all targets with all features.
- `npm run rust:test` runs the tests with the `test-utils` feature, which also
  compiles the Docker and server-matrix targets. Every test in those targets
  is `#[ignore]`, so this step reports them as ignored and runs none of them.

TypeScript coverage (`npm run coverage`) is part of `npm run check`. Rust
coverage (`npm run rust:coverage`) is not: it runs the same tests as
`rust:test`, instrumented, as CI's `rust-coverage` job.

## Ignored Rust tests

Each `#[ignore]` names its reason, and `npm run check:ignored-tests` fails when
an ignored test is missing from this table. The default run reports them as
ignored; the count is the number of checks that did not run. Last result is
from the Windows run of 2026-09-23.

| Test | Needs | Command | Lane | Last result |
| --- | --- | --- | --- | --- |
| `src-tauri/tests/docker_integration.rs` (14 tests) | the Docker stack | `scripts/with-libsodium.ps1 -Command compatibility` | compatibility | PASS 14/14 |
| `docker_simultaneous_ftp_webdav_files_and_empty_folder`, `docker_empty_folder_uses_the_recursive_transfer_path` | the Docker stack | the same command, second step | compatibility | PASS 2/2 |
| `docker_folder_manifest_preserves_nested_and_empty_directories` | Docker WebDAV on port 6065 | `npm run rust:test -- docker_folder_manifest --ignored` | native | PASS |
| `src-tauri/tests/server_matrix/` (643 tests) | matrix containers and IIS | `npm run servers:test -- all chaos heavy iis` | server matrix | PASS 643/643 on 2026-10-01, in two runs: `all chaos`, then `heavy iis` |
| `connects_lists_and_downloads_from_rebex_ftps`, `connects_lists_and_downloads_from_rebex_sftp` | internet access to test.rebex.net | `npm run rust:test -- connects_lists_and_downloads_from_rebex --ignored` | native | PASS 2/2 |
| `connects_and_round_trips_a_file` | a WebDAV server in `WEBDAV_URL`, `WEBDAV_USER`, `WEBDAV_PASS` | `npm run rust:test -- connects_and_round_trips_a_file --ignored` | native | NOT RUN: no external server |
| `cross_volume_disk_move` | a second writable volume in `FTPEACH_MOVE_TEST_VOLUME` | `npm run rust:test -- cross_volume_disk_move --ignored` | native | PASS, C: to D: |
| `artifact_symlink_cannot_write_to_its_target` | Developer Mode or SeCreateSymbolicLinkPrivilege | `npm run rust:test -- artifact_symlink_cannot_write --ignored` | native | NOT RUN: privilege not held (1314) |
| `connect_without_proxy_supports_ipv6_when_loopback_is_available` | the firewall allowing IPv6 loopback connects | `npm run rust:test -- connect_without_proxy_supports_ipv6 --ignored` | native | NOT RUN: connect to ::1 refused (EACCES) |
| `endless_reply_under_a_memory_cap` | nothing; its parent test runs it under a 128 MiB cap | runs inside `an_endless_reply_fits_in_a_process_with_a_hard_memory_cap` | default | PASS through the parent |

The `npm run rust:test -- <name> --ignored` commands above match only the
library tests they name. Without a name, `npm run rust:test -- --ignored` also
runs the Docker and server-matrix targets, which need their servers.

UNC tests are not ignored; they skip their UNC half when `\\localhost\C$` is
not reachable. `FTPEACH_REQUIRE_UNC_FIXTURES=1 npm run rust:test` makes a missing
share fail instead.

## Protocol contracts under faults

Rows are the contracts of HF-01 to HF-06; columns are the conditions they have
to survive. A cell names the test that asserts it. `-` means the condition
cannot arise for that contract.

| Contract | Conflict | Rename/delete refused | No extensions (no MLSD/MLST, LIST only) | Connection lost | Cancel | Stale listing |
| --- | --- | --- | --- | --- | --- | --- |
| HF-01 move only within one endpoint | `transferBatchOutcome`: a Move between endpoints is refused as a whole | - | - | - | `useTransfers`: refused paste keeps the cut | - |
| HF-02 no implicit replace on rename/move | FTP `no_replace_rename_refuses_a_taken_target_and_moves_onto_a_free_one`, SFTP `no_replace_rename_keeps_a_target_the_server_would_overwrite`, WebDAV `no_replace_move_onto_a_taken_destination_says_it_exists`, matrix S6 | matrix S12 (read-only folder keeps the file), `a_server_refusing_to_replace_on_rename_gets_the_old_file_set_aside` (FTP, WebDAV) | matrix S6 on vsftpd (LIST only) | `failed_metadata_transport_discards_connection_but_refusal_does_not` | `cancelled_control_operation_discards_the_socket` | accepted FTP limit: a name taken after the check is replaced (HF-02) |
| HF-03 local single-file copy | `a_target_that_appears_before_commit_is_not_replaced` | `a_fault_before_commit_keeps_the_old_target_and_leaves_no_partial` | - | - | `a_cancelled_copy_leaves_no_trace` | `a_source_changed_during_the_copy_is_refused` |
| HF-04 FTP New file never truncates | `create_new_never_truncates_an_existing_or_newly_arrived_ftp_file` | `create_new_reports_a_refused_or_failed_append_without_storing` | same test, run with and without MLST | - | - | same test: a file arriving after the listing survives |
| HF-05 whole-operation result | `transferBatchOutcome`: declining overwrite is a skip | `transferBatchOutcome`: a refused move keeps the originals | - | as a failed item: `transferBatchOutcome` reports each file | NOT COVERED: a stopped item inside a batch | - |
| HF-06 batch waits for started work | - | `transferBatchAdmission`: a failed copy does not end the batch | - | as a failed item: the same test | NOT COVERED: stopping a batch mid-admission | - |

## Fuzz and property checks

| Input | Check | Lane |
| --- | --- | --- |
| FTP LIST and MLSD lines | `list_parse` fuzz target, saved inputs | fuzz, default |
| FTP control replies | `ftp_response` fuzz target over the patched reader | fuzz, default |
| WebDAV PROPFIND XML | `webdav_propfind` fuzz target | fuzz, default |
| Remote names turned into local file names | `temp_names_create_exactly_the_named_file`: 2,000 seeded names, Windows itself as the oracle | default (Windows) |
| IPC and listing bounds | byte, entry and depth budgets in `protocol/mod.rs`, `ftp_tests.rs`, `webdav_tests.rs` | default |

Fuzz limits, crash handling and minimized inputs are in
[the fuzz README](../src-tauri/fuzz/README.md). A failing seeded name goes into
the explicit cases of `temp_name_handles_windows_devices_controls_and_unicode_edges`.

## Release matrix

The release trust report copies this table into every draft release. Rows in
the `ci` lane are proven by jobs the release workflow requires; every other row
is printed as NOT VERIFIED until someone records a result in
[native validation](native-validation.md).

| Cell | Lane | How |
| --- | --- | --- |
| Default Rust, Node, component and visual suites | ci | `checks.yml` |
| Docker compatibility round trips | ci | `protocol-compatibility.yml` |
| Packaged WebView2 smoke: shutdown flush, editor recovery, vault lock | ci | `packaged-smoke` |
| Portable copy keeps its data beside the program and none in the profile | ci | `packaged-smoke`, second run |
| Server matrix, all targets including IIS | manual | `npm run servers:test` |
| Same-volume and cross-volume move | manual | `cross_volume_disk_move`, then drag a file between two drives |
| Reparse points and junctions | manual | default suite, then move a folder containing a junction |
| UNC share | manual | `FTPEACH_REQUIRE_UNC_FIXTURES=1 npm run rust:test`, then copy to and from a share |
| Recycle bin | manual | delete a local file and folder, restore both from the bin |
| Explorer drag-out | manual | drag a remote file and folder to Explorer and to the desktop |
| Editor recovery | manual | edit a remote file, kill FTPeach, restart, upload the recovered copy |
| Windows Hello unlock | manual | enable enhanced protection, lock, unlock with Hello |
| Upgrade keeps data | manual | install the previous release, add a site, upgrade, check sites, settings and vault |
| Uninstall keeps data unless asked | manual | uninstall, reinstall, check the data is still there |
| Portable copy leaves nothing behind | manual | snapshot `%APPDATA%`, `%LOCALAPPDATA%` and the notification registry key, run the zip's copy, connect, show a notification, exit, compare |
| Portable passwords on another account | manual | save a password without a master password, open the folder as another Windows user; repeat with a master password |
| Portable update | manual | unpack the previous release's zip, update to this one, check the program version and that `data\` is unchanged |
