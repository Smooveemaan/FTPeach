import { render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import TransferItemRow from '../../../src/features/transfers/components/TransferItemRow.tsx';
import type { TransferRow } from '../../../src/features/transfers/transferStore.ts';

function renderRow(item: TransferRow) {
  return render(
    <TransferItemRow
      item={item}
      columnOrder={[]}
      gridTemplateColumns="1fr"
      speedSamples={{}}
      onRetry={vi.fn()}
      onPause={vi.fn()}
      onStop={vi.fn()}
    />,
  );
}

test.each(['D:\\Your\\Local\\Folder', '/remote/Folder/'])(
  'shows only the folder name and keeps the full path in its tooltip (%s)',
  (path) => {
    const { container } = renderRow({
      id: 'folder',
      name: path,
      direction: 'recursive',
      status: 'done',
      bytes: 0,
      startedAt: 1,
      intent: {
        id: 'folder',
        source: { kind: 'local', path },
        target: { kind: 'local', path: 'D:\\target' },
        moving: false,
        overwrite: false,
      },
    });
    expect(container.querySelector('.t-name')?.textContent).toBe('Folder');
    expect(container.querySelector('.t-name')?.getAttribute('data-tooltip')).toBe(path);
    expect(container.querySelector('.transfer-file-icon.is-folder svg')).not.toBeNull();
  },
);

test('uses the standard file type icon and remote path tooltip', () => {
  const { container } = renderRow({
    id: 'file',
    name: 'photo.png',
    direction: 'down',
    status: 'done',
    bytes: 1,
    startedAt: 1,
    protocol: 'sftp',
    connectionId: 'session',
    remoteFile: '/images/photo.png',
    localTarget: 'D:\\photo.png',
  });
  expect(container.querySelector('.t-name')?.textContent).toBe('photo.png');
  expect(container.querySelector('.t-name')?.getAttribute('data-tooltip')).toBe(
    '/images/photo.png',
  );
  expect(container.querySelector('.transfer-file-icon svg')?.getAttribute('fill')).toBe(
    'var(--file-image)',
  );
});

test('dragged folders retain a download arrow beside the orange folder icon', () => {
  const { container } = renderRow({
    id: 'folder-drag',
    name: 'Folder',
    direction: 'down',
    dragOut: true,
    isDirectory: true,
    protocol: 'webdav',
    connectionId: 'session',
    remoteFile: '/parent/Folder',
    status: 'progress',
    bytes: 0,
    startedAt: 1,
  });
  expect(container.querySelector('.dir-icon.dir-down svg')).not.toBeNull();
  expect(container.querySelector('.transfer-file-icon.is-folder svg')).not.toBeNull();
  expect(container.querySelector('.t-name')?.textContent).toBe('Folder');
  expect(container.querySelector('.t-name')?.getAttribute('data-tooltip')).toBe('/parent/Folder');
});
