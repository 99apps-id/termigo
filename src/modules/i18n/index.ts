// Minimal, dependency-free i18n.
//
// Deliberately not react-i18next / lingui: the app keeps a lean dependency tree
// and this is all it needs — a keyed catalog per language, `{var}` interpolation,
// and a hook that re-renders when the language preference changes. The language
// lives in the settings store (`AppLanguage`), so `useT` is reactive for free
// via zustand; non-React callers use `translate` with an explicit language.
//
// Missing keys fall back to English, then to the key itself, so an untranslated
// string degrades visibly but never throws.

import { usePreferencesStore } from "@/modules/settings/preferences";
import type { AppLanguage } from "@/modules/settings/store";
import { useCallback } from "react";
import { en, type TranslationKey } from "./catalogs/en";
import { id } from "./catalogs/id";

export type { TranslationKey };
export type TVars = Record<string, string | number>;

const CATALOGS: Record<AppLanguage, Record<TranslationKey, string>> = {
  en,
  id,
};

/** Selectable UI languages, for a language picker. */
export const LANGUAGES: { id: AppLanguage; label: string }[] = [
  { id: "en", label: "English" },
  { id: "id", label: "Bahasa Indonesia" },
];

function interpolate(s: string, vars?: TVars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k: string) =>
    k in vars ? String(vars[k]) : `{${k}}`,
  );
}

/** Translate a key for an explicit language. Falls back to English, then the
 *  key. Use this off the React render path (event handlers computing a string
 *  once are fine either way). */
export function translate(
  lang: AppLanguage,
  key: TranslationKey,
  vars?: TVars,
): string {
  const s = CATALOGS[lang]?.[key] ?? en[key] ?? key;
  return interpolate(s, vars);
}

/** Reactive translator bound to the current language preference. */
export function useT(): (key: TranslationKey, vars?: TVars) => string {
  const lang = usePreferencesStore((s) => s.language);
  return useCallback(
    (key: TranslationKey, vars?: TVars) => translate(lang, key, vars),
    [lang],
  );
}
