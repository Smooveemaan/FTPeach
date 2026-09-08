import { SUPPORTED_LANGUAGES } from '../i18n/index.ts';
import type { SupportedLanguage } from '../i18n/index.ts';
import SelectMenu from './SelectMenu.tsx';

interface LanguageSelectProps {
  value: SupportedLanguage;
  onChange: (value: SupportedLanguage) => void;
  disabled?: boolean;
}

export default function LanguageSelect(props: LanguageSelectProps) {
  return (
    <SelectMenu
      {...props}
      options={SUPPORTED_LANGUAGES}
      rootClassName="language-select"
      triggerClassName="language-select-trigger"
      dropdownClassName="language-select-dropdown"
      valueClassName="language-select-value"
      caretClassName="language-select-caret"
    />
  );
}
