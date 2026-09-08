import { useTranslation } from 'react-i18next';
import Icon from '../../../components/Icon.tsx';

interface NumberStepperProps {
  value: string;
  onChange: (value: string) => unknown;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

export default function NumberStepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  placeholder,
}: NumberStepperProps) {
  const { t } = useTranslation();
  const bump = (delta: number) => {
    const next = (Number(value) || 0) + delta;
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next));
    onChange(String(clamped));
  };
  return (
    <span className="number-stepper">
      <input
        type="number"
        min={min}
        max={max}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="number-stepper-btns">
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('common.increase')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => bump(step)}
        >
          <Icon name="chevronUp" size={10} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('common.decrease')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => bump(-step)}
        >
          <Icon name="chevronDown" size={10} />
        </button>
      </span>
    </span>
  );
}
