# File operation safety

The P0 and P1 fixes from the September 2026 audit establish the following behavior.

| Operation | Policy | Regression coverage |
| --- | --- | --- |
| Local protected paths | Compare parsed drive/UNC prefixes with Windows ordinal case rules and resolve existing ancestors. Also compare volume/file identities to recognize drive and SMB aliases. Missing suffixes remain protected. Reparse points are rejected before collapsing `..`. | `filesystem_safety::tests`, `commands::fs::tests::protected_app_data_public_commands` |
| Protected directory scope | App installation and FTPeach data contents cannot be read, written or deleted through guarded file commands. Their ancestors and the user profile itself cannot be deleted; ordinary files inside the user profile remain manageable. | Public copy/create/mkdir/delete fixtures in a child process with isolated APPDATA/USERPROFILE |
| Download replacement | Flush the verified sibling partial, then use native replacement rename. Never delete or move the previous destination first, and never reserve a user-visible `.ftpeach-old` name. Rename failure preserves the old destination and partial. | `protocol::transfer_file::tests`, including a Windows sharing violation and process exit before commit |
| Recursive operations | The backend scans and validates a bounded manifest, requires successful copies and rechecks the source before deletion. Listing, mkdir and copy failures preserve source data; skipped entries produce a partial report. | `application/recursive_transfer/tests.rs` and `test/component/transfers/useTransfers.test.tsx` |
| Local directory relationship | Backend preflight resolves existing ancestors and rejects the source itself, descendants and reparse aliases before traversal or mkdir. Rename and file-copy commands also validate the relationship. | Local relationship and junction fixtures |
| Remote directory move | Within one session, use server rename with a conservative component/case guard; the server enforces its alias semantics. There is no copy/delete fallback. Moves between distinct remote sessions are rejected because different connections can expose the same tree. Copy remains available. | Remote relationship tests and frontend rename/preflight tests |
| Upload and relay | Each attempt writes a fresh UUID sibling staging file. Only a successful upload, or a relay with explicit source completion, proceeds to server rename. Server refusal to replace is an error, with no delete-first fallback. Progress reports completion after rename. | `application/transfer_service_tests.rs` |
| Cancellation | Queued cancellation does not touch the remote destination. Backend cleanup after an active failure/cancellation targets only that attempt's staging path. The renderer never deletes an upload/relay destination on stop or pause-to-stop. | Pool cancellation fixtures and frontend lifecycle tests |

Upload retries, including continuation after pause, restart at byte zero in fresh staging.
Downloads resume only with a compatible source-identity sidecar (see A06 below).
If a connection is lost or staging cleanup fails, a `.ftpeach-<uuid>.part` artifact can remain
on the server. Cleanup is bounded and logged; it never substitutes the final destination.
Once a server receives the final rename, cancellation cannot roll back a committed replacement.

The tests model process interruption before local commit, not physical power loss or every
network filesystem's durability guarantees. Windows UNC fixtures use the local administrative
share when available; set `FTPEACH_REQUIRE_UNC_FIXTURES=1` to require this coverage. Protocol
fault tests use controlled backends, so they do not replace the real server compatibility suite.


## P1 contracts

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
standard v3 RENAME, never the overwriting posix-rename extension; WebDAV uses Overwrite: F.
These server semantics still require the real compatibility matrix before release.

Resume compatibility is metadata-based, not a content hash or a guarantee that a server updates
mtime correctly. A corrupt or linked sidecar is preserved and reported as an error. Abandoned
UUID partials can remain after crashes or incompatible retries; the renderer does not delete a
path guessed from the destination. No external-process path-race or power-loss guarantee is
claimed: Windows no-follow/exclusive artifact handles narrow that boundary, but final path-based
commit and ancestor replacement still require separate handle-level adversarial testing.

### Validation

The P1 regression suites run through npm test and npm run rust:test. Clippy, lint/TypeScript,
format checks, Rust boundaries, i18n and production bundle checks are separate acceptance checks.
P3 uses locale fixtures and excludes generated browser reports from source-language checks. The site-manager baseline was visually reviewed against the translated sort-field sizing test before updating. See [native validation](native-validation.md) for current results.
Packaged smoke, physical power loss and the external server compatibility matrix are not covered
by these unit/component/local-server results.

The Windows file-symlink fixture is explicitly ignored by default because it requires a privilege. P3 ran it explicitly and passed; the earlier P1 run returned OS error 1314. Run `artifact_symlink_cannot_write_to_its_target --ignored` on a host with
Developer Mode or SeCreateSymbolicLinkPrivilege. Hardlink fixtures and existing junction/reparse
checks run normally. The three earlier ignored Rust tests remain ignored as well.

A successful download consumes its UUID partial but currently retains the source metadata sidecar. A later attempt cannot reuse the absent artifact and creates a new one. Sidecar cleanup after successful commit is not claimed.
