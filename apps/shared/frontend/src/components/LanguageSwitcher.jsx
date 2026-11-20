import { useTranslation } from 'react-i18next';
import { LANGUAGES } from '../i18n/index.js';

// Native <select>, same reasoning as podotype-website's LanguageSwitcher:
// free keyboard/screen-reader support for a short, infrequently-used
// control where a hand-rolled listbox buys nothing. Sized/bordered to
// match the app's existing small controls (ThemeToggle's 30px pill,
// panel-raised background) rather than introducing a new control shape.
export default function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const current = i18n.resolvedLanguage || 'en';

  return (
    <select
      aria-label={t('language.label')}
      value={current}
      onChange={(e) => i18n.changeLanguage(e.target.value)}
      className="h-[30px] rounded-md bg-panel-raised border border-border text-[12px] font-semibold text-ink-dim px-2 hover:border-accent/50 transition-colors outline-none cursor-pointer"
    >
      {LANGUAGES.map((lang) => (
        <option key={lang.code} value={lang.code}>
          {lang.nativeLabel}
        </option>
      ))}
    </select>
  );
}
