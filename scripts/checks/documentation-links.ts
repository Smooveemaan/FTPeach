// Suggested documents for the optional documentation review tool.
export interface DocLink {
  code: RegExp;
  docs: readonly string[];
}

/**
 * Code whose changes usually change a document. Kept short on purpose: a link
 * that fires on most edits gets waved through, and that teaches nothing.
 */
export const DOC_LINKS: readonly DocLink[] = [
  {
    code: /^src-tauri\/src\/protocol\//,
    docs: [
      'docs/protocol-support.md',
      'docs/guide/protocol-reference.md',
      'docs/networking.md',
      'docs/guide/connecting.md',
      'docs/guide/ftp.md',
      'docs/guide/ftps.md',
      'docs/guide/sftp.md',
      'docs/guide/webdav.md',
      'docs/guide/transfers.md',
    ],
  },
  {
    code: /^src-tauri\/src\/(?:transfer|application)\/|^src-tauri\/src\/protocol\/transfer_file\.rs$/,
    docs: ['docs/transfer-safety.md', 'docs/guide/transfers.md', 'docs/guide/editing.md'],
  },
  {
    code: /^src-tauri\/src\/(?:store|security)\//,
    docs: [
      'docs/storage.md',
      'docs/security.md',
      'docs/guide/passwords.md',
      'docs/guide/portable.md',
    ],
  },
  {
    code: /^src-tauri\/capabilities\//,
    docs: ['docs/ipc-permissions.md'],
  },
  {
    code: /^src-tauri\/src\/runtime\/(?:updater|update_staging)/,
    docs: ['docs/updater-signing.md'],
  },
];
