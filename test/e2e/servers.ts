// The test servers of scripts/test-servers/iis.ps1 and openssh.ps1: IIS FTP and
// the OpenSSH SFTP service, unless FTPEACH_E2E_* variables name others. `root` is
// the folder the account lands in, read directly from disk.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Server } from './panes.ts';

export const ftpServer: Server = {
  protocol: 'FTP',
  host: process.env.FTPEACH_E2E_FTP_HOST ?? '127.0.0.1',
  port: process.env.FTPEACH_E2E_FTP_PORT ?? '2121',
  user: process.env.FTPEACH_E2E_FTP_USER ?? 'ftpeach_test',
  password: process.env.FTPEACH_E2E_FTP_PASSWORD ?? 'FTPeach-test-2026!',
  root: process.env.FTPEACH_E2E_FTP_ROOT ?? 'C:\\ftpeach-test-servers\\iis\\FTPeachTestFtp',
};

export const sftpServer: Server = {
  protocol: 'SFTP',
  host: process.env.FTPEACH_E2E_SFTP_HOST ?? '127.0.0.1',
  port: process.env.FTPEACH_E2E_SFTP_PORT ?? '2223',
  user: process.env.FTPEACH_E2E_SFTP_USER ?? 'ftpeach_test',
  password: process.env.FTPEACH_E2E_SFTP_PASSWORD ?? 'FTPeach-test-2026!',
  root: process.env.FTPEACH_E2E_SFTP_ROOT ?? 'C:\\ftpeach-test-servers\\openssh\\root',
};
/** The SFTP server's public host key file. */
const hostKeyFile =
  process.env.FTPEACH_E2E_SFTP_HOST_KEY ??
  'C:\\ftpeach-test-servers\\openssh\\ssh_host_ed25519_key.pub';

/** The fingerprint FTPeach shows: SHA-256 of the key blob, in lowercase hex. */
export function hostKeyFingerprint() {
  const blob = Buffer.from(readFileSync(hostKeyFile, 'utf8').trim().split(/\s+/)[1]!, 'base64');
  return createHash('sha256').update(blob).digest('hex');
}
