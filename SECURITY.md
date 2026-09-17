# Security policy

## Supported versions

Only the latest published release is supported. Security fixes ship as a new release and reach users through the built-in updater; older releases and unreleased commits do not receive fixes.

## Reporting a vulnerability

Do not open a public issue. On the **Security** tab of the `Smooveemaan/ftpeach` repository, select **Report a vulnerability** and submit a private security advisory. Include the affected version, reproduction steps, impact, and a minimal proof of concept without real credentials.

If private reporting is unavailable, open an issue without technical details and ask for it to be enabled. Do not test against systems or data you do not own.

## What to expect

- We aim to acknowledge a report within seven days.
- We aim to release a fix within 90 days of the report. This is a target, not a guarantee; if a fix needs longer, we will tell you why and agree on a new date.
- Do not disclose details before the agreed disclosure date.
- A fix for a vulnerability in a published release comes with a GitHub Security Advisory, and we request a CVE for it through GitHub.

## Not a vulnerability

The threat model in [`docs/security.md`](docs/security.md) documents the risks FTPeach accepts on purpose. A report that only demonstrates one of them will be closed, though we still welcome reports that bypass a mitigation described there. See [Explicitly accepted risks](docs/security.md#explicitly-accepted-risks) for the reasoning.

- Plain FTP sends passwords and files unencrypted.
- A connection with **Allow invalid certificates** enabled can be intercepted.
- The first SFTP connection to a host trusts its key, and a user can approve a changed host key.
- Malware running as the signed-in Windows user, or with access to the FTPeach process memory, can reach saved secrets.
- Under system protection, saved secrets are readable by anyone signed in as that Windows user, without a master password.
- An application opened through **Open with** can keep, sync, or leak the file it received.
- Failed vault unlock attempts are counted per application run and reset on restart.
- RSA SSH keys are exposed to `RUSTSEC-2023-0071`.
- With security confirmations turned off in settings, sensitive actions run without a prompt.

A chain that lets web content or a remote server run commands through the application's renderer is in scope, even if each command is individually allowed.
