import SelectMenu from '../../components/SelectMenu.tsx';
import type { SiteSortMode } from './siteManagerModel.ts';
import type { Translate } from '../../shared/types.ts';
interface SortModeSelectProps {
  value: SiteSortMode;
  onChange: (value: SiteSortMode) => void;
  t: Translate;
  allowProtocol?: boolean;
}
export default function SortModeSelect({ t, allowProtocol = true, ...props }: SortModeSelectProps) {
  const options: Array<{ value: SiteSortMode; label: string }> = [
    { value: 'manual', label: t('siteManagerDialog.sortManual') },
    { value: 'name', label: t('siteManagerDialog.sortName') },
    ...(allowProtocol
      ? [{ value: 'protocol' as const, label: t('siteManagerDialog.sortProtocol') }]
      : []),
  ];
  return (
    <SelectMenu
      {...props}
      label={t('siteManagerDialog.sortMode')}
      options={options}
      fitToOptions
      rootClassName="language-select site-manage-sort"
      triggerClassName="language-select-trigger site-manage-sort-trigger"
      dropdownClassName="site-manage-sort-dropdown"
      valueClassName="language-select-value"
      caretClassName="language-select-caret"
    />
  );
}
