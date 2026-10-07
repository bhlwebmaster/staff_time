/* BHL Attendance service worker: shows shift reminders (push notifications). No offline caching. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  const title = d.title || "BHL Attendance";
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || "",
    icon: "assets/icon-192.png",
    badge: "assets/icon-192.png",
    tag: "bhl-" + (d.kind || "reminder"),        // a newer reminder of the same kind replaces the old one
    data: { url: d.url || "./" },
    actions: [{ action: "ok", title: "OK" }],     // OK just closes it: nothing changes in the app
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  if (e.action === "ok") return;
  const url = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins.find((c) => c.url.startsWith(self.registration.scope));
    if (w) return w.focus();
    return self.clients.openWindow(url);
  })());
});
