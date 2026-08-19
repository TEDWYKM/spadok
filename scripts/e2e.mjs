/* Наскрізний тест у справжньому Chromium через DevTools Protocol.
   Запуск: node scripts/serve.mjs &   node scripts/e2e.mjs

   Геолокація підмінюється через Emulation.setGeolocationOverride,
   тому головна механіка продукту — «оцінка тільки після прибуття» —
   перевіряється по-справжньому, а не імітується.

   Знімки екрана лягають у .e2e/. */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, '.e2e');
const BASE = process.env.BASE || 'http://localhost:8080';
const PORT = Number(process.env.CDP_PORT || 9222);

const CHROME = [
  process.env.CHROME_BIN,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome'
].filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('Не знайдено Chromium'); process.exit(1); }

rmSync(shots, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });

let pass = 0, fail = 0;
const ok = m => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.error('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--disable-dev-shm-usage', '--no-first-run', '--disable-extensions',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + join(shots, 'profile'),
  '--window-size=430,900',
  'about:blank'
], { stdio: 'ignore' });

async function findTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await r.json()).find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* браузер ще піднімається */ }
    await sleep(250);
  }
  throw new Error('CDP не відповів');
}

/* Найтонший можливий клієнт: id → проміс, події в список. */
function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let n = 0;
    const waiting = new Map();
    const events = [];
    ws.onopen = () => res({
      send(method, params = {}) {
        const id = ++n;
        return new Promise((ok2, no) => {
          waiting.set(id, { ok: ok2, no });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      events,
      close: () => ws.close()
    });
    ws.onerror = e => rej(new Error('WebSocket: ' + (e.message || 'помилка')));
    ws.onmessage = m => {
      const d = JSON.parse(m.data);
      if (d.id && waiting.has(d.id)) {
        const w = waiting.get(d.id);
        waiting.delete(d.id);
        d.error ? w.no(new Error(d.error.message)) : w.ok(d.result);
      } else if (d.method) events.push(d);
    };
  });
}

const cdp = await connect(await findTarget());
const errors = [];

await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Emulation.setDeviceMetricsOverride',
  { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });

/* Збираємо все, що застосунок пише в консоль або кидає нагору. */
setInterval(() => {
  while (cdp.events.length) {
    const e = cdp.events.shift();
    if (e.method === 'Runtime.exceptionThrown')
      errors.push('exception: ' + (e.params.exceptionDetails.exception?.description ||
        e.params.exceptionDetails.text));
    if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
      const t = e.params.entry.text || '';
      /* Плитки OSM і CDN у цьому середовищі заблоковані — це не дефект
         застосунку, а обмеження пісочниці. Для них є fallback. */
      if (/tile\.openstreetmap|cdnjs|cartocdn|fonts\.g|osrm|Failed to load resource/i.test(t)) continue;
      errors.push('console: ' + t);
    }
  }
}, 50).unref();

async function evaluate(expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(function(){${expr}})()`,
    returnByValue: true, awaitPromise: true
  });
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

const $ = sel => evaluate(`return !!document.querySelector(${JSON.stringify(sel)})`);
const count = sel => evaluate(`return document.querySelectorAll(${JSON.stringify(sel)}).length`);
const text = sel => evaluate(
  `var e=document.querySelector(${JSON.stringify(sel)});return e?e.innerText:null`);
const click = async sel => {
  const done = await evaluate(
    `var e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true`);
  if (!done) throw new Error('немає елемента для кліку: ' + sel);
  await sleep(260);
};

async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(shots, name + '.png'), Buffer.from(r.data, 'base64'));
}

async function goTo(url) {
  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 80; i++) {
    await sleep(150);
    if (await evaluate('return document.readyState==="complete" && !!document.getElementById("nav").innerHTML')) return;
  }
  throw new Error('сторінка не завантажилась: ' + url);
}

/* Ставимо себе у задану точку. accuracy тримаємо низькою, щоб
   перевірявся саме радіус, а не запас на похибку. */
async function standAt(lat, lon, acc = 12) {
  await cdp.send('Emulation.setGeolocationOverride',
    { latitude: lat, longitude: lon, accuracy: acc });
  await sleep(500);
}

console.log('\nСПАДОК · наскрізний тест\n');

/* ── 1. Перший запуск ────────────────────────────────────────────── */
await cdp.send('Browser.grantPermissions', { origin: BASE, permissions: ['geolocation'] });
await goTo(BASE + '/');
await sleep(700);

(await text('.bar h1')) === 'Спадок' ? ok('застосунок відкрився') : bad('не відкрився екран карти');
(await count('.body .card')) === 17
  ? ok('17 точок у списку')
  : bad('точок у списку: ' + await count('.body .card'));
(await $('.alert')) ? ok('банер тривоги на місці') : bad('немає банера тривоги');
(await count('.nav button')) === 4 ? ok('навігація з 4 розділів') : bad('навігація зламана');
await shot('01-map');

/* ── 2. Гейт оцінки: головне правило продукту ────────────────────── */
await click('[data-open="olesko"]');
(await text('.bar h1')) === 'Пам’ятка' ? ok('картка пам’ятки відкрилась') : bad('картка не відкрилась');

const gateShown = await $('.gate');
const pickerShown = await $('[data-star]');
gateShown && !pickerShown
  ? ok('без відвідин: зорепад закритий, показано замок')
  : bad('гейт не працює', `gate=${gateShown} picker=${pickerShown}`);
await shot('02-point-gate');

/* Спроба обійти гейт напряму, як це зробив би скрипт. */
const bypass = await evaluate(`
  saveReview('olesko');
  return { rated: !!S.ratings['olesko'], toast: document.querySelector('.toast')?.innerText || null };
`);
!bypass.rated
  ? ok('прямий виклик saveReview відхилено: ' + JSON.stringify(bypass.toast))
  : bad('гейт обходиться викликом saveReview');

/* ── 3. Маршрути ─────────────────────────────────────────────────── */
await click('[data-nav="routes"]');
(await count('[data-route]')) === 9 ? ok('9 маршрутів') : bad('маршрутів: ' + await count('[data-route]'));
await click('[data-size="l"]');
(await count('[data-route]')) === 2 ? ok('фільтр «великі» → 2 маршрути') : bad('фільтр розміру не працює');
await click('[data-size="all"]');
await click('[data-route="horseshoe"]');
const stats = await evaluate(`return [...document.querySelectorAll('.stat b')].map(e=>e.innerText)`);
stats.length === 3 && +stats[0] > 100
  ? ok('маршрут порахований: ' + stats.join(' / '))
  : bad('статистика маршруту зламана: ' + JSON.stringify(stats));
await shot('03-route');

/* ── 4. Подорож і геолокація ─────────────────────────────────────── */
await click('[data-act="start"]');
(await text('.bar h1')) === 'У дорозі' ? ok('подорож почалась') : bad('екран подорожі не відкрився');

/* Далеко від точки: прибуття не зараховується. */
await standAt(49.8419, 24.0315); /* Львів, площа Ринок */
await sleep(900);
const far = await evaluate(`return {
  geo: document.querySelector('.geo')?.innerText || null,
  screen: V.screen,
  visited: Object.keys(S.visits).length
}`);
far.screen === 'journey' && far.visited === 0
  ? ok('за 60 км від точки відвідини не зараховані')
  : bad('прибуття зарахувалось здалеку: ' + JSON.stringify(far));
/[0-9]/.test(far.geo || '') ? ok('показано відстань: ' + far.geo.replace(/\n/g, ' · ')) : bad('немає відстані до точки');

/* Коли сигнал є, головна кнопка мусить чекати радіуса, а ручне
   підтвердження стати другорядним. Раніше після появи GPS кнопки
   лишалися в стані «геолокації немає». */
const buttons = await evaluate(`return {
  locked: !!document.querySelector('.locked'),
  manualGhost: !!document.querySelector('.btn.ghost[data-act="arrive-manual"]'),
  manualPrimary: !!document.querySelector('.btn.go[data-act="arrive-manual"]')
}`);
buttons.locked && buttons.manualGhost && !buttons.manualPrimary
  ? ok('при живому GPS кнопки в правильному стані')
  : bad('кнопки не оновились після появи сигналу: ' + JSON.stringify(buttons));

/* Дроби в підписах не мусять містити «з» — у моношрифті
   у верхньому регістрі його не відрізнити від трійки. */
const eyebrow = await text('.card .eyebrow');
/\d\s*\/\s*\d/.test(eyebrow) && !/\sЗ\s/.test(eyebrow)
  ? ok('підпис дня читається однозначно: ' + eyebrow)
  : bad('неоднозначний підпис: ' + eyebrow);
await shot('04-journey-far');

/* Підходимо до Олеського замку: має спрацювати автоматично. */
await standAt(49.9686, 24.8963);
await sleep(1200);
const near = await evaluate(`return {
  screen: V.screen,
  visit: S.visits['olesko'] || null,
  gate: !!document.querySelector('.gate'),
  picker: !!document.querySelector('[data-star]')
}`);
near.screen === 'point' && near.visit
  ? ok('у радіусі 300 м картка відкрилась сама')
  : bad('автоматичне прибуття не спрацювало: ' + JSON.stringify(near));
near.visit && near.visit.by === 'gps'
  ? ok('відвідини позначені як підтверджені по GPS')
  : bad('verified_by не gps: ' + JSON.stringify(near.visit));
!near.gate && near.picker
  ? ok('після прибуття зорепад відкрився')
  : bad('гейт не відкрився після відвідин');
await shot('05-point-unlocked');

/* ── 5. Оцінка ───────────────────────────────────────────────────── */
await click('[data-star="5"]');
await evaluate(`document.getElementById('rev').value = 'Найкращий вигляд з валів на заході сонця.'`);
await click('[data-act="review"]');
const rated = await evaluate(`return S.ratings['olesko'] || null`);
rated && rated.stars === 5 && rated.by === 'gps' && rated.text.length > 10
  ? ok('оцінка збережена з visit-джерелом: ' + rated.stars + '★ / ' + rated.by)
  : bad('оцінка не збереглась як слід: ' + JSON.stringify(rated));
(await evaluate(`return S.badges.includes('first')`))
  ? ok('нагорода «Перший камінь» відкрилась')
  : bad('нагорода за першу точку не відкрилась');

/* ── 6. Решта маршруту, ручне підтвердження ──────────────────────── */
await click('[data-act="continue"]');
await standAt(49.9414, 24.9890); /* Підгірці */
await sleep(1200);
(await evaluate(`return !!S.visits['pidhirtsi']`)) ? ok('друга точка зарахована') : bad('друга точка не зарахована');
await click('[data-act="continue"]');

/* Третю точку підтверджуємо вручну, стоячи далеко — так робить
   користувач у зоні без сигналу. Штамп мусить це відрізняти. */
await standAt(49.5, 24.0);
await sleep(700);
await click('[data-act="arrive-manual"]');
const manual = await evaluate(`return S.visits['zolochiv'] || null`);
manual && manual.by === 'manual'
  ? ok('ручне підтвердження позначене як manual')
  : bad('ручне підтвердження не відрізняється від GPS: ' + JSON.stringify(manual));
await shot('06-manual');

await click('[data-act="continue"]');
(await text('.bar h1')) === 'Подорож завершено' ? ok('екран завершення') : bad('маршрут не завершився');
const fin = await evaluate(`return { done: S.done, badges: S.badges }`);
fin.done.includes('horseshoe') ? ok('маршрут відмічений як пройдений') : bad('маршрут не зафіксований');
fin.badges.includes('horseshoe') && fin.badges.includes('route1')
  ? ok('нагороди за маршрут: ' + fin.badges.join(', '))
  : bad('нагороди за маршрут не відкрились: ' + fin.badges.join(', '));
await shot('07-finish');

/* ── 7. Профіль ──────────────────────────────────────────────────── */
await click('[data-nav="profile"]');
const prof = await evaluate(`return {
  stamps: document.querySelectorAll('.stamp').length,
  got: document.querySelectorAll('.badge.got').length,
  storage: document.body.innerText.includes('зберігається на пристрої'),
  freshLine: document.body.innerText.includes('Свіжих перевірок статусу')
}`);
prof.stamps === 3 ? ok('3 штампи відвідин') : bad('штампів: ' + prof.stamps);
prof.got >= 3 ? ok(prof.got + ' нагород отримано') : bad('нагород отримано: ' + prof.got);
prof.storage ? ok('прогрес пишеться на пристрій') : bad('прогрес лише в пам’яті');
prof.freshLine ? ok('видно стан свіжості перевірок статусів') : bad('немає блоку стану даних');
await shot('08-profile');

/* ── 8. Збереження між запусками ─────────────────────────────────── */
/* Це та сама діра, через яку прототип втрачав усе при перезавантаженні. */
await goTo(BASE + '/');
await sleep(700);
const after = await evaluate(`return {
  visits: Object.keys(S.visits).length,
  ratings: Object.keys(S.ratings).length,
  badges: S.badges.length,
  done: S.done.length
}`);
after.visits === 3 && after.ratings === 1 && after.done === 1
  ? ok('після перезапуску прогрес на місці: ' + JSON.stringify(after))
  : bad('прогрес втрачено при перезапуску: ' + JSON.stringify(after));

/* ── 9. Два пороги свіжості статусу ──────────────────────────────── */
/* Правило 2 довго жило тільки в тексті спеки: recommended() був
   оголошений і ніде не викликаний. Тут точку штучно «старять»
   і дивляться, куди вона з цього дівається — у списку і в треку. */
const tiers = await evaluate(`
  const p = P('univ'), was = p.upd;
  const at = d => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
  const snap = () => {
    V.screen = 'map'; V.sort = 'pop'; render();
    const el = document.querySelector('[data-open="univ"]');
    const cards = [...document.querySelectorAll('.card[data-open]')].map(c => c.dataset.open);
    const s = routeStats(ROUTES.find(r => r.id === 'ruins'));
    return {
      tag: !el ? 'нема картки' : el.querySelector('.tag.old') ? 'old'
        : el.querySelector('.tag.stale') ? 'stale' : 'none',
      rank: cards.indexOf('univ'),
      blocked: s.blocked.includes('univ'),
      stale: s.stale.includes('univ')
    };
  };
  p.upd = at(5);   const a = snap();
  p.upd = at(70);  const b = snap();
  p.upd = at(130); const c = snap();
  p.upd = was; render();
  return { fresh: a, stale: b, gone: c, restored: p.upd === was };
`);
tiers.fresh.tag === 'none' && !tiers.fresh.blocked
  ? ok('свіжа перевірка: без позначки, точка в треку')
  : bad('свіжа точка поводиться не так: ' + JSON.stringify(tiers.fresh));
tiers.stale.tag === 'stale' && !tiers.stale.blocked && tiers.stale.stale
  ? ok('70 днів: позначка є, точка лишилась у треку')
  : bad('середній ярус зламаний: ' + JSON.stringify(tiers.stale));
tiers.gone.tag === 'old' && tiers.gone.blocked
  ? ok('130 днів: точка випала з треку, як закрита')
  : bad('протухла точка не випала: ' + JSON.stringify(tiers.gone));
tiers.stale.rank > tiers.fresh.rank && tiers.gone.rank >= tiers.stale.rank
  ? ok('нерекомендовані опускаються нижче: ' + tiers.fresh.rank + ' → ' +
      tiers.stale.rank + ' → ' + tiers.gone.rank)
  : bad('порядок у «найпопулярніших» не залежить від свіжості: ' +
      [tiers.fresh.rank, tiers.stale.rank, tiers.gone.rank].join(' → '));
await shot('09-status-tiers');

/* ── 10. Шторки замість системних діалогів ───────────────────────── */
await click('[data-nav="map"]');
await click('[data-open="tustan"]');
await click('[data-act="report"]');
(await $('.scrim .sheet')) ? ok('«повідомити про проблему» відкриває шторку') : bad('шторка не відкрилась');
(await count('.sheet .opt')) === 4 ? ok('4 варіанти скарги') : bad('варіантів скарги: ' + await count('.sheet .opt'));
await shot('09-sheet');
await click('[data-sheet="1"]');
(await $('.toast')) ? ok('після вибору показано підтвердження') : bad('немає підтвердження');
!(await $('.scrim')) ? ok('шторка закрилась') : bad('шторка лишилась відкритою');

/* ── 11. Карта без мережі ────────────────────────────────────────── */
/* У цьому середовищі плитки й CDN заблоковані, тому перевіряємо
   саме той шлях, який побачить користувач у зоні без зв'язку. */
await click('[data-nav="map"]');
await sleep(2500);
const map = await evaluate(`return {
  fallback: !!document.querySelector('.lmap.fallback svg'),
  leaflet: !!document.querySelector('.leaflet-container')
}`);
map.fallback || map.leaflet
  ? ok(map.leaflet ? 'карта Leaflet піднялась' : 'без мережі показано схему замість карти')
  : bad('карта не показала ні себе, ні схему');
await shot('10-map-offline');

/* ── 12. Помилки в консолі ───────────────────────────────────────── */
await sleep(300);
errors.length === 0
  ? ok('консоль чиста')
  : bad(errors.length + ' помилок у консолі', errors.slice(0, 6).join('\n      '));

/* ── Підсумок ────────────────────────────────────────────────────── */
console.log(`\n${pass} перевірок пройдено, ${fail} провалено.`);
console.log('Знімки: ' + shots.replace(root + '/', ''));

cdp.close();
chrome.kill();
process.exit(fail ? 1 : 0);
