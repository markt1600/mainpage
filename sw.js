/* Service worker for The Daily (marktan.ai).
   Exists for two things: making the site installable as a PWA, and receiving
   Web Push while the site is closed. No offline caching — the dashboard is
   live data; a stale copy is worse than a spinner. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) {}
  const title = d.title || "The Daily";
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    tag: d.tag || "daily-digest",   // same tag = replace, so re-sends never stack up
    data: { url: d.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) { w.focus(); return; }
    }
    await self.clients.openWindow(url);
  })());
});
