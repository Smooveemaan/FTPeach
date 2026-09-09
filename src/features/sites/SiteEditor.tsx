import { useCallback, useRef, useState } from 'react';
import type {
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
import { SITE_COLORS, SITE_ICONS, SITE_ICON_LABEL_KEYS } from './siteMeta.ts';
import { setNativeInputValue } from '../../shared/nativeInput.ts';
import { useMenuPosition } from '../../hooks/useMenuPosition.ts';
import type { ManagedSite, SiteForm, SiteProtocol, Translate } from '../../shared/types.ts';
import useDismissableOverlay from '../../hooks/useDismissableOverlay.ts';
import { handler } from '../../shared/asyncFailure.ts';

type AppearanceMenu = 'icon' | 'color';
export type SiteTextField = {
  [Key in keyof SiteForm]: SiteForm[Key] extends string ? Key : never;
}[keyof SiteForm];
type SecretField = 'password' | 'keyPassphrase';
type SecretPresenceField = 'hasPassword' | 'hasKeyPassphrase';
type SecretRemovalField = 'removePassword' | 'removeKeyPassphrase';

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
  passwordRef: RefObject<HTMLInputElement>;
  keyPassphraseRef: RefObject<HTMLInputElement>;
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
  const appearanceRef = useRef<HTMLDivElement | null>(null);
  const iconTriggerRef = useRef<HTMLButtonElement | null>(null);
  const colorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const isWebdav = form.protocol === 'webdav';
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
      scrollbarWidth: appearanceMenu === 'icon' ? 10 : 0,
    },
  );
  const toggleAppearanceMenu = (type: AppearanceMenu) => {
    setAppearanceMenu((current) => (current === type ? null : type));
  };

  const secretRef = (field: SecretField) => (field === 'password' ? passwordRef : keyPassphraseRef);

  const handleSecretInput = (removeField: SecretRemovalField) => () =>
    setForm((current) => (current[removeField] ? { ...current, [removeField]: false } : current));

  const secret = (
    field: SecretField,
    hasField: SecretPresenceField,
    removeField: SecretRemovalField,
    removeLabel: string,
    extra?: ReactNode,
  ): ReactNode => (
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
          onChange={handleSecretInput(removeField)}
          protectedSecret={form[hasField] && !form[removeField]}
          onRevealSaved={() => onRevealSecret(field)}
        />
        {form[hasField] && !form[removeField] && (
          <button
            type="button"
            className="btn btn-danger btn-icon saved-secret-remove"
            aria-label={t(removeLabel)}
            data-tooltip={t(removeLabel)}
            onClick={() => {
              setNativeInputValue(secretRef(field).current, '');
              setForm((current) => ({ ...current, [removeField]: true }));
            }}
          >
            <Icon name="trash" />
          </button>
        )}
        {extra}
      </div>
      {form[hasField] && !form[removeField] && (
        <span className="saved-secret-hint">{t('siteManagerDialog.savedSecretHint')}</span>
      )}
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
                <div className="menu-items" role="menu">
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
                className="menu-dropdown site-appearance-dropdown"
                style={{ top: menuPos.top, left: menuPos.left }}
              >
                <div className="menu-items" role="menu">
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
              className="btn btn-ghost btn-icon"
              aria-label={t('siteManagerDialog.chooseLocalPath')}
              onClick={handler(onChooseLocalPath)}
            >
              <Icon name="folder" />
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
                  value={form.host}
                  onChange={onField('host')}
                />
                <span>{t('connectionBar.fields.port')}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label={t('connectionBar.fields.port')}
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
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label={t('siteManagerDialog.fields.keyFile')}
                  data-tooltip={form.keyPath || t('connectionBar.fields.chooseKeyFile')}
                  onClick={handler(onChooseKeyFile)}
                >
                  <Icon name="key" />
                </button>,
              )}
              {rsaKeySelected && (
                <span className="saved-secret-hint" role="status">
                  {t('connectionBar.rsaKeyWarning')}
                </span>
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
                (form.protocol === 'ftps' || isWebdav) && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-label={t('siteManagerDialog.fields.caCertFile')}
                    data-tooltip={form.caCertPath || t('connectionBar.fields.chooseCaCertFile')}
                    disabled={form.allowInvalidCert}
                    onClick={handler(onChooseCaCertFile)}
                  >
                    <Icon name="badgeCheck" />
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      )}
      {form.kind !== 'local' &&
        field('siteManagerDialog.fields.remotePath', 'remotePath', { placeholder: '/' })}
      {form.kind !== 'local' && (form.protocol === 'ftps' || isWebdav) && (
        <div className="settings-field">
          <span>{t('connectionBar.secureToggle.label')}</span>
          <input
            type="checkbox"
            aria-label={t('connectionBar.secureToggle.label')}
            checked={!form.allowInvalidCert}
            onChange={(event) =>
              setForm((current) => ({ ...current, allowInvalidCert: !event.target.checked }))
            }
          />
        </div>
      )}
      {form.kind !== 'local' && form.protocol === 'sftp' && (
        <div className="settings-field">
          <span>{t('connectionBar.authToggle.label')}</span>
          <input
            type="checkbox"
            aria-label={t('connectionBar.authToggle.label')}
            checked={!!form.useKeyAuth}
            onChange={(event) => {
              if (event.target.checked) setNativeInputValue(passwordRef.current, '');
              setForm((current) => ({ ...current, useKeyAuth: event.target.checked }));
            }}
          />
        </div>
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
