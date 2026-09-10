const CACHE_NAME = 'rafiqi-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './pharmacy-voice-assistant.html',
  './manifest.json',
  './favicon.png',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // نتصرفو غير فطلبات GET من نفس الأصل (الملفات الثابتة ديال التطبيق).
  // أي طلب لسيرفر آخر (الـ backend فـ Railway، خطوط Google) كيبقى يمشي
  // للشبكة مباشرة بلا أي تدخل ديالنا — باش نتائج البحث تبقى دايما طرية.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  const isHTML = request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html');

  if (isHTML) {
    // الصفحة الرئيسية كتتبدل مع كل نشر جديد، فكنجربو الشبكة أولا باش
    // المستخدم يشوف آخر نسخة، ونرجعو للنسخة المخزنة غير إلا ما كانش انترنت.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('./pharmacy-voice-assistant.html')))
    );
    return;
  }

  // باقي الملفات الثابتة (الأيقونات، manifest...) نادر ما كتبدل، فكنبداو
  // بالنسخة المخزنة (أسرع)، ونمشيو للشبكة غير إلا ما كانتش محفوظة.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      return response;
    }))
  );
});
