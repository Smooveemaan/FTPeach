interface SegmentedOption<Value extends string> {
  value: Value;
  label: string;
}

interface SegmentedControlProps<Value extends string> {
  value: Value;
  onChange: (value: Value) => unknown;
  options: readonly SegmentedOption<Value>[];
}

export default function SegmentedControl<Value extends string>({
  value,
  onChange,
  options,
}: SegmentedControlProps<Value>) {
  return (
    <div className="settings-segmented" role="radiogroup">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          className={value === opt.value ? 'active' : ''}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
