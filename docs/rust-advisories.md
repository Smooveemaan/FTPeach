# Rust advisory exceptions

Every entry in `deny.toml` must have a matching row below. CI rejects missing,
expired, or longer-than-120-day reviews, and CODEOWNERS requires the security
owner to review changes. Weekly CI runs `cargo deny check advisories licenses`.

Each `deny.toml` reason repeats the review deadline; the policy check rejects
drift from this register. Weekly CI also prints the locked `cargo tree -i rsa`
chain, the latest upstream russh version, and live RustSec `[versions]` metadata
for every ignored advisory in the job summary. Fetch failures fail that step;
stale or missing evidence is not treated as "no fix available". New versions
and patched ranges are review signals, not proof of constant-time RSA signing.

| Advisory | Owner | Added | Review by | Current status | Compensating control |
| --- | --- | --- | --- | --- | --- |
| RUSTSEC-2023-0071 | @Smooveemaan | 2026-08-30 | 2026-11-30 | Vulnerability; `rsa` 0.10.0-rc.18 through `russh` 0.63.1; RustSec still lists no patched release | Prefer Ed25519 and warn when a user selects RSA. RSA remains compatibility-only for user-selected SSH client keys; key material is never logged or returned by normal IPC. |
| RUSTSEC-2024-0436 | @Smooveemaan | 2026-08-30 | 2026-11-30 | Unmaintained; `paste` 1.0.15 through Stronghold; no patched release | The proc macro does not process runtime input. Track replacement through `iota_stronghold` updates. |
| RUSTSEC-2025-0075 | @Smooveemaan | 2026-08-30 | 2026-11-30 | Unmaintained; `unic-char-range` 0.9.0 through Tauri `urlpattern` | No direct runtime API use; renderer CSP and text rendering remain in force. Track removal through Tauri updates. |
| RUSTSEC-2025-0080 | @Smooveemaan | 2026-08-30 | 2026-11-30 | Unmaintained; `unic-common` 0.9.0 through Tauri `urlpattern` | No direct runtime API use; renderer CSP and text rendering remain in force. Track removal through Tauri updates. |
| RUSTSEC-2025-0081 | @Smooveemaan | 2026-08-30 | 2026-11-30 | Unmaintained; `unic-char-property` 0.9.0 through Tauri `urlpattern` | No direct runtime API use; renderer CSP and text rendering remain in force. Track removal through Tauri updates. |
| RUSTSEC-2025-0098 | @Smooveemaan | 2026-08-30 | 2026-11-30 | Unmaintained; `unic-ucd-version` 0.9.0 through Tauri `urlpattern` | No direct runtime API use; renderer CSP and text rendering remain in force. Track removal through Tauri updates. |
| RUSTSEC-2025-0100 | @Smooveemaan | 2026-08-30 | 2026-11-30 | Unmaintained; `unic-ucd-ident` 0.9.0 through Tauri `urlpattern` | No direct runtime API use; renderer CSP and text rendering remain in force. Track removal through Tauri updates. |
| RUSTSEC-2025-0141 | @Smooveemaan | 2026-08-30 | 2026-11-30 | Unmaintained; `bincode` 1.3.3 through Stronghold; upstream considers 1.3.3 complete | Vault snapshots are application-owned, authenticated, excluded from import, and corruption fails closed. Track replacement through `iota_stronghold` updates. |

The dependency review found no compatible direct upgrade that removes these
transitive packages as of 2026-08-31. Remove an ignore as soon as a compatible
fix is available; extending a deadline requires a fresh security review.

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
