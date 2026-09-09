import { forwardRef, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConnectionBar } from '../../connections/index.ts';
import Icon from '../../../components/Icon.tsx';
import type { IconName } from '../../../components/Icon.tsx';
import MenuItems from '../../../components/MenuItems.tsx';
import { getInterfaceScale } from '../../../platform/interfaceScale.ts';
import type { ConnectionForm, ManagedSite, PaneKind, PaneStatus } from '../../../shared/types.ts';
import useDismissableOverlay from '../../../hooks/useDismissableOverlay.ts';
import { useTruncated } from '../../../hooks/useTruncated.ts';

interface PanelPosition {
  top: number;
  inlineStart: number;
}

interface PaneSourceState {
  kind: PaneKind;
  status: PaneStatus;
  siteLabel: string;
  siteId: string | null;
  form: ConnectionForm;
  errorMessage: string;
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
      onOpenSiteManager,
      onOpenLocalPathManager,
    },
    forwardedRef,
  ) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [panelPos, setPanelPos] = useState<PanelPosition | null>(null);

    const dismiss = useCallback(() => setOpen(false), []);
    useDismissableOverlay({ open, rootRef, onDismiss: dismiss, restoreFocusRef: triggerRef });

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
      setOpen((v) => {
        const next = !v;
        if (next && triggerRef.current) {
          const rect = triggerRef.current.getBoundingClientRect();
          const scale = getInterfaceScale();
          const viewportWidth = window.innerWidth / scale;
          const inlineStart =
            document.documentElement.dir === 'rtl'
              ? viewportWidth - rect.right / scale
              : rect.left / scale;
          setPanelPos({
            top: (rect.bottom + 2) / scale,
            inlineStart: Math.max(8, inlineStart),
          });
        }
        return next;
      });
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
        >
          <span className={`pane-source-dot state-${dotState}`} />
          <span ref={labelRef} className={`pane-source-label${labelTruncated ? ' truncated' : ''}`}>
            {label}
          </span>
          <span className="pane-source-chev">▾</span>
        </button>

        {open && panelPos && (
          <div
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
                  onClick: onStartConnect,
                },
                {
                  label: t('paneSourceSwitcher.local'),
                  checked: pane.kind === 'local',
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
                  onClick={onOpenLocalPathManager}
                >
                  <Icon name="bookmark" size={14} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  data-tooltip={t('saveLocalPath.tooltip')}
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
                  onClick={onDisconnect}
                >
                  <Icon name="power" size={14} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  data-tooltip={t('menu.file.manageBookmarks')}
                  onClick={onOpenSiteManager}
                >
                  <Icon name="bookmark" size={14} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  data-tooltip={t('menu.file.saveConnection')}
                  onClick={onSaveSite}
                >
                  <Icon name="star" size={14} />
                </button>
              </>
            )}
          </>
        )}
      </div>
    );
  },
);

export default PaneSourceSwitcher;
