import React, { useState } from 'react';
import type { ChangeEvent, FormEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import ProtocolSelect from './ProtocolSelect.tsx';
import Icon from '../../components/Icon.tsx';
import PasswordInput from '../../components/PasswordInput.tsx';
import DismissibleError from '../../components/DismissibleError.tsx';
import type { ConnectionForm, PaneStatus, SiteProtocol } from '../../shared/types.ts';
import { handler } from '../../shared/asyncFailure.ts';
import { api } from '../../platform/api/index.ts';

const DEFAULT_PORTS: Record<SiteProtocol, string> = {
  ftp: '21',
  ftps: '21',
  sftp: '22',
  webdav: '',
};

type ConnectionVisualState = 'idle' | 'connecting' | 'connected' | 'paused';
type TextFieldKey = 'host' | 'port' | 'webdavUrl' | 'user' | 'password' | 'keyPassphrase';

interface ConnectionBarProps {
  form: ConnectionForm;
  onChange: (form: ConnectionForm) => void;
  status: PaneStatus;
  errorMessage?: string;
  onDismissError?: () => void;
  onConnect: () => unknown;
  onDisconnect: () => unknown;
  onCancelConnect: () => unknown;
  onSaveSite: () => unknown;
  narrow?: boolean;
  connectionVisualState: ConnectionVisualState;
  onOpenSiteManager: () => unknown;
  leadingSlot?: ReactNode;
}

export default function ConnectionBar({
  form,
  onChange,
  status,
  errorMessage,
  onDismissError,
  onConnect,
  onDisconnect,
  onCancelConnect,
  onSaveSite,
  narrow,
  connectionVisualState,
  onOpenSiteManager,
  leadingSlot,
}: ConnectionBarProps) {
  const { t } = useTranslation();
  const isBusy = status === 'connecting';
  const isConnected = status === 'connected';
  const isKeyAuth = form.protocol === 'sftp' && form.useKeyAuth;
  const isWebdav = form.protocol === 'webdav';
  const [rsaKeySelected, setRsaKeySelected] = useState(false);

  const handleField = (key: TextFieldKey) => (e: ChangeEvent<HTMLInputElement>) =>
    onChange({ ...form, [key]: e.target.value });

  const handleProtocolChange = (protocol: SiteProtocol) => {
    const prevDefault = DEFAULT_PORTS[form.protocol];
    const nextPort = form.port === prevDefault ? DEFAULT_PORTS[protocol] : form.port;
    onChange({ ...form, protocol, port: nextPort });
  };

  const chooseKeyFile = async () => {
    const selected = await api.fsLocal.selectKeyFile();
    if (selected) {
      setRsaKeySelected(selected.isRsa);
      onChange({ ...form, keyPath: selected.path });
    }
  };

  const chooseCaCertFile = async () => {
    const selected = await api.fsLocal.selectCaCertFile();
    if (typeof selected === 'string' && selected) onChange({ ...form, caCertPath: selected });
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!isConnected && !isBusy) onConnect();
  };

  const saveConnectionButton = (
    <button
      key="save-connection"
      type="button"
      className="btn btn-ghost btn-icon"
      data-tooltip={t('menu.file.saveConnection')}
      disabled={!(isWebdav ? form.webdavUrl : form.host)}
      onClick={onSaveSite}
    >
      <Icon name="star" size={14} />
    </button>
  );

  const protocolSelect = (
    <ProtocolSelect
      key="protocol"
      value={form.protocol}
      onChange={handleProtocolChange}
      disabled={isConnected || isBusy}
    />
  );

  const protocolWarning = form.protocol === 'ftp' && (
    <span
      key="protocol-warning"
      className="protocol-select-insecure"
      data-tooltip={t('protocolSelect.insecureWarning')}
    >
      <Icon name="triangleAlert" size={13} />
    </span>
  );

  const hostField = (
    <input
      key="host"
      className="field-host"
      placeholder={t('connectionBar.fields.address')}
      value={form.host}
      onChange={handleField('host')}
      disabled={isConnected || isBusy}
    />
  );

  const portField = (
    <input
      key="port"
      className="field-port"
      placeholder={t('connectionBar.fields.port')}
      value={form.port}
      onChange={handleField('port')}
      disabled={isConnected || isBusy}
    />
  );

  const webdavUrlField = (
    <input
      key="webdavUrl"
      className="field-webdav-url"
      placeholder={t('connectionBar.fields.address')}
      value={form.webdavUrl}
      onChange={handleField('webdavUrl')}
      disabled={isConnected || isBusy}
    />
  );

  const userField = (
    <input
      key="user"
      className="field-user"
      placeholder={t('connectionBar.fields.user')}
      value={form.user}
      onChange={handleField('user')}
      disabled={isConnected || isBusy}
    />
  );

  const passField = (
    <PasswordInput
      key="pass"
      className="field-pass"
      placeholder={t('connectionBar.fields.password')}
      value={form.password}
      onChange={handleField('password')}
      disabled={isConnected || isBusy}
    />
  );

  const keyPathField = (
    <React.Fragment key="keypath">
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label={t('siteManagerDialog.fields.keyFile')}
        data-tooltip={form.keyPath || t('connectionBar.fields.chooseKeyFile')}
        onClick={handler(chooseKeyFile)}
        disabled={isConnected || isBusy}
      >
        <Icon name="key" size={14} />
      </button>
      {rsaKeySelected && (
        <span
          className="protocol-select-insecure"
          aria-label={t('connectionBar.rsaKeyWarning')}
          data-tooltip={t('connectionBar.rsaKeyWarning')}
        >
          <Icon name="triangleAlert" size={13} />
        </span>
      )}
    </React.Fragment>
  );

  const passphraseField = (
    <PasswordInput
      key="passphrase"
      className="field-pass"
      placeholder={t('connectionBar.fields.passphrase')}
      value={form.keyPassphrase}
      onChange={handleField('keyPassphrase')}
      disabled={isConnected || isBusy}
    />
  );

  const secureToggle = (form.protocol === 'ftps' || isWebdav) && (
    <label
      key="secure"
      className="secure-toggle"
      data-tooltip={t('connectionBar.secureToggle.tooltip')}
    >
      <input
        type="checkbox"
        checked={!form.allowInvalidCert}
        onChange={(e) => onChange({ ...form, allowInvalidCert: !e.target.checked })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.click();
        }}
        disabled={isConnected || isBusy}
      />
      {t('connectionBar.secureToggle.label')}
    </label>
  );

  const caCertField = (form.protocol === 'ftps' || isWebdav) && (
    <button
      key="cacert"
      type="button"
      className="btn btn-ghost btn-icon"
      aria-label={t('siteManagerDialog.fields.caCertFile')}
      data-tooltip={form.caCertPath || t('connectionBar.fields.chooseCaCertFile')}
      onClick={handler(chooseCaCertFile)}
      disabled={isConnected || isBusy || form.allowInvalidCert}
    >
      <Icon name="badgeCheck" size={14} />
    </button>
  );

  const credentialFields = isKeyAuth ? (
    <React.Fragment key="credentials">
      {passphraseField}
      {keyPathField}
    </React.Fragment>
  ) : (
    <React.Fragment key="credentials">
      {passField}
      {caCertField}
    </React.Fragment>
  );

  const authToggle = form.protocol === 'sftp' && (
    <label
      key="keyauth"
      className="secure-toggle"
      data-tooltip={t('connectionBar.authToggle.tooltip')}
    >
      <input
        type="checkbox"
        checked={!!form.useKeyAuth}
        onChange={(e) => {
          const useKeyAuth = e.target.checked;
          onChange({ ...form, useKeyAuth, password: useKeyAuth ? '' : form.password });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.click();
        }}
        disabled={isConnected || isBusy}
      />
      {t('connectionBar.authToggle.label')}
    </label>
  );

  const connectButton = (
    <React.Fragment key="connect">
      {!isConnected ? (
        <button
          type={isBusy ? 'button' : 'submit'}
          className={`btn btn-icon connect-toggle-btn state-${connectionVisualState}`}
          data-tooltip={
            isBusy
              ? t('connectionBar.connectTooltip.cancel')
              : t('connectionBar.connectTooltip.connect')
          }
          onClick={
            isBusy
              ? (e) => {
                  e.preventDefault();
                  onCancelConnect();
                }
              : undefined
          }
          disabled={!isBusy && !(isWebdav ? form.webdavUrl : form.host)}
        >
          <Icon name={isBusy ? 'stop' : 'power'} size={14} />
        </button>
      ) : (
        <button
          type="button"
          className={`btn btn-icon connect-toggle-btn state-${connectionVisualState}`}
          data-tooltip={t('connectionBar.connectTooltip.disconnect')}
          onClick={onDisconnect}
        >
          <Icon name="power" size={14} />
        </button>
      )}
    </React.Fragment>
  );

  const manageBookmarksButton = (
    <button
      key="manage-bookmarks"
      type="button"
      className="btn btn-ghost btn-icon"
      data-tooltip={t('menu.file.manageBookmarks')}
      onClick={onOpenSiteManager}
    >
      <Icon name="bookmark" size={14} />
    </button>
  );

  return (
    <form className={`connection-bar ${narrow ? 'narrow' : ''}`} onSubmit={handleSubmit}>
      {narrow ? (
        <>
          {/* Two fixed rows instead of one wrapping one — see the .narrow
              CSS rule for why: a plain flex-wrap reflow has a different,
              ambiguous break point at every in-between width. */}
          <div className="connection-row">
            {leadingSlot}
            {connectButton}
            {manageBookmarksButton}
            {saveConnectionButton}
            {protocolSelect}
            {protocolWarning}
            {isWebdav ? (
              webdavUrlField
            ) : (
              <React.Fragment key="hostport">
                {hostField}
                {portField}
              </React.Fragment>
            )}
          </div>
          {/* connection-row-credentials: matches .pane-path's height (see
              theme.css) so this row lands level with the address bar on a
              local pane instead of hugging directly under the row above.
              Port stays up in row 1 with host regardless of width — see
              .field-host/.field-port's own min-width floors — rather than
              moving down here, so its position stays predictable instead of
              jumping rows as the pane resizes. */}
          <div className="connection-row connection-row-credentials">
            {userField}
            {credentialFields}
            {secureToggle}
            {authToggle}
          </div>
        </>
      ) : (
        <>
          {connectButton}
          {manageBookmarksButton}
          {saveConnectionButton}
          {protocolSelect}
          {protocolWarning}
          {isWebdav ? (
            webdavUrlField
          ) : (
            <React.Fragment key="hostport">
              {hostField}
              {portField}
            </React.Fragment>
          )}
          {userField}
          {credentialFields}
          {secureToggle}
          {authToggle}
        </>
      )}

      {errorMessage && onDismissError && (
        <DismissibleError
          className="conn-error"
          message={errorMessage}
          closeLabel={t('common.close')}
          onDismiss={onDismissError}
        />
      )}
    </form>
  );
}
