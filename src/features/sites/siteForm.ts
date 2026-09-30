import type {
  ConnectionForm,
  ManagedSite,
  ServerSettings,
  SiteProtocol,
} from '../../shared/siteContracts.ts';

export type NormalizedSitePayload = Record<string, unknown> & { id?: string; name: string };

export const DEFAULT_SITE_PORTS: Partial<Record<SiteProtocol, string>> = {
  ftp: '21',
  ftps: '21',
  sftp: '22',
};

export function createSiteForm(site?: ManagedSite | null): SiteForm {
  return {
    maxConnections: site?.maxConnections ? String(site.maxConnections) : '',
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
    // The root is the default, which the field shows as its placeholder.
    remotePath: site?.remotePath === '/' ? '' : site?.remotePath || '',
    allowInvalidCert: !!site?.allowInvalidCert,
    allowCleartextAuth: !!site?.allowCleartextAuth,
    caCertPath: site?.caCertPath || '',
    encoding: site?.encoding || '',
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

export function siteFormsEqual(a: SiteForm, b: SiteForm): boolean {
  return (Object.keys(a) as (keyof SiteForm)[]).every((key) => a[key] === b[key]);
}

export function createPaneSiteForm(pane: {
  kind?: 'local' | 'remote';
  form: ConnectionForm;
  path: string;
}): SiteForm {
  if (pane.kind === 'local') {
    return {
      ...createSiteForm(),
      kind: 'local',
      name: pane.path.split(/[\\/]/).filter(Boolean).at(-1) || pane.path,
      localPath: pane.path,
    };
  }
  return {
    ...createSiteForm(),
    ...pane.form,
    name: pane.form.protocol === 'webdav' ? pane.form.webdavUrl : pane.form.host,
    remotePath: pane.path === '/' ? '' : pane.path,
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
      icon: form.icon || 'bookmark',
      color: form.color,
    };
  }
  const defaultPort = DEFAULT_SITE_PORTS[form.protocol] || '21';
  const server: ServerSettings = {
    protocol: form.protocol,
    host: form.host.trim(),
    // Form controls expose strings, but the typed Rust contract expects a JSON number.
    port: Number(form.port.trim() || defaultPort),
    webdavUrl: form.webdavUrl.trim(),
    user: form.user.trim(),
    remotePath: form.remotePath.trim() || '/',
    allowInvalidCert: form.allowInvalidCert,
    allowCleartextAuth: form.allowCleartextAuth,
    caCertPath: form.caCertPath,
    useKeyAuth: form.useKeyAuth,
    keyPath: form.keyPath,
    // Only FTP names files in a server-chosen encoding.
    encoding: form.protocol === 'ftp' || form.protocol === 'ftps' ? form.encoding : '',
    maxConnections: Number(form.maxConnections.trim() || 0),
  };
  return {
    ...identity,
    ...server,
    name: form.name.trim(),
    password: form.useKeyAuth ? '' : secrets.password,
    removePassword: form.removePassword,
    keyPassphrase: secrets.keyPassphrase,
    removeKeyPassphrase: form.removeKeyPassphrase,
    parentId: form.parentId,
    icon: form.icon,
    color: form.color,
  };
}

/** Blank or 0 is no limit; otherwise one browsing connection plus at least one for transfers. */
export function isValidConnectionLimit(value: string): boolean {
  const limit = value.trim();
  return (
    limit === '' ||
    (/^\d+$/.test(limit) && (Number(limit) === 0 || (Number(limit) >= 2 && Number(limit) <= 128)))
  );
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
    isValidConnectionLimit(form.maxConnections) &&
    (form.protocol === 'webdav' ? form.webdavUrl.trim() : form.host.trim())
  );
}

export interface SiteForm {
  maxConnections: string;
  kind: 'site' | 'local';
  name: string;
  localPath: string;
  protocol: SiteProtocol;
  host: string;
  port: string;
  webdavUrl: string;
  user: string;
  password: string;
  hasPassword: boolean;
  removePassword: boolean;
  remotePath: string;
  allowInvalidCert: boolean;
  allowCleartextAuth: boolean;
  caCertPath: string;
  encoding: string;
  useKeyAuth: boolean;
  keyPath: string;
  keyPassphrase: string;
  hasKeyPassphrase: boolean;
  removeKeyPassphrase: boolean;
  parentId: string | null;
  icon: string;
  color: string;
}
