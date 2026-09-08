import SelectMenu from './SelectMenu.tsx';

export const DATE_FORMAT_OPTIONS = [
  { value: 'locale', label: 'Local' },
  { value: 'iso', label: 'ISO 8601' },
  { value: 'dd/MM/yyyy', label: 'DD/MM/YYYY' },
  { value: 'dd-MM-yyyy', label: 'DD-MM-YYYY' },
  { value: 'dd.MM.yyyy', label: 'DD.MM.YYYY' },
  { value: 'MM/dd/yyyy', label: 'MM/DD/YYYY' },
  { value: 'MM-dd-yyyy', label: 'MM-DD-YYYY' },
  { value: 'yyyy-MM-dd', label: 'YYYY-MM-DD' },
  { value: 'yyyy/MM/dd', label: 'YYYY/MM/DD' },
] as const;
export const TIME_FORMAT_OPTIONS = [
  { value: 'HH:mm', label: '24 h' },
  { value: 'hh:mm a', label: '12 h' },
] as const;

interface FormatSelectProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  className?: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  getOptionLabel?: (value: string, fallback: string) => string;
}
function FormatSelect({
  className = '',
  options,
  getOptionLabel = (_value, fallback) => fallback,
  ...props
}: FormatSelectProps) {
  const localized = options.map((option) => ({
    ...option,
    label: getOptionLabel(option.value, option.label),
  }));
  return (
    <SelectMenu
      {...props}
      options={localized}
      rootClassName={`language-select date-format-select ${className}`}
      triggerClassName="language-select-trigger"
      dropdownClassName="language-select-dropdown date-format-dropdown"
      valueClassName="language-select-value"
      caretClassName="language-select-caret"
    />
  );
}
interface DateFormatSelectProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  localLabel: string;
  isoLabel: string;
}
export default function DateFormatSelect(props: DateFormatSelectProps) {
  return (
    <FormatSelect
      {...props}
      className="date-part-select"
      options={DATE_FORMAT_OPTIONS}
      getOptionLabel={(value, fallback) =>
        value === 'locale' ? props.localLabel : value === 'iso' ? props.isoLabel : fallback
      }
    />
  );
}
interface TimeFormatSelectProps extends Omit<FormatSelectProps, 'options' | 'getOptionLabel'> {
  hour24Label: string;
  hour12Label: string;
}
export function TimeFormatSelect({ hour24Label, hour12Label, ...props }: TimeFormatSelectProps) {
  return (
    <FormatSelect
      {...props}
      className="time-part-select"
      options={TIME_FORMAT_OPTIONS}
      getOptionLabel={(value) => (value === 'HH:mm' ? hour24Label : hour12Label)}
    />
  );
}
