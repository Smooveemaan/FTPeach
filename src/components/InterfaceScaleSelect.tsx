import SelectMenu from './SelectMenu.tsx';
export const INTERFACE_SCALE_OPTIONS = [80, 90, 100, 110, 125, 150] as const;
interface InterfaceScaleSelectProps {
  value: number;
  onChange: (value: number) => void;
  label: string;
}
export default function InterfaceScaleSelect(props: InterfaceScaleSelectProps) {
  const options = INTERFACE_SCALE_OPTIONS.map((value) => ({ value, label: `${value}%` }));
  return (
    <SelectMenu
      {...props}
      options={options}
      rootClassName="language-select interface-scale-select"
      triggerClassName="language-select-trigger"
      dropdownClassName="language-select-dropdown interface-scale-dropdown"
      valueClassName="language-select-value"
      caretClassName="language-select-caret"
    />
  );
}
