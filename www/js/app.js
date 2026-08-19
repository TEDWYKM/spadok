/* ═══════════════════════════════════════════════════════════════════
   СПАДОК · ЛОГІКА ЗАСТОСУНКУ
   Залежить від data.js (має бути підключений раніше).

   Що змінилося порівняно з прототипом spadok-mvp-v2.html:
     1. Оцінка справді заблокована до підтвердженої відвідини —
        і в інтерфейсі, і в saveReview(). Правило 1 зі спеки.
     2. Прогрес зберігається (localStorage; якщо недоступний —
        пам'ять сесії). Раніше window.storage поза артефактом
        Claude тихо падав у catch і прогрес зникав.
     3. Справжня геолокація з радіусом ARRIVE_RADIUS_M,
        ручне підтвердження лишилося як резерв із позначкою.
     4. alert()/confirm() замінені на внутрішні шторки —
        у WebView Android системні діалоги ненадійні.
     5. Маршрут не прокладається через точки з непідтвердженим
        статусом. Правило 3 зі спеки.
     6. Свіжість перевірки статусу враховується двома порогами:
        STATUS_FRESH_DAYS і STATUS_STALE_DAYS. Правило 2.
     7. Офлайн працює через service worker, а не міняє підпис кнопки.
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

const CONFIG = {
  /* Середня дорожня швидкість по області, км/год — для оцінки часу. */
  avgSpeedKmh: 52,
  /* Скільки хвилин закладаємо на одну зупинку. */
  minutesPerStop: 45,
  /* Кеш плиток: до яких зумів тягнемо і скільком плиткам ставимо межу. */
  offlineZoom: [8, 13],
  offlineTileCap: 700,
  /* Реальне API тривог (потрібен токен за заявкою — див. docs/spec.md).
     Поки null — показуємо демо-стан і чесно це підписуємо. */
  alarmApi: null
};

/* ═════════ ЗБЕРІГАННЯ ═════════
   Одна точка входу. localStorage у приватному режимі або в частині
   WebView кидає виняток уже на записі — тому пробуємо і відступаємо
   в пам'ять, замість того щоб втратити прогрес без попередження. */
const Store = (function () {
  const KEY = 'spadok:lviv:v3';
  const LEGACY = 'spadok:lviv:v2';
  let backend = null, mem = null;
  try {
    const probe = '__spadok__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    backend = window.localStorage;
  } catch (e) { backend = null; }

  function raw(k) { return backend ? backend.getItem(k) : (k === KEY ? mem : null); }

  return {
    kind: backend ? 'local' : 'memory',
    read() {
      try {
        const cur = raw(KEY);
        if (cur) return JSON.parse(cur);
        const old = raw(LEGACY);
        if (old) return migrate(JSON.parse(old));
      } catch (e) { /* пошкоджені дані — починаємо з чистого стану */ }
      return null;
    },
    write(obj) {
      const s = JSON.stringify(obj);
      if (backend) { try { backend.setItem(KEY, s); } catch (e) { mem = s; } }
      else mem = s;
    },
    clear() {
      if (backend) { try { backend.removeItem(KEY); backend.removeItem(LEGACY); } catch (e) {} }
      mem = null;
    }
  };

  /* Прототип тримав оцінки й тексти в одному об'єкті через ключі
     id та id+':txt'. Розводимо в нормальну структуру. */
  function migrate(old) {
    const out = { v: 3, visits: {}, ratings: {}, done: [], badges: [], offline: [] };
    Object.keys(old.visited || {}).forEach(id => {
      out.visits[id] = { at: old.visited[id], by: 'manual', acc: null };
    });
    Object.keys(old.ratings || {}).forEach(k => {
      if (k.indexOf(':') > -1) return;
      out.ratings[k] = {
        stars: old.ratings[k],
        text: old.ratings[k + ':txt'] || '',
        at: (out.visits[k] && out.visits[k].at) || Date.now(),
        by: 'manual'
      };
    });
    out.done = (old.done || []).slice();
    out.badges = (old.badges || []).slice();
    return out;
  }
})();

let S = { v: 3, visits: {}, ratings: {}, done: [], badges: [], offline: [] };
let V = {
  screen: 'map', theme: 'all', sort: 'near', size: 'all',
  route: null, idx: 0, t0: 0, sel: null, from: 'map',
  media: 'photo', draftStars: 0, tiles: 'osm',
  fresh: [], sheet: null, toast: null, swUpdate: false,
  /* Дорожній режим: повноекранна карта, що їде за користувачем.
     plan — порядок точок саме цієї подорожі, перебудований під
     положення на старті; у даних маршрут лишається недоторканим. */
  road: false, roadBack: false, follow: true, followAnim: false, plan: null,
  /* Пошук: q — сам запит, searching — чи розгорнуте поле в шапці. */
  q: '', searching: false,
  /* Головний екран: яка вкладка у шторці, у якому вона положенні
     і чи вже ставили карту на позицію користувача. */
  mapTab: 'places', snap: 0, centered: false, listAt: null
};
let MOUNT = null, LMAP = null, LEAFLET = null, MEMARK = null, MEACC = null, MOUNTBOUNDS = null;
let MARKS = null, MOUNTCFG = null;
/* Трек поточного відрізка і точка, з якої його прокладали:
   відійшов далеко — перекладаємо. */
let NAVLINE = null, NAVFROM = null, NAVAT = 0, NAVBUSY = false;

function save() { Store.write(S); }

/* ═════════ УТИЛІТИ ═════════ */
const P = id => POINTS.find(p => p.id === id);

/* Дні поточної подорожі. Поки подорож не почалась — як у даних.
   Щойно почалась — беремо порядок, перебудований під старт, щоб
   екрани маршруту й подорожі не розходились між собою. */
const planDays = r => (V.plan && V.plan.id === r.id) ? V.plan.days : r.days;
const flat = r => planDays(r).reduce((a, d) => a.concat(d), []);

/* Приймає і id точки, і сирі координати — щоб трек міг починатися
   від користувача, а не тільки від пам'ятки. */
const LL = x => typeof x === 'string' ? [P(x).lat, P(x).lon] : [x.lat, x.lon];
const fmtM = m => m == null ? '—'
  : m < 1000 ? m + ' м'
    : (m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',') + ' км';

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Гаверсинус. Повертає кілометри. */
function dist(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const distM = (a, b) => dist(a, b) * 1000;

/* Азимут з a на b, градуси від півночі за годинниковою.
   Карта тримається північчю вгору, тому цей кут — це буквально
   той напрямок, у який стрілка дивиться на екрані. */
function bearing(a, b) {
  const rad = x => x * Math.PI / 180, deg = x => x * 180 / Math.PI;
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/* Довжина дня: старт → точки по черзі → повернення до бази.
   Саме з поверненням, інакше «оптимізація» жене вас у дальній кут
   області, звідки ввечері доведеться вертатись через усе. */
function dayLen(from, ids, base) {
  let km = 0, cur = from;
  for (const id of ids) { km += dist(cur, P(id)); cur = P(id); }
  return km + dist(cur, base);
}

/* Порядок точок дня під ваш старт. Днів більше ніж на 5 точок у нас
   немає, тож перебираємо всі перестановки й беремо найкоротшу —
   це швидше, ніж здається, і чесніше за жадібний обхід, який на
   близьких відстанях легко обирає гірший варіант.

   Важливо: за початковий приймаємо авторський порядок. Тому при
   рівних довжинах — а для кільця з поверненням до бази прямий
   і зворотний обхід рівні завжди — лишається той, який задумали
   в маршруті. Перестановка має рятувати від гака, а не тасувати
   точки просто тому, що може. */
function orderDay(ids, from, base) {
  if (ids.length < 2) return ids.slice();
  let best = ids.slice(), bestKm = dayLen(from, ids, base);
  if (ids.length > 7) return best;

  const walk = (left, acc) => {
    if (!left.length) {
      const km = dayLen(from, acc, base);
      if (km < bestKm - 0.05) { bestKm = km; best = acc.slice(); }
      return;
    }
    for (let i = 0; i < left.length; i++)
      walk(left.slice(0, i).concat(left.slice(i + 1)), acc.concat(left[i]));
  };
  walk(ids, []);
  return best;
}

/* План подорожі. Переставляємо тільки всередині дня — ночівля
   прив'язана до бази, тож дні між собою не перемішуються.
   Під старт підлаштовується лише перший день: у наступні ви
   виїжджаєте з бази, а не з того місця, де були вчора ввечері. */
function buildPlan(r, from, byGps) {
  const base = P(r.from);
  const days = r.ord
    ? r.days.map(d => d.slice())
    : r.days.map((d, i) => orderDay(d, i === 0 ? from : base, base));
  return { id: r.id, days, byGps: !!byGps, ord: !!r.ord };
}

function dayKm(r, d) {
  const chain = [P(r.from)].concat(d.map(P), [P(r.from)]);
  let k = 0;
  for (let i = 1; i < chain.length; i++) k += dist(chain[i - 1], chain[i]);
  return Math.round(k);
}

function routeStats(r) {
  const st = flat(r);
  let km = 0;
  planDays(r).forEach(d => { km += dayKm(r, d); });
  const min = Math.round(km / CONFIG.avgSpeedKmh * 60) + st.length * CONFIG.minutesPerStop;
  const near = st.reduce((a, id) => {
    const p = P(id);
    a.shop += p.near.shop; a.stay += p.near.stay; a.food += p.near.food;
    return a;
  }, { shop: 0, stay: 0, food: 0 });
  return {
    km, min, near,
    stops: st.length,
    days: planDays(r).length,
    warn: st.some(id => P(id).st === 'warn'),
    blocked: st.filter(id => !routable(P(id))),
    /* Застарілі — це середній ярус: точка ще в маршруті, але з позначкою.
       Протухлі вже пораховані у blocked, двічі про них не пишемо. */
    stale: st.filter(id => !fresh(P(id)) && !expired(P(id)))
  };
}

const hhmm = m => (m >= 60 ? Math.floor(m / 60) + ' год ' : '') + (m % 60) + ' хв';

/* Українська форма іменника після числа. Раніше в інтерфейсі стояло
   жорстке «точку» незалежно від кількості. */
function plural(n, one, few, many) {
  const d = n % 10, h = n % 100;
  if (d === 1 && h !== 11) return one;
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few;
  return many;
}
const pts = n => n + ' ' + plural(n, 'точка', 'точки', 'точок');

function stamp(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() +
    ' · ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function dmy(iso) {
  const d = new Date(iso), p = n => String(n).padStart(2, '0');
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear();
}
const daysSince = iso => Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);

/* ── Правила зі спеки, розділ 5 ─────────────────────────────────────
   Правило 2: точка зі застарілою перевіркою не вважається
              підтвердженою і не потрапляє в «рекомендовані»;
              коли перевірка протухла зовсім (STATUS_STALE_DAYS),
              статусу вже не можна вірити — точка випадає і з треку.
   Правило 3: маршрут не прокладається через точки, чий статус
              не підтверджений (закрито / під окупацією).            */
const fresh = p => daysSince(p.upd) <= STATUS_FRESH_DAYS;
const expired = p => daysSince(p.upd) > STATUS_STALE_DAYS;
const routable = p => p.st !== 'closed' && p.st !== 'occupied' && !expired(p);
const recommended = p => p.st === 'ok' && fresh(p);

/* Чому точка не рекомендована. Причини дві — доступ і давність перевірки —
   і показувати треба ту, що справді є, а не зручнішу. */
function recWhy(list) {
  const shut = list.filter(p => p.st !== 'ok').length;
  const old = list.length - shut;
  /* Коли причина одна, число вже назване вище — не повторюємо його. */
  if (!old) return 'обмежений або закритий доступ';
  if (!shut) return 'перевірка статусу давніша за ' + STATUS_FRESH_DAYS + ' днів';
  return shut + ' з обмеженим доступом, ' + old + ' з перевіркою давнішою за ' +
    STATUS_FRESH_DAYS + ' днів';
}

/* Чому саме точку обійшли. Причини дві, і користувач має бачити, яка. */
function blockedWhy(ids) {
  const shut = ids.filter(id => P(id).st === 'closed' || P(id).st === 'occupied').length;
  const old = ids.length - shut;
  const why = [];
  if (shut) why.push(pts(shut) + ' зі статусом «закрито» або «під окупацією» — правило 3');
  if (old) why.push(pts(old) + ' з перевіркою давнішою за ' + STATUS_STALE_DAYS + ' днів — правило 2');
  return why.join('; ');
}

/* Індекс дня, у якому лежить зупинка за наскрізним номером. */
function dayOf(r, i) {
  const days = planDays(r);
  let c = 0;
  for (let d = 0; d < days.length; d++) {
    c += days[d].length;
    if (i < c) return d;
  }
  return days.length - 1;
}
/* Перша зупинка дня в наскрізній нумерації — потрібно, щоб відстань
   рахувалася від бази, а не від останньої точки попереднього дня. */
function dayStart(r, di) {
  const days = planDays(r);
  let c = 0;
  for (let d = 0; d < di; d++) c += days[d].length;
  return c;
}

/* ═════════ ГЕОЛОКАЦІЯ ═════════
   Один менеджер на застосунок. У Capacitor беремо плагін
   (він сам просить дозвіл у Android), у браузері — navigator. */
const Geo = {
  state: 'idle',      // idle | asking | live | denied | unsupported | error
  pos: null,          // {lat, lon, acc, at}
  watch: null,
  subs: [],

  plugin() {
    const C = window.Capacitor;
    return (C && C.Plugins && C.Plugins.Geolocation) ? C.Plugins.Geolocation : null;
  },

  on(fn) { this.subs.push(fn); },
  emit() { this.subs.forEach(fn => { try { fn(); } catch (e) {} }); },

  async start() {
    if (this.state === 'live' || this.state === 'asking') return;
    const plug = this.plugin();
    if (!plug && !(navigator.geolocation)) {
      this.state = 'unsupported'; this.emit(); return;
    }
    this.state = 'asking'; this.emit();
    const opts = { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 };

    const ok = p => {
      const c = p.coords || p;
      const next = {
        lat: c.latitude, lon: c.longitude, acc: c.accuracy, at: Date.now(),
        /* Швидкість і курс GPS віддає тільки в русі. Коли їх немає —
           рахуємо курс самі, але лише при зсуві більшому за похибку:
           інакше стрілка крутилася б від дрижання сигналу на місці. */
        spd: (typeof c.speed === 'number' && c.speed >= 0) ? c.speed : null,
        hdg: (typeof c.heading === 'number' && !isNaN(c.heading)) ? c.heading : null
      };
      if (next.hdg == null && this.pos)
        next.hdg = distM(this.pos, next) > 12 ? bearing(this.pos, next) : this.pos.hdg;
      this.pos = next;
      this.state = 'live';
      this.emit();
    };
    const bad = err => {
      const code = err && err.code;
      this.state = (code === 1) ? 'denied' : 'error';
      this.emit();
    };

    try {
      if (plug) {
        try {
          const perm = await plug.requestPermissions();
          if (perm && perm.location === 'denied') { this.state = 'denied'; this.emit(); return; }
        } catch (e) { /* старі версії плагіна без requestPermissions */ }
        this.watch = await plug.watchPosition(opts, (p, err) => err ? bad(err) : ok(p));
      } else {
        this.watch = navigator.geolocation.watchPosition(ok, bad, opts);
      }
    } catch (e) { bad(e); }
  },

  stop() {
    const plug = this.plugin();
    try {
      if (this.watch == null) return;
      if (plug) plug.clearWatch({ id: this.watch });
      else navigator.geolocation.clearWatch(this.watch);
    } catch (e) {}
    this.watch = null;
  },

  /* Метри до точки або null, якщо позиції ще немає. */
  metersTo(p) {
    if (!this.pos) return null;
    return Math.round(distM(this.pos, p));
  },
  /* Чи вважаємо, що користувач фізично на місці.
     Похибку сигналу додаємо до радіуса: у лісі acc буває 50–80 м. */
  atPoint(p) {
    const m = this.metersTo(p);
    if (m == null) return false;
    const slack = Math.min(this.pos.acc || 0, 150);
    return m <= ARRIVE_RADIUS_M + slack;
  }
};

/* ═════════ КАРТА · Leaflet + OpenStreetMap ═════════ */
/* Leaflet підключаємо з vendor/ — його кладе туди `npm run vendor`
   під час збірки, щоб карта працювала в APK і офлайн з першого
   запуску. Якщо vendor не зібраний (наприклад, файли відкриті
   напряму з репозиторію), відступаємо на CDN. */
const LEAFLET_SRC = [
  { css: 'vendor/leaflet/leaflet.css', js: 'vendor/leaflet/leaflet.js' },
  {
    css: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
    js: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'
  }
];

function loadScript(src) {
  return new Promise(res => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => res(true);
    s.onerror = () => res(false);
    document.head.appendChild(s);
  });
}

function loadLeaflet() {
  if (LEAFLET) return LEAFLET;
  LEAFLET = (async () => {
    if (window.L) return true;
    for (const src of LEAFLET_SRC) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = src.css;
      document.head.appendChild(css);
      const ok = await loadScript(src.js);
      if (ok && window.L) return true;
      css.remove();
    }
    return false;
  })();
  return LEAFLET;
}

const TILES = {
  osm: {
    u: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    a: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    n: 'Стандартна', sub: null
  },
  light: {
    u: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    a: '&copy; OpenStreetMap, &copy; CARTO',
    n: 'Світла', sub: 'abcd'
  },
  /* Темна підкладка вмикається сама в дорожньому режимі: вночі за
     кермом світла карта засвічує лобове скло. Вибрати її вручну теж
     можна — вона просто третьою у смузі стилів. */
  dark: {
    u: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    a: '&copy; OpenStreetMap, &copy; CARTO',
    n: 'Темна', sub: 'abcd'
  }
};

/* Наскільки близько тримати камеру. Пішки треба бачити двір,
   на трасі — наступний поворот за кілометр. */
function navZoom(spd, toNext) {
  if (toNext != null && toNext < 350) return 17;
  if (spd == null) return 15;
  if (spd < 1.5) return 17;
  if (spd < 8) return 16;
  if (spd < 18) return 15;
  return 14;
}

async function mountMap() {
  if (!MOUNT) return;
  const cfg = MOUNT; MOUNT = null;
  const el = document.getElementById('lmap');
  if (!el) return;
  const ok = await loadLeaflet();
  if (!ok || !window.L) { el.classList.add('fallback'); el.innerHTML = fallbackSVG(cfg); return; }
  if (LMAP) { try { LMAP.remove(); } catch (e) {} LMAP = null; }

  let map;
  try {
    map = L.map(el, {
      zoomControl: !cfg.nav, scrollWheelZoom: false,
      attributionControl: true
    });
  }
  catch (e) { el.classList.add('fallback'); el.innerHTML = fallbackSVG(cfg); return; }
  LMAP = map;
  MEMARK = null; MEACC = null; NAVLINE = null; NAVFROM = null;

  /* Щойно користувач сам потягнув карту — перестаємо її смикати.
     Повернути слідування можна кнопкою, і тільки нею: інакше
     камера воювала б із рукою. */
  if (cfg.nav) map.on('dragstart zoomstart', e => {
    if (e.type === 'dragstart' || !V.followAnim) setFollow(false);
  });

  const t = TILES[cfg.nav ? 'dark' : V.tiles];
  const layer = L.tileLayer(t.u, {
    attribution: t.a, maxZoom: 18, subdomains: t.sub || 'abc'
  }).addTo(map);

  /* Якщо плитки не йдуть (немає мережі й немає кешу) — не лишаємо
     сірий прямокутник, а падаємо на схему. */
  let bad = 0, good = 0;
  layer.on('tileload', () => { good++; });
  layer.on('tileerror', () => {
    bad++;
    if (bad > 8 && good === 0 && LMAP === map) {
      try { map.remove(); } catch (e) {}
      LMAP = null;
      el.classList.add('fallback');
      el.innerHTML = fallbackSVG(cfg);
    }
  });

  MOUNTCFG = cfg;
  MARKS = L.layerGroup().addTo(map);
  drawMarks(map, cfg);
  /* Кластери живуть тільки на головній карті: на екрані маршруту
     треба бачити кожну зупинку, скільки б їх не тулилось поруч. */
  if (cfg.full) map.on('zoomend', () => { if (LMAP === map) drawMarks(map, cfg); });

  const bounds = L.latLngBounds(cfg.points.map(p => [p.lat, p.lon]));

  if (cfg.legs && cfg.legs.length) {
    const colors = ['#1C5849', '#A8542B', '#2E7D6C', '#B08417'];
    cfg.legs.forEach((leg, i) => {
      const chain = leg.map(LL);
      const line = L.polyline(chain, cfg.nav
        ? { color: '#3FD9B6', weight: 6, opacity: .9, lineCap: 'round', lineJoin: 'round', dashArray: '10 8' }
        : { color: colors[i % 4], weight: 3.4, opacity: .85, dashArray: '8 6' }
      ).addTo(map);
      bounds.extend(line.getBounds());
      if (cfg.nav && i === 0) { NAVLINE = line; NAVFROM = { lat: chain[0][0], lon: chain[0][1] }; }
      roadRoute(chain).then(geo => {
        if (geo && LMAP === map) {
          line.setLatLngs(geo);
          line.setStyle({ dashArray: null });
          const n = document.getElementById('roadnote');
          if (n) n.textContent = 'по дорогах · OSRM';
        }
      });
    });
  }

  /* Своя позиція, якщо геолокація вже дала фікс. */
  if (Geo.pos) drawMe(map);

  if (cfg.nav && Geo.pos) {
    map.setView([Geo.pos.lat, Geo.pos.lon], navZoom(Geo.pos.spd, cfg.toNext));
  } else if (cfg.full && Geo.pos) {
    /* Головний екран відкривається там, де ви є, а не там, де база. */
    V.centered = true;
    map.setView([Geo.pos.lat, Geo.pos.lon], 11);
    setTimeout(() => { if (LMAP === map) centerOnMe(map, 11); }, 60);
  } else {
    try { map.fitBounds(bounds.pad(.18)); }
    catch (e) { map.setView([49.84, 24.03], 8); }
  }
  MOUNTBOUNDS = bounds;
  setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 150);
}

/* ═════════ ПОЗНАЧКИ НА КАРТІ ═════════
   Усі позначки — кружальця, колір закріплений за типом обʼєкта.
   Під увімкненим фільтром теми колір беремо від теми: тоді на карті
   лишаються тільки її точки, і колір означає саме її.               */
function markColor(p) {
  const dk = V.road || V.tiles === 'dark';
  const key = dk ? 'd' : 'l';
  if (V.theme !== 'all' && THEME_COLOR[V.theme]) return THEME_COLOR[V.theme][key];
  return (KIND_COLOR[p.kind] || KIND_COLOR.city)[key];
}

/* Скупчення розводимо по сітці в ПІКСЕЛЯХ поточного зуму, а не в
   градусах: на карті злипаються ті точки, що близькі на екрані,
   а не ті, що близькі на глобусі. Тому з наближенням купа сама
   розпадається — окремої анімації для цього не треба. */
function clusterize(map, points, cell) {
  const z = map.getZoom();
  const cells = new Map();
  points.forEach(p => {
    const pt = map.project([p.lat, p.lon], z);
    const key = Math.floor(pt.x / cell) + ':' + Math.floor(pt.y / cell);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
  });
  return [...cells.values()];
}

function drawMarks(map, cfg) {
  if (!MARKS || !window.L) return;
  MARKS.clearLayers();
  const groups = cfg.full ? clusterize(map, cfg.points, 58) : cfg.points.map(p => [p]);

  groups.forEach(g => {
    if (g.length > 1) {
      const lat = g.reduce((a, p) => a + p.lat, 0) / g.length;
      const lon = g.reduce((a, p) => a + p.lon, 0) / g.length;
      /* Розмір росте від кількості, але повільно: інакше велике
         скупчення закриває пів області. */
      const size = Math.min(52, 30 + Math.round(Math.log2(g.length) * 7));
      const seen = g.filter(p => S.visits[p.id]).length;
      L.marker([lat, lon], {
        icon: L.divIcon({
          className: '',
          html: '<div class="mkc" style="width:' + size + 'px;height:' + size + 'px">' +
            g.length + (seen ? '<b></b>' : '') + '</div>',
          iconSize: [size, size], iconAnchor: [size / 2, size / 2]
        }),
        title: g.length + ' точок поруч'
      }).addTo(MARKS).on('click', () => {
        /* Тап по скупченню наближає до нього, а не відкриває список:
           так поводяться всі карти, і це передбачувано. */
        try { map.flyToBounds(L.latLngBounds(g.map(p => [p.lat, p.lon])).pad(.35), { maxZoom: 14 }); }
        catch (e) { map.setView([lat, lon], Math.min(14, map.getZoom() + 2)); }
      });
      return;
    }

    const p = g[0];
    const on = !!S.visits[p.id], now = cfg.now === p.id;
    L.marker([p.lat, p.lon], {
      icon: L.divIcon({
        className: '',
        html: '<div class="mk ' + (now ? 'now' : on ? 'on' : '') +
          '" style="--c:' + markColor(p) + '"><i></i></div>',
        iconSize: [24, 24], iconAnchor: [12, 12]
      }),
      title: p.n
    }).addTo(MARKS).bindPopup(
      '<b>' + esc(p.n) + '</b><br>' +
      '<span style="color:#6D8091;font-size:11.5px">' + esc(p.s) + '</span><br>' +
      '<button data-open="' + p.id + '" style="margin-top:7px;border:1px solid rgba(21,36,46,.3);' +
      'border-radius:999px;padding:6px 13px;font-size:12px;background:#fff;cursor:pointer">Відкрити</button>'
    );
  });
}

/* Своя позначка. Трикутник дивиться туди, куди ти рухаєшся; коли
   курсу немає — стає крапкою, щоб не вигадувати напрямок.
   Коло навколо — це похибка сигналу, а не радіус прибуття. */
function drawMe(map) {
  if (!Geo.pos || !window.L) return;
  const ll = [Geo.pos.lat, Geo.pos.lon];
  const hdg = Geo.pos.hdg;
  const icon = L.divIcon({
    className: '',
    html: '<div class="me' + (hdg == null ? ' flat' : '') + '"' +
      (hdg == null ? '' : ' style="transform:rotate(' + Math.round(hdg) + 'deg)"') +
      '><svg viewBox="0 0 24 24"><path d="M12 2.5l7.5 18.5L12 17l-7.5 4z"/></svg></div>',
    iconSize: [30, 30], iconAnchor: [15, 15]
  });
  if (MEMARK) {
    try { MEMARK.setLatLng(ll); MEMARK.setIcon(icon); }
    catch (e) { MEMARK = null; }
  }
  if (!MEMARK) MEMARK = L.marker(ll, { icon, zIndexOffset: 1000 }).addTo(map).bindPopup('Ви тут');

  const acc = Math.round(Geo.pos.acc || 0);
  if (acc > 15) {
    if (MEACC) { try { MEACC.setLatLng(ll); MEACC.setRadius(acc); } catch (e) { MEACC = null; } }
    if (!MEACC) MEACC = L.circle(ll, {
      radius: acc, color: '#16B8C8', weight: 1, opacity: .35, fillOpacity: .1
    }).addTo(map);
  } else if (MEACC) {
    try { map.removeLayer(MEACC); } catch (e) {}
    MEACC = null;
  }
}

/* Слідування вмикається й вимикається в одному місці, щоб кнопка
   і жест руки не розходились у стані. */
function setFollow(on) {
  if (V.follow === on) return;
  V.follow = on;
  const b = document.getElementById('rfollow');
  if (b) {
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('solid', on);
  }
}

/* Камера за користувачем. Окремий прапорець, щоб власний setView
   не був сприйнятий як «користувач сам крутнув карту». */
function followMe() {
  if (!LMAP || !Geo.pos || !V.follow) return;
  const cur = navTarget();
  V.followAnim = true;
  try {
    LMAP.setView([Geo.pos.lat, Geo.pos.lon],
      navZoom(Geo.pos.spd, cur ? Geo.metersTo(cur) : null), { animate: true, duration: .5 });
  } catch (e) {}
  setTimeout(() => { V.followAnim = false; }, 700);
}

async function roadRoute(chain) {
  try {
    const s = chain.map(c => c[1].toFixed(5) + ',' + c[0].toFixed(5)).join(';');
    const r = await fetch('https://router.project-osrm.org/route/v1/driving/' + s +
      '?overview=full&geometries=geojson');
    const j = await r.json();
    if (j.routes && j.routes[0]) return j.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
  } catch (e) { /* демо-сервер OSRM без SLA — тихо лишаємо пряму лінію */ }
  return null;
}

/* Схема на випадок, коли онлайн-карта недоступна. */
function fallbackSVG(cfg) {
  /* Та сама схема, але в дорожньому режимі — світлим по темному:
     інакше підписи зливаються з тлом і схема нічого не пояснює. */
  const dk = !!cfg.nav;
  const ink = dk ? '#EAF2F4' : '#15242E';
  const fill = dk ? '#0B1114' : '#F2F1E9';
  const done = dk ? '#3FD9B6' : '#1C5849';
  const la = cfg.points.map(p => p.lat), lo = cfg.points.map(p => p.lon);
  const b = {
    y0: Math.min.apply(null, la) - .08, y1: Math.max.apply(null, la) + .08,
    x0: Math.min.apply(null, lo) - .08, x1: Math.max.apply(null, lo) + .08
  };
  const X = l => ((l - b.x0) / (b.x1 - b.x0 || 1) * 520 + 20).toFixed(1);
  const Y = l => ((b.y1 - l) / (b.y1 - b.y0 || 1) * 250 + 20).toFixed(1);
  /* Ланка відрізка — або точка маршруту, або ваші координати:
     трек починається від вас, а не завжди від пам'ятки. */
  const legs = (cfg.legs || []).map(leg =>
    '<path d="' + leg.map((x, i) => {
      const c = LL(x);
      return (i ? 'L' : 'M') + X(c[1]) + ' ' + Y(c[0]);
    }).join(' ') +
    '" fill="none" stroke="' + (dk ? '#3FD9B6' : '#A8542B') + '" stroke-width="2" stroke-dasharray="7 5"/>').join('');
  const pins = cfg.points.map(p =>
    '<g><circle cx="' + X(p.lon) + '" cy="' + Y(p.lat) + '" r="6" fill="' +
    (S.visits[p.id] ? done : fill) + '" stroke="' + ink + '" stroke-width="1.6"/>' +
    '<text x="' + (+X(p.lon) + 10) + '" y="' + (+Y(p.lat) + 4) + '" font-size="9.5" ' +
    'font-family="IBM Plex Mono,monospace" fill="' + ink + '">' +
    esc(p.n.split(',')[0]) + '</text></g>').join('');
  return '<div class="alert" style="margin:0 0 10px">Карта недоступна без мережі — показано схему. ' +
    'Завантажте маршрут для офлайну, і плитки OpenStreetMap працюватимуть без зв’язку.</div>' +
    '<svg viewBox="0 0 560 290">' + legs + pins + '</svg>';
}

/* ═════════ ШТОРКА ГОЛОВНОГО ЕКРАНА ═════════
   Тягнеться за ручку й за шапку. Список усередині гортається сам,
   але коли він угорі й палець іде вниз — тягнеться шторка: інакше
   зібрати її назад можна було б тільки прицільним попаданням
   у вузьку смужку.                                              */
let SHEET = null;

function sheetPx() {
  const el = document.getElementById('msheet');
  return el ? el.getBoundingClientRect().height : 0;
}

function applySnap(i, animate) {
  V.snap = Math.max(0, Math.min(SNAPS.length - 1, i));
  const el = document.getElementById('msheet');
  const btn = document.getElementById('locme');
  if (!el) return;
  el.classList.toggle('dragging', !animate);
  el.style.height = (SNAPS[V.snap] * 100) + '%';
  if (btn) btn.style.bottom = 'calc(' + (SNAPS[V.snap] * 100) + '% + 14px)';
  if (!animate) requestAnimationFrame(() => el.classList.remove('dragging'));
}

function bindSheet() {
  const el = document.getElementById('msheet');
  const list = document.getElementById('mlist');
  if (SHEET) { window.removeEventListener('pointerup', SHEET.up); SHEET = null; }
  if (!el) return;
  applySnap(V.snap, true);

  const view = el.parentElement;
  let y0 = 0, h0 = 0, armed = false, live = false, fromList = false;

  /* Порогом у 6 пікселів відрізняємо перетягування від тапу: без нього
     кожен дотик до картки в списку рахувався б рухом шторки, і картка
     переставала б відкриватись. */
  const down = e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const onList = list && list.contains(e.target);
    if (onList && list.scrollTop > 0) return;
    fromList = onList;
    y0 = e.clientY;
    h0 = el.getBoundingClientRect().height;
    armed = true; live = false;
  };

  const move = e => {
    if (!armed) return;
    const dy = e.clientY - y0;
    if (!live) {
      if (Math.abs(dy) < 6) return;
      /* Зі списку тягнемо тільки вниз: рух угору там означає гортання. */
      if (fromList && dy < 0) { armed = false; return; }
      live = true;
      el.classList.add('dragging');
    }
    const H = view.getBoundingClientRect().height || 1;
    const h = Math.max(SNAPS[0] * H * .55,
      Math.min(SNAPS[SNAPS.length - 1] * H, h0 - dy));
    el.style.height = (h / H * 100) + '%';
    e.preventDefault();
  };

  const up = () => {
    armed = false;
    if (!live) return;
    live = false;
    const H = view.getBoundingClientRect().height || 1;
    const frac = el.getBoundingClientRect().height / H;
    let best = 0;
    SNAPS.forEach((sn, i) => {
      if (Math.abs(sn - frac) < Math.abs(SNAPS[best] - frac)) best = i;
    });
    el.classList.remove('dragging');
    applySnap(best, true);
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move, { passive: false });
  /* Палець часто відривається за межами шторки — ловимо це на вікні. */
  window.addEventListener('pointerup', up);
  SHEET = { el, up };
}

/* Поле пошуку живе в шапці, яку перемальовує render(). Тому подію
   ловимо делеговано на документі, а не вішаємо слухач на елемент,
   що зникне при наступному перемальовуванні. */
function onSearchInput(e) {
  if (!e.target || e.target.id !== 'q') return;
  V.q = e.target.value;
  /* Оновлюємо список і шар позначок, але не чіпаємо ні карту, ні шапку:
     повний render() забрав би фокус із поля просто посеред набору,
     а перебудова карти скинула б вигляд на кожну літеру. */
  refreshMapList();
  if (LMAP && MOUNTCFG) {
    MOUNTCFG.points = mapModel().places;
    drawMarks(LMAP, MOUNTCFG);
  }
  /* Результати мають бути видні: складену шторку піднімаємо. */
  if (V.snap === 0) applySnap(1, true);
}

function focusSearch() {
  const el = document.getElementById('q');
  if (!el) return;
  try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
}

/* Тап по ручці перебирає положення — так само, як у системних
   шторках Android: не всі тягнуть, дехто просто тицяє. */
function cycleSnap() {
  applySnap(V.snap >= SNAPS.length - 1 ? 0 : V.snap + 1, true);
}

/* Карта центрується на користувачеві, але з поправкою на шторку:
   інакше ваша позначка опинилась би точно під нею. */
function centerOnMe(map, zoom) {
  if (!Geo.pos || !map) return;
  const z = zoom || Math.max(map.getZoom() || 0, 13);
  try {
    const off = sheetPx() / 2;
    const pt = map.project([Geo.pos.lat, Geo.pos.lon], z).add([0, off]);
    map.setView(map.unproject(pt, z), z, { animate: true });
  } catch (e) {
    try { map.setView([Geo.pos.lat, Geo.pos.lon], z); } catch (e2) {}
  }
}

/* ═════════ ДРІБНІ БЛОКИ ІНТЕРФЕЙСУ ═════════ */
const STAR_PATH = 'M12 2.6l2.9 6 6.5.9-4.7 4.6 1.1 6.5L12 17.5 6.2 20.6l1.1-6.5L2.6 9.5l6.5-.9z';

function stars(v, cls) {
  let h = '<div class="stars ' + (cls || '') + '">';
  for (let i = 1; i <= 5; i++)
    h += '<span class="star ' + (i <= v ? 'on' : '') + '"><svg viewBox="0 0 24 24"><path d="' +
      STAR_PATH + '"/></svg></span>';
  return h + '</div>';
}

function starPicker(cur) {
  let h = '<div class="stars" role="radiogroup" aria-label="Ваша оцінка">';
  for (let i = 1; i <= 5; i++)
    h += '<button class="star ' + (i <= cur ? 'on' : '') + '" role="radio" aria-checked="' +
      (i === cur) + '" aria-label="' + i + ' з 5" data-star="' + i + '">' +
      '<svg viewBox="0 0 24 24"><path d="' + STAR_PATH + '"/></svg></button>';
  return h + '</div>';
}

const ST_LABEL = { ok: 'доступно', warn: 'обмежено', closed: 'закрито', occupied: 'під окупацією' };
function stTag(p) {
  const st = typeof p === 'string' ? p : p.st;
  const cls = st === 'ok' ? 'ok' : st === 'warn' ? 'warn' : 'stop';
  let h = '<span class="tag ' + cls + '">' + (ST_LABEL[st] || st) + '</span>';
  /* Правило 2, два яруси. Обидва рядки лишаються літералами навмисно:
     check.mjs звіряє класи .tag з CSS саме пошуком по тексту. */
  if (typeof p === 'object' && expired(p))
    h += '<span class="tag old">перевірка ' + daysSince(p.upd) + ' дн.</span>';
  else if (typeof p === 'object' && !fresh(p))
    h += '<span class="tag stale">перевірка ' + daysSince(p.upd) + ' дн.</span>';
  return h;
}

const mapBar = () => '<div class="mapbar">' + Object.keys(TILES).map(k =>
  '<button class="chip sm" aria-pressed="' + (V.tiles === k) + '" data-tiles="' + k + '">' +
  TILES[k].n + '</button>').join('') +
  '<span class="meta" id="roadnote">прокладаю по дорогах…</span></div>';

/* Смуга геолокації. Показує реальний стан дозволу — без вигадок. */
function geoBar(target) {
  const st = Geo.state;
  if (st === 'idle')
    return '<div class="geo off"><span class="pulse"></span><div class="txt">' +
      '<b>Геолокація вимкнена</b><span>потрібна, щоб зарахувати відвідини</span></div>' +
      '<button class="btn-sm" data-act="geo-on">Увімкнути</button></div>';
  if (st === 'asking')
    return '<div class="geo"><span class="pulse"></span><div class="txt">' +
      '<b>Шукаю сигнал…</b><span>дозвольте доступ до місця</span></div></div>';
  if (st === 'denied')
    return '<div class="geo off"><span class="pulse"></span><div class="txt">' +
      '<b>Доступ до місця відхилено</b><span>відвідини можна підтвердити вручну</span></div>' +
      '<button class="btn-sm" data-act="geo-on">Ще раз</button></div>';
  if (st === 'unsupported')
    return '<div class="geo off"><span class="pulse"></span><div class="txt">' +
      '<b>Геолокація недоступна</b><span>підтвердження лишається ручним</span></div></div>';
  if (st === 'error')
    return '<div class="geo off"><span class="pulse"></span><div class="txt">' +
      '<b>Сигнал не піймався</b><span>спробуйте на відкритому місці</span></div>' +
      '<button class="btn-sm" data-act="geo-on">Ще раз</button></div>';

  const m = target ? Geo.metersTo(target) : null;
  const here = target ? Geo.atPoint(target) : false;
  const acc = Geo.pos && Geo.pos.acc ? '±' + Math.round(Geo.pos.acc) + ' м' : 'точність невідома';
  return '<div class="geo ' + (here ? 'here' : 'live') + '"><span class="pulse"></span>' +
    '<div class="txt"><b>' + (here ? 'Ви на місці' : target ? 'До точки' : 'Сигнал є') + '</b>' +
    '<span>' + acc + '</span></div>' +
    (m != null ? '<span class="dist">' + (m >= 1000 ? (m / 1000).toFixed(1) + ' км' : m + ' м') + '</span>' : '') +
    '</div>';
}

/* Банер тривоги. Реального API немає без токена, тому стан демонстраційний
   і підписаний як демонстраційний. Місце під fetch залишено в Alarms.load(). */
const Alarms = {
  state: { active: false, at: Date.now() },
  async load() {
    if (!CONFIG.alarmApi) return;
    try {
      const r = await fetch(CONFIG.alarmApi);
      const j = await r.json();
      this.state = { active: !!(j && j.active), at: Date.now() };
      render();
    } catch (e) { /* лишаємо попередній стан */ }
  },
  banner() {
    const a = this.state;
    return '<div class="alert"><b>Повітряна тривога у Львівській обл.: ' +
      (a.active ? 'Є. Прямуйте в укриття.' : 'немає.') + '</b><br>' +
      'Станом на ' + stamp(a.at) + '. ' +
      (CONFIG.alarmApi ? 'Джерело: офіційне API тривог.'
        : 'Демо-стан: у робочій версії — офіційне API тривог за токеном.') + '</div>';
  }
};

/* ═════════ ЕКРАНИ ═════════ */
/* ── Головний екран ──────────────────────────────────────────────────
   Карта на весь екран, поверх неї стійка нижня шторка. Патерн узятий
   з застосунків, де карта і є продуктом: у стані спокою вона займає
   70% висоти, шторка визирає рівно настільки, щоб було видно, що там
   список і його можна витягти.                                      */

/* Три положення шторки, часткою висоти екрана. Не вільна висота:
   зі снапами палець потрапляє туди, куди цілився. */
const SNAPS = [0.30, 0.62, 0.92];

/* Звідки міряємо відстані. Є сигнал — від вас; немає — від бази,
   і на екрані так і написано, щоб число не вводило в оману. */
const distFrom = () => Geo.pos || P('rynok');

/* Відстань до маршруту — до найближчої його точки, а не до першої:
   маршрут може починатись далеко, а проходити поруч. */
/* «Популярність» маршруту — середня популярність його точок.
   Раніше тут стояло сортування за розміром, що просто вигадувало
   порядок із нічого. */
const routePop = r => {
  const ids = flat(r);
  return ids.reduce((a, id) => a + P(id).pop, 0) / (ids.length || 1);
};

function routeNear(r, from) {
  return flat(r).reduce((best, id) => {
    const km = dist(from, P(id));
    return km < best.km ? { km, id } : best;
  }, { km: Infinity, id: null });
}
const routeDist = (r, from) => routeNear(r, from).km;

function distTag(km) {
  return '<span class="dnum">' + (km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)) +
    '<span>км</span></span>';
}

function placeCard(p, from) {
  const my = S.ratings[p.id];
  const shown = my ? my.stars : p.rate;
  const vis = S.visits[p.id];
  return '<div class="card" data-open="' + p.id + '">' +
    '<div class="between"><h3>' + esc(p.n) + '</h3>' + distTag(dist(from, p)) + '</div>' +
    '<p class="lede" style="margin:7px 0 9px">' + esc(p.s) + '</p>' +
    '<div class="between"><div class="row">' + stars(Math.round(shown), 'sm') +
    '<span class="meta">' + shown.toFixed(1) + (my ? ' · ваша' : '') + '</span></div>' +
    '<span class="row" style="gap:5px">' + stTag(p) + '</span></div>' +
    (vis ? '<div style="margin-top:10px"><span class="stamp' + (vis.by === 'manual' ? ' manual' : '') +
      '">Відвідано · ' + stamp(vis.at) + '</span></div>' : '') +
    '</div>';
}

function routeCard(r, from) {
  const s = routeStats(r), fin = S.done.indexOf(r.id) > -1;
  const near = routeNear(r, from);
  return '<div class="card" data-route="' + r.id + '">' +
    '<div class="between"><h3>' + esc(r.n) + '</h3>' + distTag(near.km) + '</div>' +
    '<p class="lede" style="margin:7px 0 9px">' + esc(r.why) + '</p>' +
    '<div class="row" style="gap:8px;flex-wrap:wrap">' +
    '<span class="tag size">' + SIZES[r.size].d + '</span>' +
    '<span class="meta">' + s.stops + ' зупинок · ' + s.km + ' км</span>' +
    (fin ? '<span class="tag ok">пройдено</span>' : '') + '</div>' +
    /* Саме число «4 км до маршруту» без назви нічого не пояснює,
       а на кількох маршрутах через ту саму точку ще й однакове. */
    (near.id ? '<p class="meta" style="margin:8px 0 0">найближча точка · ' +
      esc(P(near.id).n) + '</p>' : '') + '</div>';
}

/* Пошук за назвою. Порівнюємо в нижньому регістрі й без апострофів:
   «пам'ятка» на телефоні набирається трьома різними символами, і всі
   троє мусять знаходити те саме. */
/* Символи задані кодами навмисно: сирі лапка й апостроф усередині
   регулярного виразу збивають з пантелику простий аналізатор
   у check.mjs, і той починає бачити код там, де рядок. */
const norm = s => String(s).toLowerCase().replace(/[\u2019\u02bc\u0027\u0060]/g, '');
const hits = p => !V.q.trim() || norm(p.n).includes(norm(V.q.trim()));

function mapModel() {
  const from = distFrom();
  const live = Geo.state === 'live' && !!Geo.pos;
  const near = V.sort !== 'pop';

  const places = (V.theme === 'all' ? POINTS : POINTS.filter(p => p.t.indexOf(V.theme) > -1))
    .filter(hits)
    .slice().sort((a, b) => near
      ? dist(from, a) - dist(from, b)
      /* Правило 2 доведене до інтерфейсу: у «найпопулярніших»
         рекомендовані йдуть першими. У «найближчих» порядок задає
         відстань — підміняти її означало б брехати про дорогу. */
      : (recommended(b) - recommended(a)) || (b.pop - a.pop));

  const routes = ROUTES.filter(r => V.theme === 'all' ||
      flat(r).some(id => P(id).t.indexOf(V.theme) > -1))
    /* За рівної відстані попереду коротший маршрут: із однієї точки
       логічніше запропонувати одноденний, ніж чотириденний. */
    .slice().sort((a, b) => near
      ? (routeDist(a, from) - routeDist(b, from)) || (routeStats(a).km - routeStats(b).km)
      : routePop(b) - routePop(a));

  /* Шукають точки, тож на час пошуку вкладка маршрутів відступає. */
  const tab = (V.q.trim() || V.mapTab !== 'routes') ? 'places' : 'routes';
  const notRec = !near ? places.filter(p => !recommended(p)) : [];
  return { from, live, near, places, routes, tab, notRec };
}

const mapListHTML = m => {
  if (m.tab === 'routes') return m.routes.map(r => routeCard(r, m.from)).join('');
  if (m.places.length) return m.places.map(p => placeCard(p, m.from)).join('');
  return '<p class="lede" style="margin:10px 2px">' + (V.q.trim()
    ? 'За запитом «' + esc(V.q.trim()) + '» нічого не знайшли' +
      (V.theme !== 'all' ? '. Можливо, заважає увімкнений фільтр теми.' : '.')
    : 'Немає точок за цим фільтром.') + '</p>';
};

/* Відстані в списку живі, але перемальовувати весь екран на кожен фікс
   GPS означало б перебудовувати карту і скидати шторку. Тому міняємо
   тільки те, що залежить від позиції. */
function refreshMapList() {
  const el = document.getElementById('mlist');
  if (!el || V.screen !== 'map') return;
  const m = mapModel();
  el.innerHTML = mapListHTML(m);
  const head = document.querySelector('.mhead');
  if (head) head.innerHTML = mapHead(m);
}

/* Шапка шторки будується окремо, бо її треба перемальовувати разом
   зі списком: під час пошуку міняються і лічильники, і те, яка
   вкладка підсвічена. Раніше оновлювався тільки список, і шторка
   показувала «Маршрути · 9» над списком знайдених місць. */
function mapHead(m) {
  const dk = (V.road || V.tiles === 'dark') ? 'd' : 'l';
  /* Легенда: колір без підпису — значення, доступне тільки тим, хто
     його бачить. Під фільтром теми вона стискається в один рядок,
     бо кольори там уже не про типи. */
  const legend = V.theme !== 'all' && THEME_COLOR[V.theme]
    ? '<div class="legend"><span style="--c:' + THEME_COLOR[V.theme][dk] + '"><i></i>' +
      esc(THEMES[V.theme]) + '</span></div>'
    : '<div class="legend">' + Object.keys(KIND_COLOR).map(k =>
        '<span style="--c:' + KIND_COLOR[k][dk] + '"><i></i>' +
        esc(KIND_COLOR[k].n) + '</span>').join('') + '</div>';

  return legend +
    '<div class="mtabs" role="group" aria-label="Що показувати">' +
    '<button aria-pressed="' + (m.tab === 'places') + '" data-tab="places">Місця · ' +
    m.places.length + '</button>' +
    '<button aria-pressed="' + (m.tab === 'routes') + '" data-tab="routes">Маршрути · ' +
    m.routes.length + '</button></div>' +
    '<div class="between"><span class="eyebrow">' +
    (m.near ? (m.live ? 'від вас' : 'від Львова') : 'найпопулярніші') + '</span>' +
    '<button class="btn-sm" data-act="sort">' +
    (m.near ? 'Найближчі' : 'Найпопулярніші') + ' ⇅</button></div>' +
    (m.near && !m.live
      ? '<p class="meta" id="nosignal" style="margin:8px 0 0;line-height:1.45">Сигналу ще немає, ' +
        'тому відстані рахуються від Львова. З\u2019явиться — перерахуються.</p>'
      : '') +
    (m.notRec.length ? '<p class="meta" style="margin:8px 0 0;line-height:1.45">' +
      pts(m.notRec.length) + ' нижче рекомендованих: ' + recWhy(m.notRec) + '.</p>' : '');
}

function scrMap() {
  const m = mapModel();
  const { from, live, near, places, routes, tab, notRec } = m;
  MOUNT = { points: places, full: true };

  return '<div class="mapview">' +
    '<div id="lmap" class="lmap"></div>' +
    '<div class="over">' + (V.swUpdate ? updBanner() : '') + Alarms.banner() +
    '<div class="chips" role="group" aria-label="Тема">' +
    '<button class="chip" aria-pressed="' + (V.theme === 'all') + '" data-theme="all">Усі теми</button>' +
    Object.keys(THEMES).map(k => '<button class="chip" aria-pressed="' + (V.theme === k) +
      '" data-theme="' + k + '">' + THEMES[k] + '</button>').join('') + '</div></div>' +
    '<button class="locme" id="locme" data-act="locme" aria-pressed="' + live + '" ' +
    'aria-label="Показати моє місце"><svg viewBox="0 0 24 24">' +
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg></button>' +
    '<div class="msheet" id="msheet">' +
    '<div class="mgrab" data-act="grab" role="button" tabindex="0" ' +
    'aria-label="Перетягніть, щоб розгорнути список"><i></i></div>' +
    '<div class="mhead">' + mapHead(m) + '</div>' +
    '<div class="mlist" id="mlist">' +
    mapListHTML(m) + '</div></div></div>';
}

function scrRoutes() {
  let list = ROUTES.filter(r => V.size === 'all' || r.size === V.size);
  if (V.theme !== 'all') list = list.filter(r => flat(r).some(id => P(id).t.indexOf(V.theme) > -1));
  return '<div><div class="chips" role="group" aria-label="Довжина маршруту">' +
    '<button class="chip" aria-pressed="' + (V.size === 'all') + '" data-size="all">Усі</button>' +
    Object.keys(SIZES).map(k => '<button class="chip" aria-pressed="' + (V.size === k) +
      '" data-size="' + k + '">' + SIZES[k].n + ' · ' + SIZES[k].d + '</button>').join('') + '</div>' +
    '<p class="lede" style="margin:12px 0 14px">Маршрути будуються від Львова. Багатоденні розбиті ' +
    'на дні з поверненням до бази щовечора.</p>' +
    (list.map(r => {
      const s = routeStats(r), fin = S.done.indexOf(r.id) > -1;
      return '<div class="card" data-route="' + r.id + '">' +
        '<div class="between"><h3>' + esc(r.n) + '</h3><span class="tag size">' + SIZES[r.size].d + '</span></div>' +
        '<p class="lede" style="margin:7px 0 10px">' + esc(r.why) + '</p>' +
        '<div class="row" style="gap:13px;flex-wrap:wrap">' +
        '<span class="meta">' + s.stops + ' точок</span>' +
        '<span class="meta">' + s.km + ' км</span>' +
        '<span class="meta">' + hhmm(s.min) + '</span>' +
        (fin ? '<span class="tag ok">пройдено</span>'
          : s.blocked.length ? '<span class="tag stop">' + s.blocked.length + ' недоступні</span>'
            : s.warn ? '<span class="tag warn">є обмеження</span>' : '') +
        (S.offline.indexOf(r.id) > -1 ? '<span class="tag">офлайн</span>' : '') +
        '</div></div>';
    }).join('') || '<p class="lede">За цим фільтром маршрутів немає.</p>') + '</div>';
}

function scrRoute() {
  const r = ROUTES.find(x => x.id === V.route), s = routeStats(r);
  /* Правила 2 і 3: у трек не потрапляють ні закриті точки, ні ті,
     чия перевірка статусу протухла — routable() перевіряє обидва. */
  MOUNT = {
    points: flat(r).map(P),
    legs: planDays(r).map(d => [P(r.from)].concat(d.filter(id => routable(P(id))).map(P), [P(r.from)]))
  };
  const off = S.offline.indexOf(r.id) > -1;

  return '<div><div id="lmap" class="lmap tall"></div>' + mapBar() +
    (s.blocked.length ? '<div class="alert" style="margin-top:12px"><b>Обійдено ' +
      s.blocked.length + ' ' + plural(s.blocked.length, 'точку', 'точки', 'точок') +
      '.</b><br>Трек прокладено без них: ' + blockedWhy(s.blocked) + '.</div>' : '') +
    (s.stale.length ? '<div class="alert" style="margin-top:12px">Перевірка статусу застаріла: ' +
      pts(s.stale.length) + '. Точки лишилися в маршруті, але доступність варто ' +
      'уточнити перед виїздом.</div>' : '') +
    '<div class="grid3" style="margin:14px 0">' +
    '<div class="stat"><b>' + s.km + '</b><span>кілометрів</span></div>' +
    '<div class="stat"><b>' + s.days + '</b><span>' + (s.days === 1 ? 'день' : 'дні') + '</span></div>' +
    '<div class="stat"><b>' + s.stops + '</b><span>зупинок</span></div></div>' +
    '<span class="eyebrow">Що поруч на маршруті</span>' +
    '<div class="row" style="gap:16px;margin:8px 0 4px">' +
    '<span class="meta">' + s.near.shop + ' магазинів</span>' +
    '<span class="meta">' + s.near.stay + ' ночівель</span>' +
    '<span class="meta">' + s.near.food + ' закладів їжі</span></div>' +
    planDays(r).map((d, di) => '<div class="dayhead"><b>День ' + (di + 1) + '</b><span class="meta">' +
      dayKm(r, d) + ' км · ' + d.length + ' зупинок</span></div><ul class="stops">' +
      d.map((id, i) => {
        const p = P(id);
        return '<li><div class="dotcol"><span class="dot ' + (S.visits[id] ? 'done' : '') + '"></span>' +
          (i < d.length - 1 ? '<span class="stem"></span>' : '') + '</div>' +
          '<div style="flex:1"><div class="between"><b style="font-size:13.5px">' + esc(p.n) + '</b>' +
          '<span class="row" style="gap:5px">' + stTag(p) + '</span></div>' +
          '<p class="lede" style="margin:4px 0 0;font-size:12.5px">' + esc(p.note) + '</p></div></li>';
      }).join('') + '</ul>').join('') +
    '<div class="rule"></div>' +
    '<button class="btn ghost" style="margin-bottom:10px" data-act="offline"' + (off ? ' disabled' : '') + '>' +
    (off ? 'Завантажено · доступно офлайн' : 'Завантажити для офлайну') + '</button>' +
    '<div class="prog" id="prog" hidden><i></i></div>' +
    '<button class="btn go" style="margin-top:10px" data-act="start">В подорож</button>' +
    '<p class="meta" style="text-align:center;margin:10px 0 0">Статуси точок перевірено ' +
    dmy(flat(r).map(id => P(id).upd).sort()[0]) + '</p></div>';
}

/* Точка, до якої зараз їдемо. Одна на весь застосунок, щоб карта,
   плашка й перерахунок треку не розходились між собою. */
function navTarget() {
  if (V.screen !== 'journey' || !V.route) return null;
  const r = ROUTES.find(x => x.id === V.route);
  if (!r) return null;
  const st = flat(r);
  return st[V.idx] ? P(st[V.idx]) : null;
}

/* Звідки веде трек до поточної точки: від вас, якщо подорож щойно
   почалась і GPS дав фікс, інакше від попередньої зупинки або бази. */
function legOrigin(r, st) {
  const d = dayOf(r, V.idx);
  if (V.idx !== dayStart(r, d)) return P(st[V.idx - 1]);
  if (Geo.pos && V.plan && V.plan.byGps && d === 0) return Geo.pos;
  return P(r.from);
}

/* Решта дня від поточної точки — і саме її ми малюємо треком,
   а не весь маршрут: позаду вже проїхане. */
function restOfDay(r) {
  const d = dayOf(r, V.idx);
  const day = planDays(r)[d];
  const from = V.idx - dayStart(r, d);
  return day.slice(from).filter(id => routable(P(id))).map(P);
}

function scrJourney() {
  const r = ROUTES.find(x => x.id === V.route), st = flat(r), cur = P(st[V.idx]);
  const d = dayOf(r, V.idx);
  const origin = legOrigin(r, st);
  const rest = restOfDay(r);
  const chain = [origin].concat(rest, [P(r.from)]);

  MOUNT = {
    points: st.map(P),
    legs: [chain],
    now: cur.id,
    nav: V.road,
    toNext: Geo.metersTo(cur)
  };
  return V.road ? roadView(r, st, cur, d, chain) : cardView(r, st, cur, d, origin);
}

/* ── Дорожній режим ─────────────────────────────────────────────────
   Повний екран, карта їде за вами, зайве прибрано. Це супровід,
   а не навігатор: обʼїздів, трафіку й голосу тут немає і не буде —
   для них є кнопка передачі в Google Maps або Waze.              */
function roadView(r, st, cur, d, chain) {
  const m = Geo.metersTo(cur);
  const brg = Geo.pos ? Math.round(bearing(Geo.pos, cur)) : 0;
  const next = st[V.idx + 1] ? P(st[V.idx + 1]) : null;
  const left = chain.slice(1).reduce((a, p, i) => a + dist(chain[i], p), 0);
  const mins = Math.round(left / CONFIG.avgSpeedKmh * 60) + restOfDay(r).length * CONFIG.minutesPerStop;

  return '<div class="roadv">' +
    '<div class="rtop">' +
    '<span class="rarrow"><svg id="rarrow" viewBox="0 0 24 24" ' +
    'style="transform:rotate(' + brg + 'deg)"><path d="M12 20V4M12 4l-6 6M12 4l6 6"/></svg></span>' +
    '<span class="rhead"><span class="rdist" id="rdist">' + fmtM(m) + '</span>' +
    '<span class="rname">' + esc(cur.n) + '</span></span>' +
    '<button class="rclose" data-act="road-off" aria-label="Вийти з дорожнього режиму">' +
    '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>' +
    '<div class="rnext' + (Geo.state === 'live' ? '' : ' rwarn') + '" id="rnext">' +
    (Geo.state === 'live'
      ? (next ? 'далі <b>' + esc(next.n) + '</b>' : 'остання зупинка дня')
      : 'сигналу немає <b>карта не веде без геолокації</b>') + '</div>' +
    '<div id="lmap" class="lmap"></div>' +
    '<div class="rbot">' +
    '<button class="rbtn round' + (V.follow ? ' solid' : '') + '" id="rfollow" data-act="follow" ' +
    'aria-pressed="' + V.follow + '" aria-label="Слідувати за мною">' +
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>' +
    '</button>' +
    '<span class="reta"><b id="reta">' + hhmm(mins) + '</b>' +
    '<span>' + Math.round(left) + ' км до кінця дня</span></span>' +
    '<button class="rbtn round" data-act="extnav" aria-label="Вести в навігаторі">' +
    '<svg viewBox="0 0 24 24"><path d="M12 2l9 20-9-5-9 5z"/></svg></button>' +
    '<button class="rbtn" data-act="overview">Огляд</button></div></div>';
}
/* ── Карткова подорож: те саме, але для читання, а не для керма ── */
function cardView(r, st, cur, d, origin) {
  const km = Math.round(dist(origin, cur));
  const here = Geo.atPoint(cur);
  const live = Geo.state === 'live';
  const fromMe = origin === Geo.pos;
  /* «Перебудовано» пишемо тільки тоді, коли порядок справді змінився.
     Для кільця з поверненням до бази авторський обхід часто вже
     найкоротший — і сказати «перебудовано» означало б приписати собі
     роботу, якої не було. */
  const shuffled = V.plan && !V.plan.ord && V.plan.byGps &&
    planDays(r).some((day, i) => day.join() !== r.days[i].join());

  /* «з» у верхньому регістрі моношрифтом не відрізнити від трійки,
     тому в підписах-eyebrow дроби пишемо скісною рискою. */
  return '<div><div id="lmap" class="lmap"></div>' + mapBar() +
    '<div style="margin-top:12px">' + geoBar(cur) + '</div>' +
    '<div class="card"><span class="eyebrow">День ' + (d + 1) + ' / ' + planDays(r).length +
    ' · зупинка ' + (V.idx + 1) + ' / ' + st.length + '</span>' +
    '<h2 style="font-size:19px;margin:8px 0 6px">' + esc(cur.n) + '</h2>' +
    '<div class="row" style="gap:14px;flex-wrap:wrap"><span class="meta">' +
    (fromMe ? 'від вас' : esc(origin.n.split(',')[0])) + ' → ' + km + ' км</span>' +
    '<span class="meta">~' + Math.round(km / CONFIG.avgSpeedKmh * 60) + ' хв</span>' +
    stTag(cur) + '</div>' +
    '<p class="meta" style="margin:9px 0 0;line-height:1.45">' +
    (V.plan && V.plan.ord
      ? 'Порядок точок цього маршруту сюжетний і не переставляється.'
      : shuffled
        ? 'Порядок точок дня перебудовано під ваше положення на старті.'
        : V.plan && V.plan.byGps
          ? 'Порядок дня звірено з вашим положенням — авторський виявився найкоротшим.'
          : 'Старт від бази: без геолокації переставляти порядок нема від чого.') +
    '</p></div>' +
    '<button class="btn go" data-act="road-on">У дорогу</button>' +
    '<button class="btn ghost" style="margin-top:8px" data-act="extnav">Вести в навігаторі</button>' +
    '<div class="rule"></div>' +
    (here
      ? '<button class="btn go" data-act="arrive-gps">Відкрити пам’ятку</button>'
      : live
        ? '<div class="locked"><span style="font-size:19px;opacity:.45">◎</span><div>' +
          '<b style="font-size:12.5px">Картка відкриється в радіусі ' + ARRIVE_RADIUS_M + ' м</b>' +
          '<p class="meta" style="margin:3px 0 0">Підійдіть до точки — далі автоматично</p></div></div>' +
          '<button class="btn ghost" style="margin-top:10px" data-act="arrive-manual">' +
          'Підтвердити вручну</button>'
        : '<button class="btn go" data-act="arrive-manual">Я на місці</button>') +
    '<button class="btn ghost" style="margin-top:8px" data-act="abort">Перервати подорож</button></div>';
}

function scrPoint() {
  const p = P(V.sel);
  const vis = S.visits[p.id];
  const my = S.ratings[p.id];
  const r = V.route ? ROUTES.find(x => x.id === V.route) : null;
  const inJ = !!r && V.from === 'journey' && flat(r)[V.idx] === p.id;

  return '<div><div class="plate">' + (V.media === 'photo' ? photoSVG(p) : reconSVG()) +
    '<div class="switch">' +
    '<button aria-pressed="' + (V.media === 'photo') + '" data-media="photo">Фото сьогодні</button>' +
    '<button aria-pressed="' + (V.media === 'recon') + '" data-media="recon">Реконструкція</button></div></div>' +
    '<div class="between" style="margin:14px 0 8px"><h2 style="font-size:19px">' + esc(p.n) + '</h2>' +
    '<span class="row" style="gap:5px">' + stTag(p) + '</span></div>' +
    '<div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
    p.t.map(t => '<span class="tag">' + THEMES[t] + '</span>').join('') + '</div>' +
    '<p class="lede" id="desc">' + esc(p.s) + '</p>' +
    '<button class="btn-sm" style="margin-top:8px" id="more" data-act="expand">Читати повністю</button>' +
    '<div class="alert" style="margin-top:14px">' + esc(p.note) + '</div>' +
    (vis ? '<div style="margin:16px 0"><span class="stamp' + (vis.by === 'manual' ? ' manual' : '') +
      '">Відвідано · ' + stamp(vis.at) + ' · ' +
      (vis.by === 'gps' ? 'GPS' : 'вручну') + '</span></div>' : '') +
    '<div class="rule"></div><span class="eyebrow">Оцінка пам’ятки</span>' +
    '<div class="row" style="margin:9px 0 12px">' + stars(Math.round(p.rate), 'sm') +
    '<span class="meta">' + p.rate.toFixed(1) + ' · ' + p.cnt + ' оцінок</span></div>' +
    ratingBlock(p, vis, my) +
    '<div class="locked" style="margin-top:12px"><span style="font-size:19px;opacity:.4">♪</span>' +
    '<div><b style="font-size:12.5px">Аудіорозповідь, 14 хв</b>' +
    '<p class="meta" style="margin:3px 0 0">Доступно у платній версії</p></div></div>' +
    '<div class="rule"></div><div class="between"><span class="meta">Статус перевірено ' + dmy(p.upd) + '</span>' +
    '<button class="btn-sm" data-act="report">Повідомити про проблему</button></div>' +
    (inJ ? '<button class="btn go" style="margin-top:16px" data-act="continue">Продовжити подорож</button>'
      : '<button class="btn ghost" style="margin-top:16px" data-act="back-map">Назад до карти</button>') +
    '</div>';
}

/* ── Правило 1 зі спеки, доведене до інтерфейсу ─────────────────────
   Без підтвердженої відвідини блок оцінки закритий, а не просто
   підписаний текстом «оцінку можна залишити лише з місця».         */
function ratingBlock(p, vis, my) {
  if (!vis) {
    const m = Geo.metersTo(p);
    const hint = m == null
      ? 'Увімкніть геолокацію або підтвердіть відвідини на маршруті.'
      : m <= ARRIVE_RADIUS_M
        ? 'Ви в радіусі точки — відвідини зараховуються на екрані подорожі.'
        : 'До точки ' + (m >= 1000 ? (m / 1000).toFixed(1) + ' км' : m + ' м') + '.';
    return '<div class="gate"><div class="row"><span class="lock">' +
      '<svg width="15" height="15" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/>' +
      '<path d="M8 10V7a4 4 0 018 0v3"/></svg></span>' +
      '<div><b>Оцінка відкриється на місці</b>' +
      '<p class="meta" style="margin:3px 0 0;line-height:1.45">' + hint + '</p></div></div>' +
      '<div style="margin:12px 0 0;opacity:.5">' + stars(0, 'off') + '</div>' +
      '<p class="meta" style="margin:9px 0 0;line-height:1.45">Так рейтинг лишається чесним: ' +
      'оцінити пам’ятку може лише той, хто до неї доїхав.</p></div>';
  }
  return '<div class="card" style="background:rgba(46,125,108,.05)">' +
    '<span class="eyebrow">' + (my ? 'Ваша оцінка' : 'Оцініть від 1 до 5') + '</span>' +
    '<div style="margin:9px 0 11px">' + starPicker(V.draftStars || (my ? my.stars : 0)) + '</div>' +
    '<textarea class="field" id="rev" rows="2" ' +
    'placeholder="Кілька слів для інших мандрівників — не обов’язково">' +
    esc(my ? my.text : '') + '</textarea>' +
    '<button class="btn-sm" style="margin-top:9px;width:100%" data-act="review"' +
    (!(V.draftStars || my) ? ' disabled' : '') + '>' +
    (my ? 'Оновити відгук' : 'Залишити відгук') + '</button>' +
    '<p class="meta" style="margin:9px 0 0">Відвідини підтверджені ' +
    (vis.by === 'gps' ? 'по GPS' : 'вручну') + ' — оцінка зарахується.</p></div>';
}

function scrFinish() {
  const r = ROUTES.find(x => x.id === V.route), s = routeStats(r);
  const mins = Math.max(1, Math.round((Date.now() - V.t0) / 60000));
  const freshB = V.fresh || [];
  MOUNT = {
    points: flat(r).map(P),
    legs: planDays(r).map(d => [P(r.from)].concat(d.filter(id => routable(P(id))).map(P), [P(r.from)]))
  };
  return '<div style="text-align:center">' +
    '<div style="font-size:34px;margin:10px 0 4px;color:var(--verd-dk)">◆</div>' +
    '<h2 style="font-size:22px">Вітаємо, ви завершили подорож</h2>' +
    '<p class="lede" style="margin:8px 0 14px">' + esc(r.n) + ' · ' + SIZES[r.size].d + '</p>' +
    '<div id="lmap" class="lmap"></div>' +
    '<div class="grid3" style="margin:14px 0">' +
    '<div class="stat"><b>' + s.stops + '</b><span>точок</span></div>' +
    '<div class="stat"><b>' + s.km + '</b><span>км треку</span></div>' +
    '<div class="stat"><b>' + hhmm(mins) + '</b><span>у подорожі</span></div></div>' +
    (freshB.length ? '<span class="eyebrow">Нові нагороди</span><div class="grid3" style="margin:9px 0 16px">' +
      freshB.map(id => {
        const b = BADGES.find(x => x.id === id);
        return '<div class="badge got"><div class="g">' + b.g + '</div><div class="n">' + b.n + '</div></div>';
      }).join('') + '</div>' : '') +
    '<button class="btn" data-act="to-profile">До мандрівного листа</button>' +
    '<button class="btn ghost" style="margin-top:8px" data-act="to-routes">Обрати новий маршрут</button></div>';
}

function scrProfile() {
  const vis = Object.keys(S.visits).map(k => [k, S.visits[k]]).sort((a, b) => b[1].at - a[1].at);
  const rated = Object.keys(S.ratings).length;
  const byGps = vis.filter(v => v[1].by === 'gps').length;
  const stale = POINTS.filter(p => !fresh(p) && !expired(p)).length;
  const gone = POINTS.filter(p => expired(p)).length;
  const oldest = POINTS.map(p => p.upd).sort()[0];

  return '<div><div class="grid3" style="margin-bottom:16px">' +
    '<div class="stat"><b>' + vis.length + ' / ' + POINTS.length + '</b><span>точок</span></div>' +
    '<div class="stat"><b>' + S.done.length + '</b><span>маршрутів</span></div>' +
    '<div class="stat"><b>' + rated + '</b><span>оцінок</span></div></div>' +
    '<span class="eyebrow">Нагороди · ' + S.badges.length + ' / 50</span>' +
    '<p class="meta" style="margin:5px 0 10px">У цій версії реалізовано ' + BADGES.length + '</p>' +
    '<div class="grid3" style="margin-bottom:18px">' + BADGES.map(b =>
      '<div class="badge ' + (S.badges.indexOf(b.id) > -1 ? 'got' : '') + '">' +
      '<div class="g">' + b.g + '</div><div class="n">' + b.n + '</div>' +
      '<div class="d">' + b.d + '</div></div>').join('') + '</div>' +
    '<span class="eyebrow">Штампи відвідин</span>' +
    (vis.length
      ? '<p class="meta" style="margin:5px 0 0">' + byGps + ' підтверджено по GPS, ' +
        (vis.length - byGps) + ' вручну</p><div style="margin-top:10px">' +
        vis.map(v => {
          const p = P(v[0]), my = S.ratings[v[0]];
          return '<div class="card" data-open="' + v[0] + '"><div class="between">' +
            '<b style="font-size:13.5px">' + esc(p.n) + '</b>' +
            (my ? '<div class="row">' + stars(my.stars, 'sm') + '</div>'
              : '<span class="meta">без оцінки</span>') + '</div>' +
            '<div style="margin-top:9px"><span class="stamp' + (v[1].by === 'manual' ? ' manual' : '') +
            '">' + stamp(v[1].at) + ' · ' + (v[1].by === 'gps' ? 'GPS' : 'вручну') + '</span></div>' +
            (my && my.text ? '<p class="lede" style="margin:9px 0 0;font-size:12.5px">«' +
              esc(my.text) + '»</p>' : '') + '</div>';
        }).join('') + '</div>'
      : '<p class="lede" style="margin-top:8px">Порожньо. Оберіть маршрут — і перший штамп ' +
        'з’явиться тут.</p>') +
    '<div class="rule"></div><span class="eyebrow">Стан даних</span>' +
    '<div class="card" style="margin-top:9px"><div class="between"><span class="meta">' +
    'Свіжих перевірок статусу</span><b style="font-size:13.5px">' + (POINTS.length - stale - gone) +
    ' / ' + POINTS.length + '</b></div>' +
    (stale || gone ? '<p class="meta" style="margin:7px 0 0;line-height:1.45">' +
      (stale ? 'Застарілих — ' + stale + (gone ? ', ' : '. ') : '') +
      (gone ? 'протухлих — ' + gone + '. ' : '') +
      'Протухлі не потрапляють ні в рекомендовані, ні в трек маршруту.</p>' : '') +
    '<p class="meta" style="margin:7px 0 0;line-height:1.45">Найдавніша перевірка — ' + dmy(oldest) +
    '. Свіжою вважається молодша за ' + STATUS_FRESH_DAYS + ' днів, ' +
    'протухлою — старша за ' + STATUS_STALE_DAYS + '.</p>' +
    '<p class="meta" style="margin:5px 0 0">Прогрес: ' +
    (Store.kind === 'local' ? 'зберігається на пристрої' : 'лише в пам’яті сесії') + '</p></div>' +
    '<button class="btn-sm" style="width:100%;margin-top:10px" data-act="reset">Очистити прогрес</button></div>';
}

/* ═════════ ЗАГЛУШКИ ЗОБРАЖЕНЬ ═════════
   Реальні фото й реконструкції — найдорожча стаття проєкту
   (див. docs/spec.md, розділ 3). Поки тримаємо місце. */
function photoSVG(p) {
  return '<svg viewBox="0 0 400 230"><rect width="400" height="230" fill="#CFCEC2"/>' +
    '<path d="M0 175 L60 150 L120 168 L190 128 L260 158 L330 138 L400 162 L400 230 L0 230 Z" fill="#B8B7A9"/>' +
    '<rect x="150" y="88" width="100" height="80" fill="#A3A295"/>' +
    '<rect x="138" y="70" width="24" height="98" fill="#96958A"/>' +
    '<rect x="238" y="70" width="24" height="98" fill="#96958A"/>' +
    '<rect x="192" y="122" width="16" height="46" fill="#7E7D74"/>' +
    '<circle cx="322" cy="52" r="18" fill="#DEDDD1" opacity=".8"/>' +
    '<text x="200" y="212" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="10" ' +
    'fill="#5C5B52" letter-spacing="1.5">ФОТО · ' + esc(p.n.split(',')[0].toUpperCase()) + '</text></svg>';
}
function reconSVG() {
  return '<svg viewBox="0 0 400 230"><rect width="400" height="230" fill="#DDE3E0"/>' +
    '<g stroke="#2E7D6C" stroke-width="1" opacity=".28">' +
    [1, 2, 3, 4, 5, 6, 7].map(i => '<line x1="' + i * 50 + '" y1="0" x2="' + i * 50 + '" y2="230"/>').join('') +
    [1, 2, 3, 4].map(i => '<line x1="0" y1="' + i * 46 + '" x2="400" y2="' + i * 46 + '"/>').join('') + '</g>' +
    '<g fill="none" stroke="#1C5849" stroke-width="1.9" stroke-linejoin="round">' +
    '<path d="M138 168 L138 62 L162 62 L162 168"/><path d="M238 168 L238 62 L262 62 L262 168"/>' +
    '<path d="M162 88 L238 88 L238 168 L162 168 Z"/><path d="M132 62 L150 40 L168 62"/>' +
    '<path d="M232 62 L250 40 L268 62"/><path d="M162 88 L200 66 L238 88"/>' +
    '<path d="M192 122 L192 168 M208 122 L208 168 M192 122 Q200 112 208 122"/>' +
    '<path d="M60 172 L340 172" stroke-dasharray="6 4" opacity=".65"/></g>' +
    '<text x="200" y="206" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="10" ' +
    'fill="#1C5849" letter-spacing="1.5">РЕКОНСТРУКЦІЯ · ІМОВІРНИЙ ВИГЛЯД</text></svg>';
}

/* ═════════ ШТОРКИ І ТОСТИ ═════════
   Заміна alert()/confirm(): у WebView Android системні діалоги
   блокують потік, а в частині пісочниць не показуються зовсім. */
let TOAST_T = null;
function toast(title, text) {
  V.toast = { title, text };
  paintOverlays();
  clearTimeout(TOAST_T);
  TOAST_T = setTimeout(() => { V.toast = null; paintOverlays(); }, 3600);
}
function sheet(cfg) { V.sheet = cfg; paintOverlays(); }
function closeSheet() { V.sheet = null; paintOverlays(); }

function paintOverlays() {
  const host = document.getElementById('overlays');
  if (!host) return;
  let h = '';
  if (V.sheet) {
    const s = V.sheet;
    h += '<div class="scrim' + (s.center ? ' center' : '') + '" data-act="scrim">' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(s.title) + '">' +
      '<h3>' + esc(s.title) + '</h3>' +
      (s.text ? '<p class="lede" style="font-size:12.5px">' + esc(s.text) + '</p>' : '') +
      s.options.map((o, i) => '<button class="opt" data-sheet="' + i + '"><b>' + esc(o.label) + '</b>' +
        (o.hint ? '<span>' + esc(o.hint) + '</span>' : '') + '</button>').join('') +
      '<button class="btn ghost" style="margin-top:10px" data-act="sheet-close">' +
      esc(s.cancel || 'Закрити') + '</button></div></div>';
  }
  if (V.toast) {
    h += '<div class="toast" role="status"><b>' + esc(V.toast.title) + '</b>' +
      (V.toast.text ? '<br>' + esc(V.toast.text) : '') + '</div>';
  }
  host.innerHTML = h;
}

const updBanner = () => '<div class="upd"><span>Є нова версія застосунку.</span>' +
  '<button data-act="reload">Оновити</button></div>';

/* ═════════ ДІЇ ═════════ */
function go(screen) {
  V.screen = screen;
  render();
  const b = document.querySelector('.body');
  if (b) b.scrollTop = 0;
}

function openPoint(id, from) {
  V.sel = id;
  V.from = from || V.screen;
  V.media = 'photo';
  V.draftStars = 0;
  go('point');
}

function openRoute(id) { V.route = id; go('route'); }

function startJourney() {
  const r = ROUTES.find(x => x.id === V.route);
  V.idx = 0; V.t0 = Date.now(); V.fresh = [];
  V.road = false; V.follow = true;
  Geo.start();
  /* Плану вистачає того, що є зараз: без фікса стартуємо від бази,
     а щойно GPS відгукнеться — перебудуємо, поки нікуди не поїхали. */
  V.plan = buildPlan(r, Geo.pos || P(r.from), !!Geo.pos);
  go('journey');
}

/* Перебудова плану після появи сигналу. Тільки на нульовій зупинці
   й тільки поки в цій подорожі нічого не відвідано: переставляти
   порядок посеред дороги означало б водити людину колами. */
function replanFromGps() {
  if (!V.route || !Geo.pos || V.idx !== 0) return false;
  const r = ROUTES.find(x => x.id === V.route);
  if (!r || !V.plan || V.plan.byGps) return false;
  if (flat(r).some(id => S.visits[id] && S.visits[id].at >= V.t0)) return false;
  V.plan = buildPlan(r, Geo.pos, true);
  return true;
}

function roadMode(on) {
  V.road = on;
  V.follow = true;
  render();
}

/* Покрокові підказки — робота навігатора. Ми віддаємо йому точку
   й відходимо: трафік, обʼїзди й голос там уже зроблені як слід. */
function extNav() {
  const cur = navTarget();
  if (!cur) return;
  const ll = cur.lat.toFixed(5) + ',' + cur.lon.toFixed(5);
  sheet({
    title: 'Вести до точки',
    text: esc(cur.n) + '. Спадок веде оглядово; покрокові підказки, обʼїзди й голос — у навігаторі.',
    options: [
      { label: 'Google Maps', hint: 'маршрут авто' },
      { label: 'Waze', hint: 'трафік і камери' },
      { label: 'Скопіювати координати', hint: ll }
    ],
    onPick(_, i) {
      closeSheet();
      if (i === 2) {
        const done = () => toast('Координати скопійовано', ll);
        if (navigator.clipboard && navigator.clipboard.writeText)
          navigator.clipboard.writeText(ll).then(done, () => toast('Не вийшло скопіювати', ll));
        else toast('Координати точки', ll);
        return;
      }
      const url = i === 0
        ? 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + ll
        : 'https://waze.com/ul?navigate=yes&ll=' + ll;
      try { window.open(url, '_blank', 'noopener'); }
      catch (e) { toast('Не вдалося відкрити навігатор', ll); }
    }
  });
}

/* Показати весь залишок дня цілком. Слідування при цьому вимикається:
   інакше наступний фікс GPS одразу вкинув би камеру назад. */
function overview() {
  setFollow(false);
  if (LMAP && MOUNTBOUNDS) {
    try { LMAP.fitBounds(MOUNTBOUNDS.pad(.18)); } catch (e) {}
  }
}

/* Відхилення від треку. Перекладаємо не частіше ніж раз на 15 секунд
   і тільки коли справді відійшли — демо-сервер OSRM без гарантій,
   смикати його на кожен фікс не можна. */
function maybeReroute() {
  if (!V.road || !LMAP || !NAVLINE || !Geo.pos || NAVBUSY) return;
  if (!NAVFROM || distM(Geo.pos, NAVFROM) < 150) return;
  if (Date.now() - NAVAT < 15000) return;
  const r = ROUTES.find(x => x.id === V.route);
  if (!r) return;
  NAVBUSY = true; NAVAT = Date.now();
  const chain = [Geo.pos].concat(restOfDay(r), [P(r.from)]).map(LL);
  const line = NAVLINE, map = LMAP;
  roadRoute(chain).then(geo => {
    NAVBUSY = false;
    if (LMAP !== map || NAVLINE !== line) return;
    NAVFROM = { lat: Geo.pos.lat, lon: Geo.pos.lon };
    try { line.setLatLngs(geo || chain); line.setStyle({ dashArray: geo ? null : '10 8' }); } catch (e) {}
  }, () => { NAVBUSY = false; });
}

/* Реєстрація відвідин. verified_by — головне поле: від нього
   залежить, чи прийметься оцінка, і як виглядає штамп. */
function registerVisit(id, by) {
  if (!S.visits[id]) {
    S.visits[id] = { at: Date.now(), by, acc: Geo.pos ? Math.round(Geo.pos.acc || 0) : null };
    save();
    checkBadges();
  }
}

function arrive(by) {
  const r = ROUTES.find(x => x.id === V.route);
  const id = flat(r)[V.idx];
  if (by === 'gps' && !Geo.atPoint(P(id))) {
    toast('Ще не на місці', 'Підійдіть ближче або підтвердіть вручну.');
    return;
  }
  registerVisit(id, by);
  if (by === 'manual') toast('Відвідини зараховано вручну', 'Штамп позначено як ручне підтвердження.');
  /* Картку пам'ятки читають, а не ведуть по ній: з дорожнього режиму
     виходимо, але памʼятаємо, щоб повернути після «Продовжити». */
  V.roadBack = V.road; V.road = false;
  openPoint(id, 'journey');
}

function continueJourney() {
  const r = ROUTES.find(x => x.id === V.route);
  if (V.idx < flat(r).length - 1) {
    V.idx++;
    if (V.roadBack) { V.road = true; V.follow = true; V.roadBack = false; }
    go('journey');
  }
  else {
    if (S.done.indexOf(r.id) < 0) S.done.push(r.id);
    V.fresh = checkBadges();
    save();
    go('finish');
  }
}

function saveReview(id) {
  /* Гейт, а не підпис. Спека, правило 1. */
  const vis = S.visits[id];
  if (!vis) {
    toast('Оцінка недоступна', 'Спершу треба підтвердити відвідини цієї точки.');
    return;
  }
  const cur = S.ratings[id];
  const n = V.draftStars || (cur ? cur.stars : 0);
  if (!n) return;
  const t = document.getElementById('rev');
  S.ratings[id] = {
    stars: n,
    text: t && t.value.trim() ? t.value.trim() : '',
    at: Date.now(),
    by: vis.by
  };
  V.draftStars = 0;
  save();
  const gained = checkBadges();
  render();
  toast('Відгук збережено', gained.length ? 'Відкрито нагороду.' : '');
}

function report() {
  sheet({
    title: 'Що не так із точкою?',
    text: 'У робочій версії звернення йде в чергу модерації разом із вашою позицією й часом.',
    options: [
      { label: 'Закрито або змінився графік', hint: 'статус потребує перевірки' },
      { label: 'Небезпечно, пошкоджено', hint: 'найвищий приоритет модерації' },
      { label: 'Помилка в описі', hint: 'текст, дата, назва' },
      { label: 'Точки не існує', hint: 'координати або об’єкт зникли' }
    ],
    onPick: o => { closeSheet(); toast('Дякуємо', '«' + o.label + '» — прийнято в чергу модерації.'); }
  });
}

function resetProgress() {
  sheet({
    title: 'Очистити прогрес?',
    text: 'Зникнуть усі штампи відвідин, оцінки й нагороди. Це не можна відмінити.',
    center: true,
    options: [{ label: 'Так, очистити', hint: 'усі дані застосунку на цьому пристрої' }],
    cancel: 'Скасувати',
    onPick: () => {
      S = { v: 3, visits: {}, ratings: {}, done: [], badges: [], offline: [] };
      V.route = null; V.idx = 0; V.fresh = [];
      Store.clear(); save();
      closeSheet();
      go('profile');
      toast('Прогрес очищено', '');
    }
  });
}

function checkBadges() {
  const v = Object.keys(S.visits), gained = [];
  const add = id => { if (S.badges.indexOf(id) < 0) { S.badges.push(id); gained.push(id); } };
  if (v.length >= 1) add('first');
  if (v.length >= 5) add('five');
  if (['olesko', 'pidhirtsi', 'zolochiv'].every(x => v.indexOf(x) > -1)) add('horseshoe');
  if (v.filter(x => P(x).t.indexOf('ruin') > -1).length >= 3) add('ruin');
  if (Object.keys(S.ratings).length >= 5) add('critic');
  if (['potelych', 'drohobych'].every(x => v.indexOf(x) > -1)) add('unesco');
  if (S.done.length >= 1) add('route1');
  if (v.indexOf('tustan') > -1) add('rock');
  if (S.done.some(id => { const r = ROUTES.find(x => x.id === id); return r && r.size === 'l'; })) add('long');
  if (v.length >= POINTS.length) add('all');
  save();
  return gained;
}

/* ═════════ ОФЛАЙН ═════════
   Кнопка справді кешує: рахуємо плитки OSM для рамки маршруту
   на зумах CONFIG.offlineZoom і віддаємо список service worker'у. */
function lonToX(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function latToY(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
}

function tilesForRoute(r) {
  const pts = flat(r).map(P).concat([P(r.from)]);
  const pad = .06;
  const b = {
    y0: Math.min.apply(null, pts.map(p => p.lat)) - pad,
    y1: Math.max.apply(null, pts.map(p => p.lat)) + pad,
    x0: Math.min.apply(null, pts.map(p => p.lon)) - pad,
    x1: Math.max.apply(null, pts.map(p => p.lon)) + pad
  };
  const urls = [];
  for (let z = CONFIG.offlineZoom[0]; z <= CONFIG.offlineZoom[1]; z++) {
    const x0 = lonToX(b.x0, z), x1 = lonToX(b.x1, z);
    const y0 = latToY(b.y1, z), y1 = latToY(b.y0, z);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        urls.push('https://tile.openstreetmap.org/' + z + '/' + x + '/' + y + '.png');
        if (urls.length >= CONFIG.offlineTileCap) return urls;
      }
  }
  return urls;
}

async function downloadOffline() {
  const r = ROUTES.find(x => x.id === V.route);
  const btn = document.querySelector('[data-act="offline"]');
  const prog = document.getElementById('prog');
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
    toast('Офлайн недоступний', 'Service worker не активний — відкрийте застосунок ще раз.');
    return;
  }
  const urls = tilesForRoute(r);
  if (btn) { btn.disabled = true; btn.textContent = 'Завантажую 0 / ' + urls.length; }
  if (prog) prog.hidden = false;

  const done = await new Promise(res => {
    const ch = new MessageChannel();
    ch.port1.onmessage = e => {
      const d = e.data || {};
      if (d.type === 'progress') {
        if (btn) btn.textContent = 'Завантажую ' + d.done + ' / ' + d.total;
        const bar = prog && prog.firstElementChild;
        if (bar) bar.style.width = Math.round(d.done / d.total * 100) + '%';
      }
      if (d.type === 'done') res(d.cached);
    };
    navigator.serviceWorker.controller.postMessage(
      { type: 'cache-tiles', urls }, [ch.port2]);
    setTimeout(() => res(-1), 180000);
  });

  if (prog) prog.hidden = true;
  if (done === -1) {
    if (btn) { btn.disabled = false; btn.textContent = 'Завантажити для офлайну'; }
    toast('Завантаження затяглося', 'Спробуйте на кращому зв’язку.');
    return;
  }
  if (S.offline.indexOf(r.id) < 0) S.offline.push(r.id);
  save();
  render();
  toast('Маршрут доступний офлайн', done + ' плиток карти й усі тексти збережено на пристрої.');
}

/* ═════════ РЕНДЕР ═════════ */
const TITLES = {
  map: ['Спадок', 'України · MVP'],
  routes: ['Маршрути', 'короткі · середні · великі'],
  route: ['Маршрут', ''],
  journey: ['У дорозі', ''],
  point: ['Пам’ятка', ''],
  finish: ['Подорож завершено', ''],
  profile: ['Мандрівний лист', '']
};

const NAV = [
  ['map', 'Карта', 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z'],
  ['routes', 'Маршрути', 'M4 19h6a4 4 0 000-8H9a4 4 0 010-8h11'],
  ['journey', 'Подорож', 'M12 21s7-6.4 7-11a7 7 0 10-14 0c0 4.6 7 11 7 11z'],
  ['profile', 'Лист', 'M6 3h9l4 4v14H6z M9 12h7 M9 16h5']
];

function render() {
  const T = TITLES[V.screen];
  const back = {
    route: 'routes', journey: 'route',
    point: V.from === 'journey' ? 'journey' : V.from === 'profile' ? 'profile' : 'map',
    finish: null
  }[V.screen];

  /* Пошук живе на головному екрані: шукають те, що на карті.
     Розгорнутий, він займає місце заголовка — на 430 пікселях
     тулити поле поруч із назвою нема куди. */
  const searchable = V.screen === 'map';
  document.getElementById('bar').innerHTML =
    (back ? '<button class="back" data-back="' + back + '" aria-label="Назад">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button>' : '') +
    (searchable && V.searching
      ? '<input class="qfield" id="q" type="search" autocomplete="off" ' +
        'placeholder="Назва пам\u2019ятки" aria-label="Пошук пам\u2019яток за назвою" ' +
        'value="' + esc(V.q) + '">' +
        '<button class="barbtn" data-act="search-off" aria-label="Закрити пошук">' +
        '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'
      : '<div><h1>' + T[0] + '</h1>' +
        (T[1] ? '<div class="sub">' + T[1] + '</div>' : '') + '</div>' +
        (searchable
          ? '<button class="barbtn" data-act="search-on" aria-label="Пошук за назвою">' +
            '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4.2-4.2"/></svg>' +
            (V.q ? '<b></b>' : '') + '</button>'
          : ''));

  /* Дорожній режим існує тільки на екрані подорожі: пішов на інший
     екран — рамка, заголовок і навігація повертаються самі. */
  document.body.classList.toggle('road', !!V.road && V.screen === 'journey');
  document.body.classList.toggle('mapv', V.screen === 'map');
  /* Позначки й бульбашки скупчень мусять знати, темна під ними
     підкладка чи світла, — незалежно від того, звідки вона темна. */
  document.body.classList.toggle('darkmap',
    V.tiles === 'dark' || (!!V.road && V.screen === 'journey'));

  if (LMAP) { try { LMAP.remove(); } catch (e) {} LMAP = null; MEMARK = null; MEACC = null; }

  const screens = {
    map: scrMap, routes: scrRoutes, route: scrRoute, journey: scrJourney,
    point: scrPoint, finish: scrFinish, profile: scrProfile
  };
  document.getElementById('body').innerHTML = (screens[V.screen] || scrMap)();

  document.getElementById('nav').innerHTML = NAV.map(it => {
    const dis = it[0] === 'journey' && !V.route;
    return '<button aria-current="' + (V.screen === it[0]) + '"' +
      (dis ? ' disabled style="opacity:.35"' : ' data-nav="' + it[0] + '"') +
      '><svg width="17" height="17" viewBox="0 0 24 24"><path d="' + it[2] + '"/></svg>' +
      it[1] + '</button>';
  }).join('');

  paintOverlays();
  if (V.screen === 'map') bindSheet(); else SHEET = null;
  mountMap();
}

/* Одна делегована обробка кліків замість inline onclick —
   безпечніше з текстом даних і легше тестувати. */
function onTap(e) {
  const t = e.target.closest('[data-open],[data-route],[data-theme],[data-size],[data-tiles],' +
    '[data-star],[data-media],[data-nav],[data-back],[data-act],[data-sheet],[data-tab]');
  if (!t) return;
  const d = t.dataset;

  if (d.sheet != null && V.sheet) { V.sheet.onPick(V.sheet.options[+d.sheet], +d.sheet); return; }
  if (d.act === 'scrim') { if (e.target === t) closeSheet(); return; }
  if (d.act === 'sheet-close') { closeSheet(); return; }
  if (d.tab != null) { V.mapTab = d.tab; render(); return; }
  if (d.theme != null) { V.theme = d.theme; render(); return; }
  if (d.size != null) { V.size = d.size; render(); return; }
  if (d.tiles != null) { V.tiles = d.tiles; render(); return; }
  if (d.media != null) { V.media = d.media; render(); return; }
  if (d.star != null) { V.draftStars = +d.star; render(); return; }
  if (d.route != null) { openRoute(d.route); return; }
  if (d.open != null) { openPoint(d.open); return; }
  if (d.nav != null) { go(d.nav); return; }
  if (d.back != null) { go(d.back); return; }

  switch (d.act) {
    case 'sort': V.sort = V.sort === 'pop' ? 'near' : 'pop'; render(); break;
    case 'grab': cycleSnap(); break;
    case 'search-on': V.searching = true; render(); focusSearch(); break;
    case 'search-off': V.searching = false; V.q = ''; render(); break;
    case 'locme':
      if (Geo.state !== 'live') Geo.start();
      if (Geo.pos && LMAP) centerOnMe(LMAP, 14);
      else toast('Шукаю сигнал', 'Щойно GPS відгукнеться — карта стане на ваше місце.');
      break;
    case 'geo-on': Geo.start(); render(); break;
    case 'start': startJourney(); break;
    case 'road-on': roadMode(true); break;
    case 'road-off': roadMode(false); break;
    case 'follow': setFollow(!V.follow); followMe(); break;
    case 'overview': overview(); break;
    case 'extnav': extNav(); break;
    case 'arrive-gps': arrive('gps'); break;
    case 'arrive-manual': arrive('manual'); break;
    case 'abort': V.road = false; go('routes'); break;
    case 'continue': continueJourney(); break;
    case 'review': saveReview(V.sel); break;
    case 'report': report(); break;
    case 'reset': resetProgress(); break;
    case 'offline': downloadOffline(); break;
    case 'expand': {
      const el = document.getElementById('desc');
      if (el) el.textContent = P(V.sel).f;
      const m = document.getElementById('more');
      if (m) m.remove();
      break;
    }
    case 'back-map': go('map'); break;
    case 'to-profile': go('profile'); break;
    case 'to-routes': go('routes'); break;
    case 'reload': location.reload(); break;
  }
}

/* ═════════ СТАРТ ═════════ */
function boot() {
  const saved = Store.read();
  if (saved) S = Object.assign(S, saved);

  document.addEventListener('click', onTap);
  document.addEventListener('input', onSearchInput);

  /* Кожен фікс GPS приходить раз на секунду-дві. Повний render()
     на кожен — це перебудова карти й миготіння, тому оновлюємо
     тільки смугу геолокації. Але коли змінюється сам стан дозволу
     (idle → live, live → denied), від нього залежать і кнопки
     екрана — тоді перемальовуємо все. Без цього після появи
     сигналу лишалася кнопка «Я на місці» замість очікування радіуса. */
  let lastState = Geo.state;
  let lastHere = false;

  Geo.on(() => {
    const stateChanged = Geo.state !== lastState;
    lastState = Geo.state;

    if (LMAP && Geo.pos) drawMe(LMAP);

    if (V.screen === 'journey' && V.route) {
      /* Перший фікс міг прийти вже після старту — тоді порядок точок
         перебудовується під нього, поки подорож ще нікуди не зрушила. */
      if (replanFromGps()) { render(); return; }

      const cur = P(flat(ROUTES.find(x => x.id === V.route))[V.idx]);
      const here = Geo.atPoint(cur);
      /* Автоматичне прибуття: спека обіцяє, що картка відкриється сама. */
      if (here && !lastHere) { lastHere = true; arrive('gps'); return; }
      if (!here) lastHere = false;
      if (stateChanged) { render(); return; }

      if (V.road) {
        /* Повний render() коштував би перебудови карти й миготіння
           на кожну секунду руху. Тому рухаємо камеру й оновлюємо
           лише те, що змінилось: число і стрілку. */
        followMe();
        maybeReroute();
        const dEl = document.getElementById('rdist');
        if (dEl) dEl.textContent = fmtM(Geo.metersTo(cur));
        const aEl = document.getElementById('rarrow');
        if (aEl && Geo.pos)
          aEl.style.transform = 'rotate(' + Math.round(bearing(Geo.pos, cur)) + 'deg)';
        return;
      }

      const bar = document.querySelector('.geo');
      if (bar) bar.outerHTML = geoBar(cur);
      return;
    }

    if (V.screen === 'map') {
      /* Перший фікс: ставимо карту на вас і перемальовуємо, бо
         змінюється і порядок списку, і підписи відстаней. */
      if (stateChanged) { render(); return; }
      if (!V.centered && Geo.pos && LMAP) { V.centered = true; centerOnMe(LMAP, 11); }
      if (Geo.pos && (!V.listAt || distM(V.listAt, Geo.pos) > 300)) {
        V.listAt = { lat: Geo.pos.lat, lon: Geo.pos.lon };
        refreshMapList();
      }
      return;
    }

    if (V.screen === 'point') {
      if (stateChanged) { render(); return; }
      const bar = document.querySelector('.geo');
      if (bar) bar.outerHTML = geoBar(P(V.sel));
    }
  });

  Alarms.load();
  /* Головний екран — це карта на вашій позиції, тож дозвіл на місце
     просимо одразу, а не аж під час першої подорожі. Відмова нічого
     не ламає: відстані рахуються від Львова, і на екрані так і сказано. */
  Geo.start();
  render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => { V.swUpdate = true; });
    }).catch(() => { /* офлайн просто не увімкнеться */ });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
