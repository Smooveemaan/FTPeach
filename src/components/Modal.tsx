import { useEffect, useId, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useTruncated } from '../hooks/useTruncated.ts';
import { holdDialogScrim } from '../platform/windowFrame.ts';

interface ModalFooterActionsProps {
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel?: ReactNode;
  danger?: boolean;
  cancelDisabled?: boolean;
  confirmDisabled?: boolean;
  confirmRef?: RefObject<HTMLButtonElement>;
}

export function ModalFooterActions({
  onCancel,
  onConfirm,
  confirmLabel,
  danger = false,
  cancelDisabled = false,
  confirmDisabled = false,
  confirmRef,
}: ModalFooterActionsProps) {
  const { t } = useTranslation();
  return (
    <>
      <button type="button" className="btn" onClick={onCancel} disabled={cancelDisabled}>
        {t('common.cancel')}
      </button>
      <button
        ref={confirmRef}
        type="button"
        className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
        onClick={onConfirm}
        disabled={confirmDisabled}
      >
        {confirmLabel ?? t('common.save')}
      </button>
    </>
  );
}

interface ModalProps {
  title?: ReactNode;
  onClose: () => void;
  onCloseButton?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  headerActions?: ReactNode;
  closeDisabled?: boolean;
  initialFocusRef?: RefObject<HTMLElement>;
}

export default function Modal({
  title,
  onClose,
  onCloseButton,
  children,
  footer,
  className,
  headerActions,
  closeDisabled = false,
  initialFocusRef,
}: ModalProps) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !closeDisabled) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, closeDisabled]);

  // The overlay scrims the app and .title-bar::after scrims the bar above it,
  // but the window border is outside the webview and no rule reaches it. Every
  // dialog in the app is this component, so holding the scrim for as long as
  // one is mounted covers all of them, nesting included.
  useEffect(() => holdDialogScrim(), []);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const [titleRef, titleTruncated] = useTruncated<HTMLSpanElement>([title]);
  const previouslyFocusedRef = useRef(document.activeElement);

  useEffect(() => {
    const previouslyFocused = previouslyFocusedRef.current;
    const focusableSelector =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const getFocusable = () =>
      dialogRef.current
        ? Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector))
        : [];

    const alreadyFocusedInside =
      dialogRef.current?.contains(document.activeElement) &&
      document.activeElement !== dialogRef.current;
    if (!alreadyFocusedInside) {
      // The header's close (X) button is first in DOM order, but autofocusing
      // it means Enter dismisses the dialog instead of reaching its actual
      // content/actions — skip it in favor of a caller-supplied target, or
      // the first real focusable in the body/footer.
      const preferred = initialFocusRef?.current;
      const first = getFocusable().find((el) => !el.classList.contains('modal-close'));
      (preferred || first || dialogRef.current)?.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl?.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        // Restoring focus to a bare icon button (e.g. a row's delete/rename
        // action) strands the user outside their list's own keyboard
        // navigation and leaves an isolated focus ring behind. Prefer the
        // row itself, which already participates in roving-tabindex nav.
        const row = previouslyFocused.closest<HTMLElement>('[role="treeitem"]');
        (row || previouslyFocused).focus();
      }
    };
    // Mount-only by design: this is the dialog's focus trap, set up when the dialog
    // opens and torn down when it closes. `initialFocusRef` is read only to pick the
    // initial focus target at that moment; re-running on a later ref change would
    // yank focus away from wherever the user has since moved it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !closeDisabled) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={`modal ${className || ''}`}
      >
        <div className="modal-header">
          <div className="modal-header-left">
            {headerActions}
            <span
              ref={titleRef}
              className={`modal-title${titleTruncated ? ' truncated' : ''}`}
              id={titleId}
            >
              {title}
            </span>
          </div>
          <button
            type="button"
            className="modal-close"
            aria-label={t('common.close')}
            onClick={onCloseButton ?? onClose}
            disabled={closeDisabled}
          >
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
