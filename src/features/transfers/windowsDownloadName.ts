// Refuses a download the backend would refuse, before its row is queued. The
// authority is src-tauri/src/local_fs/windows_names.rs; test/fixtures/windows-names.json
// holds the two to the same verdicts.
export function validateWindowsDownloadName(relativePath: string): void {
  for (const name of relativePath.split(/[\\/]/)) {
    const stem = name.split('.')[0]!.toUpperCase();
    if (
      !name ||
      name === '.' ||
      name === '..' ||
      /[<>:"|?*]/.test(name) ||
      [...name].some(
        (c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159),
      ) ||
      /[. ]$/.test(name) ||
      /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])$/.test(
        stem,
      )
    ) {
      throw new Error(`${relativePath}: Invalid Windows download name`);
    }
  }
}
