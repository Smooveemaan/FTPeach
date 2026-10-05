import { useCallback, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ChangeEventHandler,
  CSSProperties,
  Dispatch,
  InputHTMLAttributes,
  ReactNode,
  RefObject,
  SetStateAction,
} from 'react';
import PasswordInput from '../../components/PasswordInput.tsx';
import SelectMenu from '../../components/SelectMenu.tsx';
import { ProtocolSelect } from '../connections/index.ts';
import Icon from '../../components/Icon.tsx';
import DismissibleError from '../../components/DismissibleError.tsx';
import type { IconName } from '../../components/Icon.tsx';
import { SITE_COLORS, SITE_ENCODINGS, SITE_ICONS, SITE_ICON_LABEL_KEYS } from './siteMeta.ts';
import { setNativeInputValue } from '../../shared/nativeInput.ts';
import { useMenuPosition } from '../../hooks/useMenuPosition.ts';
import { DEFAULT_PORTS } from '../../shared/siteContracts.ts';
import type { ManagedSite, SiteProtocol } from '../../shared/siteContracts.ts';
import { MAX_SITE_CONNECTIONS } from '../../platform/ipcContracts.ts';
import { isValidConnectionLimit } from './siteForm.ts';
import type { SiteForm } from './siteForm.ts';
import type { Translate } from '../../shared/translate.ts';
import useDismissableOverlay from '../../hooks/useDismissableOverlay.ts';
import { handler } from '../../shared/asyncFailure.ts';

type AppearanceMenu = 'icon' | 'color';
export type SiteTextField = {
  [Key in keyof SiteForm]: SiteForm[Key] extends string ? Key : never;
}[keyof SiteForm];
type SecretField = 'password' | 'keyPassphrase';
type SecretPresenceField = 'hasPassword' | 'hasKeyPassphrase';
type SecretRemovalField = 'removePassword' | 'removeKeyPassphrase';

/** Opens an appearance grid scrolled just far enough to show the chosen item,
 * plus the grid's end padding so rounding cannot clip the item's border.
 * Module-level so the ref stays stable and re-renders keep the user's scroll. */
function revealCheckedItem(grid: HTMLDivElement | null) {
  const item = grid?.querySelector<HTMLElement>('[aria-checked="true"]');
  if (!grid || !item) return;
  const slack = parseFloat(getComputedStyle(grid).paddingBlockEnd) || 0;
  const bottom =
    item.getBoundingClientRect().bottom - grid.getBoundingClientRect().top + grid.scrollTop;
  grid.scrollTop = Math.max(0, bottom + slack - grid.clientHeight);
}

interface SiteEditorProps {
  form: SiteForm;
  folders: readonly ManagedSite[];
  setForm: Dispatch<SetStateAction<SiteForm>>;
  error: string;
  onDismissError: () => void;
  onField: (name: SiteTextField) => ChangeEventHandler<HTMLInputElement>;
  onProtocolChange: (protocol: SiteProtocol) => void;
  onChooseKeyFile: () => void | Promise<void>;
  onChooseCaCertFile: () => void | Promise<void>;
  onChooseLocalPath: () => void | Promise<void>;
  onRevealSecret: (field: SecretField) => boolean | Promise<boolean>;
  rsaKeySelected: boolean;
  passwordRef: RefObject<HTMLInputElement | null>;
  keyPassphraseRef: RefObject<HTMLInputElement | null>;
  t: Translate;
}

export default function SiteEditor({
  form,
  folders,
  setForm,
  error,
  onDismissError,
  onField,
  onProtocolChange,
  onChooseKeyFile,
  onChooseCaCertFile,
  onChooseLocalPath,
  onRevealSecret,
  rsaKeySelected,
  passwordRef,
  keyPassphraseRef,
  t,
}: SiteEditorProps) {
  const [appearanceMenu, setAppearanceMenu] = useState<AppearanceMenu | null>(null);
  // A saved secret stays locked until its pencil is pressed, so a stray click
  // can't start overwriting it.
  const [editingSecret, setEditingSecret] = useState<SecretField | null>(null);
  // The inputs are uncontrolled; this only tells the hint whether a new
  // secret has been typed over the saved one.
  const [typedSecrets, setTypedSecrets] = useState<Partial<Record<SecretField, boolean>>>({});
  const [limitConnections, setLimitConnections] = useState(() => form.maxConnections !== '');
  const [initialMaxConnections] = useState(form.maxConnections);
  // Opens by itself only when it holds something other than the defaults.
  const [advancedOpen] = useState(
    () => !!(form.remotePath || form.encoding || form.maxConnections),
  );
  const appearanceRef = useRef<HTMLDivElement | null>(null);
  const iconTriggerRef = useRef<HTMLButtonElement | null>(null);
  const colorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const isWebdav = form.protocol === 'webdav';
  // Only an http:// address can leak the password, so the choice is offered
  // exactly where it exists rather than sitting on every WebDAV bookmark.
  const isCleartextWebdav = isWebdav && /^http:\/\//i.test(form.webdavUrl.trim());
  const isFtp = form.protocol === 'ftp' || form.protocol === 'ftps';
  const isKeyAuth = form.protocol === 'sftp' && form.useKeyAuth;
  const currentColor = SITE_COLORS.find(({ value }) => value === form.color) || SITE_COLORS[0];
  const iconLabel = (name: (typeof SITE_ICONS)[number]) =>
    t(SITE_ICON_LABEL_KEYS[name] || `siteManagerDialog.icons.${name}`);

  const dismissAppearance = useCallback(() => setAppearanceMenu(null), []);
  useDismissableOverlay({
    open: appearanceMenu !== null,
    rootRef: appearanceRef,
    onDismiss: dismissAppearance,
  });

  const menuPos = useMenuPosition(
    appearanceMenu === 'icon' ? iconTriggerRef : colorTriggerRef,
    appearanceMenu !== null,
    {
      count: appearanceMenu === 'icon' ? SITE_ICONS.length : SITE_COLORS.length,
      columns: 3,
      cell: 30,
      gap: 4,
      padding: 5,
      maxRows: 3,
      scrollbarWidth: 10,
    },
  );
  const toggleAppearanceMenu = (type: AppearanceMenu) => {
    setAppearanceMenu((current) => (current === type ? null : type));
  };

  const secretRef = (field: SecretField) => (field === 'password' ? passwordRef : keyPassphraseRef);

  const handleSecretInput =
    (field: SecretField, removeField: SecretRemovalField) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      const typed = event.target.value !== '';
      setTypedSecrets((current) =>
        current[field] === typed ? current : { ...current, [field]: typed },
      );
      setForm((current) => (current[removeField] ? { ...current, [removeField]: false } : current));
      // Typing over a removed secret replaces it instead, so the field stays
      // open for the rest of the typing rather than locking after one key.
      setEditingSecret(field);
    };

  const secret = (
    field: SecretField,
    hasField: SecretPresenceField,
    removeField: SecretRemovalField,
    removeLabel: string,
    changeLabel: string,
  ): ReactNode => {
    const saved = form[hasField] && !form[removeField];
    const locked = saved && editingSecret !== field;
    return (
      <div className="saved-secret-field">
        <div className="saved-secret-control">
          <PasswordInput
            aria-label={t(
              field === 'password'
                ? 'connectionBar.fields.password'
                : 'connectionBar.fields.passphrase',
            )}
            placeholder={
              form[removeField]
                ? t('siteManagerDialog.secretWillBeRemoved')
                : form[hasField]
                  ? t('siteManagerDialog.savedSecretPlaceholder')
                  : undefined
            }
            ref={secretRef(field)}
            defaultValue=""
            onChange={handleSecretInput(field, removeField)}
            protectedSecret={saved}
            onRevealSaved={() => onRevealSecret(field)}
            readOnly={locked}
            tabIndex={locked ? -1 : undefined}
          />
          {saved && (
            <button
              type="button"
              className={`btn btn-icon field-icon-btn ${locked ? '' : 'active'}`}
              aria-label={t(changeLabel)}
              aria-pressed={!locked}
              data-tooltip={t(changeLabel)}
              onClick={() => {
                if (locked) {
                  setEditingSecret(field);
                  secretRef(field).current?.focus();
                } else {
                  setNativeInputValue(secretRef(field).current, '');
                  setEditingSecret(null);
                }
              }}
            >
              <Icon name="pencil" size={14} />
            </button>
          )}
          {saved && (
            <button
              type="button"
              className="btn btn-icon field-icon-btn saved-secret-remove"
              aria-label={t(removeLabel)}
              data-tooltip={t(removeLabel)}
              onClick={() => {
                setNativeInputValue(secretRef(field).current, '');
                setForm((current) => ({ ...current, [removeField]: true }));
              }}
            >
              <Icon name="trash" size={14} />
            </button>
          )}
        </div>
        {saved && !locked && (
          <span className="saved-secret-hint">
            {t(
              typedSecrets[field]
                ? 'siteManagerDialog.savedSecretReplaceHint'
                : 'siteManagerDialog.savedSecretHint',
            )}
          </span>
        )}
      </div>
    );
  };
  // The checkbox sits in the control column with its label after it, so a long
  // translated label never pushes it off the form's grid.
  const toggle = (
    label: string,
    checked: boolean,
    onChange: (checked: boolean) => void,
    extra?: ReactNode,
  ): ReactNode => (
    <div className="settings-field site-toggle-field">
      <label className="site-toggle">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{t(label)}</span>
      </label>
      {extra}
    </div>
  );
  const field = (
    label: string,
    name: SiteTextField,
    props: InputHTMLAttributes<HTMLInputElement> = {},
    className = '',
  ): ReactNode => (
    <div className={`settings-field ${className}`.trim()}>
      <span>{t(label)}</span>
      <input
        type="text"
        aria-label={t(label)}
        value={form[name]}
        onChange={onField(name)}
        {...props}
      />
    </div>
  );

  return (
    <div className="site-edit-form">
      <div className="site-field-group site-identity-fields" ref={appearanceRef}>
        {field('siteManagerDialog.fields.name', 'name', { autoFocus: true }, 'site-name-field')}
        <div className="settings-field">
          <span>{t('siteManagerDialog.fields.icon')}</span>
          <div className="site-appearance-select">
            <button
              type="button"
              ref={iconTriggerRef}
              className={`site-appearance-trigger ${appearanceMenu === 'icon' ? 'active' : ''}`}
              aria-label={t('siteManagerDialog.fields.icon')}
              aria-haspopup="menu"
              aria-expanded={appearanceMenu === 'icon'}
              data-tooltip={t('siteManagerDialog.fields.icon')}
              onClick={() => toggleAppearanceMenu('icon')}
            >
              <Icon name={form.icon as IconName} size={15} color={form.color || undefined} />
            </button>
            {appearanceMenu === 'icon' && menuPos && (
              <div
                className="menu-dropdown site-appearance-dropdown site-icon-dropdown"
                style={{ top: menuPos.top, left: menuPos.left }}
              >
                <div className="menu-items" role="menu" ref={revealCheckedItem}>
                  {SITE_ICONS.map((name) => (
                    <button
                      type="button"
                      key={name}
                      role="menuitemradio"
                      aria-checked={form.icon === name}
                      aria-label={iconLabel(name)}
                      className="menu-item"
                      data-tooltip={iconLabel(name)}
                      onClick={() => {
                        setForm((current) => ({ ...current, icon: name }));
                        setAppearanceMenu(null);
                      }}
                    >
                      <span className="menu-item-check">{form.icon === name ? '✓' : ''}</span>
                      <span className="menu-item-icon">
                        <Icon name={name as IconName} size={15} color={form.color || undefined} />
                      </span>
                      <span className="menu-item-label">{iconLabel(name)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="settings-field">
          <span>{t('siteManagerDialog.fields.color')}</span>
          <div className="site-appearance-select site-color-select">
            <button
              type="button"
              ref={colorTriggerRef}
              className={`site-appearance-trigger ${appearanceMenu === 'color' ? 'active' : ''}`}
              aria-label={t('siteManagerDialog.fields.color')}
              aria-haspopup="menu"
              aria-expanded={appearanceMenu === 'color'}
              data-tooltip={t('siteManagerDialog.fields.color')}
              onClick={() => toggleAppearanceMenu('color')}
            >
              <span
                className={`site-appearance-color ${currentColor.value ? '' : 'is-default'}`}
                style={
                  currentColor.value
                    ? ({ '--swatch-color': currentColor.value } as CSSProperties)
                    : undefined
                }
              />
            </button>
            {appearanceMenu === 'color' && menuPos && (
              <div
                className="menu-dropdown site-appearance-dropdown site-color-dropdown"
                style={{ top: menuPos.top, left: menuPos.left }}
              >
                <div className="menu-items" role="menu" ref={revealCheckedItem}>
                  {SITE_COLORS.map(({ key, value }) => (
                    <button
                      type="button"
                      key={key}
                      role="menuitemradio"
                      aria-checked={form.color === value}
                      aria-label={t(`siteManagerDialog.colors.${key}`)}
                      className="menu-item"
                      data-tooltip={t(`siteManagerDialog.colors.${key}`)}
                      onClick={() => {
                        setForm((current) => ({ ...current, color: value }));
                        setAppearanceMenu(null);
                      }}
                    >
                      <span className="menu-item-check">{form.color === value ? '✓' : ''}</span>
                      <span
                        className={`site-appearance-color ${value ? '' : 'is-default'}`}
                        style={value ? ({ '--swatch-color': value } as CSSProperties) : undefined}
                      />
                      <span className="menu-item-label">
                        {t(`siteManagerDialog.colors.${key}`)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="settings-field">
        <span>{t('siteManagerDialog.fields.folder')}</span>
        <SelectMenu
          label={t('siteManagerDialog.fields.folder')}
          value={form.parentId ?? ''}
          onChange={(value) => setForm((current) => ({ ...current, parentId: value || null }))}
          options={[
            { value: '', label: t('siteManagerDialog.noFolder') },
            ...folders.map((folder) => ({ value: folder.id, label: folder.name })),
          ]}
          rootClassName="language-select site-folder-select"
          triggerClassName="language-select-trigger"
          dropdownClassName="language-select-dropdown site-folder-dropdown"
          valueClassName="language-select-value"
          caretClassName="language-select-caret"
        />
      </div>
      {form.kind === 'local' && (
        <div className="settings-field">
          <span>{t('siteManagerDialog.fields.localPath')}</span>
          <div className="saved-secret-control">
            <input
              type="text"
              aria-label={t('siteManagerDialog.fields.localPath')}
              value={form.localPath}
              onChange={onField('localPath')}
            />
            <button
              type="button"
              className="btn btn-icon field-icon-btn"
              aria-label={t('siteManagerDialog.chooseLocalPath')}
              onClick={handler(onChooseLocalPath)}
            >
              <Icon name="folder" size={14} />
            </button>
          </div>
        </div>
      )}
      {form.kind !== 'local' && (
        <div className="site-field-group site-connection-fields">
          <div className="settings-field">
            <span>{t('siteManagerDialog.fields.protocol')}</span>
            <span className="settings-field-protocol">
              <ProtocolSelect value={form.protocol} onChange={onProtocolChange} />
              {form.protocol === 'ftp' && (
                <span
                  className="protocol-select-insecure"
                  data-tooltip={t('protocolSelect.insecureWarning')}
                >
                  <Icon name="triangleAlert" size={13} />
                </span>
              )}
            </span>
          </div>
          {isWebdav ? (
            field('connectionBar.fields.address', 'webdavUrl')
          ) : (
            <div className="settings-field">
              <span>{t('connectionBar.fields.address')}</span>
              <div className="site-address-port-control">
                <input
                  type="text"
                  aria-label={t('connectionBar.fields.address')}
                  // The longest host name DNS allows; the backend refuses more.
                  maxLength={255}
                  value={form.host}
                  onChange={onField('host')}
                />
                <span>{t('connectionBar.fields.port')}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label={t('connectionBar.fields.port')}
                  placeholder={DEFAULT_PORTS[form.protocol]}
                  value={form.port}
                  onChange={onField('port')}
                />
              </div>
            </div>
          )}
        </div>
      )}
      {form.kind !== 'local' && (
        <div className="site-field-group site-credentials-fields">
          {field('connectionBar.fields.user', 'user')}
          {isKeyAuth ? (
            <div className="settings-field site-passphrase-field">
              <span>{t('connectionBar.fields.passphrase')}</span>
              {secret(
                'keyPassphrase',
                'hasKeyPassphrase',
                'removeKeyPassphrase',
                'siteManagerDialog.removeSavedPassphrase',
                'siteManagerDialog.changeSavedPassphrase',
              )}
            </div>
          ) : (
            <div className="settings-field">
              <span>{t('connectionBar.fields.password')}</span>
              {secret(
                'password',
                'hasPassword',
                'removePassword',
                'siteManagerDialog.removeSavedPassword',
                'siteManagerDialog.changeSavedPassword',
              )}
            </div>
          )}
        </div>
      )}
      {form.kind !== 'local' &&
        (form.protocol === 'ftps' || isWebdav) &&
        toggle(
          'connectionBar.secureToggle.label',
          !form.allowInvalidCert,
          (checked) => setForm((current) => ({ ...current, allowInvalidCert: !checked })),
          <button
            type="button"
            className="btn btn-icon field-icon-btn"
            aria-label={t('siteManagerDialog.fields.caCertFile')}
            data-tooltip={form.caCertPath || t('connectionBar.fields.chooseCaCertFile')}
            disabled={form.allowInvalidCert}
            onClick={handler(onChooseCaCertFile)}
          >
            <Icon name="badgeCheck" size={14} />
          </button>,
        )}
      {form.kind !== 'local' &&
        isCleartextWebdav &&
        toggle('connectionBar.cleartextToggle.label', form.allowCleartextAuth, (checked) =>
          setForm((current) => ({ ...current, allowCleartextAuth: checked })),
        )}
      {form.kind !== 'local' && isCleartextWebdav && (
        <p className="settings-hint site-field-hint">
          {t('connectionBar.cleartextToggle.tooltip')}
        </p>
      )}
      {form.kind !== 'local' &&
        form.protocol === 'sftp' &&
        toggle(
          'connectionBar.authToggle.label',
          !!form.useKeyAuth,
          (checked) => {
            if (checked) setNativeInputValue(passwordRef.current, '');
            setForm((current) => ({ ...current, useKeyAuth: checked }));
          },
          isKeyAuth && (
            <button
              type="button"
              className="btn btn-icon field-icon-btn"
              aria-label={t('siteManagerDialog.fields.keyFile')}
              data-tooltip={form.keyPath || t('connectionBar.fields.chooseKeyFile')}
              onClick={handler(onChooseKeyFile)}
            >
              <Icon name="key" size={14} />
            </button>
          ),
        )}
      {form.kind !== 'local' && isKeyAuth && rsaKeySelected && (
        <p className="settings-hint site-field-hint" role="status">
          {t('connectionBar.rsaKeyWarning')}
        </p>
      )}
      {form.kind !== 'local' && (
        <details className="site-advanced" open={advancedOpen}>
          <summary>
            <Icon name="chevronRight" size={13} />
            {t('siteManagerDialog.advancedSettings')}
          </summary>
          <div className="site-advanced-body">
            {field('siteManagerDialog.fields.remotePath', 'remotePath', {
              placeholder: t('siteManagerDialog.remotePathPlaceholder'),
            })}
            {isFtp && (
              <>
                <div className="settings-field">
                  <span>{t('siteManagerDialog.fields.encoding')}</span>
                  <SelectMenu
                    label={t('siteManagerDialog.fields.encoding')}
                    value={form.encoding}
                    onChange={(value) => setForm((current) => ({ ...current, encoding: value }))}
                    options={[
                      { value: '', label: t('siteManagerDialog.encodings.utf8') },
                      ...SITE_ENCODINGS.map(({ value, name, script }) => ({
                        value,
                        label: `${t(`siteManagerDialog.encodings.${script}`)} (${name})`,
                      })),
                    ]}
                    rootClassName="language-select site-folder-select site-encoding-select"
                    triggerClassName="language-select-trigger"
                    dropdownClassName="language-select-dropdown site-folder-dropdown site-encoding-dropdown"
                    valueClassName="language-select-value"
                    caretClassName="language-select-caret"
                  />
                </div>
                <p className="settings-hint site-field-hint">
                  {t('siteManagerDialog.encodingHint')}
                </p>
              </>
            )}
            <div className="settings-field">
              <span>{t('siteManagerDialog.fields.maxConnections')}</span>
              <div className="site-connection-limit-control">
                <SelectMenu
                  label={t('siteManagerDialog.fields.maxConnections')}
                  value={limitConnections ? 'limit' : ''}
                  onChange={(value) => {
                    setLimitConnections(!!value);
                    setForm((current) => ({
                      ...current,
                      maxConnections: value ? current.maxConnections || '4' : '',
                    }));
                  }}
                  options={[
                    { value: '', label: t('siteManagerDialog.connectionLimit.none') },
                    { value: 'limit', label: t('siteManagerDialog.connectionLimit.limited') },
                  ]}
                  rootClassName="language-select site-folder-select site-encoding-select"
                  triggerClassName="language-select-trigger"
                  dropdownClassName="language-select-dropdown site-folder-dropdown site-encoding-dropdown"
                  valueClassName="language-select-value"
                  caretClassName="language-select-caret"
                />
                {limitConnections && (
                  <input
                    type="number"
                    min={2}
                    max={MAX_SITE_CONNECTIONS}
                    step={1}
                    className="site-connection-limit-input"
                    aria-label={t('siteManagerDialog.connectionLimit.count')}
                    aria-describedby="site-max-connections-hint"
                    aria-invalid={!isValidConnectionLimit(form.maxConnections)}
                    value={form.maxConnections}
                    onChange={onField('maxConnections')}
                    // An emptied count means no limit, which the select should say.
                    onBlur={() => {
                      if (!form.maxConnections.trim()) setLimitConnections(false);
                    }}
                  />
                )}
              </div>
            </div>
            <p className="settings-hint site-field-hint" id="site-max-connections-hint">
              {t('siteManagerDialog.maxConnectionsHint')}
            </p>
            {form.maxConnections !== initialMaxConnections && (
              <p className="settings-hint site-field-hint site-field-note" role="status">
                {t('siteManagerDialog.maxConnectionsChanged')}
              </p>
            )}
          </div>
        </details>
      )}
      {error && (
        <DismissibleError
          className="conn-error"
          message={error}
          closeLabel={t('common.close')}
          onDismiss={onDismissError}
        />
      )}
    </div>
  );
}
