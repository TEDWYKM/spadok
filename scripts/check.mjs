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
  new vm.Script(data + '\n;globalThis.__d={POINTS,ROUTES,THEMES,SIZES,BADGES,STATUS_FRESH_DAYS,ARRIVE_RADIUS_M};')
    .runInContext(ctx);
} catch (e) { bad('data.js не виконався: ' + e.message); }

const D = ctx.__d;
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
    /* Маршрут із однієї недоступної точки лишив би користувача ні з чим. */
    const routable = r.days.flat().filter(id => {
      const p = D.POINTS.find(x => x.id === id);
      return p && p.st !== 'closed' && p.st !== 'occupied';
    });
    if (!routable.length) bad(r.id + ': усі точки недоступні — маршрут не прокладеться');
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

/* ── 6. Дрібні регресії ──────────────────────────────────────────── */
if (/\balert\s*\(/.test(appCode) || /\bconfirm\s*\(/.test(appCode))
  bad('у app.js повернулися системні діалоги alert/confirm');
else ok('системних діалогів немає');

const css = readFileSync(join(www, 'css', 'app.css'), 'utf8');
[...appjs.matchAll(/class="tag ([a-z]+)"/g)].map(m => m[1])
  .filter((v, i, a) => a.indexOf(v) === i)
  .forEach(c => css.includes('.tag.' + c) ? null : bad('немає стилю .tag.' + c));
ok('усі класи статусів мають стилі');

console.log(fails ? `\n${fails} проблем.` : '\nУсе сходиться.');
process.exit(fails ? 1 : 0);
