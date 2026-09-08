// How a saved site presents itself: the icon and colour it can be given, and
// the one-line summary shown under its name.

import i18n from '../../i18n/index.ts';

import type { ManagedSite } from '../../shared/types.ts';

export const SITE_ICONS = [
  'bookmark',
  'globe',
  'briefcase',
  'house',
  'cloud',
  'flask',
  'gamepad',
  'clapperboard',
  'camera',
  'building2',
  'bookOpen',
  'music',
  'codeXml',
  'mapPin',
  'graduationCap',
  'shoppingBag',
  'heart',
  'newspaper',
] as const;

export const SITE_ICON_LABEL_KEYS: Partial<Record<(typeof SITE_ICONS)[number], string>> = {
  building2: 'siteManagerDialog.icons.briefcase',
  bookOpen: 'menu.help.documentation',
  music: 'siteManagerDialog.icons.clapperboard',
  codeXml: 'aboutDialog.sourceCode',
  mapPin: 'siteManagerDialog.icons.globe',
  graduationCap: 'menu.help.documentation',
  shoppingBag: 'siteManagerDialog.icons.bookmark',
  heart: 'siteManagerDialog.icons.bookmark',
  newspaper: 'menu.help.documentation',
};

export interface SiteColorOption {
  key: string;
  value: string;
}

/** The first entry is the "no colour" default every unmatched lookup lands on. */
export const SITE_COLORS: [SiteColorOption, ...SiteColorOption[]] = [
  { key: 'default', value: '' },
  { key: 'peach', value: 'var(--accent-primary)' },
  { key: 'red', value: 'var(--accent-red)' },
  { key: 'amber', value: 'var(--accent-amber)' },
  { key: 'green', value: 'var(--accent-green)' },
  { key: 'blue', value: 'var(--file-text)' },
  { key: 'purple', value: 'var(--file-code)' },
  { key: 'pink', value: 'var(--file-video)' },
  { key: 'teal', value: 'var(--file-spreadsheet)' },
];

export function siteMeta(site: ManagedSite): string {
  return site.protocol === 'webdav'
    ? `WEBDAV · ${site.user || i18n.t('common.noLoginUser')} · ${site.webdavUrl || ''}`
    : `${(site.protocol ?? 'ftp').toUpperCase()} · ${site.user || i18n.t('common.anonymousUser')}@${site.host}:${site.port}`;
}
