# File operation safety

## Guarantee matrix

What an existing target can expect from each operation when the user has not approved replacing
it. Every IPC entry point defaults to no replacement: only an explicit `overwrite: true` replaces
(`fs_rename`, `session_rename`, `fs_copy_file`, the transfer commands and the recursive intent).
Move between different endpoints does not exist: `canMoveBetween` in `src/shared/movePolicy.ts` is
the one policy for drag and drop, paste after Cut and transfer routing.

| Operation | Local | FTP / FTPS | SFTP | WebDAV |
| --- | --- | --- | --- | --- |
| Rename, same-endpoint Move of one entry | No-replace rename by the OS; atomic | Checks the target, then RNFR/RNTO: a file created in between is replaced | `lstat`, then v3 RENAME, which refuses an existing target; a server that replaces anyway (SFTPGo) races the same way as FTP | `MOVE` with `Overwrite: F`; the server refuses atomically |
| Commit of an upload or download | Download: verified UUID partial, no-replace commit by the OS | Upload: UUID staging, then the rename row | Upload: UUID staging, then the rename row | Upload: UUID staging, then the rename row |
| New empty file | Exclusive create | Checks the target, then an empty `APPE`: a file created in between keeps its content; an existing name is `alreadyExists`; 502/504 is `createUnsupported` | Exclusive open (`EXCLUDE`); a taken name is `alreadyExists` | PROPFIND, then `PUT` with `If-None-Match: *`; a taken name is `alreadyExists` |
| Recursive copy | Each file commits as above; declining or skipping one keeps the source folder | same | same | same |
| Move of a folder | Verified copy, then handle-based deletion of each unchanged source file | Same-session server rename only | Same-session server rename only | Same-session `MOVE` only |

Approved replacement of an upload renames a server's refusal aside to `.ftpeach-<uuid>.old`,
publishes the staging file and deletes the old file only afterwards; a failed publication puts it
back. FTP has no atomic no-replace rename, so no FTP row above is atomic; see
[conservative limits](#conservative-limits).

| Promise | Tests |
| --- | --- |
| No flag keeps the target, locally and remotely | `commands::fs::tests::rename_and_copy_without_an_overwrite_decision_keep_the_existing_target`; `test/unit/file-browser/paneFileOperations.test.ts` |
| Remote no-replace rename per protocol | `ftp_tests::no_replace_rename_refuses_a_taken_target_and_moves_onto_a_free_one`, `sftp_tests::no_replace_rename_keeps_a_target_the_server_would_overwrite`, `webdav_tests::no_replace_move_onto_a_taken_destination_says_it_exists` |
| Download commit keeps a target created after the preflight | `transfer_file::tests::no_replace_commit_preserves_a_target_created_after_preflight` |
| Approved replacement sets aside and restores | `sftp_tests::without_posix_rename_the_existing_file_is_set_aside_then_removed`, `a_set_aside_file_is_put_back_when_the_new_one_cannot_take_its_name` |
| New file never truncates | `local_create::tests::creates_folders_with_parents_and_files_without_replacing`, `ftp_tests::create_new_never_truncates_an_existing_or_newly_arrived_ftp_file`, `create_new_reports_a_refused_or_failed_append_without_storing`, `sftp_tests::creating_a_taken_name_says_it_exists_and_opens_nothing_else`, `webdav_tests::a_file_arriving_before_the_empty_put_is_reported_as_existing`; against real servers, `round_trip` in `src-tauri/tests/docker_integration.rs` for all four protocols |
| Single local copy is staged | `staged_copy::tests::a_fault_before_commit_keeps_the_old_target_and_leaves_no_partial` |
| Skipped nested file keeps the Move source | `recursive_transfer::tests::skip_merges_missing_files_and_retains_move_source` |
| Move between endpoints touches nothing | `test/component/transfers/useTransfers.test.tsx` ("a move between different endpoints touches nothing"), `test/component/file-browser/dragMove.test.tsx` |

## Local and transfer policies

| Operation | Policy | Regression coverage |
| --- | --- | --- |
| Local protected paths | Compare parsed drive/UNC prefixes with Windows ordinal case rules and resolve existing ancestors. Also compare volume/file identities to recognize drive and SMB aliases. Missing suffixes remain protected. Reparse points are rejected before collapsing `..`. | `filesystem_safety::tests`, `commands::fs::tests::protected_app_data_public_commands` |
| Protected directory scope | App installation and FTPeach data contents cannot be read, written or deleted through guarded file commands. Their ancestors and the user profile itself cannot be deleted; ordinary files inside the user profile remain manageable. | Public copy/create/mkdir/delete fixtures in a child process with isolated APPDATA/USERPROFILE |
| Download replacement | Flush the verified sibling partial, then use native replacement rename. Never delete or move the previous destination first, and never reserve a user-visible `.ftpeach-old` name. Rename failure preserves the old destination and partial. | `protocol::transfer_file::tests`, including a Windows sharing violation and process exit before commit |
| Recursive operations | The backend scans and validates a bounded manifest, requires successful copies and rechecks the source before deletion. Listing, mkdir and copy failures preserve source data; skipped entries produce a partial report. | `application/recursive_transfer/tests.rs` and `test/component/transfers/useTransfers.test.tsx` |
| Local directory relationship | Backend preflight resolves existing ancestors and rejects the source itself, descendants and reparse aliases before traversal or mkdir. Rename and file-copy commands also validate the relationship. | Local relationship and junction fixtures |
| Remote directory move | Within one session, use server rename with a conservative component/case guard; the server enforces its alias semantics. There is no copy/delete fallback. Moves between distinct remote sessions are rejected because different connections can expose the same tree. Copy remains available. | Remote relationship tests and frontend rename/preflight tests |
| Upload and relay | Each attempt writes a fresh UUID sibling staging file. Only a successful upload, or a relay with explicit source completion, proceeds to server rename. A server that refuses to replace an existing file has that file renamed aside to a hidden `.ftpeach-<uuid>.old` sibling, the staging file renamed into its name, and only then the old file deleted; if the second rename fails, the old file is renamed back. There is no delete-first fallback. Progress reports completion after rename. | `application/transfer_service_tests.rs` |
| Cancellation | Queued cancellation does not touch the remote destination. Backend cleanup after an active failure/cancellation targets only that attempt's staging path. The renderer never deletes an upload/relay destination on stop or pause-to-stop. | Pool cancellation fixtures and frontend lifecycle tests |

Upload retries restart in fresh staging unless a paused upload passes the source and staging-overlap checks.
Downloads resume only with a compatible source-identity sidecar (see A06 below).
If a connection is lost or staging cleanup fails, a `.ftpeach-<uuid>.part` artifact can remain
on the server. Cleanup is bounded and logged; it never substitutes the final destination.
Recursive Stop follows the more conservative ownership rules below and reports retained objects to the renderer.
Once a server receives the final rename, cancellation cannot roll back a committed replacement.

The tests model process interruption before local commit, not physical power loss or every
network filesystem's durability guarantees. Windows UNC fixtures use the local administrative
share when available; set `FTPEACH_REQUIRE_UNC_FIXTURES=1` to require this coverage. Protocol
fault tests use controlled backends, so they do not replace the real server compatibility suite.

## Recursive operation contracts

| Phase | Guarantee and conservative fallback |
| --- | --- |
| Resume | The journal records the delivered destination as well as the source size/mtime. Before any resumed writes or skips, every recorded destination must still be a file with the saved receipt. Missing, replaced, changed or unverifiable destinations fail with an integrity conflict; the user must resolve it and restart. Explicit overwrite on the old attempt does not bypass this check. |
| Local receipts | Windows receipts include volume/file identity, change time, last-write time, size, type and a USN change-journal revision where available. Without USN, files up to 1 MiB receive a SHA-256 digest; larger files have no strong receipt and cannot authorize resumed skips or deletion. Local source receipts are checked after copying and again before a resumed skip. Timestamps alone are insufficient, including change time, because fast writes can share a clock tick. |
| Remote receipts | Current adapters expose file type, size and modification time through bounded listings. Missing metadata fails verification. This is metadata-based Copy verification, not a content hash: equal-size changes with unchanged server mtime cannot be detected. No full reread of large files was introduced. Remote receipts never authorize destructive rollback or copy/delete Move. |
| Stop | Only a newly created local object with a matching identity can be removed. Files require the recorded version too; directories must still have their identity and must be empty at the native delete operation. Overwritten destinations are retained. Changed or unverifiable objects are retained and reported using the structured `cleanupIncomplete` code. |
| Staging | Journals record the operation ID and exact retained staging paths. Recursive Stop never infers ownership from `.ftpeach-<UUID>.part`, never sweeps a folder for matching names and never follows a sidecar to delete its contents. Unverified partials are retained with diagnostics. A stopped upload's matching staging registry entry is forgotten so disconnect cannot subsequently delete that reported retained object. |
| Remote rollback | Remote files and collections are retained because the adapters do not expose conditional object deletion. In particular, there is no WebDAV LIST-then-recursive-DELETE fallback; a file appearing in that interval cannot be deleted by rollback. |
| Move | Copy/delete Move is enabled only between local endpoints on Windows. After the final source manifest check, each file's destination is opened with write/delete sharing denied and verified. Its source is then opened with the same sharing restriction plus DELETE access, verified against the saved receipt and deleted through that handle with `SetFileInformationByHandle`. The destination handle stays open until the source handle closes. A conflict preserves the current source file and already delivered targets. Same-session remote server Rename remains available; other moves are refused before any write, and the user can copy instead. |

The source-deletion phase is irreversible and its journal never rolls back the destination,
including after a later cancellation. This change does not claim protection against malicious
metadata forgery, existing writable memory mappings, replacement of ancestor directories,
filesystem-specific durability failures or physical power loss. Local handle deletion fails
closed when the filesystem refuses the required sharing/access semantics. Non-Windows
copy/delete Move and automatic rollback are unavailable rather than falling back to path deletion.

Windows reads the per-file journal revision with
[FSCTL_READ_FILE_USN_DATA](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_read_file_usn_data).
SMB does not support that control; the bounded digest fallback or conservative refusal applies.
Verification costs one metadata/USN lookup per capture on supporting filesystems, or at most
1 MiB of content per capture otherwise. This is a bound on extra reads, not a throughput benchmark.
The original overwrite flag is never broadened merely because the journal once created a file;
recopying a changed source requires explicit overwrite consent or a new destination.

Regression tests cover destination removal/edit/type replacement on upload, download and relay
resume; local edits and replacements with restored size/mtime; source changes injected after the
final scan; destination changes before source deletion; sharing violations; foreign staging;
nonempty/replaced directories; and frontend notification of incomplete Stop cleanup. Controlled
FTP tests exercise cancellation with retained artifacts. Real-server compatibility and packaged
smoke remain separate checks.

## Resume, staging and pool contracts

Creating a named empty file through FTP/FTPS
first checks for a current conflict, returning `alreadyExists` without writing. If absent, it
sends `APPE` with an empty body and waits for the server's completion reply. `APPE` creates a
missing file and appends to an existing one, so zero bytes leave the content of a file that
arrived after the check as it was; STOR, or a staged upload followed by RNTO, would truncate or
replace it. The guarantee is about content only: the server may still update the racing file's
modification time or run upload hooks, and success does not prove that the file is new. A
server answering `APPE` with 502 or 504 yields `createUnsupported`; any other refusal or a
failed completion reaches the user through the ordinary error mapping. There is never a STOR
fallback. SFTP exclusive creation and WebDAV conditional creation are unchanged. A real TCP FTP
fixture verifies existing bytes, a file stored between the check and `APPE`, a refused `APPE`
with no STOR fallback, and a failed completion.

| Audit | Behavior | Regression coverage |
| --- | --- | --- |
| A06 | A sidecar records endpoint/account, remote path, known size and an available source version (FTP MDTM, SFTP mtime, WebDAV ETag/Last-Modified). A missing marker or incompatible identity starts a new UUID partial. Legacy fixed-name partials are never adopted. HTTP resume sends If-Range. | transfer_file resume identity tests; WebDAV protocol fixtures |
| A07 | Download partials are operation-owned UUID siblings. Actual artifact opens reject reparse points and multiple hard links; Windows handles deny sharing while open. All local downloads and file-manager mutations share one mutex. Remote upload/relay and browse mutations reserve normalized overlapping paths across session tabs. Reservations remain owned by queued/running tasks. | artifact hardlink/symlink tests; local mutation guard; target_reservation tests |
| A08 | Relay admission checks both pools under deterministic lock ordering and admits both legs only when they can start. An undersized or busy pair fails immediately with a retry/concurrency message. It never waits while holding one worker. | same-pool Fixed(1) refusal, 256 KiB paired stream, opposite relay/cancellation tests |
| A09 | A pool closes when its final worker cannot be replaced, resolving every queued response. Closed pools reject enqueue; active/queued duplicate attempt IDs are rejected. Disconnect during cancellation is bounded. | replacement failure, duplicate ID, post-destroy and cancellation tests |
| A10 | Rows retain their UI ID, while each execution gets a UUID attempt ID used by IPC, progress and cancellation. Cancelling remains active until the invocation settles. Old events do not mutate the new attempt; retry cannot run during cancellation. | test/component/transfers/useTransfers.test.tsx |
| A11 | Every nested file checks the overwrite policy. Failed destination listing is an error. Local comparisons fold case. IPC defaults to no replacement, and local commit/create, WebDAV MOVE and SFTP v3 RENAME enforce no-replace at execution. Declining/skipping a nested file prevents deletion of the source folder. | nested skip/ask tests; racing local commit test; protocol no-replace methods |
| A12 | SSH pins use a strict reader, never generic last-good recovery. Unreadable/corrupt/unsupported stores and a missing main file with a surviving backup fail closed. Only a genuinely absent store permits first trust. | known_hosts damaged-store fixtures |
| A13 | WebDAV explicitly sets read-idle deadlines. PUT has a separate activity-based deadline reset as the HTTP body is consumed, then waits a bounded time for the response. Relay source reads/writes are bounded. Zero connect timeout uses a 60-second transfer-idle default. Timeout classification uses reqwest/Elapsed types. | stalled GET body and PUT response fixtures |
| A14 | FTP LIST checks byte and entry budgets while reading. Data idle, initial command and final control-response timeouts are errors, never EOF or partial success. | LIST oversized/entry-limit/stalled-name fixtures |
| A15 | Only a typed PROPFIND 404 means absent. Other failures propagate without PUT. Empty-file creation sends If-None-Match: *. | PROPFIND 403/500 fixtures |
| A16 | Remote-to-local names are validated before directory creation and again in backend downloads. Device names, ADS, controls and trailing dots/spaces are rejected without renaming. Pure remote paths keep their protocol naming rules. | Windows name table and frontend manifest guard |
| A17 | IPC and import share settings types, numeric integer ranges and supported enum validation. Zero concurrency means unlimited in both explicit and inherited session configuration; zero connect timeout remains valid. Secret input fields have an explicit IPC-only allowlist. | settings schema tests; inherited zero-concurrency test |
| A18 | Save awaits persistence and blocks duplicate saves/close while pending. Backend rejection or a thrown write error leaves the dialog and draft available for retry. | settingsDialog persistence-failure component test; store write-error tests |

### Conservative limits

Local mutations currently serialize globally, including downloads to different destinations.
This favors correctness over local-download parallelism. Remote reservations also deliberately
ignore connection IDs and fold case, so independent servers with the same target path can
conflict. Server aliases that do not have the same normalized path are not proven equivalent.

FTP has no portable atomic no-replace rename. Its no-replace commit checks the target (SIZE, or the
parent's listing where SIZE is unsupported) immediately before RNFR/RNTO and refuses a target that
exists, so a racing file can still be replaced only if it appears between that check and RNTO —
not at any point during the upload. SFTP uses
standard v3 RENAME for no-replace, never the overwriting posix-rename extension; WebDAV uses
Overwrite: F. Servers that violate SFTP v3 no-replace semantics can still replace a target
created after the preliminary lstat. Server behavior requires compatibility testing.

The accepted HF-02 policy keeps ordinary FTP rename available: a free
name does not trigger an overwrite question, and a detected conflict requires confirmation.
FTPeach checks the destination immediately before rename but does not claim atomic protection
against another client creating it in that interval. Closing HF-02 accepts this protocol
limitation; it does not mean the race was eliminated or that tests prove its absence.

Resume compatibility is metadata-based, not a content hash or a guarantee that a server updates
mtime correctly. A corrupt or linked sidecar is preserved and reported as an error. Abandoned
UUID partials can remain after crashes or incompatible retries; the renderer does not delete a
path guessed from the destination. No external-process path-race or power-loss guarantee is
claimed: Windows no-follow/exclusive artifact handles narrow that boundary, but final path-based
commit and ancestor replacement still require separate handle-level adversarial testing.

### Validation

These regression suites run through `npm test` and `npm run rust:test`, both part of `npm run check`.
See [native validation](native-validation.md) and the [verification matrix](verification-matrix.md) for what else runs and when.
Packaged smoke, physical power loss and the external server compatibility matrix are not covered
by these unit/component/local-server results.

The Windows file-symlink fixture is ignored by default because it requires a privilege. Run `artifact_symlink_cannot_write_to_its_target --ignored` on a host with
Developer Mode or SeCreateSymbolicLinkPrivilege. Hardlink fixtures and existing junction/reparse
checks run normally.

A successful download consumes its UUID partial and removes its matching source metadata sidecar. Interrupted downloads may retain both; recursive Stop does not delete unverified artifacts.

## Open with uploads

Open-with changes are queued once per copy with the latest dirty revision. An upload
acknowledges only its captured revision; newer saves remain pending. While a copy's
upload is in flight its queued revision is not asked about, because a transfer to that
file is already active and the question could only be refused; it surfaces once, after
the upload settles either way. Questions about other copies are unaffected. Failed uploads
and failed sync acknowledgements keep a retryable question. An admission refusal
because an older upload is still running also keeps the newer revision retryable.
Later dismisses the
question without marking the copy synced; disconnect retains unsynced copies for
recovery. Queue and revision regressions live in `openWithRecovery.test.tsx` and
`local_fs::open_with::tests` (HF-07).

## Drag and drop contracts

Internal drags default to Move between local directories or within one remote connection; uploads, downloads and transfers between connections default to Copy. Ctrl requests Copy, Shift requests Move, and Ctrl+Shift is rejected. Copy/delete moves across endpoints are unavailable: `canMoveBetween` in `src/shared/movePolicy.ts` allows Move only between local directories or within one remote connection, and drag-and-drop, paste after Cut and the transfer routing all apply it, for files and folders alike. A refused paste keeps the cut so the user can copy instead; the routing refuses such a Move before any copy starts and never deletes a source after a copy. The backend can still reject a server rename; its error is surfaced without substituting Copy.

A selection reports what each of its names did — copied, moved, skipped or failed — plus whether a move left its source in place (`src/features/transfers/transferBatchResult.ts`). A skip is the user's own answer (a declined overwrite question, a name that left the listing) and is not reported as a failure; a refused item is counted and named once for the whole selection, and a move that could not finish says separately that the originals are still there. Paste after Cut clears the clipboard only when every name actually moved, so a refused or partly refused move can be pasted again. Nothing retries a refused item on its own.

The cursor badge shows the source icon and name/count plus Move or Copy over a valid destination. An unavailable destination uses the existing not-allowed cursor, without a separate symbol badge; disconnected servers retain the existing connect-first panel. Without a destination it shows the picked-up name/count without an action. Source rows retain ordinary selection. Folder rows and visible address breadcrumb segments highlight only for an accepted action. An address segment supplies its absolute path, including parent directories and roots; it does not navigate when dropped on. Background drops in the other pane use its current directory. Same-directory, self and descendant destinations are rejected before dispatch, with backend path validation remaining authoritative for aliases and races.

Incoming Explorer drops support the same address segments and remain Copy-only; outgoing native drags also advertise Copy only. Editing the address or hovering its separators does not select a destination.

Local single-file moves use filesystem rename with explicit overwrite approval, rather than copying and later deleting by path. Only a cross-volume rename error activates the verified file fallback: the source is held open denying writes/deletes, bytes are copied into a unique destination-side temporary file, flushed, and SHA-256 plus length are checked against rereads of both files. The temporary file is published by its still-protected handle, then the source is deleted through its original protected handle. This works without USN support and uses bounded buffers for large files. Other rename errors do not activate the fallback. Before publication, failure removes only the owned temporary object; after publication, a source-deletion failure retains the verified destination and reports an error. Existing ancestor-path, memory-mapped-write and power-loss limitations still apply. Recursive local folder moves retain the verified P0 route.

Rename and single-file copy request replacement only when the caller passes `overwrite: true`, after the user resolves a detected conflict (MoveTo, paste, drag or remote F2). A missing or `false` flag selects the no-replace path locally and in `session_rename`, subject to the remote protocol limitations above. Remote F2, including a change of letter case, first requests no-replace and retries with overwrite only after confirmation of an `alreadyExists` response. A successful rename to a free name needs no extra confirmation.

`fs_copy_file` uses the same staged copy as recursive local copies: bytes go to a unique hidden sibling, the source must keep its length and modification time, the sibling is synced and only then committed under the overwrite policy. A failure before commit removes only that sibling; an existing target keeps its old content and a new target never appears partially written.

Address breadcrumbs explicitly opt back into pointer events during drag; the browser regression uses real mouse movement with production CSS. Windows handle publication follows [FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info).
