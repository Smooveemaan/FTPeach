import { useTranslation } from 'react-i18next';
import Icon from '../components/Icon.tsx';
import { useWindowControls } from '../platform/useWindowControls.ts';

interface TitleBarProps {
  minimizeToTray: boolean;
}

function TauriWindowControls({ minimizeToTray }: TitleBarProps) {
  const { t } = useTranslation();
  const { available, maximized, minimize, toggleMaximize, close } =
    useWindowControls(minimizeToTray);
  if (!available) return null;

  return (
    <div className="title-bar-controls">
      <button
        type="button"
        className="title-bar-btn"
        onClick={minimize}
        aria-label={t('titleBar.minimize')}
      >
        <Icon name="windowMinimize" size={12} />
      </button>
      <button
        type="button"
        className="title-bar-btn"
        onClick={toggleMaximize}
        aria-label={t(maximized ? 'titleBar.restore' : 'titleBar.maximize')}
      >
        <Icon name={maximized ? 'windowRestore' : 'windowMaximize'} size={12} />
      </button>
      <button
        type="button"
        className="title-bar-btn title-bar-btn-close"
        onClick={close}
        aria-label={t('common.close')}
      >
        <Icon name="windowClose" size={12} />
      </button>
    </div>
  );
}

export default function TitleBar({ minimizeToTray }: TitleBarProps) {
  return (
    <div className="title-bar" data-tauri-drag-region="deep">
      <span className="wordmark">
        <b>FTP</b>each
      </span>
      <span className="title-bar-spacer" />
      <TauriWindowControls minimizeToTray={minimizeToTray} />
    </div>
  );
}
