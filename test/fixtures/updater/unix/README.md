# Signed Unix package fixtures

These are synthetic metadata-only packages at version `0.2.0`, not runnable
applications or installable releases. The AppImage has a minimal ELF64 header
and a Zstandard-compressed SquashFS containing `ftpeach-update-version`.
The Mac tarball contains `FTPeach.app/Contents/Info.plist`; the Debian archive
contains gzip-compressed `control` metadata and a placeholder data member.

The throwaway public key verifies only these test signatures. Its private key
is not part of the repository and must never sign a release. Tests exercise
the real signature and embedded-version checks with a captured installer
callback, including tampering, a forged announcement and a downgrade.
