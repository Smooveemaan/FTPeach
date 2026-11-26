# Rust advisory exceptions

Every entry in `src-tauri/deny.toml` must have a matching row below, with its RustSec
kind: `vulnerability`, `unmaintained`, `unsound` or `notice`, or `yanked` for a crate
version ignored by name. CI rejects
missing, expired, or longer-than-120-day reviews and unknown kinds; the weekly
audit also fails when a kind disagrees with RustSec's own classification.
CODEOWNERS assigns changes to this policy to the security owner. Weekly CI runs
`cargo deny check advisories licenses`.

Each `src-tauri/deny.toml` reason repeats the review deadline; the policy check rejects
drift from this register. Weekly CI also prints live RustSec `[versions]` metadata
for every ignored advisory in the job summary and verifies that each advisory's kind
agrees with RustSec. Fetch failures fail that step; stale or missing evidence is
not treated as "no fix available".

The 120-day window runs from the last review, so a deadline moves only with a new
dated review section below.

| Advisory | Kind | Owner | Reviewed | Review by | Current status | Compensating control |
| --- | --- | --- | --- | --- | --- | --- |
| RUSTSEC-2024-0370 | unmaintained | @Smooveemaan | 2026-11-13 | 2027-02-11 | `proc-macro-error` 1.0.4 through `glib-macros` 0.18.5 and `gtk3-macros` 0.18.2; no compatible fixed release | Used only while compiling GTK macros, not at runtime. Remove when Tauri's GTK dependency no longer requires these macros. |
| RUSTSEC-2026-0370 | unmaintained | @Smooveemaan | 2026-11-13 | 2027-02-11 | `zvariant` 5.15.0 through `zbus` 5.19.0; its replacement is part of zbus 6 | Keep vulnerability advisories enabled; review Tauri plugins, keepawake and KSNI for compatible zbus 6 releases. |
| RUSTSEC-2026-0371 | unmaintained | @Smooveemaan | 2026-11-13 | 2027-02-11 | `zbus_names` 4.3.4 through `zbus` 5.19.0; its replacement is part of zbus 6 | Keep vulnerability advisories enabled; review Tauri plugins, keepawake and KSNI for compatible zbus 6 releases. |
| RUSTSEC-2026-0372 | unmaintained | @Smooveemaan | 2026-11-13 | 2027-02-11 | `zvariant_derive` 5.15.0 through `zvariant` 5.15.0; its replacement is part of zbus 6 | Derive macros run only during compilation; review the same zbus consumers before removing this exception. |

The reviews below found no compatible direct upgrade that removes the accepted
transitive advisories at their recorded dates. Remove an ignore as soon as a compatible
fix is available; extending a deadline requires a fresh security review.

The `chrono` exception (RUSTSEC-2026-0543) was removed on 2026-11-26: FTPeach
migrated its date and time code to `jiff` 1.0, `russh-sftp` was updated from 3.0.1
to 4.0.0 and `trash` from 5.2.9 to 5.4.0, removing `chrono` from all audited
targets.

The `rsa` exception (RUSTSEC-2023-0071) was removed on 2026-11-21: `russh` 0.65.2
and `ssh-key` 0.7.0-rc.12 accept `rsa ^0.10`, updating the lockfile to `rsa` 0.10.0,
which RustSec lists as patched.

The five `rust-unic` exceptions (RUSTSEC-2025-0075, -0080, -0081, -0098 and
-0100) were removed on 2026-10-02: Tauri 2.12 uses `urlpattern` 0.6.0, which no
longer depends on those crates, and `cargo deny` reported each advisory as not
encountered.

The `paste` (RUSTSEC-2024-0436) and `bincode` (RUSTSEC-2025-0141) exceptions were removed
on 2026-10-23: both came only through Stronghold, which FTPeach no longer uses. The vault
of 0.5 and earlier is read by FTPeach's own code once, to move it to the current format.

The three `zip` exceptions (RUSTSEC-2026-0367, -0368 and -0369, all in `extract`) were
removed on 2026-10-23. `tauri-plugin-updater` needed `zip` 4 only for its `install`, which
FTPeach never calls: it is built without its `zip` feature, and FTPeach's own unpacking of
the portable update (`runtime/update_staging.rs`) uses `zip` 9.

## Dependency advisory review, 2026-11-26

`russh-sftp` 4.0.0 was published on 2026-11-21 with `jiff ^1.0.0` in place of `chrono`.
FTPeach replaced its direct `chrono` usage with `jiff` 1.0, updated `russh-sftp` from
3.0.1 to 4.0.0, and updated `trash` from 5.2.9 to 5.4.0. `chrono` no longer appears in
any of the four audited targets, so
[RUSTSEC-2026-0543](https://rustsec.org/advisories/RUSTSEC-2026-0543.html) was removed
from `src-tauri/deny.toml`.

The four remaining unmaintained exceptions (`proc-macro-error` through GTK 0.18 and
`zvariant`/`zbus_names`/`zvariant_derive` through zbus 5) were also checked without
extending their 2027-02-11 deadline: Tauri 2.12.7 still requires `gtk ^0.18`, and the
Tauri notification, opener and single-instance plugins, `keepawake`, and `ksni` still
require `zbus ^5`.

## Dependency advisory review, 2026-11-21

`russh` was updated from 0.65.1 to 0.65.2, which loosens its `rsa` requirement to
`^0.10` and updates `ssh-key` to 0.7.0-rc.12. The lockfile now resolves `rsa` 0.10.0,
which RustSec lists as patched for
[RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html). That
exception was removed from `src-tauri/deny.toml`; no vulnerability exceptions remain.
FTPeach still recommends Ed25519 for new SSH keys and warns when an RSA key is selected.

[RUSTSEC-2026-0543](https://rustsec.org/advisories/RUSTSEC-2026-0543.html) marks
`chrono` as unmaintained with no patched release (`informational = "unmaintained"`).
In the audited targets (`x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`,
`aarch64-apple-darwin`, `x86_64-apple-darwin`), `chrono` 0.4.45 is required directly
by FTPeach and transitively by `russh-sftp` 3.0.1 and `trash` 5.2.9 (`russh-util`
0.52.0 depends on `chrono` only for `wasm32`). `russh-sftp` 3.0.1 is the latest
published release on crates.io and requires `chrono ^0.4.45` unconditionally;
upstream `master` has switched to `jiff` 1.0.0 but has not been released yet, and
`trash` 5.4.0 has also moved to `jiff`. Replacing FTPeach's own `chrono` calls alone
would still leave `chrono` in the lockfile through `russh-sftp`. This exception
covers only the unmaintained notice, does not suppress vulnerability advisories for
`chrono`, and expires on 2027-02-19.

## Unix dependency review, 2026-11-13

The audit graph now includes Windows x64, Linux x64 and both macOS architectures
of the universal release. The same graph is used by the regular and weekly cargo-deny jobs.
`target-lexicon`'s `Apache-2.0 WITH LLVM-exception` license is accepted by both
cargo-deny and cargo-about.

`russh` was updated from 0.63.3 to 0.65.1, which fixes
[RUSTSEC-2026-0495](https://rustsec.org/advisories/RUSTSEC-2026-0495.html).
FTPeach uses the SSH client and does not run the affected SSH agent server.
The update keeps the existing RSA compatibility path and its separate advisory.
RustSec now lists `rsa >=0.10.0` as patched for
[RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html), but
russh 0.65.1 requires exactly `rsa =0.10.0-rc.18`. A lockfile update cannot select
the fixed release. The RSA exception was reviewed without extending its
2027-01-23 deadline; the Ed25519 advice and user-selected RSA signing path remain
in place. This update does not establish constant-time RSA signing.

The yanked `async-executor` 1.14.0 was updated to 1.14.1 instead of adding a
yanked-version exception.

The four new exceptions cover unmaintained packages, not newly accepted
vulnerabilities. GTK 0.18 requires `glib-macros` 0.18.5 and `gtk3-macros` 0.18.2;
neither has a compatible release replacing `proc-macro-error`. Updating GTK alone
would leave Tauri's GTK 0.18 dependency in the graph.

`zbus_names`, `zvariant` and `zvariant_derive` were merged into zbus 6. The locked
Tauri notification, opener and single-instance plugins, notify-rust, keepawake
and KSNI still require zbus 5. Updating only FTPeach's direct zbus dependency
would retain the unmaintained crates through these consumers. Replacing or
patching that stack is outside this dependency update. These exceptions do not
suppress other advisories for the same packages and expire on 2027-02-11.

## RSA review, 2026-10-23

RUSTSEC-2023-0071 was first accepted on 2026-08-30. This review extends it to 2027-01-23.

- RustSec still lists `patched = []` and names rsa 0.9.10 and 0.10.0-rc.18 as affected.
- The newest `rsa` is 0.10.0-rc.19, but it does not reach FTPeach: russh 0.63.3, and
  also the newest russh 0.64.1, pin `rsa` to `=0.10.0-rc.18` and `ssh-key` to
  `=0.7.0-rc.11`. `cargo update -p rsa` changes nothing, and moving to 0.64 would not
  remove the advisory.
- The reachability found on 2026-09-07 still holds. `protocol/sftp/connect.rs` loads
  the selected key and signs with it only for key authentication; password
  authentication never takes that path.
- The control is still in place. When the picked key file is RSA (OpenSSH, PKCS#1 PEM
  or PuTTY), `commands/dialog.rs` marks it, and the connection bar and the site editor
  show the Ed25519 advice. The prefix detection has unit tests.
- `cargo deny check advisories` passes with this one exception.

Next review: before 2027-01-23, or as soon as RustSec lists a patched release or russh
moves off the `rsa` crate.

## Reachability review, 2026-09-07

Fresh cargo deny check advisories licenses passed with the eight existing exceptions; this does not remove them. Locked inverse dependency inspection found:

- rsa 0.10.0-rc.18 through russh 0.63.1, both directly and through ssh-key 0.7.0-rc.11.
- paste 1.0.15 through stronghold_engine 2.0.1 and iota_stronghold 2.1.0.
- unic-char-range/property and unic-ucd-ident 0.9.0 through urlpattern 0.3.0 and tauri-utils 2.9.3; the common/version crates belong to that same Unicode dependency family.
- bincode 1.3.3 through iota_stronghold 2.1.0.

In protocol/sftp.rs, key authentication calls load_secret_key on the selected path and passes that key to russh authenticate_publickey. RSA private signing is therefore reachable when the user selects an RSA key; password authentication does not take this private-key branch. Host-key verification is a separate public-key operation. This source review does not establish exploitability or constant-time behavior, and the Ed25519 warning does not eliminate the vulnerable compatibility path. Review remains due by 2026-11-30; no exception was extended.

Recorded evidence: .local/logs/p3-cargo-deny.log and .local/logs/p3-{rsa,paste,unic,bincode}-tree.log; release CI reruns the database check rather than relying on this dated result.

The [RustSec advisory](https://rustsec.org/advisories/RUSTSEC-2023-0071.html), checked on 2026-09-07, still lists no patched versions.

The checked dependency source continues from russh client/encrypted.rs to helpers::sign_with_hash_alg, whose RSA branch invokes signature::Signer::try_sign on the RSA keypair/hash pair in ssh-key. This confirms a private signing path rather than merely an RSA entry in Cargo.lock.
