import type { UpdaterStatus } from '../../src/platform/ipcContracts.ts';
import defaults from '../../src/shared/settingsDefaults.json';
import type { FileEntry, ManagedSite } from '../../src/shared/types.ts';

const ok = { ok: true } as const;
const unsubscribe = () => {};
const updateListeners = new Set<(_status: UpdaterStatus) => void>();
const emitUpdate = (status: UpdaterStatus) =>
  updateListeners.forEach((listener) => listener(status));

const localEntries: FileEntry[] = [
  { name: 'Projects', isDirectory: true, modifiedAt: '2026-08-30T12:00:00Z' },
  { name: 'Downloads', isDirectory: true, modifiedAt: '2026-08-29T08:15:00Z' },
  {
    name: 'release-notes.md',
    isDirectory: false,
    size: 18_432,
    modifiedAt: '2026-09-01T09:30:00Z',
  },
  {
    name: 'ftpeach-backup.zip',
    isDirectory: false,
    size: 7_340_032,
    modifiedAt: '2026-08-28T18:42:00Z',
  },
];

const remoteEntries: FileEntry[] = [
  {
    name: 'public_html',
    isDirectory: true,
    permissions: 'drwxr-xr-x',
    modifiedAt: '2026-08-31T20:00:00Z',
  },
  {
    name: 'backups',
    isDirectory: true,
    permissions: 'drwx------',
    modifiedAt: '2026-08-27T06:40:00Z',
  },
  {
    name: 'index.html',
    isDirectory: false,
    size: 28_672,
    permissions: '-rw-r--r--',
    modifiedAt: '2026-09-01T10:05:00Z',
  },
  {
    name: 'robots.txt',
    isDirectory: false,
    size: 248,
    permissions: '-rw-r--r--',
    modifiedAt: '2026-08-22T14:12:00Z',
  },
];

const sites: ManagedSite[] = [
  {
    id: 'production',
    name: 'Production',
    protocol: 'sftp',
    host: 'sftp.example.com',
    port: 22,
    user: 'deploy',
    remotePath: '/var/www',
    icon: 'server',
    color: '#f59e0b',
  },
  {
    id: 'staging',
    name: 'Staging',
    protocol: 'webdav',
    webdavUrl: 'https://files.example.com/dav',
    user: 'editor',
    remotePath: '/',
    icon: 'cloud',
    color: '#60a5fa',
  },
];

/** `?lang=ar` on the harness URL. The app takes its language (and, through
 * `i18n.dir`, the document's `dir`) from this setting, so a spec asks for an
 * RTL render the same way a user would: by choosing the language. */
const requestedLanguage = new URLSearchParams(window.location.search).get('lang');

const settings = {
  ...defaults,
  autoCheckUpdates: false,
  autoReconnectTabs: true,
  legacyPasswordNoticeShown: true,
  plaintextSecretNoticeShown: true,
  ...(requestedLanguage ? { language: requestedLanguage } : {}),
};

const resolved = <T>(value: T) => Promise.resolve(value);

export const visualTestApi = {
  settings: {
    get: () => resolved(settings),
    set: () => resolved(ok),
    revealProxyPassword: () => resolved(null),
  },
  sites: {
    list: () => resolved(sites),
    save: () => resolved(ok),
    delete: () => resolved(ok),
    saveFolder: () => resolved(ok),
    deleteFolder: () => resolved(ok),
    applyLayout: () => resolved(ok),
    hasLegacySecret: () => resolved(false),
    hasPlaintextSecret: () => resolved(false),
    revealSecret: () => resolved({ ...ok, value: '' }),
  },
  tabs: {
    get: () =>
      resolved({
        activeTabId: 'production-tab',
        tabs: [
          {
            id: 'production-tab',
            name: 'Production',
            panes: {
              a: { kind: 'local' as const, path: 'C:\\Users\\developer\\Projects' },
              b: { kind: 'remote' as const, siteId: 'production', path: '/var/www' },
            },
          },
          {
            id: 'staging-tab',
            name: 'Staging',
            panes: {
              a: { kind: 'local' as const, path: 'C:\\Users\\developer\\Downloads' },
              b: { kind: 'remote' as const, siteId: 'staging', path: '/' },
            },
          },
        ],
      }),
    set: () => resolved(ok),
    clear: () => resolved(ok),
  },
  fsLocal: {
    list: (path = 'C:\\Users\\developer\\Projects') =>
      resolved({ ok: true, path, entries: localEntries }),
    homedir: () => resolved('C:\\Users\\developer'),
    drives: () => resolved([{ path: 'C:\\', label: 'Windows (C:)' }]),
    mkdir: () => resolved(ok),
    rename: () => resolved(ok),
    copyFile: () => resolved(ok),
    delete: () => resolved(ok),
    createFile: () => resolved(ok),
    revealPath: () => resolved(ok),
    openDocument: () => resolved(ok),
    executePath: () => resolved(ok),
    selectDir: () => resolved(null),
    selectKeyFile: () => resolved(null),
    selectCaCertFile: () => resolved(null),
    selectApplication: () => resolved(null),
    pathForFile: () => null,
    isDir: () => resolved(false),
    onOsDragDrop: () => unsubscribe,
  },
  session: {
    connect: () => resolved(ok),
    cancelConnect: () => resolved(ok),
    disconnect: () => resolved(ok),
    list: () => resolved({ ok: true, entries: remoteEntries }),
    mkdir: () => resolved(ok),
    createFile: () => resolved(ok),
    delete: () => resolved(ok),
    rename: () => resolved(ok),
    chmod: () => resolved(ok),
    forgetHostKey: () => resolved(ok),
  },
  transfer: {
    upload: () => resolved(ok),
    download: () => resolved(ok),
    remoteCopy: () => resolved(ok),
    cancel: () => resolved(ok),
    cancelRemoteCopy: () => resolved(ok),
    onProgress: () => unsubscribe,
    onDragOutStarted: () => unsubscribe,
  },
  updater: {
    check: () => resolved(ok),
    download: () => {
      emitUpdate({ state: 'downloading', version: '0.3.2', percent: 0 });
      let percent = 0;
      const timer = window.setInterval(() => {
        percent += 5;
        emitUpdate(
          percent < 100
            ? { state: 'downloading', version: '0.3.2', percent }
            : { state: 'downloaded', version: '0.3.2' },
        );
        if (percent >= 100) window.clearInterval(timer);
      }, 250);
      return resolved(ok);
    },
    install: () => resolved(ok),
    onStatus: (callback: (_status: UpdaterStatus) => void) => {
      const params = new URLSearchParams(window.location.search);
      const state = params.get('update');
      updateListeners.add(callback);
      if (state === 'available' || state === 'downloaded' || state === 'downloading') {
        const rawPercent = params.get('percent');
        const percent = rawPercent == null ? undefined : Number(rawPercent);
        callback(
          state !== 'downloading'
            ? { state, version: '0.3.2' }
            : {
                state,
                version: '0.3.2',
                ...(percent != null && Number.isFinite(percent) ? { percent } : {}),
              },
        );
      }
      return () => {
        updateListeners.delete(callback);
      };
    },
  },
  proxy: { test: () => resolved(ok) },
  openWith: {
    start: () => resolved(ok),
    stop: () => resolved(ok),
    onChanged: () => unsubscribe,
    onProgress: () => unsubscribe,
  },
  log: {
    setEnabled: () => resolved(ok),
    setFileLogging: () => resolved(ok),
    save: () => resolved(ok),
    exportDiagnostics: () => resolved(ok),
    onMessage: () => unsubscribe,
  },
  shortcuts: {
    onKeyDown: (callback: (_event: KeyboardEvent) => void) => {
      window.addEventListener('keydown', callback, { capture: true });
      return () => window.removeEventListener('keydown', callback, { capture: true });
    },
  },
  vault: {
    status: () =>
      resolved({
        configured: true,
        locked: false,
        systemUnlockAvailable: true,
        systemUnlockEnabled: true,
      }),
    setup: () => resolved(ok),
    unlock: () => resolved(ok),
    lock: () => resolved(ok),
    enableSystemUnlock: () => resolved(ok),
    unlockSystem: () => resolved(ok),
    disableSystemUnlock: () => resolved(ok),
    changePassword: () => resolved(ok),
    reset: () => resolved(ok),
    useSystemProtection: () => resolved(ok),
  },
  app: {
    version: () => resolved('0.2.0-visual'),
    systemHourCycle: () => resolved<'h23'>('h23'),
    setWindowTheme: () => {},
    resetLayout: () => resolved(ok),
    exportSettings: () => resolved(ok),
    importSettings: () => resolved(ok),
    openExternal: () => resolved(ok),
    openDevtools: () => resolved(ok),
  },
  notifications: { transfersComplete: () => resolved(ok) },
  tray: { setLabels: () => resolved(ok) },
} as unknown as Window['api'];
