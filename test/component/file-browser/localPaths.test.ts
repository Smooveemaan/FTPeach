import { expect, test, vi } from 'vitest';
import { hostPlatform } from '../../../src/platform/os.ts';
import {
  currentLocalRoot,
  dropDestinationPath,
  joinLocalPath,
  localPathParts,
} from '../../../src/shared/paths.ts';
import { createPaneNavigation } from '../../../src/features/file-browser/panes/createPaneNavigation.ts';
import { makeTab } from '../../../src/features/file-browser/panes/paneModel.ts';
import { resolveDropAction } from '../../../src/features/file-browser/components/dropAction.ts';
import { validateWindowsDownloadName } from '../../../src/features/transfers/windowsDownloadName.ts';
import {
  transferDisplayName,
  transferRoutePlaces,
} from '../../../src/features/transfers/transferPresentation.ts';
import type { TransferRow } from '../../../src/features/transfers/transferStore.ts';

const agents = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  macos: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  linux: 'Mozilla/5.0 (X11; Linux x86_64)',
};
for (const [os, agent] of Object.entries(agents)) {
  test(`${os}: paths, roots, navigation, drops and download names follow the host`, async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(agent);
    expect(hostPlatform()).toBe(os);
    const windows = os === 'windows';
    const root = windows ? 'C:\\' : '/';
    const home = windows ? 'C:\\Users\\me' : '/home/me';
    const nested = joinLocalPath(home, 'work');
    expect(nested).toBe(windows ? 'C:\\Users\\me\\work' : '/home/me/work');
    expect(joinLocalPath(root, 'file')).toBe(windows ? 'C:\\file' : '/file');
    expect(dropDestinationPath('local', home, root)).toBe(root);
    expect(dropDestinationPath('local', home, 'work')).toBe(nested);
    expect(currentLocalRoot(nested, [root, home, nested + 'space'])).toBe(home);
    expect(currentLocalRoot(home.toUpperCase(), [home])).toBe(windows ? home : undefined);
    expect(currentLocalRoot(home + 'ward', [home])).toBeUndefined();
    expect(currentLocalRoot(home, [root, home])).toBe(home);
    expect(localPathParts('/home/back\\slash')).toEqual(
      windows ? ['home', 'back', 'slash'] : ['home', 'back\\slash'],
    );
    for (const name of ['CON.txt', 'a:b', 'back\\slash', 'name.']) {
      if (windows && name !== 'back\\slash')
        expect(() => validateWindowsDownloadName(name)).toThrow();
      else expect(() => validateWindowsDownloadName(name)).not.toThrow();
    }
    const tab = makeTab('paths');
    tab.panes.a.path = home;
    tab.panes.b.path = '/remote';
    const refreshPane = vi.fn(async (_id: string, path: string) => ({ ok: true, path }));
    const navigation = createPaneNavigation({
      panes: tab.panes,
      activeTabId: tab.id,
      syncBrowsing: true,
      setTabs: vi.fn(),
      syncAnchorsRef: { current: { [tab.id]: { a: home, b: '/remote' } } },
      inFlightRefreshesRef: { current: {} },
      pendingDescendRef: { current: {} },
      refreshPane,
      updatePane: vi.fn(),
    });
    expect(navigation.crumbsFor({ ...tab.panes.a, path: root })).toEqual([
      { label: windows ? 'C:' : '/', path: root },
    ]);
    const crumbs = navigation.crumbsFor({ ...tab.panes.a, path: nested });
    expect(crumbs.at(-1)).toEqual({ label: 'work', path: nested });
    navigation.paneParent('a');
    expect(refreshPane.mock.calls[0]?.[1]).toBe(windows ? 'C:\\Users' : '/home');
    refreshPane.mockClear();
    await navigation.navigatePane('a', nested);
    expect(refreshPane).toHaveBeenCalledWith('b', '/remote/work', undefined, tab.id);
    tab.panes.a.path = root;
    refreshPane.mockClear();
    navigation.paneParent('a');
    expect(refreshPane).not.toHaveBeenCalled();
    const source = { ...tab.panes.a, path: home, entries: [{ name: 'work', isDirectory: true }] };
    const target = { ...source, path: nested };
    const keys = { ctrlKey: false, shiftKey: false };
    expect(resolveDropAction(source, target, null, ['work'], keys)).toBe('invalid');
    expect(
      resolveDropAction(source, { ...target, path: nested.toUpperCase() }, null, ['work'], keys),
    ).toBe(windows ? 'invalid' : 'move');
    const file = windows ? 'C:\\Users\\me\\file' : '/home/back\\slash/file';
    const row = {
      direction: 'local',
      localFile: file,
      localTarget: joinLocalPath(root, 'file'),
    } as TransferRow;
    expect(
      transferRoutePlaces(
        row,
        () => 'server',
        (key) => key,
      ),
    ).toEqual([windows ? 'me' : 'back\\slash', root]);
    const directory = {
      direction: 'recursive',
      intent: {
        source: { kind: 'local', path: windows ? nested : '/home/back\\slash' },
        target: { kind: 'remote', path: '/', connectionId: 's' },
      },
    } as TransferRow;
    expect(transferDisplayName(directory)).toBe(windows ? 'work' : 'back\\slash');
  });
}

test('UNC navigation keeps the share as its root', () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(agents.windows);
  const tab = makeTab('unc');
  tab.panes.a.path = '\\\\host\\share';
  const refreshPane = vi.fn(async () => ({ ok: true }));
  const navigation = createPaneNavigation({
    panes: tab.panes,
    activeTabId: tab.id,
    syncBrowsing: false,
    setTabs: vi.fn(),
    syncAnchorsRef: { current: {} },
    inFlightRefreshesRef: { current: {} },
    pendingDescendRef: { current: {} },
    refreshPane,
    updatePane: vi.fn(),
  });
  navigation.paneParent('a');
  expect(refreshPane).not.toHaveBeenCalled();
  expect(navigation.crumbsFor(tab.panes.a)).toEqual([
    { label: 'host\\share', path: '\\\\host\\share' },
  ]);
});
