import { memo, useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import ContextMenu from '../../components/ContextMenu.tsx';
import Icon from '../../components/Icon.tsx';
import { handler } from '../../shared/asyncFailure.ts';
import { terminalStore } from './terminalStore.ts';
import type { TerminalSessionSnapshot, TerminalStore } from './terminalStore.ts';

export interface TerminalPanelProps {
  session: TerminalSessionSnapshot;
  style?: CSSProperties | undefined;
  store?: TerminalStore;
}

function TerminalPanel({ session, style, store = terminalStore }: TerminalPanelProps) {
  const { t } = useTranslation();
  const { connectionId, mode, status, exitCode, message, hasSelection } = session;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const isCollapsed = mode === 'collapsed';
  const isMaximized = mode === 'maximized';

  useEffect(() => {
    const container = bodyRef.current;
    if (!container) return;
    return store.attachHost(connectionId, container);
  }, [connectionId, store]);

  useEffect(() => {
    const container = bodyRef.current;
    if (!container || isCollapsed) return;

    let frame = 0;
    const scheduleFit = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        store.syncResize(connectionId);
      });
    };

    scheduleFit();

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        if (frame) cancelAnimationFrame(frame);
      };
    }

    const observer = new ResizeObserver(scheduleFit);
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [connectionId, isCollapsed, isMaximized, store]);

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  let statusText: string | null = null;
  let statusTooltip: string | null = null;
  if (status === 'connecting') {
    statusText = t('terminal.status.connecting');
  } else if (status === 'exited') {
    statusText =
      exitCode !== null && exitCode !== 0
        ? t('terminal.processExitedWithCode', { code: exitCode })
        : t('terminal.processExited');
    statusTooltip = statusText;
  } else if (status === 'refused') {
    statusText = t('terminal.status.shellRefusedShort');
    statusTooltip = t('terminal.shellRefused');
  } else if (status === 'error') {
    statusText = message || t('terminal.openFailed');
    statusTooltip = statusText;
  }

  const nonZeroExit = status === 'exited' && exitCode !== null && exitCode !== 0;

  return (
    <section
      className={`terminal-panel ${isCollapsed ? 'is-collapsed' : ''} ${isMaximized ? 'is-maximized' : ''}`}
      style={style}
      data-terminal-mode={mode}
      aria-label={t('terminal.title')}
    >
      <div className="section-panel-header terminal-panel-header">
        <span className="terminal-panel-title">{t('terminal.title')}</span>
        {statusText && (
          <>
            <span className="toolbar-divider" />
            <span
              className={`terminal-panel-status is-${status}${nonZeroExit ? ' is-nonzero' : ''}`}
              role="status"
              data-tooltip={statusTooltip ?? undefined}
            >
              {statusText}
            </span>
          </>
        )}
        <span className="terminal-panel-actions">
          {(status === 'exited' || status === 'error') && (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-icon header-icon-btn"
                data-action="terminal-reconnect"
                data-tooltip={t('terminal.reconnect')}
                aria-label={t('terminal.reconnect')}
                onClick={handler(() => store.reconnect(connectionId))}
              >
                <Icon name="refresh" size={12} />
              </button>
              <span className="toolbar-divider" />
            </>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-icon header-icon-btn"
            data-action="terminal-copy"
            data-tooltip={t('terminal.contextMenu.copy')}
            aria-label={t('terminal.contextMenu.copy')}
            disabled={!hasSelection}
            onClick={() => store.copySelection(connectionId)}
          >
            <Icon name="copy" size={12} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon header-icon-btn"
            data-action="terminal-paste"
            data-tooltip={t('terminal.contextMenu.paste')}
            aria-label={t('terminal.contextMenu.paste')}
            disabled={status !== 'open'}
            onClick={() => store.pasteFromClipboard(connectionId)}
          >
            <Icon name="clipboard" size={12} />
          </button>
          <span className="toolbar-divider" />
          <button
            type="button"
            className="btn btn-ghost btn-icon header-icon-btn"
            data-action="terminal-collapse"
            data-tooltip={isCollapsed ? t('terminal.expand') : t('terminal.collapse')}
            aria-label={isCollapsed ? t('terminal.expand') : t('terminal.collapse')}
            onClick={() => store.toggleCollapse(connectionId)}
          >
            <Icon name={isCollapsed ? 'chevronUp' : 'chevronDown'} size={12} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon header-icon-btn"
            data-action="terminal-maximize"
            data-tooltip={isMaximized ? t('terminal.restore') : t('terminal.maximize')}
            aria-label={isMaximized ? t('terminal.restore') : t('terminal.maximize')}
            onClick={() => store.toggleMaximize(connectionId)}
          >
            <Icon name={isMaximized ? 'chevronsCollapse' : 'chevronsExpand'} size={12} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon header-icon-btn"
            data-action="terminal-close"
            data-tooltip={t('terminal.close')}
            aria-label={t('terminal.close')}
            onClick={() => store.close(connectionId)}
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      </div>

      <div
        className="terminal-panel-body"
        data-terminal-input="true"
        onContextMenu={handleContextMenu}
        onMouseDown={() => {
          if (status === 'open') store.focus(connectionId);
        }}
      >
        <div ref={bodyRef} className="terminal-panel-viewport" />
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              id: 'terminal-copy',
              label: t('terminal.contextMenu.copy'),
              disabled: !store.hasSelection(connectionId),
              onClick: () => store.copySelection(connectionId),
            },
            {
              id: 'terminal-paste',
              label: t('terminal.contextMenu.paste'),
              disabled: status !== 'open',
              onClick: () => store.pasteFromClipboard(connectionId),
            },
            { separator: true },
            {
              id: 'terminal-select-all',
              label: t('terminal.contextMenu.selectAll'),
              onClick: () => store.selectAll(connectionId),
            },
            {
              id: 'terminal-clear',
              label: t('terminal.contextMenu.clear'),
              onClick: () => store.clear(connectionId),
            },
          ]}
        />
      )}
    </section>
  );
}

export default memo(TerminalPanel);
