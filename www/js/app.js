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
     6. Свіжість перевірки статусу враховується. Правило 2.
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
  screen: 'map', theme: 'all', sort: 'pop', size: 'all',
  route: null, idx: 0, t0: 0, sel: null, from: 'map',
  media: 'photo', draftStars: 0, tiles: 'osm',
  fresh: [], sheet: null, toast: null, swUpdate: false
};
let MOUNT = null, LMAP = null, LEAFLET = null, MEMARK = null;

function save() { Store.write(S); }

/* ═════════ УТИЛІТИ ═════════ */
const P = id => POINTS.find(p => p.id === id);
const flat = r => r.days.reduce((a, d) => a.concat(d), []);

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

function dayKm(r, d) {
  const chain = [P(r.from)].concat(d.map(P), [P(r.from)]);
  let k = 0;
  for (let i = 1; i < chain.length; i++) k += dist(chain[i - 1], chain[i]);
  return Math.round(k);
}

function routeStats(r) {
  const st = flat(r);
  let km = 0;
  r.days.forEach(d => { km += dayKm(r, d); });
  const min = Math.round(km / CONFIG.avgSpeedKmh * 60) + st.length * CONFIG.minutesPerStop;
  const near = st.reduce((a, id) => {
    const p = P(id);
    a.shop += p.near.shop; a.stay += p.near.stay; a.food += p.near.food;
    return a;
  }, { shop: 0, stay: 0, food: 0 });
  return {
    km, min, near,
    stops: st.length,
    days: r.days.length,
    warn: st.some(id => P(id).st === 'warn'),
    blocked: st.filter(id => !routable(P(id))),
    stale: st.filter(id => !fresh(P(id)))
  };
}

const hhmm = m => (m >= 60 ? Math.floor(m / 60) + ' год ' : '') + (m % 60) + ' хв';

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
              підтвердженою і не потрапляє в «рекомендовані».
   Правило 3: маршрут не прокладається через точки, чий статус
              не підтверджений (закрито / під окупацією).            */
const fresh = p => daysSince(p.upd) <= STATUS_FRESH_DAYS;
const routable = p => p.st !== 'closed' && p.st !== 'occupied';
const recommended = p => p.st === 'ok' && fresh(p);

/* Індекс дня, у якому лежить зупинка за наскрізним номером. */
function dayOf(r, i) {
  let c = 0;
  for (let d = 0; d < r.days.length; d++) {
    c += r.days[d].length;
    if (i < c) return d;
  }
  return r.days.length - 1;
}
/* Перша зупинка дня в наскрізній нумерації — потрібно, щоб відстань
   рахувалася від бази, а не від останньої точки попереднього дня. */
function dayStart(r, di) {
  let c = 0;
  for (let d = 0; d < di; d++) c += r.days[d].length;
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
      this.pos = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, at: Date.now() };
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
  }
};

async function mountMap() {
  if (!MOUNT) return;
  const cfg = MOUNT; MOUNT = null;
  const el = document.getElementById('lmap');
  if (!el) return;
  const ok = await loadLeaflet();
  if (!ok || !window.L) { el.classList.add('fallback'); el.innerHTML = fallbackSVG(cfg); return; }
  if (LMAP) { try { LMAP.remove(); } catch (e) {} LMAP = null; }

  let map;
  try { map = L.map(el, { zoomControl: true, scrollWheelZoom: false }); }
  catch (e) { el.classList.add('fallback'); el.innerHTML = fallbackSVG(cfg); return; }
  LMAP = map;
  MEMARK = null;

  const t = TILES[V.tiles];
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

  cfg.points.forEach(p => {
    const on = !!S.visits[p.id], now = cfg.now === p.id;
    const shape = p.kind === 'sacral' ? 'sacral ' : p.kind === 'ruin' ? 'ruin ' : '';
    const cls = 'mk ' + shape + (now ? 'now' : on ? 'on' : '');
    L.marker([p.lat, p.lon], {
      icon: L.divIcon({
        className: '', html: '<div class="' + cls + '"><i></i></div>',
        iconSize: [22, 22], iconAnchor: [11, 11]
      }),
      title: p.n
    }).addTo(map).bindPopup(
      '<b>' + esc(p.n) + '</b><br>' +
      '<span style="color:#6D8091;font-size:11.5px">' + esc(p.s) + '</span><br>' +
      '<button data-open="' + p.id + '" style="margin-top:7px;border:1px solid rgba(21,36,46,.3);' +
      'border-radius:8px;padding:6px 11px;font-size:12px;background:#fff;cursor:pointer">Відкрити</button>'
    );
  });

  const bounds = L.latLngBounds(cfg.points.map(p => [p.lat, p.lon]));

  if (cfg.legs && cfg.legs.length) {
    const colors = ['#1C5849', '#A8542B', '#2E7D6C', '#B08417'];
    cfg.legs.forEach((leg, i) => {
      const chain = leg.map(id => [P(id).lat, P(id).lon]);
      const line = L.polyline(chain, {
        color: colors[i % 4], weight: 3.4, opacity: .85, dashArray: '8 6'
      }).addTo(map);
      bounds.extend(line.getBounds());
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

  try { map.fitBounds(bounds.pad(.18)); }
  catch (e) { map.setView([49.84, 24.03], 8); }
  setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 150);
}

function drawMe(map) {
  if (!Geo.pos || !window.L) return;
  const ll = [Geo.pos.lat, Geo.pos.lon];
  if (MEMARK) { try { MEMARK.setLatLng(ll); return; } catch (e) {} }
  MEMARK = L.circleMarker(ll, {
    radius: 6, color: '#15242E', weight: 2, fillColor: '#A8542B', fillOpacity: 1
  }).addTo(map).bindPopup('Ви тут');
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
  const la = cfg.points.map(p => p.lat), lo = cfg.points.map(p => p.lon);
  const b = {
    y0: Math.min.apply(null, la) - .08, y1: Math.max.apply(null, la) + .08,
    x0: Math.min.apply(null, lo) - .08, x1: Math.max.apply(null, lo) + .08
  };
  const X = l => ((l - b.x0) / (b.x1 - b.x0 || 1) * 520 + 20).toFixed(1);
  const Y = l => ((b.y1 - l) / (b.y1 - b.y0 || 1) * 250 + 20).toFixed(1);
  const legs = (cfg.legs || []).map(leg =>
    '<path d="' + leg.map((id, i) => (i ? 'L' : 'M') + X(P(id).lon) + ' ' + Y(P(id).lat)).join(' ') +
    '" fill="none" stroke="#A8542B" stroke-width="2" stroke-dasharray="7 5"/>').join('');
  const pins = cfg.points.map(p =>
    '<g><circle cx="' + X(p.lon) + '" cy="' + Y(p.lat) + '" r="6" fill="' +
    (S.visits[p.id] ? '#1C5849' : '#F2F1E9') + '" stroke="#15242E" stroke-width="1.6"/>' +
    '<text x="' + (+X(p.lon) + 10) + '" y="' + (+Y(p.lat) + 4) + '" font-size="9.5" ' +
    'font-family="IBM Plex Mono,monospace" fill="#15242E">' +
    esc(p.n.split(',')[0]) + '</text></g>').join('');
  return '<div class="alert" style="margin:0 0 10px">Карта недоступна без мережі — показано схему. ' +
    'Завантажте маршрут для офлайну, і плитки OpenStreetMap працюватимуть без зв’язку.</div>' +
    '<svg viewBox="0 0 560 290">' + legs + pins + '</svg>';
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
  /* Правило 2: якщо перевірка застаріла, статус не вважається підтвердженим. */
  if (typeof p === 'object' && !fresh(p))
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
function scrMap() {
  const list = V.theme === 'all' ? POINTS : POINTS.filter(p => p.t.indexOf(V.theme) > -1);
  const base = P('rynok');
  const sorted = list.slice().sort((a, b) =>
    V.sort === 'pop' ? b.pop - a.pop : dist(base, a) - dist(base, b));
  MOUNT = { points: list };

  return '<div>' + (V.swUpdate ? updBanner() : '') + Alarms.banner() +
    '<div class="chips" role="group" aria-label="Тема">' +
    '<button class="chip" aria-pressed="' + (V.theme === 'all') + '" data-theme="all">Усі теми</button>' +
    Object.keys(THEMES).map(k => '<button class="chip" aria-pressed="' + (V.theme === k) +
      '" data-theme="' + k + '">' + THEMES[k] + '</button>').join('') + '</div>' +
    '<div id="lmap" class="lmap"></div>' + mapBar() +
    '<div class="between" style="margin:14px 0 10px"><span class="eyebrow">' + list.length +
    ' точок · ' + Object.keys(S.visits).length + ' відвідано</span>' +
    '<button class="btn-sm" data-act="sort">' +
    (V.sort === 'pop' ? 'Найпопулярніші' : 'Найближчі') + ' ⇅</button></div>' +
    sorted.map(p => {
      const d = Math.round(dist(base, p));
      const my = S.ratings[p.id];
      const shown = my ? my.stars : p.rate;
      const vis = S.visits[p.id];
      return '<div class="card" data-open="' + p.id + '">' +
        '<div class="between"><h3>' + esc(p.n) + '</h3><span class="row" style="gap:5px">' + stTag(p) + '</span></div>' +
        '<p class="lede" style="margin:7px 0 9px">' + esc(p.s) + '</p>' +
        '<div class="between"><div class="row">' + stars(Math.round(shown), 'sm') +
        '<span class="meta">' + shown.toFixed(1) + (my ? ' · ваша' : '') + '</span></div>' +
        '<span class="meta">' + d + ' км від Львова</span></div>' +
        (vis ? '<div style="margin-top:10px"><span class="stamp' + (vis.by === 'manual' ? ' manual' : '') +
          '">Відвідано · ' + stamp(vis.at) + '</span></div>' : '') +
        '</div>';
    }).join('') + '</div>';
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
  /* Правило 3: недоступні точки не потрапляють у прокладений трек. */
  MOUNT = {
    points: flat(r).map(P),
    legs: r.days.map(d => [r.from].concat(d.filter(id => routable(P(id))), [r.from]))
  };
  const off = S.offline.indexOf(r.id) > -1;

  return '<div><div id="lmap" class="lmap tall"></div>' + mapBar() +
    (s.blocked.length ? '<div class="alert" style="margin-top:12px"><b>' + s.blocked.length +
      ' точку з маршруту обійдено.</b><br>Статус не підтверджений, тому трек прокладено без неї — ' +
      'правило 3 продуктової спеки.</div>' : '') +
    (s.stale.length ? '<div class="alert" style="margin-top:12px">Перевірка статусу застаріла у ' +
      s.stale.length + ' точок. Уточніть доступність перед виїздом.</div>' : '') +
    '<div class="grid3" style="margin:14px 0">' +
    '<div class="stat"><b>' + s.km + '</b><span>кілометрів</span></div>' +
    '<div class="stat"><b>' + s.days + '</b><span>' + (s.days === 1 ? 'день' : 'дні') + '</span></div>' +
    '<div class="stat"><b>' + s.stops + '</b><span>зупинок</span></div></div>' +
    '<span class="eyebrow">Що поруч на маршруті</span>' +
    '<div class="row" style="gap:16px;margin:8px 0 4px">' +
    '<span class="meta">' + s.near.shop + ' магазинів</span>' +
    '<span class="meta">' + s.near.stay + ' ночівель</span>' +
    '<span class="meta">' + s.near.food + ' закладів їжі</span></div>' +
    r.days.map((d, di) => '<div class="dayhead"><b>День ' + (di + 1) + '</b><span class="meta">' +
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

function scrJourney() {
  const r = ROUTES.find(x => x.id === V.route), st = flat(r), cur = P(st[V.idx]);
  const d = dayOf(r, V.idx);
  const prev = V.idx === dayStart(r, d) ? P(r.from) : P(st[V.idx - 1]);
  const km = Math.round(dist(prev, cur));
  MOUNT = {
    points: st.map(P),
    legs: [[r.from].concat(r.days[d].filter(id => routable(P(id))), [r.from])],
    now: cur.id
  };
  const here = Geo.atPoint(cur);
  const live = Geo.state === 'live';

  /* «з» у верхньому регістрі моношрифтом не відрізнити від трійки,
     тому в підписах-eyebrow дроби пишемо скісною рискою. */
  return '<div><div id="lmap" class="lmap"></div>' + mapBar() +
    '<div style="margin-top:12px">' + geoBar(cur) + '</div>' +
    '<div class="card"><span class="eyebrow">День ' + (d + 1) + ' / ' + r.days.length +
    ' · зупинка ' + (V.idx + 1) + ' / ' + st.length + '</span>' +
    '<h2 style="font-size:19px;margin:8px 0 6px">' + esc(cur.n) + '</h2>' +
    '<div class="row" style="gap:14px;flex-wrap:wrap"><span class="meta">' +
    esc(prev.n.split(',')[0]) + ' → ' + km + ' км</span>' +
    '<span class="meta">~' + Math.round(km / CONFIG.avgSpeedKmh * 60) + ' хв</span>' +
    stTag(cur) + '</div></div>' +
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
    legs: r.days.map(d => [r.from].concat(d.filter(id => routable(P(id))), [r.from]))
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
  const stale = POINTS.filter(p => !fresh(p)).length;
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
    'Свіжих перевірок статусу</span><b style="font-size:13.5px">' + (POINTS.length - stale) +
    ' / ' + POINTS.length + '</b></div>' +
    '<p class="meta" style="margin:7px 0 0;line-height:1.45">Найдавніша перевірка — ' + dmy(oldest) +
    '. Свіжою вважається молодша за ' + STATUS_FRESH_DAYS + ' днів.</p>' +
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
function startJourney() { V.idx = 0; V.t0 = Date.now(); V.fresh = []; Geo.start(); go('journey'); }

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
  openPoint(id, 'journey');
}

function continueJourney() {
  const r = ROUTES.find(x => x.id === V.route);
  if (V.idx < flat(r).length - 1) { V.idx++; go('journey'); }
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
  map: ['Спадок', 'Львівщина · MVP'],
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

  document.getElementById('bar').innerHTML =
    (back ? '<button class="back" data-back="' + back + '" aria-label="Назад">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button>' : '') +
    '<div><h1>' + T[0] + '</h1>' + (T[1] ? '<div class="sub">' + T[1] + '</div>' : '') + '</div>';

  if (LMAP) { try { LMAP.remove(); } catch (e) {} LMAP = null; MEMARK = null; }

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
  mountMap();
}

/* Одна делегована обробка кліків замість inline onclick —
   безпечніше з текстом даних і легше тестувати. */
function onTap(e) {
  const t = e.target.closest('[data-open],[data-route],[data-theme],[data-size],[data-tiles],' +
    '[data-star],[data-media],[data-nav],[data-back],[data-act],[data-sheet]');
  if (!t) return;
  const d = t.dataset;

  if (d.sheet != null && V.sheet) { V.sheet.onPick(V.sheet.options[+d.sheet], +d.sheet); return; }
  if (d.act === 'scrim') { if (e.target === t) closeSheet(); return; }
  if (d.act === 'sheet-close') { closeSheet(); return; }
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
    case 'geo-on': Geo.start(); render(); break;
    case 'start': startJourney(); break;
    case 'arrive-gps': arrive('gps'); break;
    case 'arrive-manual': arrive('manual'); break;
    case 'abort': go('routes'); break;
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
      const cur = P(flat(ROUTES.find(x => x.id === V.route))[V.idx]);
      const here = Geo.atPoint(cur);
      /* Автоматичне прибуття: спека обіцяє, що картка відкриється сама. */
      if (here && !lastHere) { lastHere = true; arrive('gps'); return; }
      if (!here) lastHere = false;
      if (stateChanged) { render(); return; }
      const bar = document.querySelector('.geo');
      if (bar) bar.outerHTML = geoBar(cur);
      return;
    }

    if (V.screen === 'point' || V.screen === 'map') {
      if (stateChanged) { render(); return; }
      const bar = document.querySelector('.geo');
      if (bar) bar.outerHTML = geoBar(V.screen === 'point' ? P(V.sel) : null);
    }
  });

  Alarms.load();
  render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => { V.swUpdate = true; });
    }).catch(() => { /* офлайн просто не увімкнеться */ });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
