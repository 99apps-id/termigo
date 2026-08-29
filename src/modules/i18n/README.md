# i18n

A minimal, dependency-free localization layer. No react-i18next / lingui — the
app keeps a lean dependency tree and this is all it needs: a keyed catalog per
language, `{var}` interpolation, and a hook that re-renders when the language
changes.

## Using it

```tsx
import { useT } from "@/modules/i18n";

function Thing() {
  const t = useT();
  return <p>{t("settings.general.language")}</p>;
}
```

- `useT()` returns a translator bound to the current language preference; the
  component re-renders when the user switches language (it reads the settings
  store via zustand).
- Off the React render path, use `translate(lang, key, vars)` directly.
- Interpolate with `{var}`: `t("settings.backup.restored", { count })`.
- A missing key falls back to English, then to the key itself — an untranslated
  string shows up visibly but never crashes.

The language preference lives in the settings store (`AppLanguage` = `"en" |
"id"`, default `"en"`); the picker is in **Settings › General › Language**.

## Adding a string

1. Add the key + English text to `catalogs/en.ts`. The key is the source of
   truth; namespace it by area (`settings.general.*`, `common.*`).
2. Add the same key to `catalogs/id.ts`. `Record<TranslationKey, string>` makes
   a missing key a **type error**, so parity is enforced at compile time (and by
   `i18n.test.ts`).
3. Replace the hardcoded string in the component with `t("your.key")`.

## Adding a language

1. Add the code to `AppLanguage` in `@/modules/settings/store` and to the load
   validation there.
2. Create `catalogs/<code>.ts` as `Record<TranslationKey, string>` (copy `id.ts`
   and translate).
3. Register it in `CATALOGS` and `LANGUAGES` in `index.ts`.

## Scope

This is a **foundation with a reference slice** (Settings › General). Most of the
UI is still hardcoded English; migrate it incrementally, one section at a time,
by moving its strings into the catalogs and swapping in `t()`. The plumbing,
the language setting and the parity guarantee are already in place, so each
migration is mechanical.
