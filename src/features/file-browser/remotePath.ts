// Remote-path navigation: what the pane shows above the listing, and where
// "up one level" goes. Both answer questions only the browser asks.

import i18n from '../../i18n/index.ts';

export interface Crumb {
  label: string;
  path: string;
  icon?: 'database';
}

export function parentRemotePath(current: string): string {
  if (current === '/' || current === '') return '/';
  const parts = current.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join('/')}` : '/';
}

export function remoteCrumbs(current: string): Crumb[] {
  const parts = current.split('/').filter(Boolean);
  const crumbs: Crumb[] = [{ label: i18n.t('common.rootFolder'), path: '/', icon: 'database' }];
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}
