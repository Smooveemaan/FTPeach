import { reportAsyncFailure } from '../shared/asyncFailure.ts';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal.tsx';

const PROJECT_URL = 'https://github.com/Smooveemaan/ftpeach';
const LICENSE_URL = `${PROJECT_URL}/blob/main/LICENSE`;
const ISSUES_URL = `${PROJECT_URL}/issues`;

interface AboutDialogProps {
  onClose: () => void;
  /**
   * The two application calls this dialog makes, injected rather than read off
   * the global: a shared component has no business knowing how IPC is reached.
   */
  appApi: Pick<Window['api']['app'], 'version' | 'openExternal'>;
}

export default function AboutDialog({ onClose, appApi }: AboutDialogProps) {
  const { t } = useTranslation();
  const [version, setVersion] = useState('');

  const openExternal = (url: string) => {
    void appApi.openExternal(url);
  };

  useEffect(() => {
    appApi.version().then(setVersion).catch(reportAsyncFailure);
  }, [appApi]);

  return (
    <Modal title={t('aboutDialog.title')} onClose={onClose} className="modal-about">
      <p>
        <b>FTPeach</b> {version && `v${version}`}
      </p>
      <p>{t('aboutDialog.tagline')}</p>
      <section className="about-legal" aria-label={t('aboutDialog.legalInformation')}>
        <p className="about-copyright">Copyright © 2026 Leonid Lozovskii (Smooveemaan)</p>
        <div className="about-links">
          <button type="button" className="about-link" onClick={() => openExternal(LICENSE_URL)}>
            Apache-2.0
          </button>
          <span aria-hidden="true">·</span>
          <button type="button" className="about-link" onClick={() => openExternal(PROJECT_URL)}>
            {t('aboutDialog.sourceCode')}
          </button>
          <span aria-hidden="true">·</span>
          <button type="button" className="about-link" onClick={() => openExternal(ISSUES_URL)}>
            {t('aboutDialog.reportIssue')}
          </button>
        </div>
      </section>
    </Modal>
  );
}
