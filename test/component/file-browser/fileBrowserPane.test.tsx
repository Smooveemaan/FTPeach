import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import FileBrowserPane from '../../../src/features/file-browser/FileBrowserPane.tsx';
import type { FileBrowserPaneModel } from '../../../src/features/file-browser/FileBrowserPane.tsx';
import type { FilePaneProps } from '../../../src/features/file-browser/FilePane.tsx';
import { makePane as makePaneState } from '../../../src/features/file-browser/panes/paneModel.ts';
import type { PaneState } from '../../../src/features/file-browser/panes/paneModel.ts';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

let lastFilePaneProps: FilePaneProps | null = null;
vi.mock('../../../src/features/file-browser/FilePane.tsx', () => ({
  default: (props: FilePaneProps) => {
    lastFilePaneProps = props;
    return null;
  },
}));

function makePane(overrides: Partial<PaneState> = {}): PaneState {
  return {
    ...makePaneState('a', 'local'),
    path: 'C:\\',
    entries: [
      { name: 'Zoo.txt', isDirectory: false, size: 1 },
      { name: 'Alpha', isDirectory: true, size: 0 },
    ],
    selected: new Set(),
    history: [],
    future: [],
    loading: false,
    refreshedAt: 1,
    ...overrides,
  };
}

function makeModel(paneA: PaneState): FileBrowserPaneModel {
  const returnsFn = () => vi.fn();
  return {
    panes: { a: paneA, b: makePane({ entries: [] }) },
    activeTabId: 'tab-1',
    searchInputRef: { current: null },
    orderedSites: [],
    sites: [],
    columns: {
      local: { a: [], b: [] },
      remote: { a: [], b: [] },
      localWidths: { a: {}, b: {} },
      remoteWidths: { a: {}, b: {} },
      changeLocal: returnsFn,
      changeRemote: returnsFn,
      changeLocalWidths: returnsFn,
      changeRemoteWidths: returnsFn,
    },
    actions: {
      crumbsFor: () => [{ label: 'root', path: '/' }],
      canCopyBetween: () => false,
      buildMenu: () => () => [],
      openDriveMenu: returnsFn,
      chooseLocalDir: returnsFn,
      navigate: vi.fn(),
      openDirectory: vi.fn(),
      updatePane: vi.fn(),
      rename: vi.fn(),
      deleteSelected: vi.fn(),
      goUp: vi.fn(),
      goBack: vi.fn(),
      goForward: vi.fn(),
      goHome: vi.fn(),
      moveTo: vi.fn(),
      newFolder: vi.fn(),
      newFile: vi.fn(),
      copySelected: vi.fn(),
      copyToClipboard: vi.fn(),
      cutToClipboard: vi.fn(),
      canPaste: () => false,
      pasteClipboard: vi.fn(),
      switchToLocal: vi.fn(),
      startConnect: vi.fn(),
      setForm: vi.fn(),
      connect: returnsFn,
      disconnect: vi.fn(),
      cancelConnect: vi.fn(),
      connectSite: vi.fn(),
      activate: vi.fn(),
      saveSite: returnsFn,
      openSiteManager: vi.fn(),
      openLocalPathManager: vi.fn(),
      openLocalPath: vi.fn(),
      openRemoteFile: vi.fn(),
      dropFiles: vi.fn(),
      join: (pane, name) => `${pane.path}${name}`,
    },
    dragMoveStart: vi.fn(),
    outboundDragRef: { current: false },
    showHiddenFiles: false,
    paneOrientation: 'horizontal',
  };
}

describe('FileBrowserPane entries identity', () => {
  test('keeps the same entries array reference across a selection-only re-render', () => {
    const sharedEntries = makePane().entries;
    const model1 = makeModel(makePane({ entries: sharedEntries, selected: new Set() }));
    const { rerender } = render(<FileBrowserPane id="a" style={{}} model={model1} />);
    const firstEntries = lastFilePaneProps?.entries;
    expect(firstEntries).toEqual(sharedEntries);

    const model2 = makeModel(makePane({ entries: sharedEntries, selected: new Set(['Alpha']) }));
    rerender(<FileBrowserPane id="a" style={{}} model={model2} />);

    expect(lastFilePaneProps?.entries).toBe(firstEntries);
  });

  test('recomputes entries when the underlying listing actually changes', () => {
    const model1 = makeModel(makePane());
    const { rerender } = render(<FileBrowserPane id="a" style={{}} model={model1} />);
    const firstEntries = lastFilePaneProps?.entries;

    const model2 = makeModel(
      makePane({ entries: [{ name: 'NewFile.txt', isDirectory: false, size: 5 }] }),
    );
    rerender(<FileBrowserPane id="a" style={{}} model={model2} />);

    expect(lastFilePaneProps?.entries).not.toBe(firstEntries);
    expect(lastFilePaneProps?.entries.map((entry) => entry.name)).toEqual(['NewFile.txt']);
  });
});

describe('FileBrowserPane drop targets', () => {
  test('a Server pane offers to take an OS drop only while connected', () => {
    const remote = (status: PaneState['status']) =>
      makePane({ kind: 'remote', status, path: '/', connectionId: 'session', protocol: 'sftp' });

    render(<FileBrowserPane id="a" style={{}} model={makeModel(remote('connected'))} />);
    expect(lastFilePaneProps?.onDropFiles).toBeTypeOf('function');

    // Dropping into a pane with no session used to reach the backend and come
    // back as a connection error the user had no way to see coming.
    render(<FileBrowserPane id="a" style={{}} model={makeModel(remote('idle'))} />);
    expect(lastFilePaneProps?.onDropFiles).toBeUndefined();

    // A local pane copies the paths itself, so no session is involved and the
    // other pane's state has no say in it.
    render(<FileBrowserPane id="a" style={{}} model={makeModel(makePane())} />);
    expect(lastFilePaneProps?.onDropFiles).toBeTypeOf('function');
  });
});
