import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

let granted = false;

async function ensurePermission(): Promise<boolean> {
  // Cache only the positive result: a transient denial (e.g. the OS prompt
  // dismissed while unfocused) must not disable notifications for the session.
  if (granted) return true;
  let ok = await isPermissionGranted();
  if (!ok) ok = (await requestPermission()) === "granted";
  granted = ok;
  return ok;
}

export async function osNotify(title: string, body: string): Promise<boolean> {
  try {
    if (!(await ensurePermission())) return false;
    sendNotification({ title, body });
    return true;
  } catch (e) {
    console.warn("[termigo] os notification failed:", e);
    return false;
  }
}
