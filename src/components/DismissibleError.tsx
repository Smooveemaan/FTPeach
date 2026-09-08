import Icon from './Icon.tsx';

interface DismissibleErrorProps {
  message: string;
  onDismiss: () => void;
  closeLabel: string;
  className?: string;
}

export default function DismissibleError({
  message,
  onDismiss,
  closeLabel,
  className = '',
}: DismissibleErrorProps) {
  return (
    <div className={`dismissible-error ${className}`.trim()} role="alert">
      <span>{message}</span>
      <button
        type="button"
        className="dismissible-error-close"
        aria-label={closeLabel}
        data-tooltip={closeLabel}
        onClick={onDismiss}
      >
        <Icon name="windowClose" size={12} />
      </button>
    </div>
  );
}
