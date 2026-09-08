# Manual end-to-end scripts

These scenarios are not part of the automated test suite: they require real servers and are run manually. They are ready-to-run Playwright drivers retained from manual testing sessions so the end-to-end checks do not need to be rewritten each time.

## Running the scripts

The scripts use `playwright-core` to control an isolated application window. It is intentionally not a project dependency, so install it temporarily before running a scenario:

```sh
npm install --no-save playwright-core
```

Run a script from the repository root in Git Bash or another POSIX-like environment. Clear `ELECTRON_RUN_AS_NODE` and use the isolated `--user-data-dir` already configured by each script so the real `%APPDATA%\FTPeach` profile is not touched:

```sh
VERIFY_SCRATCH=/path/to/a/temporary/directory env -u ELECTRON_RUN_AS_NODE node --experimental-strip-types scripts/manual-tests/<script>.ts
```

Afterward, run `npm uninstall --no-save playwright-core` if it was installed only for this check.

## Scripts

- **`verify-demo-wftpserver.ts`** performs a full FTP and FTPS pass against the public Wing FTP Server demo (`demo.wftpserver.com`, `demo`/`demo`). Read the limitations below before using it.
- **`create-icon-category-samples.ps1`** creates a set of dummy files (image, archive, code, and so on) in a target directory for manually checking file-type icons and size formatting: `powershell -File scripts/manual-tests/create-icon-category-samples.ps1 -TargetDirectory <dir>`.

### Notes about demo.wftpserver.com

- The account can write only under `/upload` and cannot rename or delete files. This is a public server shared by all testers. The script creates one test file and does not attempt to remove it.
- Plain FTP may stall on the passive data channel in some networks. In one reproduced environment, data transferred correctly but the TCP socket did not close cleanly, probably because of an FTP ALG on the home router. FTPS against the same server completed reliably. If the FTP phase stalls, investigate the current network before treating it as an application defect.
- A local test server without these restrictions can provide full read/write access and avoid interference from NAT or FTP ALG behavior.
