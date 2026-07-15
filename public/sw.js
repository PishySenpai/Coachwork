/* Service worker Coachwork : activation immédiate, page en cache pour le
   hors-ligne (réseau d'abord), clic sur notification → retour à l'app. */

const CACHE = "coachwork-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.mode !== "navigate") return;
  e.respondWith(
    fetch(req)
      .then((rep) => {
        const copie = rep.clone();
        caches.open(CACHE).then((c) => c.put("/", copie)).catch(() => {});
        return rep;
      })
      .catch(() => caches.match("/"))
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(
    self.registration.showNotification(d.titre || "Coachwork", {
      body: d.corps || "",
      tag: "coachwork-repos",
      renotify: true,
      icon: "/icone-192.png",
      badge: "/icone-192.png",
      vibrate: [150, 90, 150],
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((fenetres) => {
      for (const f of fenetres) {
        if ("focus" in f) return f.focus();
      }
      return self.clients.openWindow("/");
    })
  );
});
