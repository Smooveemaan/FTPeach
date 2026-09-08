import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';

import Application from '../../src/app/Application.tsx';
import ErrorBoundary from '../../src/components/ErrorBoundary.tsx';
import { setTransfersStore } from '../../src/features/transfers/transferStore.ts';
import i18n from '../../src/i18n/index.ts';
import '../../src/styles/theme.css';
import { visualTestApi } from './visualTestApi.ts';
import { installKeyboardNavigation } from '../../src/platform/keyboardNavigation.ts';

const disposeKeyboardNavigation = installKeyboardNavigation();
if (import.meta.hot) import.meta.hot.dispose(disposeKeyboardNavigation);

window.api = visualTestApi;
setTransfersStore({
  upload: {
    id: 'upload',
    direction: 'up',
    name: 'release-notes.md',
    protocol: 'sftp',
    status: 'progress',
    bytes: 11_264,
    total: 18_432,
    startedAt: Date.now() - 8_000,
    connectionId: 'visual-remote',
    localFile: 'C:\\Users\\developer\\Projects\\release-notes.md',
    remoteTarget: '/var/www/release-notes.md',
  },
  // Named long enough to overflow the "File" column, so every baseline shows
  // a `.truncated` label — the one place the shared `--truncate-fade` token
  // is under test, and the only way a regression in its direction (it has to
  // mirror in RTL) fails a check instead of shipping.
  queued: {
    id: 'queued',
    direction: 'up',
    name: 'quarterly-infrastructure-migration-plan-final-revision.tar.gz',
    protocol: 'sftp',
    status: 'queued',
    bytes: 0,
    total: 41_943_040,
    startedAt: Date.now() - 2_000,
    connectionId: 'visual-remote',
    localFile:
      'C:\\Users\\developer\\Projects\\quarterly-infrastructure-migration-plan-final-revision.tar.gz',
    remoteTarget: '/var/www/quarterly-infrastructure-migration-plan-final-revision.tar.gz',
  },
  download: {
    id: 'download',
    direction: 'down',
    name: 'robots.txt',
    protocol: 'sftp',
    status: 'done',
    bytes: 248,
    total: 248,
    startedAt: Date.now() - 12_000,
    connectionId: 'visual-remote',
    remoteFile: '/var/www/robots.txt',
    localTarget: 'C:\\Users\\developer\\Projects\\robots.txt',
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root visual test container.');

createRoot(root).render(
  <ErrorBoundary>
    <I18nextProvider i18n={i18n}>
      <Application />
    </I18nextProvider>
  </ErrorBoundary>,
);
