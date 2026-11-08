const CACHE_NAME = 'child-status-shell-v5';
const APP_SHELL = [
    '/',
    '/main.html',
    '/lock-screen.html',
    '/child-screen.html',
    '/parent-screen.html',
    '/style.css',
    '/script.js',
    '/manifest.json',
    '/icons/icon-192.png',
    '/icons/icon-512.png'
];
const APP_SHELL_PATHS = new Set(APP_SHELL.map(path => new URL(path, self.location.origin).pathname));

async function updateCachedResponse(request, response) {
    if (!response.ok) return;
    try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
    } catch (error) {
        console.error('Could not update the offline app cache.', error);
    }
}

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys
                .filter(key => key.startsWith('child-status-shell-') && key !== CACHE_NAME)
                .map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const requestUrl = new URL(event.request.url);
    if (event.request.method !== 'GET'
        || requestUrl.origin !== self.location.origin
        || requestUrl.pathname.startsWith('/api/')) {
        return;
    }

    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request)
                .then(async response => {
                    await updateCachedResponse(event.request, response);
                    return response;
                })
                .catch(async () => await caches.match(event.request) || caches.match('/'))
        );
        return;
    }

    if (APP_SHELL_PATHS.has(requestUrl.pathname)) {
        event.respondWith(
            fetch(event.request)
                .then(async response => {
                    await updateCachedResponse(event.request, response);
                    return response;
                })
                .catch(async () => await caches.match(event.request))
        );
    }
});
