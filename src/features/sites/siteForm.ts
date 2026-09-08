import type { ManagedSite, SiteForm, SiteProtocol } from '../../shared/types.ts';

export type NormalizedSitePayload = Record<string, unknown> & { id?: string; name: string };

export const DEFAULT_SITE_PORTS: Partial<Record<SiteProtocol, string>> = {
  ftp: '21',
  ftps: '21',
  sftp: '22',
};

export function createSiteForm(site?: ManagedSite | null): SiteForm {
  return {
    kind: site?.kind === 'local' ? 'local' : 'site',
    name: site?.name || '',
    localPath: site?.localPath || '',
    protocol: site?.protocol || 'ftp',
    host: site?.host || '',
    port: site?.port ? String(site.port) : '',
    webdavUrl: site?.webdavUrl || '',
    user: site?.user || '',
    password: '',
    hasPassword: !!site?.hasPassword,
    removePassword: false,
    remotePath: site?.remotePath || '/',
    allowInvalidCert: !!site?.allowInvalidCert,
    caCertPath: site?.caCertPath || '',
    useKeyAuth: !!site?.useKeyAuth,
    keyPath: site?.keyPath || '',
    keyPassphrase: '',
    hasKeyPassphrase: !!site?.hasKeyPassphrase,
    removeKeyPassphrase: false,
    parentId: site?.parentId ?? null,
    icon: site?.icon || 'bookmark',
    color: site?.color || '',
  };
}

export interface SiteFormSecrets {
  password: string;
  keyPassphrase: string;
}

export function normalizeSiteForm(
  form: SiteForm,
  editingId?: string | null,
  secrets: SiteFormSecrets = { password: '', keyPassphrase: '' },
): NormalizedSitePayload {
  // A new site carries no `id` key at all rather than an `id` of `undefined`:
  // the backend tells create from update by whether the field is there.
  const id = editingId === '__new__' ? undefined : editingId || undefined;
  const identity = id === undefined ? {} : { id };
  if (form.kind === 'local') {
    return {
      ...identity,
      kind: 'local',
      name: form.name.trim(),
      localPath: form.localPath.trim(),
      parentId: form.parentId,
      icon: form.icon || 'folder',
      color: form.color,
    };
  }
  const defaultPort = DEFAULT_SITE_PORTS[form.protocol] || '21';
  const parsedPort = Number(form.port.trim() || defaultPort);
  return {
    ...identity,
    name: form.name.trim(),
    protocol: form.protocol,
    host: form.host.trim(),
    // Form controls expose strings, but the typed Rust contract expects a JSON number.
    port: parsedPort,
    webdavUrl: form.webdavUrl.trim(),
    user: form.user.trim(),
    password: form.useKeyAuth ? '' : secrets.password,
    removePassword: form.removePassword,
    allowInvalidCert: form.allowInvalidCert,
    caCertPath: form.caCertPath,
    remotePath: form.remotePath.trim() || '/',
    useKeyAuth: form.useKeyAuth,
    keyPath: form.keyPath,
    keyPassphrase: secrets.keyPassphrase,
    removeKeyPassphrase: form.removeKeyPassphrase,
    parentId: form.parentId,
    icon: form.icon,
    color: form.color,
  };
}

export function canSubmitSiteForm(form: SiteForm): boolean {
  if (form.kind === 'local') return !!(form.name.trim() && form.localPath.trim());
  const port = form.port.trim();
  const validPort =
    form.protocol === 'webdav' ||
    port === '' ||
    (/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535);
  return !!(
    form.name.trim() &&
    validPort &&
    (form.protocol === 'webdav' ? form.webdavUrl.trim() : form.host.trim())
  );
}
