import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import FileBrowserPane from '../../../src/features/file-browser/FileBrowserPane.tsx';
import type { FileBrowserPaneProps } from '../../../src/features/file-browser/FileBrowserPane.tsx';
import type { FilePaneProps } from '../../../src/features/file-browser/FilePane.tsx';
import { makePane as makePaneState } from '../../../src/features/file-browser/panes/paneModel.ts';
import type { PaneState } from '../../../src/features/file-browser/panes/paneModel.ts';
import type { FileClipboardModel } from '../../../src/features/file-browser/useFileClipboard.ts';
import type { PanesModel } from '../../../src/features/file-browser/usePanes.ts';

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

// Every owner the pane reads, with nothing the tests below look at.
function makeProps(paneA: PaneState): FileBrowserPaneProps {
  const returnsFn = () => vi.fn();
  const browser = {
    panes: { a: paneA, b: makePane({ entries: [] }) },
    activeTabId: 'tab-1',
    crumbsFor: () => [{ label: 'root', path: '/' }],
    canCopyBetween: () => false,
    chooseLocalDir: returnsFn,
    connectPane: returnsFn,
    paneJoin: (pane: PaneState, name: string) => `${pane.path}${name}`,
  };
  return {
    id: 'a',
    style: {},
    searchInputRef: { current: null },
    browser: browser as unknown as PanesModel,
    clipboard: {
      canPaste: () => false,
      cutNames: () => undefined,
      dragMove: { startDrag: vi.fn() },
      outboundDragRef: { current: false },
    } as unknown as FileClipboardModel,
    sites: { connectableSites: [], orderedSites: [], localPaths: [] },
    settings: {
      layout: {
        showHiddenFiles: false,
        localColumns: { a: [], b: [] },
        remoteColumns: { a: [], b: [] },
        localColumnWidths: { a: {}, b: {} },
        remoteColumnWidths: { a: {}, b: {} },
      },
      shortcuts: { keyboardShortcuts: {} },
    },
    columns: {
      changeLocalColumns: returnsFn,
      changeRemoteColumns: returnsFn,
      changeLocalColumnWidths: returnsFn,
      changeRemoteColumnWidths: returnsFn,
    },
    paneOrientation: 'horizontal',
    shell: {
      dialogs: {
        driveMenu: null,
        setDriveMenu: vi.fn(),
        setNewFolderTarget: vi.fn(),
        setNewFileTarget: vi.fn(),
        setMoveToTarget: vi.fn(),
        setChmodTarget: vi.fn(),
        setShowSiteManagerDialog: vi.fn(),
        setShowLocalPathManagerDialog: vi.fn(),
      },
      transfers: { copyEntries: vi.fn(), handleOsDropFiles: vi.fn() },
      openWith: { setTarget: vi.fn() },
      saveSite: returnsFn,
      reportError: vi.fn(),
    },
  };
}

describe('FileBrowserPane entries identity', () => {
  test('keeps the same entries array reference across a selection-only re-render', () => {
    const sharedEntries = makePane().entries;
    const props1 = makeProps(makePane({ entries: sharedEntries, selected: new Set() }));
    const { rerender } = render(<FileBrowserPane {...props1} />);
    const firstEntries = lastFilePaneProps?.entries;
    expect(firstEntries).toEqual(sharedEntries);

    const props2 = makeProps(makePane({ entries: sharedEntries, selected: new Set(['Alpha']) }));
    rerender(<FileBrowserPane {...props2} />);

    expect(lastFilePaneProps?.entries).toBe(firstEntries);
  });

  test('recomputes entries when the underlying listing actually changes', () => {
    const props1 = makeProps(makePane());
    const { rerender } = render(<FileBrowserPane {...props1} />);
    const firstEntries = lastFilePaneProps?.entries;

    const props2 = makeProps(
      makePane({ entries: [{ name: 'NewFile.txt', isDirectory: false, size: 5 }] }),
    );
    rerender(<FileBrowserPane {...props2} />);

    expect(lastFilePaneProps?.entries).not.toBe(firstEntries);
    expect(lastFilePaneProps?.entries.map((entry) => entry.name)).toEqual(['NewFile.txt']);
  });
});

describe('FileBrowserPane drop targets', () => {
  test('a Server pane offers to take an OS drop only while connected', () => {
    const remote = (status: PaneState['status']) =>
      makePane({ kind: 'remote', status, path: '/', connectionId: 'session', protocol: 'sftp' });

    render(<FileBrowserPane {...makeProps(remote('connected'))} />);
    expect(lastFilePaneProps?.onDropFiles).toBeTypeOf('function');

    // Dropping into a pane with no session used to reach the backend and come
    // back as a connection error the user had no way to see coming.
    render(<FileBrowserPane {...makeProps(remote('idle'))} />);
    expect(lastFilePaneProps?.onDropFiles).toBeUndefined();

    // A local pane copies the paths itself, so no session is involved and the
    // other pane's state has no say in it.
    render(<FileBrowserPane {...makeProps(makePane())} />);
    expect(lastFilePaneProps?.onDropFiles).toBeTypeOf('function');
  });
});

describe('FileBrowserPane new-file availability', () => {
  const connected = (protocol: PaneState['protocol']) =>
    makePane({
      kind: 'remote',
      status: 'connected',
      path: '/',
      connectionId: 'session',
      protocol,
    });

  test('the new-file action is offered over every protocol', () => {
    for (const protocol of ['sftp', 'webdav', 'ftp', 'ftps'] as const) {
      render(<FileBrowserPane {...makeProps(connected(protocol))} />);
      expect(lastFilePaneProps?.onNewFile).toBeTypeOf('function');
    }
  });
});
