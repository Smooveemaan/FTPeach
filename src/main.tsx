import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import ErrorBoundary from './components/ErrorBoundary.tsx';
import i18n from './i18n/index.ts';
import './styles/theme.css';
import { installKeyboardNavigation } from './platform/keyboardNavigation.ts';

const disposeKeyboardNavigation = installKeyboardNavigation();
if (import.meta.hot) import.meta.hot.dispose(disposeKeyboardNavigation);

const securityRequestId = new URLSearchParams(window.location.search).get('security-confirmation');

// Each window loads only its own UI. Start the main UI and IPC adapter imports
// together so the adapter does not add a second module-loading waterfall.
const content = securityRequestId
  ? await import('./platform/SecurityConfirmation.tsx').then(
      ({ default: SecurityConfirmation }) => <SecurityConfirmation requestId={securityRequestId} />,
    )
  : await Promise.all([
      import('./App.tsx'),
      '__TAURI_INTERNALS__' in window
        ? import('./platform/tauriApi.ts').then(({ installTauriApi }) => installTauriApi())
        : Promise.resolve(),
    ]).then(([{ default: App }]) => <App />);

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root application container.');

createRoot(rootElement).render(
  <ErrorBoundary>
    <I18nextProvider i18n={i18n}>{content}</I18nextProvider>
  </ErrorBoundary>,
);
