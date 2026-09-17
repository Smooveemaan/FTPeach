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

export type SiteEncodingScript =
  | 'cyrillic'
  | 'westernEuropean'
  | 'centralEuropean'
  | 'greek'
  | 'turkish'
  | 'hebrew'
  | 'arabic'
  | 'baltic'
  | 'vietnamese'
  | 'thai'
  | 'japanese'
  | 'simplifiedChinese'
  | 'traditionalChinese'
  | 'korean';

/**
 * File name encodings an FTP site can use besides UTF-8, grouped by script.
 * `value` is the WHATWG label the backend looks the encoding up by.
 */
export const SITE_ENCODINGS: readonly {
  value: string;
  name: string;
  script: SiteEncodingScript;
}[] = [
  { value: 'windows-1251', name: 'Windows-1251', script: 'cyrillic' },
  { value: 'koi8-r', name: 'KOI8-R', script: 'cyrillic' },
  { value: 'ibm866', name: 'CP866', script: 'cyrillic' },
  { value: 'windows-1252', name: 'Windows-1252', script: 'westernEuropean' },
  { value: 'windows-1250', name: 'Windows-1250', script: 'centralEuropean' },
  { value: 'iso-8859-2', name: 'ISO-8859-2', script: 'centralEuropean' },
  { value: 'windows-1253', name: 'Windows-1253', script: 'greek' },
  { value: 'windows-1254', name: 'Windows-1254', script: 'turkish' },
  { value: 'windows-1255', name: 'Windows-1255', script: 'hebrew' },
  { value: 'windows-1256', name: 'Windows-1256', script: 'arabic' },
  { value: 'windows-1257', name: 'Windows-1257', script: 'baltic' },
  { value: 'windows-1258', name: 'Windows-1258', script: 'vietnamese' },
  { value: 'windows-874', name: 'Windows-874', script: 'thai' },
  { value: 'shift_jis', name: 'Shift_JIS', script: 'japanese' },
  { value: 'euc-jp', name: 'EUC-JP', script: 'japanese' },
  { value: 'gbk', name: 'GBK', script: 'simplifiedChinese' },
  { value: 'big5', name: 'Big5', script: 'traditionalChinese' },
  { value: 'euc-kr', name: 'EUC-KR', script: 'korean' },
];

export function siteMeta(site: ManagedSite): string {
  return site.protocol === 'webdav'
    ? `WEBDAV · ${site.user || i18n.t('common.noLoginUser')} · ${site.webdavUrl || ''}`
    : `${(site.protocol ?? 'ftp').toUpperCase()} · ${site.user || i18n.t('common.anonymousUser')}@${site.host}:${site.port}`;
}
