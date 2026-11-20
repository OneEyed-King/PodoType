import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';
import de from './locales/de.json';
import pt from './locales/pt.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import ja from './locales/ja.json';
import ru from './locales/ru.json';

// Supported languages, in the order offered in the switcher. nativeLabel
// is how each one names itself, shown regardless of the currently active
// language (a German speaker sees "Deutsch" even while the UI is in
// English). Mirrors podotype-website's src/i18n/index.js — same approach,
// same supported set, kept in sync by hand across the two codebases.
export const LANGUAGES = [
  { code: 'en', nativeLabel: 'English' },
  { code: 'de', nativeLabel: 'Deutsch' },
  { code: 'pt', nativeLabel: 'Português (BR)' },
  { code: 'es', nativeLabel: 'Español' },
  { code: 'fr', nativeLabel: 'Français' },
  { code: 'ja', nativeLabel: '日本語' },
  { code: 'ru', nativeLabel: 'Русский' },
];

const STORAGE_KEY = 'podotype-lang';

// Detection order: an explicit prior choice (localStorage) wins first,
// otherwise fall back to the browser's own language preference
// (navigator.languages). Deliberately NOT IP-based geolocation -- see
// podotype-website's i18n/index.js for the full reasoning (unreliable,
// a third-party dependency, and a privacy mismatch for a project whose
// pitch is "your data never leaves your network").
i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      de: { translation: de },
      pt: { translation: pt },
      es: { translation: es },
      fr: { translation: fr },
      ja: { translation: ja },
      ru: { translation: ru },
    },
    fallbackLng: 'en',
    supportedLngs: LANGUAGES.map((l) => l.code),
    nonExplicitSupportedLngs: true,
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: STORAGE_KEY,
      caches: ['localStorage'],
    },
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
