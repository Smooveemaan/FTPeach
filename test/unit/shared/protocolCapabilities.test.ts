import assert from 'node:assert/strict';
import test from 'node:test';
import { canCreateNamedFile } from '../../../src/shared/protocolCapabilities.ts';

test('a named file can only be created where the protocol cannot replace one by accident', () => {
  assert.equal(canCreateNamedFile({ kind: 'local', protocol: null }), true);
  assert.equal(canCreateNamedFile({ kind: 'remote', protocol: 'sftp' }), true);
  assert.equal(canCreateNamedFile({ kind: 'remote', protocol: 'webdav' }), true);
  // FTP's STOR truncates the name it is given, and the backend refuses it, so
  // no entry point may ask for a name it cannot use.
  assert.equal(canCreateNamedFile({ kind: 'remote', protocol: 'ftp' }), false);
  assert.equal(canCreateNamedFile({ kind: 'remote', protocol: 'ftps' }), false);
  assert.equal(canCreateNamedFile({ kind: 'remote', protocol: null }), false);
});
