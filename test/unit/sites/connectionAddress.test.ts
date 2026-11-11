import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionAddress } from '../../../src/shared/siteContracts.ts';
import { initialForm } from '../../../src/features/file-browser/panes/paneModel.ts';

test('connection addresses include explicit or default ports and bracket IPv6', () => {
  assert.equal(
    connectionAddress({ ...initialForm, host: 'ftp.example.org' }),
    'ftp.example.org:21',
  );
  assert.equal(connectionAddress({ ...initialForm, protocol: 'sftp', host: '::1' }), '[::1]:22');
  assert.equal(connectionAddress({ ...initialForm, host: '[::1]', port: '2121' }), '[::1]:2121');
  assert.equal(connectionAddress(initialForm), '');
});

test('WebDAV addresses retain scheme, port and path without exposing credentials', () => {
  assert.equal(
    connectionAddress({
      ...initialForm,
      protocol: 'webdav',
      webdavUrl: 'https://user:secret@example.org:8443/dav/',
    }),
    'https://example.org:8443/dav/',
  );
  assert.equal(
    connectionAddress({ ...initialForm, protocol: 'webdav', webdavUrl: 'https://example.org/dav' }),
    'https://example.org:443/dav',
  );
  assert.equal(connectionAddress({ ...initialForm, protocol: 'webdav', webdavUrl: 'invalid' }), '');
  assert.equal(
    connectionAddress({ ...initialForm, protocol: 'webdav', webdavUrl: 'file:///secret' }),
    '',
  );
});
