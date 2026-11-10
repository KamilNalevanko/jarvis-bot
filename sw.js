// Minimal service worker so the app can be installed to the home screen. It caches nothing: prices must always be live.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
