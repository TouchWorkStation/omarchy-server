// Offline shell only. API calls are never cached: they always go to your Umbrel.
const CACHE = 'umbrel-touch-v1'
self.addEventListener('install', (e) => {
	e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg'])).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
	e.waitUntil(
		caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
	)
})
self.addEventListener('fetch', (e) => {
	const url = new URL(e.request.url)
	if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return
	if (url.pathname.startsWith('/assets/')) {
		e.respondWith(
			caches.match(e.request).then(
				(hit) =>
					hit ||
					fetch(e.request).then((res) => {
						const copy = res.clone()
						caches.open(CACHE).then((c) => c.put(e.request, copy))
						return res
					}),
			),
		)
		return
	}
	if (e.request.mode === 'navigate') {
		e.respondWith(
			fetch(e.request)
				.then((res) => {
					const copy = res.clone()
					caches.open(CACHE).then((c) => c.put('/', copy))
					return res
				})
				.catch(() => caches.match('/')),
		)
	}
})
