import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { bindingFromEvent, formatBinding } from '../shortcuts/bindings.ts';
import { useTruncated } from '../hooks/useTruncated.ts';

interface ShortcutRecorderProps {
  value: string | null;
  onChange: (binding: string) => void;
  onCancel?: () => void;
  disabled?: boolean;
}

export default function ShortcutRecorder({
  value,
  onChange,
  onCancel,
  disabled = false,
}: ShortcutRecorderProps) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (
      event.code === 'Escape' &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !event.metaKey
    ) {
      setRecording(false);
      onCancel?.();
      return;
    }
    const binding = bindingFromEvent(event);
    if (!binding) return; // bare modifier keydown — keep listening
    setRecording(false);
    onChange(binding);
  };

  const label = recording
    ? t('settings.shortcuts.recording')
    : value
      ? formatBinding(value)
      : t('settings.shortcuts.unbound');
  const [textRef, textTruncated] = useTruncated<HTMLSpanElement>([label]);

  return (
    <button
      type="button"
      className={`shortcut-recorder ${recording ? 'recording' : ''}`}
      disabled={disabled}
      onClick={() => setRecording(true)}
      onKeyDown={recording ? handleKeyDown : undefined}
      onBlur={() => setRecording(false)}
      data-tooltip={!recording && value ? label : undefined}
    >
      <span ref={textRef} className={`shortcut-recorder-text${textTruncated ? ' truncated' : ''}`}>
        {label}
      </span>
    </button>
  );
}
