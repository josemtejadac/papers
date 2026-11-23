// Service worker de Abstracta: permite instalar la app y abrirla sin conexión.
// No cachea /api/ en general (los datos compartidos siempre vienen de la red), con una
// excepción: /api/pdf, que sirve el PDF de cada paper por nuestro propio dominio justo para
// poder guardarlo y volver a mostrarlo sin conexión (ver reader-download en index.html).
const CACHE = 'lab-papers-v4';
const PDF_CACHE = 'lab-papers-pdfs-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
  '/vendor/katex/katex.min.js', '/vendor/katex/katex.min.css', '/vendor/katex/contrib/auto-render.min.js'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== PDF_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if(req.method !== 'GET' || url.origin !== self.location.origin) return;

  if(url.pathname === '/api/pdf'){
    // Cache-first: una vez descargado un paper (botón Descargar), su PDF se sirve del teléfono
    // sin red. Solo la app decide qué se guarda, para no llenar la memoria con PDFs solo vistos.
    event.respondWith(
      caches.open(PDF_CACHE).then(c => c.match(url.pathname + url.search)).then(hit => hit || fetch(req).catch(() =>
        new Response('Sin conexión: este PDF no está descargado en el teléfono. Descárgalo con el botón de descarga cuando tengas internet.', {
          status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' }
        })
      ))
    );
    return;
  }
  if(url.pathname.startsWith('/api/')) return;

  if(req.mode === 'navigate'){
    // Red primero (siempre la versión más nueva); sin conexión, la última copia guardada.
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put('/index.html', copy));
        return res;
      }).catch(() => caches.match('/index.html').then(hit => hit || Response.error()))
    );
    return;
  }
  event.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if(res.ok){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
