/* Service worker Report Officina — notifiche push */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* payload non JSON */ }
  const title = data.title || "Report Officina";
  const urgente = data.urgente === true;
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/" },
      tag: data.tag || "officina-msg",
      renotify: true,
      // lavoro completato: resta sullo schermo finche non la si tocca, non sparisce da sola
      requireInteraction: urgente,
      // vibrazione lunga: sul telefono in tasca si sente anche col suono basso
      vibrate: urgente ? [400, 200, 400, 200, 400, 200, 600] : undefined,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) { w.navigate(url); return w.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});
