import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../components/Icon.tsx';
import { useSettingsNavCarousel } from '../hooks/useSettingsNavCarousel.ts';
import type { Translate } from '../../../shared/types.ts';

export type CategoryKey =
  'connection' | 'transfers' | 'interface' | 'shortcuts' | 'security' | 'updates' | 'logging';

export interface SettingsCategory {
  key: CategoryKey;
  label: string;
}

// Left-nav order, top to bottom — also determines the default active
// category (buildSettingsCategories(t)[0], used by SettingsDialog.tsx).
export const buildSettingsCategories = (
  t: Translate,
): [SettingsCategory, ...SettingsCategory[]] => [
  { key: 'connection', label: t('settings.categories.connection') },
  { key: 'transfers', label: t('settings.categories.transfers') },
  { key: 'interface', label: t('settings.categories.interface') },
  { key: 'shortcuts', label: t('settings.categories.shortcuts') },
  { key: 'security', label: t('settings.categories.security') },
  { key: 'updates', label: t('settings.categories.updates') },
  { key: 'logging', label: t('settings.categories.logging') },
];

interface SettingsNavProps {
  categories: SettingsCategory[];
  category: CategoryKey;
  onSelectCategory: (key: CategoryKey) => void;
  onEnterPanel: () => void;
  narrow: boolean;
  // Tab label widths can change without the tab count changing (a language
  // switch) — passed through to useSettingsNavCarousel to trigger a remeasure.
  remeasureKey: unknown;
}

export default function SettingsNav({
  categories,
  category,
  onSelectCategory,
  onEnterPanel,
  narrow,
  remeasureKey,
}: SettingsNavProps) {
  const { t } = useTranslation();
  const enterPanelOnTabRef = useRef(false);
  const rtl = document.documentElement.dir === 'rtl';
  const {
    settingsNavRef,
    settingsNavWindowRef,
    settingsNavTabsRef,
    settingsNavCarousel,
    scrollSettingsTabs,
    revealSettingsTab,
  } = useSettingsNavCarousel({
    narrow,
    remeasureKey,
    activeIndex: categories.findIndex((c) => c.key === category),
  });

  return (
    <nav className="settings-nav" ref={settingsNavRef}>
      <button
        type="button"
        className="settings-nav-arrow"
        aria-label={t('paneToolbar.back')}
        disabled={!settingsNavCarousel.canScrollBack}
        aria-hidden={!settingsNavCarousel.overflowing}
        onClick={() => scrollSettingsTabs(-1)}
      >
        <Icon name={rtl ? 'chevronRight' : 'chevronLeft'} size={9} />
      </button>
      <div className="settings-nav-window" ref={settingsNavWindowRef}>
        <div
          className="settings-nav-scroll"
          style={
            settingsNavCarousel.width == null
              ? undefined
              : { width: `${settingsNavCarousel.width}px` }
          }
        >
          <div
            className="settings-nav-tabs"
            ref={settingsNavTabsRef}
            style={{
              transform: `translateX(${rtl ? settingsNavCarousel.offset : -settingsNavCarousel.offset}px)`,
            }}
          >
            {categories.map((c, index) => (
              <button
                key={c.key}
                type="button"
                className={`settings-nav-item ${category === c.key ? 'active' : ''}`}
                data-label={c.label}
                aria-current={category === c.key ? 'true' : undefined}
                onFocus={() => revealSettingsTab(index)}
                onBlur={() => {
                  enterPanelOnTabRef.current = false;
                }}
                onPointerDown={() => {
                  enterPanelOnTabRef.current = false;
                }}
                onKeyDown={(event) => {
                  if (!narrow || event.altKey || event.ctrlKey || event.metaKey) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    enterPanelOnTabRef.current = true;
                  } else if (event.key === 'Tab' && !event.shiftKey && enterPanelOnTabRef.current) {
                    event.preventDefault();
                    event.stopPropagation();
                    enterPanelOnTabRef.current = false;
                    onEnterPanel();
                  }
                }}
                onClick={() => onSelectCategory(c.key)}
              >
                <span>{c.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <button
        type="button"
        className="settings-nav-arrow"
        aria-label={t('paneToolbar.forward')}
        disabled={!settingsNavCarousel.canScrollForward}
        aria-hidden={!settingsNavCarousel.overflowing}
        onClick={() => scrollSettingsTabs(1)}
      >
        <Icon name={rtl ? 'chevronLeft' : 'chevronRight'} size={9} />
      </button>
    </nav>
  );
}
