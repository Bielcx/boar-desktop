import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import pt from "./locales/pt.json";

/**
 * UI localization. Entirely local — no network calls, no
 * device-locale auto-detection (the user picks explicitly, in Settings or
 * the first-run setup wizard, same as theme/personality). English is the
 * source of truth; other locales fall back to it for any missing key so a
 * partial translation never renders blank.
 */
i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    pt: { translation: pt },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export default i18n;
