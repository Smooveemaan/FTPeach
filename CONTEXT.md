# FTPeach

A Windows desktop file manager for local files and remote FTP, FTPS, SFTP, and WebDAV servers. This glossary fixes the words used in the product, its security documents, and its code.

## Security

**Supported release**:
The latest published FTPeach release. Security fixes ship only as a new release delivered through the updater; older releases and unreleased commits are not supported.
_Avoid_: supported version, main branch

**System protection**:
The secret-storage mode in which saved secrets are encrypted for the signed-in Windows account, with no master password. Anyone acting as that Windows user can read them.
_Avoid_: Windows account protection, DPAPI mode, legacy storage

**Enhanced protection**:
The secret-storage mode in which every saved secret, including the proxy password, lives in the vault and is unreadable until the vault is unlocked.
_Avoid_: Stronghold mode, protected mode

**Vault**:
The master-password-encrypted store that holds saved secrets under enhanced protection. It is either locked or unlocked.
_Avoid_: protected storage, Stronghold (except when naming the library)

**Saved secret**:
A password or passphrase FTPeach keeps between launches: a saved site's password, an SSH-key passphrase, or the proxy password. Passwords typed for an unsaved connection are not saved secrets.
_Avoid_: credential, stored password

**System unlock**:
Unlocking the vault with Windows Hello instead of the master password. It belongs to enhanced protection and is unrelated to system protection despite the similar name.
_Avoid_: Windows Hello unlock, biometric unlock

**Accepted risk**:
A known weakness the project keeps on purpose and documents in the threat model. A report that only demonstrates an accepted risk is not a vulnerability.
_Avoid_: known issue, won't fix
