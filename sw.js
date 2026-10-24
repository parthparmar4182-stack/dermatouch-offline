/* Dermatouch Offline — service worker.
   Only for notifications: lets the app show a phone notification and opens the
   app when it is tapped. It caches nothing, so a new index.html is always used. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope)) { try { await c.focus(); if ('navigate' in c) await c.navigate(url); } catch (_) { } return; }
    }
    await self.clients.openWindow(url);
  })());
});
