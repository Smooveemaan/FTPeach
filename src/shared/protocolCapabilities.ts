import type { PaneKind, SiteProtocol } from './types.ts';

/** The side of an operation, as far as a protocol capability needs to know it. */
export interface ProtocolEndpoint {
  kind: PaneKind;
  protocol: SiteProtocol | null;
}

/**
 * Whether a new, empty file can be created under a name the user chose without
 * putting an existing file at risk.
 *
 * FTP's `STOR` truncates whatever already has that name, and staging a file and
 * renaming it into place has the same race, so the backend refuses the operation
 * (`create_file` in `src-tauri/src/protocol/ftp.rs`). Offering the action anyway
 * would ask the user for a name and only then admit it cannot be used, so every
 * entry point — toolbar, menu and keyboard shortcut — checks this first.
 */
export function canCreateNamedFile({ kind, protocol }: ProtocolEndpoint): boolean {
  return kind === 'local' || protocol === 'sftp' || protocol === 'webdav';
}
