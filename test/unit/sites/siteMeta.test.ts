import assert from 'node:assert/strict';
import test from 'node:test';
import i18n from '../../../src/i18n/index.ts';
import {
  siteMeta,
  SITE_COLORS,
  SITE_ICONS,
  SITE_ICON_LABEL_KEYS,
} from '../../../src/features/sites/siteMeta.ts';

test('site summaries distinguish protocols and translated missing users', async () => {
  await i18n.changeLanguage('en');
  const site = { id: 'site', name: 'Example', host: 'example.org', port: 21 };
  assert.equal(siteMeta(site), `FTP · ${i18n.t('common.anonymousUser')}@example.org:21`);
  for (const protocol of ['ftp', 'ftps', 'sftp'] as const) {
    assert.equal(
      siteMeta({ ...site, protocol, user: 'alice' }),
      `${protocol.toUpperCase()} · alice@example.org:21`,
    );
  }
  assert.equal(
    siteMeta({ ...site, protocol: 'webdav', user: 'alice', webdavUrl: 'https://example.org/dav' }),
    'WEBDAV · alice · https://example.org/dav',
  );
  assert.equal(
    siteMeta({ ...site, protocol: 'webdav' }),
    `WEBDAV · ${i18n.t('common.noLoginUser')} · `,
  );
});

test('site palette has a no-color default and unique choices with valid label overrides', () => {
  assert.deepEqual(SITE_COLORS[0], { key: 'default', value: '' });
  assert.equal(new Set(SITE_COLORS.map(({ key }) => key)).size, SITE_COLORS.length);
  assert.equal(new Set(SITE_ICONS).size, SITE_ICONS.length);
  for (const [icon, key] of Object.entries(SITE_ICON_LABEL_KEYS)) {
    assert.ok(SITE_ICONS.some((value) => value === icon));
    assert.ok(i18n.exists(key));
  }
});
