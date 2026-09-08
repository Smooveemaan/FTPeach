import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../components/Icon.tsx';
import type { IconName } from '../../../components/Icon.tsx';
import { siteMeta } from '../../sites/index.ts';
import type { ManagedSite } from '../../../shared/types.ts';

interface PaneConnectEmptyStateProps {
  sites: readonly ManagedSite[];
  orderedSites: readonly ManagedSite[];
  onSiteConnect: (site: ManagedSite) => unknown;
  onOpenSiteManager: () => unknown;
}

interface PaneQuicklistRowProps {
  site: ManagedSite;
  onSiteConnect: (site: ManagedSite) => unknown;
}

const QUICKLIST_LIMIT = 3;

export default function PaneConnectEmptyState({
  sites,
  orderedSites,
  onSiteConnect,
  onOpenSiteManager,
}: PaneConnectEmptyStateProps) {
  const { t } = useTranslation();
  if (sites.length === 0) {
    return (
      <div className="pane-connect-empty pane-connect-onboard">
        <Icon name="database" size={30} />
        <div className="pane-connect-onboard-title">
          {t('paneConnectEmptyState.noSavedConnectionsTitle')}
        </div>
        <div className="pane-connect-onboard-body">
          {t('paneConnectEmptyState.noSavedConnectionsBody')}
        </div>
        <button
          type="button"
          className="btn btn-ghost pane-connect-cta"
          onClick={onOpenSiteManager}
        >
          {t('paneConnectEmptyState.manageBookmarksCta', {
            label: t('paneConnectEmptyState.manageBookmarksLink'),
          })}
        </button>
      </div>
    );
  }

  return (
    <div className="pane-connect-empty pane-connect-quicklist">
      <div className="pane-quicklist-label">{t('paneConnectEmptyState.quicklistLabel')}</div>
      {orderedSites.slice(0, QUICKLIST_LIMIT).map((site) => (
        <PaneQuicklistRow key={site.id} site={site} onSiteConnect={onSiteConnect} />
      ))}
      <button
        type="button"
        className="btn btn-ghost pane-quicklist-more"
        onClick={onOpenSiteManager}
      >
        {t('paneConnectEmptyState.manageBookmarksLink')}
      </button>
    </div>
  );
}

function PaneQuicklistRow({ site, onSiteConnect }: PaneQuicklistRowProps) {
  const metaRef = useRef<HTMLDivElement>(null);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    const el = metaRef.current;
    if (!el) return undefined;
    const check = () => setTruncated(el.scrollWidth > el.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [site.id]);

  return (
    <div
      className="pane-quicklist-row"
      role="button"
      tabIndex={0}
      onClick={() => onSiteConnect(site)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onSiteConnect(site);
      }}
    >
      <span className="pane-quicklist-icon">
        <Icon
          name={(site.icon || 'bookmark') as IconName}
          size={15}
          color={site.color || undefined}
        />
      </span>
      <div className="pane-quicklist-info">
        <div className="pane-quicklist-name">{site.name}</div>
        <div ref={metaRef} className={`pane-quicklist-meta${truncated ? ' truncated' : ''}`}>
          {siteMeta(site)}
        </div>
      </div>
      <span className="pane-quicklist-connect">
        <Icon name="power" size={13} />
      </span>
    </div>
  );
}
