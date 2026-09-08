import { forwardRef, useEffect, useState } from 'react';
import type { InputHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from './Icon.tsx';
import { handler } from '../shared/asyncFailure.ts';

interface PasswordInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'className' | 'type'
> {
  className?: string;
  protectedSecret?: boolean;
  onRevealSaved?: () => boolean | Promise<boolean>;
}

const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  { className = '', protectedSecret = false, onRevealSaved, onChange, ...props },
  ref,
) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [uncontrolledHasValue, setUncontrolledHasValue] = useState(
    () => String(props.defaultValue ?? '').length > 0,
  );
  const hasValue =
    props.value === undefined ? uncontrolledHasValue : String(props.value ?? '').length > 0;
  const showToggle = hasValue || (!!onRevealSaved && protectedSecret);
  const label = visible ? t('common.hidePassword') : t('common.showPassword');

  useEffect(() => {
    if (!hasValue) setVisible(false);
  }, [hasValue]);

  return (
    <span className={`password-input ${className}`.trim()}>
      <input
        {...props}
        ref={ref}
        type={visible ? 'text' : 'password'}
        onChange={(event) => {
          setUncontrolledHasValue(event.target.value.length > 0);
          onChange?.(event);
        }}
      />
      {showToggle && (
        <button
          type="button"
          className="password-visibility-toggle"
          aria-label={label}
          title={label}
          aria-pressed={visible}
          disabled={props.disabled}
          onClick={handler(async () => {
            if (!visible && !hasValue && onRevealSaved) {
              const revealed = await onRevealSaved();
              if (!revealed) return;
            }
            setVisible((value) => !value);
          })}
        >
          <Icon name={visible ? 'eyeOff' : 'eye'} size={14} />
        </button>
      )}
      {!hasValue && protectedSecret && !onRevealSaved && (
        <span
          className="password-protected-indicator"
          role="img"
          aria-label={t('common.savedSecretProtected')}
          title={t('common.savedSecretProtected')}
        >
          <Icon name="lock" size={14} />
        </span>
      )}
    </span>
  );
});

export default PasswordInput;
