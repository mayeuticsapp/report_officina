import { Platform } from "react-native";
import { getVapidPublicKey, savePushSubscription } from "@/src/api/client";

/**
 * Notifiche push web (PWA). Solo browser: su nativo non fa nulla.
 * Su Android funziona da Chrome; su iPhone serve prima "Aggiungi a schermata Home".
 */

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function pushSupported(): boolean {
  return (
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function pushPermission(): "granted" | "denied" | "default" | "unsupported" {
  if (!pushSupported()) return "unsupported";
  return Notification.permission as any;
}

/** Registra il service worker, chiede il permesso e iscrive il dispositivo. */
export async function enablePush(): Promise<"ok" | "denied" | "unsupported" | "error"> {
  if (!pushSupported()) return "unsupported";
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return "denied";
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const vapid = await getVapidPublicKey();
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid) as any,
      });
    }
    await savePushSubscription(sub.toJSON());
    return "ok";
  } catch (e) {
    console.warn("enablePush", e);
    return "error";
  }
}

/** Se il permesso è già stato dato, ri-iscrive in silenzio (utile dopo login/cambio utente). */
export async function resubscribeIfGranted(): Promise<void> {
  if (!pushSupported() || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await savePushSubscription(sub.toJSON());
  } catch { /* silenzioso */ }
}
