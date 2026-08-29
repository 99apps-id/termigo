// English catalog — the source of truth for translation keys.
//
// `TranslationKey` is derived from this object, so every other language catalog
// must cover exactly these keys (enforced by `Record<TranslationKey, string>`).
// Keys are namespaced by area ("settings.general.*", "common.*"); values may
// contain `{var}` placeholders filled in by the translator.
//
// This is a seed covering the reference slice migrated to i18n (Settings ›
// General: language, startup, backup). Grow it incrementally as more of the UI
// is translated — see src/modules/i18n/README.md.
export const en = {
  "common.export": "Export…",
  "common.restore": "Restore…",

  "settings.general.language": "Language",
  "settings.general.languageDesc": "Interface language for Termigo.",

  "settings.general.startup": "Startup",
  "settings.general.launchAtLogin": "Launch at login",
  "settings.general.launchAtLoginDesc":
    "Open Termigo automatically when you sign in.",
  "settings.general.restoreWindow": "Restore window position & size",
  "settings.general.restoreWindowDesc":
    "Reopen the main window where you left it. Applies on next launch.",

  "settings.general.backupHeading": "Backup & Restore",
  "settings.general.backupTitle": "Settings backup",
  "settings.general.backupDesc":
    "Export all preferences to a JSON file, or restore them on another machine. Secrets (API keys, SSH credentials) stay in the OS keychain and are not included.",

  "settings.backup.exported": "Settings exported",
  "settings.backup.exportFailed": "Export failed: {error}",
  "settings.backup.restored": "Restored {count} setting(s)",
  "settings.backup.restoreFailed": "Restore failed: {error}",
  "settings.backup.notText": "That file is not a UTF-8 text file.",
};

/** Every translation key, derived from the English catalog. */
export type TranslationKey = keyof typeof en;
