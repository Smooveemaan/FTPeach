import { render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import TransferItemRow from '../../../src/features/transfers/components/TransferItemRow.tsx';
import type { TransferRow } from '../../../src/features/transfers/transferStore.ts';
import type { ReorderableColumnKey } from '../../../src/features/transfers/transferColumns.ts';

const LABELS: Record<string, string> = { a: 'Production', b: 'Backup' };

test.each([0, 2048])('completed transfers show 100%% without a total (%s bytes)', (bytes) => {
  const { container } = renderRow(
    {
      id: 'fast',
      name: 'text.txt',
      direction: 'down',
      status: 'done',
      bytes,
      startedAt: 1,
      protocol: 'webdav',
      connectionId: 'session',
      remoteFile: '/text.txt',
      localTarget: 'D:\\text.txt',
    },
    ['progress'],
  );
  expect(container.querySelector('[data-column-cell="progress"]')?.textContent).toContain('100%');
});

function renderRow(item: TransferRow, columnOrder: ReorderableColumnKey[] = []) {
  return render(
    <TransferItemRow
      item={item}
      connectionLabel={(connectionId) => LABELS[connectionId] ?? '?'}
      columnOrder={[
        'file',
        'status',
        ...columnOrder.filter((key) => key !== 'file' && key !== 'status'),
      ]}
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

test.each([
  ['local', 'remote:a', 'up', 'Upload', 'Upload'],
  ['remote:a', 'local', 'down', 'Download', 'Download'],
  ['remote:a', 'remote:b', 'copy', 'Copy', 'Copy between servers'],
  ['remote:a', 'remote:a', 'server-copy', 'Copy', 'Copy on the server'],
  // A folder dropped from Explorer onto the local pane never touches a server.
  ['local', 'local', 'local-copy', 'Copy', 'Copy on this computer'],
] as const)(
  'a running %s to %s folder walk reports the direction it is actually going',
  (from, to, icon, label, title) => {
    const endpoint = (kind: 'local' | 'remote:a' | 'remote:b') =>
      kind === 'local'
        ? ({ kind, path: 'D:\\Folder' } as const)
        : ({ kind: 'remote', path: '/Folder', connectionId: kind.slice(7) } as const);
    const { container } = renderRow(
      {
        id: 'walk',
        name: 'Folder',
        direction: 'recursive',
        status: 'progress',
        bytes: 1,
        startedAt: 1,
        ...(to === 'local' ? {} : { targetProtocol: 'sftp' as const }),
        intent: {
          id: 'walk',
          source: endpoint(from),
          target: endpoint(to),
          moving: false,
          overwrite: false,
        },
      },
      [],
    );
    expect(container.querySelector('.status-tag')?.textContent).toBe(label);
    expect(container.querySelector(`.dir-icon.dir-${icon}`)?.getAttribute('data-tooltip')).toBe(
      title,
    );
    // A folder walk keeps a journal it can resume from, whichever way it goes.
    const pause = container.querySelector('.pause-btn');
    expect(pause).toHaveProperty('disabled', false);
    expect(pause?.getAttribute('data-tooltip')).toBe('Paused');
  },
);

test.each(['local', 'remote'] as const)(
  'a %s folder walk into WebDAV cannot pause, since the file it cuts short would start over',
  (from) => {
    const { container } = renderRow({
      id: 'walk',
      name: 'Folder',
      direction: 'recursive',
      status: 'progress',
      bytes: 1,
      startedAt: 1,
      targetProtocol: 'webdav',
      intent: {
        id: 'walk',
        source:
          from === 'local'
            ? { kind: 'local', path: 'D:\\Folder' }
            : { kind: 'remote', path: '/Folder', connectionId: 'a' },
        target: { kind: 'remote', path: '/Folder', connectionId: 'b' },
        moving: false,
        overwrite: false,
      },
    });
    const pause = container.querySelector('.pause-btn');
    expect(pause).toHaveProperty('disabled', true);
    expect(pause?.getAttribute('data-tooltip')).toBe('Pause is not supported by WebDAV');
  },
);

test('a folder moved within one server is a single rename, so it cannot pause', () => {
  const { container } = renderRow({
    id: 'rename',
    name: 'Folder',
    direction: 'recursive',
    status: 'progress',
    bytes: 0,
    startedAt: 1,
    intent: {
      id: 'rename',
      source: { kind: 'remote', path: '/Folder', connectionId: 'a' },
      target: { kind: 'remote', path: '/Moved/Folder', connectionId: 'a' },
      moving: true,
      overwrite: false,
    },
  });
  const pause = container.querySelector('.pause-btn');
  expect(pause).toHaveProperty('disabled', true);
  expect(pause?.getAttribute('data-tooltip')).toBe(
    'Pause is not supported when copying on the server',
  );
});

test.each([
  ['a', 'b', 'Copy between servers', 'Pause is not supported when copying between servers'],
  ['a', 'a', 'Copy on the server', 'Pause is not supported when copying on the server'],
])(
  'a relay copy from session %s to session %s is told apart from a copy on one server',
  (sourceConnectionId, targetConnectionId, title, pauseTooltip) => {
    const { container } = renderRow({
      id: 'relay',
      name: 'photo.png',
      direction: 'copy',
      status: 'progress',
      bytes: 1,
      startedAt: 1,
      protocol: 'sftp',
      sourceConnectionId,
      targetConnectionId,
      sourcePath: '/photo.png',
      remoteTarget: '/backup/photo.png',
    });
    expect(container.querySelector('.dir-icon')?.getAttribute('data-tooltip')).toBe(title);
    expect(container.querySelector('.pause-btn')?.getAttribute('data-tooltip')).toBe(pauseTooltip);
  },
);

const isolated = (text: string) => `\u2068${text}\u2069`;

test.each([
  [
    'an upload from a nested folder',
    {
      direction: 'up',
      protocol: 'sftp',
      connectionId: 'a',
      localFile: 'D:\\Work\\Projects\\site.zip',
      remoteTarget: '/www/site.zip',
    },
    `${isolated('Projects')} → ${isolated('Production')}`,
    `${isolated('D:\\Work\\Projects\\site.zip')} → ${isolated('Production: /www/site.zip')}`,
  ],
  [
    'an upload',
    {
      direction: 'up',
      protocol: 'sftp',
      connectionId: 'a',
      localFile: 'D:\\site.zip',
      remoteTarget: '/www/site.zip',
    },
    `${isolated('D:\\')} → ${isolated('Production')}`,
    `${isolated('D:\\site.zip')} → ${isolated('Production: /www/site.zip')}`,
  ],
  [
    'a download',
    {
      direction: 'down',
      protocol: 'sftp',
      connectionId: 'a',
      remoteFile: '/www/site.zip',
      localTarget: 'D:\\site.zip',
    },
    `${isolated('Production')} → ${isolated('D:\\')}`,
    `${isolated('Production: /www/site.zip')} → ${isolated('D:\\site.zip')}`,
  ],
  [
    'a drag to Explorer',
    {
      direction: 'down',
      dragOut: true,
      protocol: 'sftp',
      connectionId: 'a',
      remoteFile: '/www/site.zip',
    },
    // Explorer picks a folder on this computer without saying which.
    `${isolated('Production')} → ${isolated('Computer')}`,
    'Production: /www/site.zip',
  ],
  [
    'a copy between servers',
    {
      direction: 'copy',
      protocol: 'sftp',
      sourceConnectionId: 'a',
      targetConnectionId: 'b',
      sourcePath: '/www/site.zip',
      remoteTarget: '/old/site.zip',
    },
    `${isolated('Production')} → ${isolated('Backup')}`,
    `${isolated('Production: /www/site.zip')} → ${isolated('Backup: /old/site.zip')}`,
  ],
  [
    'a copy on one server',
    {
      direction: 'copy',
      protocol: 'sftp',
      sourceConnectionId: 'a',
      targetConnectionId: 'a',
      sourcePath: '/www/site.zip',
      remoteTarget: '/old/site.zip',
    },
    `${isolated('Production: www')} → ${isolated('Production: old')}`,
    `${isolated('Production: /www/site.zip')} → ${isolated('Production: /old/site.zip')}`,
  ],
  [
    'a folder copied on this computer',
    {
      direction: 'recursive',
      intent: {
        id: 'row',
        source: { kind: 'local', path: 'D:\\Site' },
        target: { kind: 'local', path: 'E:\\Site' },
        moving: false,
        overwrite: false,
      },
    },
    `${isolated('D:\\')} → ${isolated('E:\\')}`,
    `${isolated('D:\\Site')} → ${isolated('E:\\Site')}`,
  ],
  [
    'a folder sent from one server to another',
    {
      direction: 'recursive',
      targetProtocol: 'sftp',
      intent: {
        id: 'row',
        source: { kind: 'remote', path: '/www', connectionId: 'b' },
        target: { kind: 'remote', path: '/www', connectionId: 'a' },
        moving: false,
        overwrite: false,
      },
    },
    `${isolated('Backup')} → ${isolated('Production')}`,
    `${isolated('Backup: /www')} → ${isolated('Production: /www')}`,
  ],
] as const)('the Route column names where %s goes', (_, route, label, tooltip) => {
  const { container } = renderRow(
    {
      id: 'row',
      name: 'site.zip',
      status: 'progress',
      bytes: 0,
      startedAt: 1,
      ...route,
    } as TransferRow,
    ['route'],
  );
  const cell = container.querySelector('.t-route');
  expect(cell?.getAttribute('aria-label')).toBe(label);
  expect(container.querySelectorAll('.t-route-name')).toHaveLength(2);
  expect(cell?.getAttribute('data-tooltip')).toBe(tooltip);
});

test('long endpoint names retain their full text and keep the route arrow separate', () => {
  const folder = 'A very long folder name '.repeat(12).trim();
  const { container } = renderRow(
    {
      id: 'long-route',
      name: 'file.txt',
      status: 'done',
      bytes: 0,
      startedAt: 1,
      direction: 'up',
      protocol: 'sftp',
      connectionId: 'a',
      localFile: `C:\\Work\\${folder}\\file.txt`,
      remoteTarget: '/file.txt',
    },
    ['route'],
  );
  const names = container.querySelectorAll('.t-route-name');
  expect(names[0]?.textContent).toBe(folder);
  expect(names[1]?.textContent).toBe('Production');
  expect(container.querySelector('.t-route-arrow')?.textContent).toBe('→');
  expect(container.querySelector('.t-route')?.getAttribute('data-tooltip')).toContain(
    `C:\\Work\\${folder}\\file.txt`,
  );
});
