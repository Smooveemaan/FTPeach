import { forwardRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConnectionBar } from '../../connections/index.ts';
import Icon from '../../../components/Icon.tsx';
import type { IconName } from '../../../components/Icon.tsx';
import ContextMenu from '../../../components/ContextMenu.tsx';
import { clipboard } from '../../../platform/clipboard.ts';
import { handler, reportRejection } from '../../../shared/asyncFailure.ts';
import { connectionAddress } from '../../../shared/siteContracts.ts';
import MenuItems from '../../../components/MenuItems.tsx';
import { useAnchoredMenu } from '../../../hooks/useMenuPosition.ts';
import type { ConnectionForm, ManagedSite } from '../../../shared/siteContracts.ts';
import type { PaneKind, PaneStatus } from '../../../shared/paneContracts.ts';
import { useTruncated } from '../../../hooks/useTruncated.ts';

interface PaneSourceState {
  kind: PaneKind;
  status: PaneStatus;
  siteLabel: string;
  siteId: string | null;
  form: ConnectionForm;
  errorMessage: string;
  sshFingerprint?: string | undefined;
}

interface PaneSourceSwitcherProps {
  pane: PaneSourceState;
  orderedSites: readonly ManagedSite[];
  localPaths: readonly ManagedSite[];
  updatedAt?: string | number | Date | null;
  /** Formats {@link updatedAt}. A prop, so this stays free of settings state. */
  formatDate: (date: string | number | Date | null | undefined) => string;
  onSwitchLocal: () => unknown;
  onStartConnect: () => unknown;
  onFormChange: (form: ConnectionForm) => unknown;
  onDismissError: () => unknown;
  onConnect: () => unknown;
  onDisconnect: () => unknown;
  onCancelConnect: () => unknown;
  onSiteConnect: (site: ManagedSite) => unknown;
  onLocalPathOpen: (site: ManagedSite) => unknown;
  onSaveSite: () => unknown;
  terminalActive?: boolean;
  onToggleTerminal?: () => unknown;
  onConnectWithTerminal?: () => unknown;
  onOpenSiteManager: () => unknown;
  onOpenLocalPathManager: () => unknown;
}

const PaneSourceSwitcher = forwardRef<HTMLDivElement, PaneSourceSwitcherProps>(
  function PaneSourceSwitcher(
    {
      pane,
      orderedSites,
      localPaths,
      updatedAt,
      formatDate,
      onSwitchLocal,
      onStartConnect,
      onFormChange,
      onDismissError,
      onConnect,
      onDisconnect,
      onCancelConnect,
      onSiteConnect,
      onLocalPathOpen,
      onSaveSite,
      terminalActive,
      onToggleTerminal,
      onConnectWithTerminal,
      onOpenSiteManager,
      onOpenLocalPathManager,
    },
    forwardedRef,
  ) {
    const { t } = useTranslation();
    const { open, setOpen, rootRef, triggerRef, panelRef, panelPos } = useAnchoredMenu();

    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
    const address = connectionAddress(pane.form);
    const isConnected = pane.status === 'connected';
    const showForm = pane.kind === 'remote' && !isConnected;
    const dotState =
      pane.kind === 'local'
        ? 'connected'
        : pane.status === 'connecting'
          ? 'connecting'
          : isConnected
            ? 'connected'
            : 'idle';
    const label =
      pane.kind === 'local'
        ? t('paneSourceSwitcher.local')
        : isConnected
          ? pane.siteLabel ||
            pane.form.host ||
            pane.form.webdavUrl ||
            t('paneSourceSwitcher.remote')
          : t('paneSourceSwitcher.remote');
    const [labelRef, labelTruncated] = useTruncated<HTMLSpanElement>([label]);

    const toggleOpen = () => {
      setContextMenu(null);
      setOpen((v) => !v);
    };

    const sourceButton = (
      <div className="pane-source-anchor" ref={rootRef}>
        <button
          type="button"
          ref={triggerRef}
          className={`pane-source ${open ? 'open' : ''} ${dotState === 'idle' ? 'disconnected' : ''}`}
          data-tooltip={
            updatedAt
              ? t('paneSourceSwitcher.updatedAtTooltip', { date: formatDate(updatedAt) })
              : undefined
          }
          onClick={toggleOpen}
          onContextMenu={(event) => {
            event.preventDefault();
            setOpen(false);
            if (pane.kind === 'remote') setContextMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          <span className={`pane-source-dot state-${dotState}`} />
          <span ref={labelRef} className={`pane-source-label${labelTruncated ? ' truncated' : ''}`}>
            {label}
          </span>
          <span className="pane-source-chev">▾</span>
        </button>

        {open && panelPos && (
          <div
            ref={panelRef}
            className="menu-dropdown pane-source-menu"
            style={{ top: panelPos.top, insetInlineStart: panelPos.inlineStart }}
          >
            <MenuItems
              onAction={() => setOpen(false)}
              items={[
                ...(pane.kind === 'remote' && isConnected
                  ? [
                      { label: t('menu.file.disconnect'), danger: true, onClick: onDisconnect },
                      { separator: true },
                    ]
                  : []),
                {
                  label: t('paneSourceSwitcher.connectToServer'),
                  className: 'new-connection',
                  checked: pane.kind === 'remote',
                  radio: true,
                  onClick: onStartConnect,
                },
                {
                  label: t('paneSourceSwitcher.local'),
                  checked: pane.kind === 'local',
                  radio: true,
                  disabled: pane.kind === 'local',
                  onClick: onSwitchLocal,
                },
                ...(pane.kind === 'local' && localPaths.length > 0
                  ? [
                      { separator: true },
                      ...localPaths.map((site) => ({
                        label: site.name,
                        icon: (
                          <Icon
                            name={(site.icon || 'bookmark') as IconName}
                            size={13}
                            color={site.color || undefined}
                          />
                        ),
                        checked: pane.siteId === site.id,
                        radio: true,
                        onClick: () => onLocalPathOpen(site),
                      })),
                    ]
                  : []),
                ...(pane.kind === 'remote' && orderedSites.length > 0
                  ? [
                      { separator: true },
                      ...orderedSites.map((site, i) => ({
                        label: site.name,
                        icon: (
                          <Icon
                            name={(site.icon || 'bookmark') as IconName}
                            size={13}
                            color={site.color || undefined}
                          />
                        ),
                        checked: isConnected && pane.siteId === site.id,
                        radio: true,
                        onClick: () => onSiteConnect(site),
                        ...(i === 0 ? { scrollStart: true } : {}),
                      })),
                    ]
                  : []),
              ]}
            />
          </div>
        )}
      </div>
    );

    return (
      <div ref={forwardedRef} className={`pane-source-wrap ${showForm ? 'form-open' : ''}`}>
        {contextMenu && pane.kind === 'remote' && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            items={[
              {
                id: 'toggle-connection',
                label: t(
                  isConnected
                    ? 'connectionBar.connectTooltip.disconnect'
                    : 'connectionBar.connectTooltip.connect',
                ),
                disabled: pane.status === 'connecting' || (!isConnected && !address),
                onClick: handler(isConnected ? onDisconnect : onConnect),
              },
              {
                id: 'copy-connection-address',
                label: t('paneSourceSwitcher.copyConnectionAddress'),
                disabled: !address,
                onClick: () => reportRejection(clipboard.writeText(address)),
              },
              ...(pane.form.protocol === 'sftp' && pane.sshFingerprint
                ? [
                    {
                      id: 'ssh-fingerprint',
                      label: t('paneSourceSwitcher.copySshFingerprint'),
                      onClick: () => reportRejection(clipboard.writeText(pane.sshFingerprint!)),
                    },
                  ]
                : []),
            ]}
          />
        )}
        {showForm ? (
          <ConnectionBar
            leadingSlot={sourceButton}
            form={pane.form}
            onChange={onFormChange}
            status={pane.status}
            errorMessage={pane.errorMessage}
            onDismissError={onDismissError}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onCancelConnect={onCancelConnect}
            onSaveSite={onSaveSite}
            onOpenTerminal={onConnectWithTerminal}
            terminalActive={terminalActive}
            narrow
            connectionVisualState={pane.status === 'connecting' ? 'connecting' : 'idle'}
            onOpenSiteManager={onOpenSiteManager}
          />
        ) : (
          <>
            {sourceButton}
            {pane.kind === 'local' && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  data-tooltip={t('siteManagerDialog.manageLocalPaths')}
                  aria-label={t('siteManagerDialog.manageLocalPaths')}
                  onClick={onOpenLocalPathManager}
                >
                  <Icon name="bookmark" size={14} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  data-tooltip={t('saveLocalPath.tooltip')}
                  aria-label={t('saveLocalPath.tooltip')}
                  onClick={onSaveSite}
                >
                  <Icon name="star" size={14} />
                </button>
              </>
            )}
            {/* Once connected, ConnectionBar (and the connect/disconnect
              power button it owns) unmounts entirely — without this, the
              only way to disconnect is to open the dropdown menu above.
              Keeps the same button visible across the connecting→connected
              transition instead of it vanishing the moment the form closes. */}
            {pane.kind === 'remote' && isConnected && (
              <>
                <button
                  type="button"
                  className="btn btn-icon connect-toggle-btn state-connected"
                  data-tooltip={t('connectionBar.connectTooltip.disconnect')}
                  aria-label={t('connectionBar.connectTooltip.disconnect')}
                  onClick={onDisconnect}
                >
                  <Icon name="power" size={14} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  data-tooltip={t('menu.file.manageBookmarks')}
                  aria-label={t('menu.file.manageBookmarks')}
                  onClick={onOpenSiteManager}
                >
                  <Icon name="bookmark" size={14} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  data-tooltip={t('menu.file.saveConnection')}
                  aria-label={t('menu.file.saveConnection')}
                  onClick={onSaveSite}
                >
                  <Icon name="star" size={14} />
                </button>
                {onToggleTerminal && (
                  <button
                    type="button"
                    className={`btn btn-ghost btn-icon terminal-toggle-btn ${terminalActive ? 'active' : ''}`}
                    data-action="toggle-terminal"
                    data-tooltip={
                      pane.form.protocol !== 'sftp'
                        ? t('terminal.sftpOnlyTooltip')
                        : terminalActive
                          ? t('terminal.close')
                          : t('terminal.open')
                    }
                    aria-label={
                      pane.form.protocol !== 'sftp'
                        ? t('terminal.sftpOnlyTooltip')
                        : terminalActive
                          ? t('terminal.close')
                          : t('terminal.open')
                    }
                    aria-pressed={
                      pane.form.protocol === 'sftp' ? Boolean(terminalActive) : undefined
                    }
                    disabled={pane.form.protocol !== 'sftp'}
                    onClick={onToggleTerminal}
                  >
                    <Icon name="terminal" size={14} />
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
    );
  },
);

export default PaneSourceSwitcher;
