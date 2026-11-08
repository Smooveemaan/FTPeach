import { useTranslation } from 'react-i18next';
import Icon from '../components/Icon.tsx';
import { hostPlatform } from '../platform/os.ts';
import { useWindowControls, type WindowControlsModel } from '../platform/useWindowControls.ts';

interface TitleBarProps {
  minimizeToTray: boolean;
  platform?: 'windows' | 'macos' | 'linux';
}

function TauriWindowControls({
  maximized,
  minimize,
  toggleMaximize,
  close,
}: Omit<WindowControlsModel, 'available' | 'showSystemMenu'>) {
  const { t } = useTranslation();

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

export default function TitleBar({ minimizeToTray, platform = hostPlatform() }: TitleBarProps) {
  const isMac = platform === 'macos';
  const { available, showSystemMenu, ...controls } = useWindowControls(
    minimizeToTray,
    undefined,
    !isMac && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
  );

  return (
    <div
      className={`title-bar ${isMac ? 'macos' : ''}`}
      data-platform={platform}
      data-tauri-drag-region="deep"
      onContextMenu={
        available && !isMac
          ? (event) => {
              event.preventDefault();
              showSystemMenu();
            }
          : undefined
      }
    >
      <span className="wordmark">
        <b>FTP</b>each
      </span>
      <span className="title-bar-spacer" />
      {available && !isMac && <TauriWindowControls {...controls} />}
    </div>
  );
}
