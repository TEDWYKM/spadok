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

/* Якщо на порту вже хтось відповідає — це браузер від попереднього
   запуску, який упав і не прибрався. Мовчки причепитись до нього
   означало б тестувати чужий localStorage і вірити результату:
   саме так тест одного разу «побачив» відвідини, яких не робив. */
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
  if (r.ok) {
    console.error(`  ✗ порт ${PORT} уже зайнятий браузером від попереднього запуску.`);
    console.error(`      Закрийте його: pkill -f "remote-debugging-port=${PORT}"`);
    process.exit(1);
  }
} catch { /* нікого немає — саме те, що треба */ }

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--disable-dev-shm-usage', '--no-first-run', '--disable-extensions',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + join(shots, 'profile'),
  '--window-size=430,900',
  'about:blank'
], { stdio: 'ignore' });

/* Прибирання на будь-якому виході, а не лише на щасливому: інакше
   перша ж провалена перевірка лишає браузер жити, і наступний
   запуск бачить не той стан, який сам створив. */
let killed = false;
const shutdown = () => {
  if (killed) return;
  killed = true;
  try { chrome.kill(); } catch { /* уже мертвий */ }
};
process.on('exit', shutdown);
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => { shutdown(); process.exit(130); }));
process.on('uncaughtException', e => { console.error('\n  ✗ ' + (e && e.message)); shutdown(); process.exit(1); });
process.on('unhandledRejection', e => { console.error('\n  ✗ ' + (e && e.message)); shutdown(); process.exit(1); });

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

/* Порядок точок тепер залежить від того, звідки ви стартували, тому
   тест не має права припускати, що першою буде саме та точка, яка
   лежить першою в даних. Питаємо застосунок, куди він веде. */
const aim = await evaluate(`
  const r = ROUTES.find(x => x.id === V.route);
  const id = flat(r)[V.idx];
  return { id, lat: P(id).lat, lon: P(id).lon,
           order: V.plan.days[0].join(','), byGps: V.plan.byGps };
`);
aim.byGps
  ? ok('план перебудовано під фактичне положення: ' + aim.order)
  : bad('план лишився без урахування GPS: ' + JSON.stringify(aim));

/* Підходимо до першої точки: має спрацювати автоматично. */
await standAt(aim.lat, aim.lon);
await sleep(1200);
const near = await evaluate(`return {
  screen: V.screen,
  visit: S.visits[${JSON.stringify(aim.id)}] || null,
  gate: !!document.querySelector('.gate'),
  picker: !!document.querySelector('[data-star]')
}`);
near.screen === 'point' && near.visit
  ? ok('у радіусі 300 м картка відкрилась сама: ' + aim.id)
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
const rated = await evaluate(`return S.ratings[${JSON.stringify(aim.id)}] || null`);
rated && rated.stars === 5 && rated.by === 'gps' && rated.text.length > 10
  ? ok('оцінка збережена з visit-джерелом: ' + rated.stars + '★ / ' + rated.by)
  : bad('оцінка не збереглась як слід: ' + JSON.stringify(rated));
(await evaluate(`return S.badges.includes('first')`))
  ? ok('нагорода «Перший камінь» відкрилась')
  : bad('нагорода за першу точку не відкрилась');

/* ── 6. Решта маршруту, ручне підтвердження ──────────────────────── */
await click('[data-act="continue"]');
const aim2 = await evaluate(`
  const r = ROUTES.find(x => x.id === V.route);
  const id = flat(r)[V.idx];
  return { id, lat: P(id).lat, lon: P(id).lon };
`);
await standAt(aim2.lat, aim2.lon);
await sleep(1200);
(await evaluate(`return !!S.visits[${JSON.stringify(aim2.id)}]`))
  ? ok('друга точка зарахована: ' + aim2.id)
  : bad('друга точка не зарахована: ' + aim2.id);
await click('[data-act="continue"]');

/* Третю точку підтверджуємо вручну, стоячи далеко — так робить
   користувач у зоні без сигналу. Штамп мусить це відрізняти. */
const aim3 = await evaluate(`
  const r = ROUTES.find(x => x.id === V.route);
  return { id: flat(r)[V.idx] };
`);
await standAt(49.5, 24.0);
await sleep(700);
await click('[data-act="arrive-manual"]');
const manual = await evaluate(`return S.visits[${JSON.stringify(aim3.id)}] || null`);
manual && manual.by === 'manual'
  ? ok('ручне підтвердження позначене як manual: ' + aim3.id)
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
  const p = P('univ'), was = p.upd, wasSort = V.sort;
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
  /* Прибираємо за собою: інакше наступні перевірки побачать екран
     у режимі «найпопулярніші» і вирішать, що зламане сортування. */
  p.upd = was; V.sort = wasSort; render();
  return { fresh: a, stale: b, gone: c, restored: p.upd === was && V.sort === wasSort };
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

/* ── 10. Старт від свого місця й дорожній режим ──────────────────── */
/* Стоїмо під Бродами — на іншому кінці області від бази. Саме тут
   видно, чи справді порядок дня будується під людину. Не в самій
   точці: інакше спрацює автоприбуття і перевіряти буде нічого. */
await standAt(50.1400, 25.1000);
await sleep(700);
await click('[data-nav="routes"]');
await click('[data-route="horseshoe-plus"]');
await click('[data-act="start"]');
await sleep(900);

const plan = await evaluate(`
  const r = ROUTES.find(x => x.id === V.route);
  const st = flat(r);
  return {
    order: V.plan.days[0].join(','),
    data: r.days[0].join(','),
    byGps: V.plan.byGps,
    first: st[V.idx],
    fromMe: legOrigin(r, st) === Geo.pos
  };
`);
plan.byGps && plan.order !== plan.data
  ? ok('порядок дня перебудовано під старт: ' + plan.data + ' → ' + plan.order)
  : bad('порядок не перебудувався: ' + JSON.stringify(plan));
plan.first === 'brody'
  ? ok('першою стала найближча точка: brody')
  : bad('перша точка не найближча: ' + plan.first);
plan.fromMe
  ? ok('трек починається від координат користувача')
  : bad('трек починається не від користувача');

/* Сюжетний маршрут не переставляється — інакше від задуму
   «городище → замок → бастіон» лишився б набір точок поруч. */
const ordered = await evaluate(`
  const r = ROUTES.find(x => x.id === 'defense');
  const p = buildPlan(r, Geo.pos, true);
  return { got: p.days[0].join(','), want: r.days[0].join(','), ord: !!r.ord };
`);
ordered.ord && ordered.got === ordered.want
  ? ok('сюжетний маршрут не переставлено: ' + ordered.got)
  : bad('сюжетний порядок зруйновано: ' + JSON.stringify(ordered));

await click('[data-act="road-on"]');
await sleep(500);
const road = await evaluate(`return {
  body: document.body.classList.contains('road'),
  navHidden: getComputedStyle(document.querySelector('.nav')).display === 'none',
  barHidden: getComputedStyle(document.querySelector('.bar')).display === 'none',
  dist: document.getElementById('rdist')?.innerText || null,
  arrow: document.getElementById('rarrow')?.style.transform || null,
  eta: document.getElementById('reta')?.innerText || null,
  follow: V.follow
}`);
road.body && road.navHidden && road.barHidden
  ? ok('дорожній режим займає весь екран')
  : bad('дорожній режим не повноекранний: ' + JSON.stringify(road));
/\d/.test(road.dist || '') && /rotate\(-?\d+deg\)/.test(road.arrow || '')
  ? ok('плашка веде: ' + road.dist + ' · ' + road.arrow)
  : bad('плашка напрямку порожня: ' + JSON.stringify(road));
/\d/.test(road.eta || '') ? ok('показано час до кінця дня: ' + road.eta) : bad('немає часу до кінця дня');
await shot('10-road');

/* Відстань має жити: під'їжджаємо ближче — число меншає. */
const before = road.dist;
await standAt(50.1100, 25.1200);
await sleep(900);
const nowDist = await evaluate(`return document.getElementById('rdist')?.innerText || null`);
nowDist && nowDist !== before
  ? ok('відстань оновлюється в русі: ' + before + ' → ' + nowDist)
  : bad('відстань не змінилась при русі: ' + before + ' → ' + nowDist);

/* Слідування вимикається кнопкою і оглядом, і це видно в стані. */
await click('[data-act="follow"]');
const off = await evaluate(`return V.follow`);
await click('[data-act="overview"]');
const afterOver = await evaluate(`return V.follow`);
off === false && afterOver === false
  ? ok('слідування вимикається кнопкою і оглядом')
  : bad('стан слідування не сходиться: ' + off + ' / ' + afterOver);

/* Покрокові підказки віддаємо назовні — перевіряємо, що є куди. */
await click('[data-act="extnav"]');
const ext = await evaluate(`return {
  open: !!document.querySelector('.scrim .sheet'),
  opts: [...document.querySelectorAll('.sheet .opt b')].map(e => e.innerText)
}`);
ext.open && ext.opts.length === 3
  ? ok('передача в навігатор: ' + ext.opts.join(' / '))
  : bad('немає передачі в навігатор: ' + JSON.stringify(ext));
await click('[data-sheet="2"]');
!(await $('.scrim')) ? ok('шторка навігатора закрилась') : bad('шторка навігатора лишилась');

await click('[data-act="road-off"]');
const back = await evaluate(`return {
  body: document.body.classList.contains('road'),
  navShown: getComputedStyle(document.querySelector('.nav')).display !== 'none'
}`);
!back.body && back.navShown
  ? ok('вихід із дорожнього режиму повертає звичайний екран')
  : bad('після виходу екран не відновився: ' + JSON.stringify(back));
await click('[data-act="abort"]');

/* ── 10b. Покрокові підказки ─────────────────────────────────────── */
/* OSRM у цьому середовищі недоступний, тож підсовуємо синтетичну
   відповідь тієї самої форми: буква Г — 700 м на схід, поворот
   праворуч, 1100 м на південь. Перевіряємо не мережу, а математику. */
const guide = await evaluate(`
  const seg = (a, b, n) => {
    const out = [];
    for (let i = 0; i <= n; i++)
      out.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
    return out;
  };
  const A = [30.500, 50.400], B = [30.510, 50.400], C = [30.510, 50.390];
  const route = { legs: [{ steps: [
    { name: 'вулиця Перша', maneuver: { type: 'depart', modifier: 'straight' },
      geometry: { coordinates: seg(A, B, 20) } },
    { name: 'вулиця Друга', maneuver: { type: 'turn', modifier: 'right' },
      geometry: { coordinates: seg(B, C, 20) } },
    { name: '', maneuver: { type: 'arrive' }, geometry: { coordinates: [C] } }
  ] }] };
  const g = buildGuide(route);
  const at = (lat, lon) => guideWhere(g, { lat, lon });
  return {
    steps: g.steps.map(s => s.s),
    voices: g.steps.map(s => s.v),
    start: at(50.400, 30.500),
    mid:   at(50.400, 30.505),
    corner:at(50.400, 30.5099),
    aside: at(50.402, 30.505),
    total: Math.round(g.cum[g.cum.length - 1])
  };
`);
Math.abs(guide.total - 1815) < 60
  ? ok('довжина треку порахована: ' + guide.total + ' м')
  : bad('довжина треку не сходиться: ' + guide.total);
Math.abs(guide.start.toMan - 709) < 40 && guide.start.step === 0
  ? ok('до першого маневру ' + Math.round(guide.start.toMan) + ' м')
  : bad('відстань до маневру хибна: ' + JSON.stringify(guide.start));
Math.abs(guide.mid.toMan - 355) < 40
  ? ok('на середині відрізка лишається половина: ' + Math.round(guide.mid.toMan) + ' м')
  : bad('на середині порахувало ' + Math.round(guide.mid.toMan));
guide.corner.toMan < 60
  ? ok('біля повороту відстань майже нульова')
  : bad('біля повороту досі ' + Math.round(guide.corner.toMan));
/* Головне: схід міряється від ЛІНІЇ, а не від точки старту. За 220 м
   убік від прямої ми маємо бути «поза треком», а не «проїхали далеко». */
Math.abs(guide.aside.off - 222) < 30 && guide.start.off < 5
  ? ok('відхилення міряється від лінії треку: ' + Math.round(guide.aside.off) + ' м')
  : bad('відхилення рахується не так: ' + JSON.stringify({ aside: guide.aside.off, start: guide.start.off }));
/* Назва вулиці не мусить лізти в фразу — інакше виходить
   «праворуч на вулиця Друга». На екрані вона окремо, у голосі через кому. */
guide.steps[1] === 'Праворуч' && guide.voices[1] === 'Поверніть праворуч, вулиця Друга'
  ? ok('маневри перекладені без ламаних відмінків: «' + guide.steps[1] + '» / «' + guide.voices[1] + '»')
  : bad('маневр звучить не так: ' + JSON.stringify({ s: guide.steps[1], v: guide.voices[1] }));
/^Ви на місці$/.test(guide.voices[2])
  ? ok('прибуття озвучується окремо')
  : bad('прибуття звучить як: ' + guide.voices[2]);

/* Пороги озвучення мусять залежати від швидкості: пішки попереджати
   за кілометр безглуздо, на трасі за сорок метрів — пізно. */
const thresholds = await evaluate(`return {
  walk: speakPoints(1), town: speakPoints(7), road: speakPoints(25), none: speakPoints(null)
}`);
thresholds.walk[0] < thresholds.town[0] && thresholds.town[0] < thresholds.road[0]
  ? ok('пороги підказок ростуть зі швидкістю: ' + thresholds.walk[0] + ' / ' +
      thresholds.town[0] + ' / ' + thresholds.road[0] + ' м')
  : bad('пороги не залежать від швидкості: ' + JSON.stringify(thresholds));

/* Голос може бути відсутній — застосунок мусить це визнавати,
   а не вдавати, що озвучив. */
const voice = await evaluate(`
  const has = !!Voice.pick();
  const said = Voice.say('перевірка');
  return { has, said, honest: has === said };
`);
voice.honest
  ? ok(voice.has ? 'український голос є, озвучення працює'
                 : 'українського голосу немає — застосунок це визнає, а не вдає')
  : bad('Voice.say бреше про результат: ' + JSON.stringify(voice));

/* ── 11. Головний екран: карта і нижня шторка ────────────────────── */
await click('[data-nav="map"]');
await sleep(700);
const home = await evaluate(`
  const view = document.querySelector('.mapview');
  const sh = document.getElementById('msheet');
  const map = document.getElementById('lmap');
  const V0 = view.getBoundingClientRect(), M = map.getBoundingClientRect();
  const ids = [...document.querySelectorAll('#mlist .card')].map(c => c.dataset.open);
  const from = Geo.pos || P('rynok');
  const ds = ids.map(id => dist(from, P(id)));
  return {
    frac: +(sh.getBoundingClientRect().height / V0.height).toFixed(2),
    mapFills: Math.round(M.height) >= Math.round(V0.height) - 2 &&
              Math.round(M.width) >= Math.round(V0.width) - 2,
    handle: !!document.querySelector('.mgrab'),
    locme: !!document.getElementById('locme'),
    count: ids.length,
    ordered: ds.every((d, i) => i === 0 || d >= ds[i - 1] - 0.001),
    first: ids[0], firstKm: Math.round(ds[0])
  };
`);
home.frac >= 0.26 && home.frac <= 0.34
  ? ok('у спокої карта займає ' + Math.round((1 - home.frac) * 100) + '% екрана')
  : bad('шторка не в тому положенні: ' + home.frac);
home.mapFills ? ok('карта на всю площу, без рамок') : bad('карта не заповнює екран');
home.handle && home.locme
  ? ok('є ручка шторки і кнопка «до мене»')
  : bad('немає ручки або кнопки центрування: ' + JSON.stringify(home));
home.ordered && home.count === 17
  ? ok('місця відсортовані від найближчого: ' + home.first + ' (' + home.firstKm + ' км)')
  : bad('порядок за відстанню порушено: ' + JSON.stringify(home));

/* Ручка перебирає положення — для тих, хто тицяє, а не тягне. */
await click('[data-act="grab"]');
await sleep(450);
const grown = await evaluate(`
  const view = document.querySelector('.mapview');
  return +(document.getElementById('msheet').getBoundingClientRect().height /
           view.getBoundingClientRect().height).toFixed(2);
`);
grown > home.frac
  ? ok('тап по ручці розгортає шторку: ' + home.frac + ' → ' + grown)
  : bad('шторка не розгорнулась: ' + home.frac + ' → ' + grown);

/* Маршрути в тій самій шторці й теж від найближчого. */
await click('[data-tab="routes"]');
await sleep(350);
const tabRoutes = await evaluate(`
  const ids = [...document.querySelectorAll('#mlist .card')].map(c => c.dataset.route);
  const from = Geo.pos || P('rynok');
  const ds = ids.map(id => routeDist(ROUTES.find(r => r.id === id), from));
  return { ids, ordered: ds.every((d, i) => i === 0 || d >= ds[i - 1] - 0.001), first: ids[0] };
`);
tabRoutes.ids.length === 9 && tabRoutes.ordered
  ? ok('маршрути в шторці теж від найближчого: ' + tabRoutes.first)
  : bad('маршрути не відсортовані: ' + JSON.stringify(tabRoutes));
/* Кольори позначок і розпад скупчень. Плитки в цьому середовищі
   заблоковані, тож Leaflet не піднімається — перевіряємо саму логіку
   на підставленій проєкції Меркатора, а не картинку. */
const marks = await evaluate(`
  const proj = (ll, z) => {
    const s = 256 * Math.pow(2, z), rad = ll[0] * Math.PI / 180;
    return { x: (ll[1] + 180) / 360 * s,
             y: (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * s };
  };
  const stub = z => ({ getZoom: () => z, project: (ll, zz) => proj(ll, zz === undefined ? z : zz) });
  const sizes = z => clusterize(stub(z), POINTS, 58).map(g => g.length).sort((a, b) => b - a);
  const kinds = Object.keys(KIND_COLOR);
  const colors = kinds.map(k => KIND_COLOR[k].l);
  const wasTheme = V.theme;
  V.theme = 'sacral';
  const themed = markColor(P('univ'));
  V.theme = wasTheme;
  return {
    far: sizes(8), mid: sizes(11), near: sizes(15),
    uniqueColors: new Set(colors).size, kinds: kinds.length,
    perKind: new Set(POINTS.map(p => markColor(p))).size,
    themed, themeHex: THEME_COLOR.sacral.l
  };
`);
marks.far.length < marks.near.length && marks.far[0] > 1
  ? ok('на дальньому зумі точки збираються: ' + marks.far.length + ' груп замість ' +
      marks.near.length + ', найбільша — ' + marks.far[0])
  : bad('скупчення не збираються: ' + JSON.stringify(marks));
marks.near.every(n => n === 1)
  ? ok('на близькому зумі кожна точка окремо')
  : bad('на близькому зумі точки досі злиплись: ' + JSON.stringify(marks.near));
marks.uniqueColors === marks.kinds && marks.perKind === marks.kinds
  ? ok(marks.kinds + ' типів — ' + marks.kinds + ' різних кольорів, без повторів')
  : bad('кольори типів не унікальні: ' + JSON.stringify(marks));
marks.themed === marks.themeHex
  ? ok('під фільтром теми колір береться від теми')
  : bad('фільтр теми не міняє колір: ' + marks.themed + ' замість ' + marks.themeHex);
/* Легенда показує рівно ті типи, що є в поточній області. */
const leg = await evaluate(`
  const shown = document.querySelectorAll('.legend span').length;
  const kinds = new Set(regPoints().map(p => p.kind));
  return { shown, kinds: kinds.size };
`);
leg.shown === leg.kinds
  ? ok('легенда показує рівно ті типи, що є в області: ' + leg.shown)
  : bad('легенда не збігається з даними: ' + JSON.stringify(leg));

/* Пошук за назвою: іконка в шапці, живий фільтр, порожній результат. */
/* .sub малюється великими літерами через CSS, тому порівнюємо
   без урахування регістру — інакше тест сперечався б зі стилем. */
(await text('.bar .sub')).toLowerCase() === 'україни · mvp'
  ? ok('підпис під назвою: ' + await text('.bar .sub'))
  : bad('підпис не змінився: ' + await text('.bar .sub'));
await click('[data-act="search-on"]');
(await $('#q')) ? ok('пошук відкривається з шапки') : bad('поле пошуку не з’явилось');

const typed = await evaluate(`
  const el = document.getElementById('q');
  el.value = 'олеськ';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return null;
`);
await sleep(400);
const found = await evaluate(`return {
  ids: [...document.querySelectorAll('#mlist .card')].map(c => c.dataset.open),
  snap: V.snap, focused: document.activeElement && document.activeElement.id
}`);
found.ids.length === 1 && found.ids[0] === 'olesko'
  ? ok('пошук за назвою знаходить точку: ' + found.ids[0])
  : bad('пошук знайшов не те: ' + JSON.stringify(found.ids));
found.snap > 0 ? ok('шторка піднялась, щоб показати знайдене') : bad('шторка лишилась складеною');

/* Шапка шторки мусить іти за пошуком: підсвічена вкладка і лічильники.
   Спершу оновлювався тільки список, і над знайденими місцями світилося
   «Маршрути · 9». */
const headSync = await evaluate(`
  const t = [...document.querySelectorAll('.mtabs button')];
  return { pressed: t.find(b => b.getAttribute('aria-pressed') === 'true')?.dataset.tab,
           label: t[0].innerText };
`);
headSync.pressed === 'places' && /·\s*1$/.test(headSync.label.trim())
  ? ok('шапка шторки йде за пошуком: ' + headSync.label)
  : bad('шапка відстала від пошуку: ' + JSON.stringify(headSync));

/* Апостроф на телефоні набирається різними символами — усі мусять
   знаходити те саме. */
const apos = await evaluate(`
  const el = document.getElementById('q');
  const out = [];
  for (const q of ['пам\u2019ятка', "пам'ятка"]) { V.q = q; out.push(regPoints().filter(hits).length); }
  /* Рахуємо по своїй області: «Андріївська церква» є в Києві, і на
     глобальному списку тест сперечався б із тим, що застосунок
     свідомо не показує. */
  V.q = 'церква'; const churches = regPoints().filter(hits).length;
  V.q = 'олеськ'; el.value = 'олеськ';
  return { same: out[0] === out[1], churches };
`);
apos.same ? ok('різні апострофи шукають однаково') : bad('апостроф ламає пошук');
apos.churches === 2 ? ok('частковий збіг знаходить обидві церкви') : bad('частковий збіг: ' + apos.churches);

await evaluate(`
  const el = document.getElementById('q');
  el.value = 'абракадабра';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return null;
`);
await sleep(350);
(await text('#mlist')).includes('нічого не знайшли')
  ? ok('порожній результат пояснює себе')
  : bad('порожній результат мовчить: ' + (await text('#mlist')).slice(0, 60));
await shot('11-search');

await click('[data-act="search-off"]');
/* Пошук тимчасово перебиває вкладку на «Місця» — і мусить повернути
   її як було. До цього місця тест лишив відкритою вкладку маршрутів. */
const closed = await evaluate(`return {
  field: !!document.getElementById('q'), q: V.q, tab: V.mapTab,
  ids: [...document.querySelectorAll('#mlist .card')].length
}`);
!closed.field && closed.q === '' && closed.tab === 'routes' && closed.ids === 9
  ? ok('закриття пошуку повертає вкладку, що була до нього')
  : bad('після закриття пошуку щось лишилось: ' + JSON.stringify(closed));

await shot('11-home');
await click('[data-tab="places"]');

/* ── 11b. Області ────────────────────────────────────────────────── */
/* Стаємо під Києвом — застосунок мусить сам перемкнутись на Київщину
   і показати саме її точки, маршрути й банер тривоги. */
await standAt(50.1139, 30.8657);   /* Витачів */
await sleep(1200);
const kyiv = await evaluate(`return {
  region: V.region,
  places: [...document.querySelectorAll('#mlist .card')].map(c => c.dataset.open),
  alarm: document.querySelector('.over .alert')?.innerText || '',
  regsel: document.querySelector('.regsel')?.innerText.trim() || ''
}`);
kyiv.region === 'kyiv'
  ? ok('за положенням обрано Київщину')
  : bad('область не перемкнулась: ' + kyiv.region);
kyiv.places.length === 7 && kyiv.places.every(id => ['sofia','lavra','zoloti','andriiv','zamkova','vytachiv','divych'].includes(id))
  ? ok('у списку лише київські точки, найближча — ' + kyiv.places[0])
  : bad('у списку чужі точки: ' + JSON.stringify(kyiv.places));
kyiv.places[0] === 'vytachiv'
  ? ok('найближчою стала точка, на якій ми стоїмо')
  : bad('найближча не та: ' + kyiv.places[0]);
/* Банер тривоги — безпековий шар: він мусить називати ту область,
   у якій ви є, інакше він гірший за відсутній. */
kyiv.alarm.includes('Київській обл.')
  ? ok('банер тривоги назвав Київську область')
  : bad('банер лишився чужим: ' + kyiv.alarm.slice(0, 60));
kyiv.regsel === 'Київщина' ? ok('перемикач показує Київщину') : bad('перемикач: ' + kyiv.regsel);

await click('[data-tab="routes"]');
await sleep(300);
/* ROUTES живе в сторінці, не в тесті — питаємо про область там. */
const kroutes = await evaluate(`
  const ids = [...document.querySelectorAll('#mlist .card')].map(c => c.dataset.route);
  return { ids, alien: ids.filter(id => (ROUTES.find(r => r.id === id) || {}).reg !== 'kyiv') };
`);
kroutes.ids.length === 4 && !kroutes.alien.length
  ? ok('маршрути теж лише київські: ' + kroutes.ids.length)
  : bad('маршрути з чужої області: ' + JSON.stringify(kroutes));
await click('[data-tab="places"]');
await shot('11b-kyiv');

/* Пошук обмежений областю — але не мусить бути глухим кутом:
   якщо точка є в іншій області, застосунок пропонує перейти. */
await click('[data-act="search-on"]');
await evaluate(`
  const el = document.getElementById('q');
  el.value = 'олеськ';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return null;
`);
await sleep(400);
(await $('[data-goreg="lviv"]'))
  ? ok('порожній пошук підказує іншу область замість глухого кута')
  : bad('пошук мовчить про точку, яка є в іншій області');
await click('[data-goreg="lviv"]');
await sleep(500);
const jumped = await evaluate(`return {
  region: V.region, saved: S.region,
  ids: [...document.querySelectorAll('#mlist .card')].map(c => c.dataset.open)
}`);
jumped.region === 'lviv' && jumped.ids.length === 1 && jumped.ids[0] === 'olesko'
  ? ok('перехід в іншу область зберігає запит і показує знайдене')
  : bad('перехід загубив запит: ' + JSON.stringify(jumped));
jumped.saved === 'lviv'
  ? ok('вибір руками записано, щоб пережив перезапуск')
  : bad('вибір області не збережено: ' + jumped.saved);
await click('[data-act="search-off"]');

/* ── 12. Шторки замість системних діалогів ───────────────────────── */
await click('[data-nav="map"]');
await click('[data-open="tustan"]');
await click('[data-act="report"]');
(await $('.scrim .sheet')) ? ok('«повідомити про проблему» відкриває шторку') : bad('шторка не відкрилась');
(await count('.sheet .opt')) === 4 ? ok('4 варіанти скарги') : bad('варіантів скарги: ' + await count('.sheet .opt'));
await shot('09-sheet');
await click('[data-sheet="1"]');
(await $('.toast')) ? ok('після вибору показано підтвердження') : bad('немає підтвердження');
!(await $('.scrim')) ? ok('шторка закрилась') : bad('шторка лишилась відкритою');

/* ── 13. Карта без мережі ────────────────────────────────────────── */
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

/* ── 14. Помилки в консолі ───────────────────────────────────────── */
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
