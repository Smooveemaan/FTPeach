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
