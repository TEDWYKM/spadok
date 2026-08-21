/* ═══════════════════════════════════════════════════════════════════
   СПАДОК · SERVICE WORKER
   Спека, правило 4: офлайн обов'язковий — багато точок у зоні
   слабкого зв'язку. Тому:

     • оболонка застосунку кешується на встановленні;
     • плитки карти кешуються на вимогу («Завантажити для офлайну»)
       і додатково пасивно, коли користувач їх просто дивиться;
     • запити до OSRM ніколи не кешуються — трек залежить від дороги,
       застарілий трек шкідливіший за відсутній.
   ═══════════════════════════════════════════════════════════════════ */

/* Версію переписує scripts/release.mjs — руками не правити.
   Доки байти цього файлу не змінилися, браузер вважає service worker
   тим самим і не переустановлює його, а той офлайн віддає стару
   оболонку з кешу. Тому підняття версії — не косметика: це єдиний
   сигнал, за яким пристрій дізнається, що застосунок оновився. */
const VERSION = '0.6.0';

/* Плитки карти версіонуються окремо і навмисно. Людина могла свідомо
   викачати область для офлайну — десятки мегабайт через мобільний
   інтернет десь у дорозі. Звичайний реліз застосунку не має права
   це стерти. Ця версія міняється тільки тоді, коли міняється сам
   тайл-сервер або схема адрес. */
const TILES_VERSION = 'v1';

const SHELL = 'spadok-shell-' + VERSION;
const TILES = 'spadok-tiles-' + TILES_VERSION;
const FONTS = 'spadok-fonts-' + TILES_VERSION;

/* Скільком плиткам дозволяємо жити в кеші. Львівщина на зумах 8–13
   в межі 700 плиток — це приблизно 20–30 МБ. */
const TILE_CAP = 1400;

const SHELL_FILES = [
  '.',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/data.js',
  'js/app.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    /* addAll падає цілком, якщо хоч один файл недоступний —
       тому кладемо поштучно й не валимо встановлення через дрібницю. */
    await Promise.all(SHELL_FILES.map(f =>
      c.add(new Request(f, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = [SHELL, TILES, FONTS];
    const names = await caches.keys();
    /* Тільки свої кеші. На GitHub Pages origin спільний для всіх
       проєктів акаунта, і caches.keys() чесно повертає чужі теж —
       стерти їх звідси було б хамством, яке важко відстежити. */
    await Promise.all(names
      .filter(n => n.indexOf('spadok-') === 0 && keep.indexOf(n) < 0)
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

const isTile = u =>
  /tile\.openstreetmap\.org/.test(u.hostname) || /basemaps\.cartocdn\.com/.test(u.hostname);
const isFont = u =>
  /fonts\.googleapis\.com/.test(u.hostname) || /fonts\.gstatic\.com/.test(u.hostname);
const isRouter = u => /router\.project-osrm\.org/.test(u.hostname);

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  /* Маршрутизація — тільки з мережі. */
  if (isRouter(url)) return;

  /* Плитки: спершу кеш (щоб офлайн працював), потім мережа. */
  if (isTile(url)) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok) { c.put(req, res.clone()); trim(TILES, TILE_CAP); }
        return res;
      } catch (err) {
        return new Response('', { status: 504, statusText: 'offline tile' });
      }
    })());
    return;
  }

  /* Шрифти: кеш, потім мережа. Без них застосунок читається
     системним шрифтом, тому падіння не критичне. */
  if (isFont(url)) {
    e.respondWith((async () => {
      const c = await caches.open(FONTS);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
        return res;
      } catch (err) {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  /* Своя оболонка: мережа з відступом у кеш. Так оновлення
     підхоплюється відразу, але офлайн застосунок відкривається. */
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const c = await caches.open(SHELL);
          c.put(req, res.clone());
        }
        return res;
      } catch (err) {
        const hit = await caches.match(req);
        if (hit) return hit;
        if (req.mode === 'navigate') {
          const idx = await caches.match('index.html');
          if (idx) return idx;
        }
        return new Response('Немає з’єднання', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
  }
});

/* Найстаріші записи геть, коли кеш плиток переріс межу. */
async function trim(name, cap) {
  const c = await caches.open(name);
  const keys = await c.keys();
  if (keys.length <= cap) return;
  for (let i = 0; i < keys.length - cap; i++) await c.delete(keys[i]);
}

/* Завантаження маршруту для офлайну. Тягнемо послідовними пачками:
   тайл-сервер OSM просить не влаштовувати паралельний шторм. */
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type !== 'cache-tiles' || !Array.isArray(d.urls)) return;
  const port = e.ports && e.ports[0];
  const urls = d.urls.slice(0, 2000);

  e.waitUntil((async () => {
    const c = await caches.open(TILES);
    let done = 0, cached = 0;
    const BATCH = 6;

    for (let i = 0; i < urls.length; i += BATCH) {
      const slice = urls.slice(i, i + BATCH);
      await Promise.all(slice.map(async u => {
        try {
          const hit = await c.match(u);
          if (hit) { cached++; return; }
          const res = await fetch(u, { mode: 'cors' });
          if (res && res.ok) { await c.put(u, res.clone()); cached++; }
        } catch (err) { /* пропущену плитку домалюємо з мережі пізніше */ }
        finally { done++; }
      }));
      if (port) port.postMessage({ type: 'progress', done, total: urls.length });
    }
    await trim(TILES, TILE_CAP);
    if (port) port.postMessage({ type: 'done', cached, total: urls.length });
  })());
});
