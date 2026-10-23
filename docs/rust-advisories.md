# Rust advisory exceptions

Every entry in `src-tauri/deny.toml` must have a matching row below, with its RustSec
kind: `vulnerability`, `unmaintained`, `unsound` or `notice`, or `yanked` for a crate
version ignored by name. CI rejects
missing, expired, or longer-than-120-day reviews and unknown kinds; the weekly
audit also fails when a kind disagrees with RustSec's own classification.
CODEOWNERS requires the security owner to review changes. Weekly CI runs
`cargo deny check advisories licenses`.

Each `src-tauri/deny.toml` reason repeats the review deadline; the policy check rejects
drift from this register. Weekly CI also prints the locked `cargo tree -i rsa`
chain, the latest upstream russh version, and live RustSec `[versions]` metadata
for every ignored advisory in the job summary. Fetch failures fail that step;
stale or missing evidence is not treated as "no fix available". New versions
and patched ranges are review signals, not proof of constant-time RSA signing.

The 120-day window runs from the last review, so a deadline moves only with a new
dated review section below.

| Advisory | Kind | Owner | Reviewed | Review by | Current status | Compensating control |
| --- | --- | --- | --- | --- | --- | --- |
| RUSTSEC-2023-0071 | vulnerability | @Smooveemaan | 2026-10-23 | 2027-01-23 | `rsa` 0.10.0-rc.18 through `russh` 0.63.3; RustSec still lists no patched release | Prefer Ed25519 and warn when a user selects RSA. RSA remains compatibility-only for user-selected SSH client keys; key material is never logged or returned by normal IPC. |

The dependency review found no compatible direct upgrade that removes these
transitive packages as of 2026-10-23. Remove an ignore as soon as a compatible
fix is available; extending a deadline requires a fresh security review.

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
