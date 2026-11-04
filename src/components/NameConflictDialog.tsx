import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal.tsx';
import { isolate } from '../shared/bidi.ts';
import type { NameConflictDecision } from '../shared/paneContracts.ts';

interface NameConflictDialogProps {
  name: string;
  remaining: number;
  onDecision: (decision: NameConflictDecision) => void;
  onClose: () => void;
}

export default function NameConflictDialog({
  name,
  remaining,
  onDecision,
  onClose,
}: NameConflictDialogProps) {
  const { t } = useTranslation();
  const [applyToAll, setApplyToAll] = useState(false);
  const overwriteRef = useRef<HTMLButtonElement>(null);
  const decide = (action: NameConflictDecision['action']) => {
    onDecision({ action, applyToAll });
  };

  return (
    <Modal
      title="FTPeach"
      onClose={onClose}
      className="modal-confirm"
      initialFocusRef={overwriteRef}
      footer={
        <>
          <button type="button" className="btn" onClick={() => decide('skip')}>
            {t('confirm.skipLabel')}
          </button>
          <button type="button" className="btn" onClick={() => decide('copy')}>
            {t('confirm.createCopyLabel')}
          </button>
          <button
            ref={overwriteRef}
            type="button"
            className="btn btn-danger"
            onClick={() => decide('overwrite')}
          >
            {t('confirm.overwriteLabel')}
          </button>
        </>
      }
    >
      <p>{t('confirm.overwriteSingleExists', { name: isolate(name) })}</p>
      {remaining > 0 && (
        <label className="secure-toggle name-conflict-apply-all">
          <input
            type="checkbox"
            checked={applyToAll}
            onChange={(event) => setApplyToAll(event.target.checked)}
          />
          {t('confirm.applyToAllRemaining')}
        </label>
      )}
    </Modal>
  );
}
