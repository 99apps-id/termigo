// Bahasa Indonesia catalog. Must cover every key in the English catalog —
// `Record<TranslationKey, string>` makes a missing key a type error.
import type { TranslationKey } from "./en";

export const id: Record<TranslationKey, string> = {
  "common.export": "Ekspor…",
  "common.restore": "Pulihkan…",

  "settings.general.language": "Bahasa",
  "settings.general.languageDesc": "Bahasa antarmuka untuk Termigo.",

  "settings.general.startup": "Saat Mulai",
  "settings.general.launchAtLogin": "Jalankan saat masuk",
  "settings.general.launchAtLoginDesc":
    "Buka Termigo otomatis saat kamu masuk ke sistem.",
  "settings.general.restoreWindow": "Pulihkan posisi & ukuran jendela",
  "settings.general.restoreWindowDesc":
    "Buka kembali jendela utama di posisi terakhir. Berlaku saat peluncuran berikutnya.",

  "settings.general.backupHeading": "Cadangkan & Pulihkan",
  "settings.general.backupTitle": "Cadangan setelan",
  "settings.general.backupDesc":
    "Ekspor semua preferensi ke berkas JSON, atau pulihkan di mesin lain. Rahasia (kunci API, kredensial SSH) tetap di keychain OS dan tidak disertakan.",

  "settings.backup.exported": "Setelan diekspor",
  "settings.backup.exportFailed": "Ekspor gagal: {error}",
  "settings.backup.restored": "{count} setelan dipulihkan",
  "settings.backup.restoreFailed": "Pemulihan gagal: {error}",
  "settings.backup.notText": "Berkas itu bukan teks UTF-8.",
};
