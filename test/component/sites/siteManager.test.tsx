import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { SiteManagerDialog } from '../../../src/features/sites/ui.ts';
import type { SiteManagerDialogProps } from '../../../src/features/sites/SiteManagerDialog.tsx';
import type { ManagedSite } from '../../../src/shared/types.ts';
import { createPaneSiteForm, createSiteForm } from '../../../src/features/sites/siteForm.ts';
import { tauriApi } from '../../../src/platform/tauriApi.ts';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const entries: ManagedSite[] = [
  { id: 'folder-1', kind: 'folder', name: 'Servers', parentId: null },
  {
    id: 'local-folder-1',
    kind: 'folder',
    managerScope: 'localPaths',
    name: 'Projects',
    parentId: null,
  },
  {
    id: 'local-1',
    kind: 'local',
    name: 'Workspace',
    localPath: 'C:\\Workspace',
    parentId: 'local-folder-1',
  },
  {
    id: 'site-1',
    kind: 'site',
    name: 'Production',
    protocol: 'sftp',
    host: 'prod.example.test',
    port: 22,
    user: 'deploy',
    hasPassword: true,
    remotePath: '/',
    parentId: 'folder-1',
  },
];

const searchEntries: ManagedSite[] = [
  ...entries,
  {
    id: 'site-2',
    kind: 'site',
    name: 'Docs Bucket',
    protocol: 'webdav',
    webdavUrl: 'https://docs.example.test/dav',
    user: 'reader',
    remotePath: '/',
    parentId: null,
  },
];

function renderManager(overrides: Partial<SiteManagerDialogProps> = {}) {
  const props = {
    entries,
    onSave: vi.fn(async () => ({ ok: true })),
    onDelete: vi.fn(async () => ({ ok: true })),
    onApplyLayout: vi.fn(async () => ({ ok: true })),
    onSaveFolder: vi.fn(async () => ({ ok: true })),
    onDeleteFolder: vi.fn(async () => ({ ok: true })),
    onConnect: vi.fn(),
    onImport: vi.fn(),
    onExport: vi.fn(),
    onVaultUnlockRequired: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<SiteManagerDialog {...props} />), props };
}

function requireHtml(element: Element | null | undefined): HTMLElement {
  if (!(element instanceof HTMLElement)) throw new Error('Expected an HTML element');
  return element;
}

function installSiteManagerApiMocks() {
  window.api = {
    ...tauriApi,
    vault: {
      ...tauriApi.vault,
      status: vi.fn(async () => ({
        configured: false,
        locked: false,
        systemUnlockAvailable: false,
        systemUnlockEnabled: false,
      })),
    },
    sites: { ...tauriApi.sites, revealSecret: vi.fn() },
    fsLocal: { ...tauriApi.fsLocal, selectKeyFile: vi.fn() },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Site Manager workflows', () => {
  beforeEach(() => {
    installSiteManagerApiMocks();
  });

  test.each(['ftp', 'ftps', 'sftp', 'webdav'] as const)(
    'prefills and saves a %s connection using the manager form',
    async (protocol) => {
      const user = userEvent.setup();
      const useKeyAuth = protocol === 'sftp';
      const initialForm = createPaneSiteForm({
        kind: 'remote',
        path: '/uploads/current',
        form: {
          ...createSiteForm(),
          protocol,
          host: 'draft.example.test',
          port: '2222',
          webdavUrl: 'https://draft.example.test/dav',
          user: 'draft-user',
          password: 'draft-password',
          useKeyAuth,
          keyPath: 'C:\\keys\\private-key',
          keyPassphrase: 'draft-passphrase',
          caCertPath: 'C:\\certs\\ca.pem',
          allowInvalidCert: true,
        },
      });
      const { props } = renderManager({ initialForm });
      expect(screen.queryByRole('tree')).toBeNull();
      expect(screen.getByLabelText<HTMLInputElement>('siteManagerDialog.fields.name').value).toBe(
        protocol === 'webdav' ? initialForm.webdavUrl : initialForm.host,
      );
      expect(screen.getByLabelText<HTMLInputElement>('connectionBar.fields.address').value).toBe(
        protocol === 'webdav' ? initialForm.webdavUrl : initialForm.host,
      );
      expect(screen.getByLabelText<HTMLInputElement>('connectionBar.fields.user').value).toBe(
        'draft-user',
      );
      expect(
        screen.getByLabelText<HTMLInputElement>('siteManagerDialog.fields.remotePath').value,
      ).toBe('/uploads/current');
      const secret = screen.getByLabelText<HTMLInputElement>(
        useKeyAuth ? 'connectionBar.fields.passphrase' : 'connectionBar.fields.password',
      );
      expect(secret.value).toBe(useKeyAuth ? 'draft-passphrase' : 'draft-password');
      expect(secret.type).toBe('password');
      await user.click(screen.getByRole('button', { name: 'siteManagerDialog.fields.folder' }));
      await user.click(screen.getByRole('option', { name: 'Servers' }));
      await user.click(screen.getByRole('button', { name: 'common.save' }));
      expect(props.onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          protocol,
          host: initialForm.host,
          port: 2222,
          webdavUrl: initialForm.webdavUrl,
          user: 'draft-user',
          remotePath: '/uploads/current',
          password: useKeyAuth ? '' : 'draft-password',
          keyPassphrase: useKeyAuth ? 'draft-passphrase' : '',
          useKeyAuth,
          keyPath: initialForm.keyPath,
          caCertPath: initialForm.caCertPath,
          allowInvalidCert: true,
          parentId: 'folder-1',
        }),
      );
    },
  );

  test('opens a prefilled local path and closes on cancel without saving', async () => {
    const user = userEvent.setup();
    const { props } = renderManager({
      managerKind: 'localPaths',
      initialForm: createPaneSiteForm({
        kind: 'local',
        path: 'C:\\Projects',
        form: createSiteForm(),
      }),
    });
    expect(screen.getByLabelText<HTMLInputElement>('siteManagerDialog.fields.name').value).toBe(
      'Projects',
    );
    expect(
      screen.getByLabelText<HTMLInputElement>('siteManagerDialog.fields.localPath').value,
    ).toBe('C:\\Projects');
    await user.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  test('creates and edits a bookmark through the form', async () => {
    const user = userEvent.setup();
    const { props } = renderManager();

    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.addBookmark' }));
    await user.type(screen.getByRole('textbox', { name: 'siteManagerDialog.fields.name' }), 'Test');
    await user.type(
      screen.getByRole('textbox', { name: 'connectionBar.fields.address' }),
      'test.example',
    );
    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.fields.folder' }));
    expect(screen.queryByRole('option', { name: 'Projects' })).toBeNull();
    await user.click(screen.getByRole('option', { name: 'Servers' }));
    await user.click(screen.getByRole('button', { name: 'common.save' }));
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Test', host: 'test.example', parentId: 'folder-1' }),
    );
    // A new bookmark carries no `id` key at all — that absence is what tells
    // the backend to create rather than update.
    expect(vi.mocked(props.onSave).mock.calls[0]?.[0]).not.toHaveProperty('id');

    const row = screen.getByText('Production').closest('.site-manage-row');
    await user.click(
      within(requireHtml(row)).getByRole('button', { name: 'siteManagerDialog.titleEdit' }),
    );
    const name = screen.getByRole('textbox', { name: 'siteManagerDialog.fields.name' });
    await user.clear(name);
    await user.type(name, 'Production 2');
    const editFolder = screen.getByRole('button', {
      name: 'siteManagerDialog.fields.folder',
    });
    expect(editFolder.textContent).toContain('Servers');
    await user.click(editFolder);
    await user.click(screen.getByRole('option', { name: 'siteManagerDialog.noFolder' }));
    await user.click(screen.getByRole('button', { name: 'common.save' }));
    expect(props.onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'site-1', name: 'Production 2', password: '', parentId: null }),
    );
  });

  test('creates a local path in a selected local-path folder', async () => {
    const user = userEvent.setup();
    const { props } = renderManager({ managerKind: 'localPaths' });
    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.addLocalBookmark' }));
    await user.type(
      screen.getByRole('textbox', { name: 'siteManagerDialog.fields.name' }),
      'New path',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'siteManagerDialog.fields.localPath' }),
      'C:\\New',
    );
    const folder = screen.getByRole('button', {
      name: 'siteManagerDialog.fields.folder',
    });
    expect(folder.textContent).toContain('siteManagerDialog.noFolder');
    await user.click(folder);
    expect(screen.queryByRole('option', { name: 'Servers' })).toBeNull();
    await user.click(screen.getByRole('option', { name: 'Projects' }));
    await user.click(screen.getByRole('button', { name: 'common.save' }));
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'local', localPath: 'C:\\New', parentId: 'local-folder-1' }),
    );
  });

  test('keeps saved secrets out of form state and clears an explicit reveal on blur and lock', async () => {
    const user = userEvent.setup();
    vi.mocked(window.api.sites.revealSecret).mockResolvedValue({
      ok: true,
      value: 'revealed-bookmark-secret',
    });
    renderManager();

    const row = screen.getByText('Production').closest('.site-manage-row');
    await user.click(
      within(requireHtml(row)).getByRole('button', { name: 'siteManagerDialog.titleEdit' }),
    );
    const input = screen.getByLabelText<HTMLInputElement>('connectionBar.fields.password');
    expect(input.value).toBe('');

    await user.click(screen.getByRole('button', { name: 'common.showPassword' }));
    await waitFor(() => expect(input.value).toBe('revealed-bookmark-secret'));
    window.dispatchEvent(new Event('blur'));
    await waitFor(() => expect(input.value).toBe(''));

    await user.click(screen.getByRole('button', { name: 'common.showPassword' }));
    await waitFor(() => expect(input.value).toBe('revealed-bookmark-secret'));
    window.dispatchEvent(new Event('ftpeach:vault-locked'));
    await waitFor(() => expect(input.value).toBe(''));
  });

  test('requests vault unlock and retries saving a bookmark', async () => {
    const user = userEvent.setup();
    const onSave = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, errorCode: 'vaultLocked', error: 'vault is locked' })
      .mockResolvedValueOnce({ ok: true });
    const onVaultUnlockRequired = vi.fn();
    renderManager({ onSave, onVaultUnlockRequired });

    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.addBookmark' }));
    await user.type(screen.getByRole('textbox', { name: 'siteManagerDialog.fields.name' }), 'Test');
    await user.type(
      screen.getByRole('textbox', { name: 'connectionBar.fields.address' }),
      'test.example',
    );
    await user.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => expect(onVaultUnlockRequired).toHaveBeenCalledOnce());
    onVaultUnlockRequired.mock.calls[0]?.[0]();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  });

  test('keeps the bookmark and local-path managers independent', async () => {
    const user = userEvent.setup();
    const bookmarkManager = renderManager();

    expect(screen.getByText('Production')).toBeTruthy();
    expect(screen.queryByText('Workspace')).toBeNull();
    expect(screen.queryByRole('button', { name: 'siteManagerDialog.addLocalBookmark' })).toBeNull();
    bookmarkManager.unmount();

    renderManager({ managerKind: 'localPaths' });
    expect(screen.getByText('Workspace')).toBeTruthy();
    expect(screen.queryByText('Production')).toBeNull();
    expect(screen.queryByRole('button', { name: 'siteManagerDialog.addBookmark' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.addLocalBookmark' }));
    expect(screen.getByText('siteManagerDialog.titleNewLocalPath')).toBeTruthy();
    expect(
      screen.getByRole('textbox', { name: 'siteManagerDialog.fields.localPath' }),
    ).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'connectionBar.fields.address' })).toBeNull();
  });

  test('does not offer protocol sorting in the local-path manager', async () => {
    const user = userEvent.setup();
    renderManager({ managerKind: 'localPaths' });
    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.sortMode' }));
    expect(screen.queryByRole('option', { name: 'siteManagerDialog.sortProtocol' })).toBeNull();
  });

  test('uses the app-styled bookmark sorting menu', async () => {
    const user = userEvent.setup();
    renderManager();

    const trigger = screen.getByRole('button', { name: 'siteManagerDialog.sortMode' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const byName = screen.getByRole('option', { name: 'siteManagerDialog.sortName' });
    await user.click(byName);
    expect(trigger.textContent).toContain('siteManagerDialog.sortName');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  test('sorting disables drag handles without changing sensor effect dependencies', async () => {
    const errors = vi.spyOn(console, 'error');
    try {
      const user = userEvent.setup();
      const { container } = renderManager();
      const handles = () =>
        Array.from(container.querySelectorAll('.site-manage-list [aria-disabled]'));
      expect(handles().length).toBeGreaterThan(0);
      await user.click(screen.getByRole('button', { name: 'siteManagerDialog.sortMode' }));
      await user.click(screen.getByRole('option', { name: 'siteManagerDialog.sortName' }));
      expect(handles().every((node) => node.getAttribute('aria-disabled') === 'true')).toBe(true);
      await user.click(screen.getByRole('button', { name: 'siteManagerDialog.sortMode' }));
      await user.click(screen.getByRole('option', { name: 'siteManagerDialog.sortManual' }));
      expect(handles().every((node) => node.getAttribute('aria-disabled') === 'false')).toBe(true);
      expect(
        errors.mock.calls.some((args) => String(args[0]).includes('changed size between renders')),
      ).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  test('warns before saving a probable duplicate and allows explicit confirmation', async () => {
    const user = userEvent.setup();
    const { props } = renderManager();
    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.addBookmark' }));
    await user.type(screen.getByRole('textbox', { name: 'siteManagerDialog.fields.name' }), 'Copy');
    await user.click(screen.getByRole('button', { name: 'FTP' }));
    await user.click(screen.getByRole('option', { name: 'SFTP' }));
    await user.type(
      screen.getByRole('textbox', { name: 'connectionBar.fields.address' }),
      'prod.example.test',
    );
    await user.clear(screen.getByRole('textbox', { name: 'connectionBar.fields.port' }));
    await user.type(screen.getByRole('textbox', { name: 'connectionBar.fields.port' }), '22');
    await user.type(screen.getByRole('textbox', { name: 'connectionBar.fields.user' }), 'deploy');
    await user.click(screen.getByRole('button', { name: 'common.save' }));

    expect(props.onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.saveAnyway' }));
    expect(props.onSave).toHaveBeenCalledOnce();
  });

  test.each([
    ['SFTP', 'connectionBar.authToggle.label', false],
    ['FTPS', 'connectionBar.secureToggle.label', true],
  ] as const)(
    '%s checkbox uses Space and leaves Enter unchanged',
    async (protocol, label, initial) => {
      const user = userEvent.setup();
      const { props } = renderManager();
      await user.click(screen.getByRole('button', { name: 'siteManagerDialog.addBookmark' }));
      await user.click(screen.getByRole('button', { name: 'FTP' }));
      await user.click(screen.getByRole('option', { name: protocol }));
      const checkbox = screen.getByRole<HTMLInputElement>('checkbox', { name: label });
      const changes = vi.fn();
      checkbox.addEventListener('change', changes);
      checkbox.focus();
      expect(checkbox.checked).toBe(initial);
      await user.keyboard('{Enter}');
      expect(checkbox.checked).toBe(initial);
      expect(changes).not.toHaveBeenCalled();
      await user.keyboard(' ');
      expect(checkbox.checked).toBe(!initial);
      expect(changes).toHaveBeenCalledTimes(1);
      await user.keyboard(' ');
      expect(checkbox.checked).toBe(initial);
      expect(changes).toHaveBeenCalledTimes(2);
      expect(props.onSave).not.toHaveBeenCalled();
    },
  );

  test('warns when the selected SSH private key uses RSA', async () => {
    const user = userEvent.setup();
    vi.mocked(window.api.fsLocal.selectKeyFile).mockResolvedValue({
      path: 'C:\\keys\\legacy-rsa',
      isRsa: true,
    });
    renderManager();

    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.addBookmark' }));
    await user.click(screen.getByRole('button', { name: /FTP/ }));
    await user.click(screen.getByRole('option', { name: 'SFTP' }));
    await user.click(screen.getByRole('checkbox', { name: 'connectionBar.authToggle.label' }));
    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.fields.keyFile' }));

    expect(screen.getByRole('status').textContent).toBe('connectionBar.rsaKeyWarning');
  });

  test('creates, renames and deletes folders and deletes a bookmark', async () => {
    const user = userEvent.setup();
    const { props } = renderManager();

    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.newFolder' }));
    const newFolder = screen.getByRole('textbox', {
      name: 'siteManagerDialog.folderNamePlaceholder',
    });
    await user.type(newFolder, 'Archive{Enter}');
    expect(props.onSaveFolder).toHaveBeenCalledWith({
      name: 'Archive',
      parentId: null,
      managerScope: 'bookmarks',
    });

    const folderRow = screen.getByText('Servers').closest('.site-manage-row');
    await user.click(
      within(requireHtml(folderRow)).getByRole('button', { name: 'filePane.rename' }),
    );
    const rename = screen.getByRole('textbox', {
      name: 'siteManagerDialog.folderNamePlaceholder',
    });
    await user.clear(rename);
    await user.type(rename, 'Hosts{Enter}');
    expect(props.onSaveFolder).toHaveBeenLastCalledWith({
      id: 'folder-1',
      name: 'Hosts',
      parentId: null,
      managerScope: 'bookmarks',
    });

    const siteRow = document.querySelector('.site-manage-content .site-manage-row.is-site');
    await user.click(within(requireHtml(siteRow)).getByRole('button', { name: 'paneMenu.delete' }));
    const siteConfirm = screen.getAllByRole('dialog').at(-1);
    fireEvent.click(
      within(requireHtml(siteConfirm)).getByRole('button', { name: 'paneMenu.delete' }),
    );
    await waitFor(() => expect(props.onDelete).toHaveBeenCalledWith('site-1'));

    await user.click(
      within(requireHtml(folderRow)).getByRole('button', { name: 'paneMenu.delete' }),
    );
    const folderConfirm = screen.getAllByRole('dialog').at(-1);
    await user.click(
      within(requireHtml(folderConfirm)).getByRole('button', { name: 'paneMenu.delete' }),
    );
    await waitFor(() => expect(props.onDeleteFolder).toHaveBeenCalledWith('folder-1'));
  });

  test('keeps the appearance dropdown fully inside the window when its trigger sits at an edge', async () => {
    const user = userEvent.setup();
    renderManager();
    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.addBookmark' }));

    vi.stubGlobal('innerWidth', 400);
    vi.stubGlobal('innerHeight', 300);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 270,
      bottom: 290,
      left: 350,
      right: 390,
      width: 40,
      height: 20,
      x: 350,
      y: 270,
      toJSON() {},
    });

    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.fields.icon' }));

    const dropdown = requireHtml(document.querySelector('.site-appearance-dropdown'));
    // Mirrors the fixed 3-column, 30px-cell grid .site-appearance-dropdown
    // .menu-items sets in dialogs.css for SITE_ICONS' entries (3 columns).
    const menuSide = 3 * 30 + 2 * 4 + 2 * 5;
    const top = parseFloat(dropdown.style.top);
    const left = parseFloat(dropdown.style.left);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top + menuSide).toBeLessThanOrEqual(window.innerHeight);
    expect(left + menuSide).toBeLessThanOrEqual(window.innerWidth);
  });

  test('search filters bookmarks by name, host, user and folder, and connects from results', async () => {
    const user = userEvent.setup();
    const { props } = renderManager({ entries: searchEntries });

    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.searchPlaceholder' }));
    const search = screen.getByRole('textbox', { name: 'siteManagerDialog.searchPlaceholder' });

    // Matches by remote host, even though the query itself isn't in the name.
    await user.type(search, 'prod.example');
    screen.getByText('Production');
    expect(screen.queryByText('Docs Bucket')).toBeNull();
    // The matched bookmark's parent folder is shown for context.
    screen.getByText('Servers');

    // Matches by WebDAV URL for a root-level bookmark with no parent folder.
    await user.clear(search);
    await user.type(search, 'docs.example');
    screen.getByText('Docs Bucket');
    expect(screen.queryByText('Production')).toBeNull();

    // Matches by folder name too.
    await user.clear(search);
    await user.type(search, 'Servers');
    screen.getByText('Production');
    expect(screen.queryByText('Docs Bucket')).toBeNull();

    // Connecting from a search result behaves like connecting from the tree.
    const row = screen.getByText('Production').closest('.site-manage-row');
    await user.click(
      within(requireHtml(row)).getByRole('button', {
        name: 'connectionBar.connectTooltip.connect',
      }),
    );
    expect(props.onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: 'site-1' }));

    // A query matching nothing shows the empty state instead of a blank list.
    await user.clear(search);
    await user.type(search, 'no such bookmark');
    screen.getByText('siteManagerDialog.noSearchResults');

    // Clearing the search restores the normal folder tree.
    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.clearSearch' }));
    expect((search as HTMLInputElement).value).toBe('');
    expect(screen.getByText('Servers').closest('.site-manage-row.is-folder')).not.toBeNull();
  });
});

describe('Site Manager tree: click-to-connect, keyboard model and quick actions', () => {
  beforeEach(() => {
    installSiteManagerApiMocks();
  });

  test('clicking a site row connects; clicking its own buttons does not', async () => {
    const user = userEvent.setup();
    const { props } = renderManager();

    const row = screen.getByText('Production').closest('.site-manage-row');
    await user.click(requireHtml(row));
    expect(props.onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: 'site-1' }));

    vi.mocked(props.onConnect).mockClear();
    await user.click(
      within(requireHtml(row)).getByRole('button', { name: 'siteManagerDialog.titleEdit' }),
    );
    expect(props.onConnect).not.toHaveBeenCalled();
  });

  test('Enter connects a focused site row and toggles a focused folder row', () => {
    const { props } = renderManager();

    const siteRow = screen.getByText('Production').closest('.site-manage-row');
    fireEvent.keyDown(requireHtml(siteRow), { key: 'Enter' });
    expect(props.onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: 'site-1' }));

    const folderRow = screen.getByRole('treeitem', { name: 'Servers' });
    expect(folderRow.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(folderRow, { key: 'Enter' });
    expect(folderRow.getAttribute('aria-expanded')).toBe('false');
    // Restore the shared module-level expanded-state before the next test —
    // collapsedFolderIds persists across every test in this file.
    fireEvent.keyDown(folderRow, { key: 'Enter' });
    expect(folderRow.getAttribute('aria-expanded')).toBe('true');
  });

  test('F2 opens the edit form for a site and inline-renames a focused folder', async () => {
    const { props } = renderManager();

    const siteRow = screen.getByText('Production').closest('.site-manage-row');
    fireEvent.keyDown(requireHtml(siteRow), { key: 'F2' });
    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'siteManagerDialog.fields.name' })
        .value,
    ).toBe('Production');
    await userEvent.setup().click(screen.getByRole('button', { name: 'common.cancel' }));

    const folderRow = screen.getByRole('treeitem', { name: 'Servers' });
    fireEvent.keyDown(folderRow, { key: 'F2' });
    expect(
      screen.getByRole<HTMLInputElement>('textbox', {
        name: 'siteManagerDialog.folderNamePlaceholder',
      }).value,
    ).toBe('Servers');
    fireEvent.keyDown(
      screen.getByRole('textbox', { name: 'siteManagerDialog.folderNamePlaceholder' }),
      { key: 'Escape' },
    );
    expect(props.onSaveFolder).not.toHaveBeenCalled();
  });

  test('Escape and the ✕ button back out of the edit form instead of closing the whole dialog', async () => {
    const user = userEvent.setup();
    const { props } = renderManager();

    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.addBookmark' }));
    expect(screen.getByRole('textbox', { name: 'siteManagerDialog.fields.name' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'siteManagerDialog.fields.name' })).toBeNull();
    expect(screen.getByRole('button', { name: 'siteManagerDialog.addBookmark' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.addBookmark' }));
    await user.click(screen.getByRole('button', { name: 'common.close' }));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'siteManagerDialog.addBookmark' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  test('Delete opens a confirmation for the focused row', () => {
    renderManager();
    const siteRow = screen.getByText('Production').closest('.site-manage-row');
    fireEvent.keyDown(requireHtml(siteRow), { key: 'Delete' });
    // The Site Manager dialog itself is also role="dialog" — the confirm
    // prompt is the second, nested one.
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
  });

  test('ArrowDown moves focus from a folder header to its own expanded child', () => {
    renderManager();
    const folderRow = screen.getByRole('treeitem', { name: 'Servers' });
    const siteRow = screen.getByText('Production').closest('.site-manage-row');
    fireEvent.keyDown(folderRow, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(siteRow);
    fireEvent.keyDown(requireHtml(siteRow), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(folderRow);
  });

  test('collapsing a folder restores the roving tab stop from its hidden child', async () => {
    renderManager();
    const folderRow = screen.getByRole('treeitem', { name: 'Servers' });
    const siteRow = requireHtml(screen.getByText('Production').closest('.site-manage-row'));
    fireEvent.focus(siteRow);

    fireEvent.click(
      within(folderRow).getByRole('button', { name: 'siteManagerDialog.collapseFolder' }),
    );

    await waitFor(() => expect(folderRow.tabIndex).toBe(0));
    expect(screen.queryByRole('treeitem', { name: 'Production' })).toBeNull();

    // Restore the shared module-level expanded-state for following cases.
    fireEvent.click(
      within(folderRow).getByRole('button', { name: 'siteManagerDialog.expandFolder' }),
    );
  });

  test('nests a folder child group inside its parent treeitem', () => {
    renderManager();
    const folder = screen.getByRole('treeitem', { name: 'Servers' });
    const group = within(folder).getByRole('group');
    expect(within(group).getByRole('treeitem', { name: 'Production' })).not.toBeNull();
    expect(folder.parentElement?.getAttribute('role')).toBe('tree');
  });

  test('duplicating a site opens a prefilled add form under a new name', async () => {
    const user = userEvent.setup();
    const { props } = renderManager();

    const row = screen.getByText('Production').closest('.site-manage-row');
    await user.click(
      within(requireHtml(row)).getByRole('button', { name: 'siteManagerDialog.duplicate' }),
    );

    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'siteManagerDialog.fields.name' })
        .value,
    ).toBe('ProductionsiteManagerDialog.duplicateNameSuffix');
    await user.click(screen.getByRole('button', { name: 'common.save' }));
    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.saveAnyway' }));
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'prod.example.test', parentId: 'folder-1' }),
    );
    // A duplicate is a new bookmark: no `id` key, so the backend creates it.
    expect(vi.mocked(props.onSave).mock.calls[0]?.[0]).not.toHaveProperty('id');
  });

  test('"New Bookmark Here" from a folder saves the new bookmark into that folder', async () => {
    const user = userEvent.setup();
    const { props } = renderManager();

    const folderRow = screen.getByText('Servers').closest('.site-manage-row.is-folder');
    await user.click(
      within(requireHtml(folderRow)).getByRole('button', {
        name: 'siteManagerDialog.newBookmarkInFolder',
      }),
    );

    await user.type(screen.getByRole('textbox', { name: 'siteManagerDialog.fields.name' }), 'X');
    await user.type(
      screen.getByRole('textbox', { name: 'connectionBar.fields.address' }),
      'x.example',
    );
    await user.click(screen.getByRole('button', { name: 'common.save' }));
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ parentId: 'folder-1' }));
  });

  test('search results expose connect, duplicate and context-menu quick actions', async () => {
    const user = userEvent.setup();
    const { props } = renderManager({ entries: searchEntries });
    await user.click(screen.getByRole('button', { name: 'siteManagerDialog.searchPlaceholder' }));
    await user.type(
      screen.getByRole('textbox', { name: 'siteManagerDialog.searchPlaceholder' }),
      'Production',
    );

    const row = screen.getByText('Production').closest('.site-manage-row');
    await user.click(
      within(requireHtml(row)).getByRole('button', {
        name: 'connectionBar.connectTooltip.connect',
      }),
    );
    expect(props.onConnect).toHaveBeenCalledWith(expect.objectContaining({ id: 'site-1' }));

    fireEvent.contextMenu(requireHtml(row), { clientX: 20, clientY: 20 });
    await user.click(screen.getByText('siteManagerDialog.duplicate'));
    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'siteManagerDialog.fields.name' })
        .value,
    ).toBe('ProductionsiteManagerDialog.duplicateNameSuffix');
  });

  test('the "..." overflow trigger is gone from bookmark and folder rows', () => {
    renderManager();
    expect(screen.queryByRole('button', { name: 'toolbarOverflowMenu.more' })).toBeNull();
  });

  test('right-click rename on a bookmark edits its name inline without opening the full editor', async () => {
    const user = userEvent.setup();
    const { props } = renderManager();

    const row = screen.getByText('Production').closest('.site-manage-row');
    fireEvent.contextMenu(requireHtml(row), { clientX: 10, clientY: 10 });
    await user.click(screen.getByText('filePane.rename'));

    const rename = screen.getByRole('textbox', { name: 'filePane.rename' });
    expect((rename as HTMLInputElement).value).toBe('Production');
    await user.clear(rename);
    await user.type(rename, 'Prod Renamed{Enter}');

    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'site-1', name: 'Prod Renamed', host: 'prod.example.test' }),
    );
    expect(screen.queryByRole('textbox', { name: 'siteManagerDialog.fields.name' })).toBeNull();
  });

  test('reports and rolls back a failed keyboard reorder', async () => {
    const sourceSite = entries.find((entry) => entry.id === 'site-1')!;
    const rootEntries = [
      { ...sourceSite, id: 'site-a', name: 'Alpha', parentId: null },
      { ...sourceSite, id: 'site-b', name: 'Beta', parentId: null },
    ];
    const { props } = renderManager({
      entries: rootEntries,
      onApplyLayout: vi.fn(async () => ({ ok: false, error: 'Layout failed' })),
    });

    const alpha = screen.getByRole('treeitem', { name: 'Alpha' });
    fireEvent.keyDown(alpha, { key: 'ArrowDown', altKey: true });

    expect((await screen.findByRole('alert')).textContent).toContain('Layout failed');
    expect(props.onApplyLayout).toHaveBeenCalledOnce();
    expect(screen.getAllByRole('treeitem').map((row) => row.dataset.rowId)).toEqual([
      'site-a',
      'site-b',
    ]);
  });
});
