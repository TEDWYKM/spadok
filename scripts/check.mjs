/* Перевірки цілісності перед публікацією. Запуск: node scripts/check.mjs
   Падає з кодом 1, якщо щось не сходиться — і тоді CI не деплоїть. */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const www = join(root, 'www');

let fails = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.error('  ✗ ' + m); fails++; };

/* ── 1. Файли на місці ───────────────────────────────────────────── */
const need = [
  'index.html', 'sw.js', 'manifest.webmanifest',
  'css/app.css', 'js/data.js', 'js/app.js',
  'icons/icon-192.png', 'icons/icon-512.png',
  'icons/maskable-192.png', 'icons/maskable-512.png'
];
need.forEach(f => existsSync(join(www, f)) ? null : bad('немає www/' + f));
if (!fails) ok(`усі ${need.length} обов'язкових файлів на місці`);

/* ── 2. Синтаксис скриптів ───────────────────────────────────────── */
const data = readFileSync(join(www, 'js', 'data.js'), 'utf8');
const appjs = readFileSync(join(www, 'js', 'app.js'), 'utf8');
for (const [name, src] of [['data.js', data], ['app.js', appjs], ['sw.js', readFileSync(join(www, 'sw.js'), 'utf8')]]) {
  try { new vm.Script(src, { filename: name }); ok('синтаксис ' + name); }
  catch (e) { bad(name + ': ' + e.message); }
}

/* ── 3. Дані ─────────────────────────────────────────────────────── */
const ctx = { console };
try {
  vm.createContext(ctx);
  new vm.Script(data + '\n;globalThis.__d={POINTS,ROUTES,THEMES,SIZES,BADGES,' +
    'STATUS_FRESH_DAYS,STATUS_STALE_DAYS,ARRIVE_RADIUS_M};')
    .runInContext(ctx);
} catch (e) { bad('data.js не виконався: ' + e.message); }

const D = ctx.__d;
const age = p => Math.floor((Date.now() - new Date(p.upd).getTime()) / 864e5);
if (D) {
  const ids = D.POINTS.map(p => p.id);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  dup.length ? bad('дублікати id точок: ' + dup.join(', ')) : ok(`${ids.length} точок, id унікальні`);

  const themes = Object.keys(D.THEMES);
  D.POINTS.forEach(p => {
    if (typeof p.lat !== 'number' || typeof p.lon !== 'number') bad(p.id + ': немає координат');
    if (p.lat < 44 || p.lat > 53 || p.lon < 22 || p.lon > 41) bad(p.id + ': координати поза Україною');
    if (!['ok', 'warn', 'closed', 'occupied'].includes(p.st)) bad(p.id + ': невідомий статус ' + p.st);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.upd)) bad(p.id + ': upd має бути ISO-датою, а не ' + p.upd);
    if (!p.t.length) bad(p.id + ': немає жодної теми');
    p.t.forEach(t => themes.includes(t) ? null : bad(p.id + ': невідома тема ' + t));
    if (!p.s || !p.f) bad(p.id + ': порожній опис');
    if (!p.note) bad(p.id + ': немає попередження для мандрівника');
    if (!(p.rate >= 1 && p.rate <= 5)) bad(p.id + ': рейтинг поза 1–5');
  });
  ok('поля точок валідні');

  const rids = D.ROUTES.map(r => r.id);
  const rdup = rids.filter((x, i) => rids.indexOf(x) !== i);
  rdup.length ? bad('дублікати id маршрутів: ' + rdup.join(', ')) : ok(`${rids.length} маршрутів, id унікальні`);

  const used = new Set();
  D.ROUTES.forEach(r => {
    if (!D.SIZES[r.size]) bad(r.id + ': невідомий розмір ' + r.size);
    if (!ids.includes(r.from)) bad(r.id + ': база ' + r.from + ' не існує');
    if (!r.days.length) bad(r.id + ': немає жодного дня');
    r.days.forEach((d, i) => {
      if (!d.length) bad(r.id + ': день ' + (i + 1) + ' порожній');
      d.forEach(id => {
        used.add(id);
        if (!ids.includes(id)) bad(r.id + ': точка ' + id + ' не існує');
      });
    });
    /* Той самий фільтр, що й routable() в app.js: закрито, під окупацією
       або перевірка протухла. День без жодної прохідної точки рендериться
       порожнім, тому це перевіряється по днях, а не лише по маршруту. */
    r.days.forEach((d, i) => {
      const pass = d.filter(id => {
        const p = D.POINTS.find(x => x.id === id);
        return p && p.st !== 'closed' && p.st !== 'occupied' && age(p) <= D.STATUS_STALE_DAYS;
      });
      if (d.length && !pass.length)
        bad(r.id + ', день ' + (i + 1) + ': жодної прохідної точки — трек буде порожній');
    });
  });
  ok('маршрути посилаються тільки на наявні точки');

  const orphans = ids.filter(id => !used.has(id));
  orphans.length
    ? console.log('  · точки без маршруту: ' + orphans.join(', '))
    : ok('кожна точка входить хоча б в один маршрут');

  const bids = D.BADGES.map(b => b.id);
  const bdup = bids.filter((x, i) => bids.indexOf(x) !== i);
  bdup.length ? bad('дублікати id нагород: ' + bdup.join(', ')) : ok(`${bids.length} нагород, id унікальні`);

  /* Нагороди, умови яких перевіряються по id точок у app.js. */
  const refd = [...appjs.matchAll(/'([a-z]+)'/g)].map(m => m[1]);
  ['olesko', 'pidhirtsi', 'zolochiv', 'potelych', 'drohobych', 'tustan'].forEach(id => {
    if (!ids.includes(id)) bad('умова нагороди посилається на неіснуючу точку ' + id);
    if (!refd.includes(id)) bad('точка ' + id + ' зникла з умов нагород у app.js');
  });
  ok('умови нагород сходяться з даними');

  if (!(D.ARRIVE_RADIUS_M > 0)) bad('ARRIVE_RADIUS_M не заданий');
  if (!(D.STATUS_FRESH_DAYS > 0)) bad('STATUS_FRESH_DAYS не заданий');
  if (!(D.STATUS_STALE_DAYS > D.STATUS_FRESH_DAYS))
    bad('STATUS_STALE_DAYS має бути більшим за STATUS_FRESH_DAYS');

  /* ── Свіжість самих даних ──────────────────────────────────────────
     Це не перевірка коду, а перевірка того, що хтось таки ходив
     і звіряв статуси. Спека, правило 2: протухлі точки випадають
     з продукту, тож випускати реліз із ними — випускати діри. */
  const stale = D.POINTS.filter(p => age(p) > D.STATUS_FRESH_DAYS && age(p) <= D.STATUS_STALE_DAYS);
  const gone = D.POINTS.filter(p => age(p) > D.STATUS_STALE_DAYS);
  if (gone.length)
    bad(`перевірка статусу протухла (>${D.STATUS_STALE_DAYS} дн.) у ${gone.length} точок: ` +
      gone.map(p => p.id).join(', ') + '. Звірте доступність і оновіть upd у data.js');
  else if (stale.length)
    console.log(`  · перевірка застаріла (>${D.STATUS_FRESH_DAYS} дн.) у ${stale.length} точок: ` +
      stale.map(p => p.id).join(', '));
  else ok('перевірки статусу свіжі в усіх точках');
}

/* ── 4. Манифест ─────────────────────────────────────────────────── */
try {
  const m = JSON.parse(readFileSync(join(www, 'manifest.webmanifest'), 'utf8'));
  ['name', 'short_name', 'start_url', 'display', 'icons'].forEach(k =>
    m[k] ? null : bad('manifest: немає ' + k));
  m.icons.forEach(i => existsSync(join(www, i.src)) ? null : bad('manifest: немає ' + i.src));
  if (!m.icons.some(i => i.purpose === 'maskable')) bad('manifest: немає maskable-іконки');
  ok('manifest валідний, іконки на місці');
} catch (e) { bad('manifest: ' + e.message); }

/* Прибирає комментарі, але не чіпає рядки — інакше згадка alert()
   у пояснювальному комментарі виглядала б як справжній виклик,
   а 'https://…' у рядку — як початок комментаря. */
function stripComments(src) {
  let out = '', i = 0, s = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (s) {
      if (c === '\\') { out += c + (src[i + 1] || ''); i += 2; continue; }
      if (c === s) s = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { s = c; out += c; i++; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    out += c; i++;
  }
  return out;
}
const appCode = stripComments(appjs);

/* ── 5. Головне правило продукту ─────────────────────────────────── */
/* Прототип показував зорепад без відвідин. Це regression-тест на те,
   що гейт не зникне при наступному рефакторингу. */
if (!/if\s*\(!vis\)/.test(appCode)) bad('ratingBlock без перевірки відвідин — гейт зник');
else if (!/const vis = S\.visits\[id\];[\s\S]{0,200}if \(!vis\)/.test(appCode))
  bad('saveReview без перевірки відвідин — гейт можна обійти');
else ok('гейт «оцінка тільки після відвідин» на місці');

/* Правило 2 колись існувало тільки на папері: recommended() був
   оголошений і ніде не використаний, а протухла перевірка ніяк
   не впливала на трек. Обидва regression-тести — щоб не повторилось. */
if (!/const routable = p =>[^\n]*!expired\(p\)/.test(appCode))
  bad('routable() не враховує протухлу перевірку — правило 2 знову декоративне');
else if ((appCode.match(/recommended\(/g) || []).length < 2)
  bad('recommended() оголошений, але ніде не використаний');
else ok('правило 2 доведене до сортування і до треку');

/* ── 6. Дрібні регресії ──────────────────────────────────────────── */
if (/\balert\s*\(/.test(appCode) || /\bconfirm\s*\(/.test(appCode))
  bad('у app.js повернулися системні діалоги alert/confirm');
else ok('системних діалогів немає');

const css = readFileSync(join(www, 'css', 'app.css'), 'utf8');
[...appjs.matchAll(/class="tag ([a-z]+)"/g)].map(m => m[1])
  .filter((v, i, a) => a.indexOf(v) === i)
  .forEach(c => css.includes('.tag.' + c) ? null : bad('немає стилю .tag.' + c));
ok('усі класи статусів мають стилі');

/* ── 7. Дорожній режим ───────────────────────────────────────────── */
/* Він майже цілком тримається на CSS: без правил це буде не
   повноекранна навігація, а звичайний екран із дивними написами. */
['roadv', 'rtop', 'rnext', 'rbot', 'rarrow', 'rclose', 'reta', 'me']
  .forEach(c => css.includes('.' + c) ? null : bad('немає стилю .' + c + ' — дорожній режим без вигляду'));
if (!/body\.road/.test(css)) bad('немає правил body.road — рамка й навігація не сховаються');
else ok('дорожній режим має свої стилі');

/* Правило 5 спеки: атрибуція OSM обов'язкова на кожній карті,
   і темна підкладка в дорожньому режимі — не виняток. */
if (/attributionControl:\s*false/.test(appCode))
  bad('атрибуцію карти вимкнено — це порушення ліцензії ODbL і правила 5');
else ok('атрибуція карти нізвідки не вимикається');

/* Головний екран майже цілком тримається на CSS: без правил шторка
   не буде шторкою, а карта не займе екран. */
['mapview', 'msheet', 'mgrab', 'mtabs', 'mlist', 'locme']
  .forEach(c => css.includes('.' + c) ? null : bad('немає стилю .' + c + ' — головний екран розсиплеться'));
if (!/body\.mapv/.test(css)) bad('немає правил body.mapv — карта не займе екран');
else ok('головний екран має свої стилі');

/* Клас-модифікатор на body і клас контейнера колись збіглися, і весь
   застосунок стиснувся вдвічі: селектор .mapv чіпляв і сам <body>. */
if (/^\.mapv\{/m.test(css))
  bad('.mapv як самостійний селектор зачепить і <body class="mapv"> — перейменуйте контейнер');
else ok('модифікатор body і контейнер карти не конфліктують');

/* Перестановка точок під користувача не має права ламати маршрути,
   у яких порядок і є змістом. */
if (!/r\.ord/.test(appCode))
  bad('buildPlan не дивиться на r.ord — сюжетні маршрути будуть переставлятись');
else ok('сюжетні маршрути захищені від перестановки');
if (D) {
  const story = D.ROUTES.filter(r => r.ord).map(r => r.id);
  story.includes('defense')
    ? ok('порядок «Оборонної дуги» позначений як сюжетний')
    : bad('«Оборонна дуга» втратила ord:true — її хронологію переставить перший же старт');
}

console.log(fails ? `\n${fails} проблем.` : '\nУсе сходиться.');
process.exit(fails ? 1 : 0);
