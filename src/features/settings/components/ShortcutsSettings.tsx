import { useTranslation } from 'react-i18next';
import Icon from '../../../components/Icon.tsx';
import ShortcutRecorder from '../../../components/ShortcutRecorder.tsx';
import { SHORTCUT_ACTIONS, shortcutActionsByScope } from '../../../shortcuts/registry.ts';
import { effectiveBinding, findConflict } from '../../../shortcuts/resolve.ts';
import type { PaneId } from '../../../shared/types.ts';
import type { PaneOrientation, ShortcutOverrides } from '../useSettings.ts';

interface ShortcutsSettingsProps {
  shortcutOverridesValue: ShortcutOverrides;
  setShortcutOverridesValue: (
    update: ShortcutOverrides | ((current: ShortcutOverrides) => ShortcutOverrides),
  ) => void;
  paneOrientation: PaneOrientation;
}

export default function ShortcutsSettings({
  shortcutOverridesValue,
  setShortcutOverridesValue,
  paneOrientation,
}: ShortcutsSettingsProps) {
  const { t } = useTranslation();

  const shortcutPaneSideWord = (pane: PaneId) =>
    paneOrientation === 'vertical'
      ? t(pane === 'a' ? 'paneSide.top' : 'paneSide.bottom')
      : t(pane === 'a' ? 'paneSide.left' : 'paneSide.right');

  return (
    <div className="settings-option-list">
      <div className="settings-option-group">
        <div className="settings-shortcuts-heading">
          <span className="settings-shortcuts-title">{t('settings.shortcuts.title')}</span>
          <button
            type="button"
            className="btn btn-icon settings-shortcuts-reset"
            aria-label={t('settings.shortcuts.resetAll')}
            data-tooltip={t('settings.shortcuts.resetAll')}
            disabled={
              !SHORTCUT_ACTIONS.some(
                (entry) => effectiveBinding(entry.id, shortcutOverridesValue) !== entry.default,
              )
            }
            onClick={() => setShortcutOverridesValue({})}
          >
            <Icon name="refresh" size={14} />
          </button>
        </div>
        <p className="settings-hint">{t('settings.shortcuts.hint')}</p>
      </div>
      <div className="settings-shortcuts-scopes">
        {(
          [
            { scope: 'global', titleKey: 'settings.shortcuts.globalTitle' },
            { scope: 'pane', titleKey: 'settings.shortcuts.paneTitle' },
          ] as const
        ).map(({ scope, titleKey }) => (
          <div className="settings-shortcuts-list" key={scope}>
            <div className="settings-shortcuts-scope-header">{t(titleKey)}</div>
            {shortcutActionsByScope(scope).map((entry) => {
              const binding = effectiveBinding(entry.id, shortcutOverridesValue);
              const conflictId = findConflict(
                entry.id,
                binding,
                entry.scope,
                shortcutOverridesValue,
              );
              const conflictEntry = conflictId && SHORTCUT_ACTIONS.find((a) => a.id === conflictId);
              const overridden = binding !== entry.default;
              return (
                <div className="settings-shortcut-row" key={entry.id}>
                  <span className="settings-shortcut-label">
                    {entry.pane
                      ? t(entry.labelKey, { side: shortcutPaneSideWord(entry.pane) })
                      : t(entry.labelKey)}
                  </span>
                  <ShortcutRecorder
                    value={binding}
                    onChange={(next) =>
                      setShortcutOverridesValue((current) => {
                        const updated = { ...current };
                        if (next === entry.default) delete updated[entry.id];
                        else updated[entry.id] = next;
                        return updated;
                      })
                    }
                  />
                  <div className="settings-shortcut-actions">
                    <button
                      type="button"
                      className="btn btn-icon settings-shortcut-icon-btn"
                      aria-label={t('settings.shortcuts.reset')}
                      data-tooltip={t('settings.shortcuts.reset')}
                      disabled={!overridden}
                      onClick={() =>
                        setShortcutOverridesValue((current) => {
                          const next = { ...current };
                          delete next[entry.id];
                          return next;
                        })
                      }
                    >
                      <Icon name="refresh" size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon settings-shortcut-icon-btn"
                      aria-label={t('settings.shortcuts.unassign')}
                      data-tooltip={t('settings.shortcuts.unassign')}
                      aria-hidden={!binding || undefined}
                      tabIndex={binding ? undefined : -1}
                      onClick={() =>
                        setShortcutOverridesValue((current) => ({
                          ...current,
                          [entry.id]: '',
                        }))
                      }
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                  {conflictEntry && (
                    <span className="settings-hint settings-warning settings-shortcut-conflict">
                      <Icon name="triangleAlert" size={12} />
                      {t('settings.shortcuts.conflict', {
                        action: t(conflictEntry.labelKey),
                      })}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
