/* Перевірки цілісності перед публікацією. Запуск: node scripts/check.mjs
   Падає з кодом 1, якщо щось не сходиться — і тоді CI не деплоїть. */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { SHELL_FILES, STAMP, fingerprint, readVersion } from './version.mjs';

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
    'STATUS_FRESH_DAYS,STATUS_STALE_DAYS,ARRIVE_RADIUS_M,KIND_COLOR,THEME_COLOR,REGIONS};')
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
  });
  ok('поля точок валідні');

  /* Спільної оцінки місця в даних бути не може: поки голоси не стали
     спільними, її просто немає. «4.6 · 1240 оцінок» у демо-наборі були
     єдиною річчю в застосунку, яка прямо казала неправду. */
  const faked = D.POINTS.filter(p => p.rate != null || p.cnt != null).map(p => p.id);
  faked.length
    ? bad('у даних повернулися вигадані рейтинги (' + faked.slice(0, 3).join(', ') +
      '…) — спільна думка зʼявиться тільки разом із сервером')
    : ok('вигаданих рейтингів у даних немає');

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

  /* ── Області ─────────────────────────────────────────────────────
     Точка чи маршрут без області провалюються між екранами: їх не
     показує жоден список, і помітити це на око майже неможливо. */
  const regs = Object.keys(D.REGIONS);
  D.POINTS.forEach(p => regs.includes(p.reg)
    ? null : bad(p.id + ': невідома або відсутня область — ' + p.reg));
  D.ROUTES.forEach(r => {
    if (!regs.includes(r.reg)) { bad(r.id + ': невідома або відсутня область — ' + r.reg); return; }
    /* Маршрут не має права вести до чужої області: база в одній,
       точки в іншій — це подорож через пів країни. */
    const alien = r.days.flat().filter(id => {
      const p = D.POINTS.find(x => x.id === id);
      return p && p.reg !== r.reg;
    });
    if (alien.length) bad(r.id + ' (' + r.reg + '): точки з чужої області — ' + alien.join(', '));
    const base = D.POINTS.find(p => p.id === r.from);
    if (base && base.reg !== r.reg) bad(r.id + ': база ' + r.from + ' з області ' + base.reg);
  });
  regs.forEach(k => {
    const base = D.POINTS.find(p => p.id === D.REGIONS[k].base);
    if (!base) bad('область ' + k + ': бази ' + D.REGIONS[k].base + ' не існує');
    else if (base.reg !== k) bad('область ' + k + ': база ' + base.id + ' належить ' + base.reg);
    if (!D.POINTS.some(p => p.reg === k)) bad('область ' + k + ' порожня');
    if (!D.ROUTES.some(r => r.reg === k)) bad('область ' + k + ' без жодного маршруту');
  });
  ok(regs.length + ' області: точки, маршрути й бази не перетинаються');

  /* Нагороди, прив'язані до області, мусять посилатись на неї ж. */
  D.BADGES.forEach(b => {
    if (b.reg && !regs.includes(b.reg)) bad('нагорода ' + b.id + ': невідома область ' + b.reg);
  });
  regs.forEach(k => D.BADGES.some(b => b.reg === k)
    ? null : bad('в області ' + k + ' немає жодної власної нагороди'));
  ok('нагороди розподілені по областях');

  /* Палітра позначок і дані мусять сходитись в обидва боки. Саме ця
     перевірка знайшла, що Тустань — єдина наскельна фортеця набору —
     лежала як звичайна руїна, і пʼятий колір не діставався нікому. */
  const usedKinds = new Set(D.POINTS.map(p => p.kind));
  Object.keys(D.KIND_COLOR).forEach(k => usedKinds.has(k)
    ? null
    : bad('тип ' + k + ' має колір, але жодної точки — колір мертвий'));
  usedKinds.forEach(k => D.KIND_COLOR[k]
    ? null
    : bad('тип ' + k + ' є в точках, але не має кольору'));
  Object.keys(D.THEMES).forEach(t => D.THEME_COLOR[t]
    ? null
    : bad('тема ' + t + ' не має кольору'));
  const hexes = Object.values(D.KIND_COLOR).map(c => c.l);
  new Set(hexes).size === hexes.length
    ? ok('кожен тип має власний колір, і кожен колір комусь дістається')
    : bad('кольори типів повторюються: ' + hexes.join(', '));

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
if (!/if\s*\(!vis\)/.test(appCode)) bad('voteBlock без перевірки відвідин — гейт зник');
else if (!/const vis = S\.visits\[id\];[\s\S]{0,200}if \(!vis\)/.test(appCode))
  bad('saveVote без перевірки відвідин — гейт можна обійти');
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
['mapview', 'msheet', 'mgrab', 'mtabs', 'mlist', 'locme', 'mkchip', 'mkav']
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

/* ── 8. Версія релізу ────────────────────────────────────────────────
   Найдорожчий баг цього проєкту не був помітний зсередини: VERSION
   у sw.js лишалась 'v1' сім релізів поспіль. Автор бачив зміни завжди,
   бо відкривав з диска; усі інші сиділи на оболонці з кешу й не мали
   способу дізнатися, що вона стара. Тому перевірка тут груба: змінили
   оболонку — підніміть версію, інакше збірки не буде. */
const sw = readFileSync(join(www, 'sw.js'), 'utf8');

if (!existsSync(STAMP)) {
  bad('немає release.json — запустіть node scripts/release.mjs');
} else {
  const stamp = JSON.parse(readFileSync(STAMP, 'utf8'));
  const seen = {
    'package.json': readVersion('package.json'),
    'www/sw.js': readVersion('www/sw.js'),
    'www/js/data.js': readVersion('www/js/data.js'),
    'release.json': stamp.version
  };
  const uniq = [...new Set(Object.values(seen))];

  if (uniq.length !== 1 || !uniq[0])
    bad('версія розійшлася по файлах: ' +
      Object.entries(seen).map(([k, v]) => k + '=' + v).join(', ') +
      '. Лікується: node scripts/release.mjs');
  else if (!/^\d+\.\d+\.\d+$/.test(uniq[0]))
    bad('версія має вигляд major.minor.patch, а не «' + uniq[0] + '»');
  else
    ok('версія ' + uniq[0] + ' однакова в package.json, sw.js, data.js і release.json');

  const fp = fingerprint();
  if (fp.digest !== stamp.digest) {
    const changed = SHELL_FILES.filter(f => fp.files[f] !== (stamp.files || {})[f]);
    bad('оболонка змінилася, а версія — ні (' + seen['package.json'] + '). ' +
      'Люди, які вже відкривали застосунок, лишаться на старій.\n' +
      '      Змінилося: ' + (changed.join(', ') || 'склад файлів') + '\n' +
      '      Лікується: node scripts/release.mjs');
  } else ok('відбиток оболонки збігається з випущеною версією');
}

/* Кеш плиток не має права залежати від версії застосунку: людина
   викачує область для офлайну свідомо, часом через мобільний інтернет
   у дорозі, і черговий реліз не сміє стерти ці мегабайти. */
if (/spadok-tiles-'\s*\+\s*VERSION\b/.test(sw))
  bad('кеш плиток привʼязаний до версії застосунку — реліз зітре людям викачану карту');
else ok('викачана офлайн-карта переживає реліз');

/* caches.keys() на GitHub Pages повертає й кеші сусідніх проєктів
   того самого акаунта: origin у них спільний. */
if (!/indexOf\('spadok-'\)\s*===?\s*0|startsWith\('spadok-'\)/.test(sw))
  bad('чистка кешів не обмежена префіксом spadok- — зітремо чужі проєкти на тому ж домені');
else ok('чистка кешів чіпає тільки свої');

/* Банер «є нова версія» має вмикатись від оновлення, а не від першого
   встановлення, і тільки коли нова оболонка вже докачалась. */
const regBlock = (appCode.match(/'serviceWorker' in navigator[\s\S]{0,1200}/) || [''])[0];
if (!/swUpdate = true/.test(regBlock))
  bad('банер оновлення ніде не вмикається — нову версію ніхто не помітить');
else if (!/controller/.test(regBlock))
  bad('updatefound без перевірки контролера — банер вискочить на першому ж встановленні');
else if (!/'installed'/.test(regBlock))
  bad('банер зʼявляється до того, як нова версія докачалась — кнопка «Оновити» нічого не дасть');
else ok('банер оновлення відрізняє встановлення від оновлення');

/* ── 9. Поїздка до однієї точки ──────────────────────────────────────
   Вона свідомо зроблена маршрутом з одного дня й однієї зупинки, щоб
   іти тим самим кодом, що й подорож. Ціна такого рішення — кілька
   місць, де забути про неї легко й непомітно. Саме їх тут і сторожимо. */
if (/ROUTES\.find\(x => x\.id === V\.route\)/.test(appCode))
  bad('маршрут подорожі шукають напряму в ROUTES — поїздки до однієї точки там немає, ' +
    'екран мовчки отримає null. Єдині двері — R()');
else if (!/function R\(id\)/.test(appCode))
  bad('немає R() — резолвера маршруту подорожі');
else ok('маршрут подорожі скрізь береться через R()');

if (!/data-act="route-here"/.test(appCode))
  bad('у картці точки немає кнопки «Прокласти маршрут сюди»');
else if (!/function routeHere/.test(appCode))
  bad('кнопка є, обробника немає');
else ok('маршрут до однієї точки прокладається з картки');

/* Маршрут — кільце з поверненням до бази, поїздка — відрізок.
   Повернення, дописане повз endLeg(), означало б, що людину після
   однієї памʼятки ведуть «додому» через базу області. */
if (/concat\([^;]*,\s*\[P\(r\.from\)\]\)/.test(appCode))
  bad('повернення до бази дописане повз endLeg() — поїздку до однієї точки зроблять кільцем');
else if (!/const endLeg =/.test(appCode))
  bad('немає endLeg() — нічим відрізнити маршрут від поїздки');
else ok('повернення до бази йде тільки через endLeg()');

/* Правило 3 має єдиний виняток — і він мусить лишатися свідомим.
   Без inTrack() підтверджена людиною поїздка до зачиненої точки
   малювала б порожній трек: точку відсіяв би той самий фільтр. */
/* Перевіряємо саме restOfDay(): це та функція, що вирішує, які точки
   лягають у трек прямо зараз. Достатньо їй повернутися до голого
   routable() — і підтверджена людиною поїздка малюватиме порожній
   трек, бо єдину точку відсіє той самий фільтр, від якого її щойно
   свідомо звільнили. */
const restBlock = (appCode.match(/function restOfDay\(r\)[\s\S]{0,500}?\n\}/) || [''])[0];
if (!/const inTrack =/.test(appCode))
  bad('немає inTrack() — після згоди людини єдина точка треку зникне за правилом 3');
else if (!/inTrack\(r, id\)/.test(restBlock))
  bad('restOfDay() фільтрує повз inTrack() — підтверджена поїздка отримає порожній трек');
else if ((appCode.match(/inTrack\(r, id\)/g) || []).length < 3)
  bad('inTrack() застосований не скрізь, де будується трек');
else ok('виняток із правила 3 діє тільки там, де людина його підтвердила');

/* І він мусить бути саме підтвердженим, а не мовчазним. */
if (!/routeHere[\s\S]{0,900}'occupied'/.test(appCode) ||
    !/routeHere[\s\S]{0,900}expired\(p\)/.test(appCode))
  bad('routeHere() не попереджає про статус — правило 3 обходиться мовчки');
else ok('перед поїздкою до непідтвердженої точки людину попереджають');

/* Поїздка до однієї точки не маршрут: інакше «Довга дорога»
   діставалася б за поїздку до сусідньої церкви. */
if (!/!r\.solo && S\.done/.test(appCode))
  bad('поїздка до однієї точки йде в «маршрути пройдено» — лічильник перестане щось означати');
else ok('одна точка не зараховується як пройдений маршрут');

/* ── 10. Кабінет ─────────────────────────────────────────────────────
   Профіль і журнал подорожей. Дані локальні, але за формою це вже
   акаунт, і найдорожча помилка тут — не зламаний екран, а тихо
   записані зайві дані. */

/* Схема живе в трьох місцях: початковий стан, міграція і очищення
   прогресу. Розійтись їм не можна: reset зі старим номером мовчки
   відкотив би людину на попередню схему. */
const upBlock = (appCode.match(/function upgrade\(s\)[\s\S]{0,1600}?\n {2}\}/) || [''])[0];
const resetBlock = (appCode.match(/function resetProgress\(\)[\s\S]{0,1200}?\n\}/) || [''])[0];
const vStart = (appCode.match(/let S = \{\s*\n?\s*v: (\d+)/) || [])[1];
/* Міграція проходить сходинками (v3 → v4 → v5), тож у ній кілька
   присвоєнь. Цікавить остання: саме до неї підіймається схема. */
const vUp = (upBlock.match(/s\.v = (\d+)/g) || [])
  .map(m => m.replace(/\D/g, ''))
  .sort((a, b) => a - b)
  .pop();
const vReset = (resetBlock.match(/v: (\d+)/) || [])[1];
if (!vStart || !vUp || !vReset)
  bad('не знайшов версію схеми в одному з трьох місць: стан, upgrade(), resetProgress()');
else if (!(vStart === vUp && vUp === vReset))
  bad('версія схеми розійшлася: стан=' + vStart + ', upgrade=' + vUp + ', reset=' + vReset);
else ok('схема даних v' + vStart + ' однакова в стані, міграції й очищенні');

/* Історію за минуле вигадувати не можна: у штампів є час, і згрупувати
   їх по днях виглядало б красиво — але це були б подорожі, яких
   застосунок не бачив, із вигаданими кілометрами. */
if (!/trips = \[\]/.test(upBlock))
  bad('upgrade() не заводить порожній журнал подорожей');
else if (/s\.visits/.test(upBlock))
  bad('upgrade() зазирає у штампи — схоже на спробу вигадати історію заднім числом');
else ok('міграція починає журнал із чистого аркуша, а не вигадує минуле');

/* Головне правило кабінету. Подорож — це «був у такій точці такого
   дня». Щойно в запис потрапляють координати, це вже журнал
   переміщень людини, а спека, правило 6, каже про них окремо. */
const tripBlock = (appCode.match(/function tripStart\(r\)[\s\S]{0,900}?\n\}/) || [''])[0];
if (!tripBlock) bad('немає tripStart() — журнал подорожей нічим не вести');
else if (/\blat\b|\blon\b|Geo\.pos/.test(tripBlock))
  bad('у запис подорожі потрапляють координати — це вже трек, а не журнал (правило 6)');
else ok('запис подорожі не містить координат');

/* Журнал, який десь перестали вести, гірший за відсутній: людина
   бачить дірку й не розуміє, чого бракує. */
if (!/V\.plan = buildPlan[\s\S]{0,240}tripStart\(r\)/.test(appCode))
  bad('startJourney() не відкриває запис у журналі — подорожі не записуватимуться');
else if (!/S\.visits\[id\] = \{[\s\S]{0,400}tripVisit\(id\)/.test(appCode))
  bad('registerVisit() не додає точку в журнал — подорожі будуть без зупинок');
else if (!/V\.ended = true;[\s\S]{0,160}tripEnd\(/.test(appCode))
  bad('подорож не закривається в журналі — усі записи лишаться «триває»');
else ok('журнал ведеться від старту до фінішу');

/* Прогрес і акаунт — різні речі, і кнопки мусять робити різне.
   «Очистити прогрес» стирає пройдене й лишає профіль; «Видалити
   акаунт» стирає все. Якби вони робили одне й те саме, одна з них
   брехала б назвою. */
const delBlock = (appCode.match(/function deleteAccount\(\)[\s\S]{0,1400}?\n\}/) || [''])[0];
if (!/trips: \[\]/.test(resetBlock))
  bad('очищення прогресу лишає журнал подорожей');
else if (/me: null/.test(resetBlock))
  bad('очищення прогресу стирає й профіль — тоді воно нічим не відрізняється від видалення акаунта');
else if (!delBlock)
  bad('немає deleteAccount() — Google Play вимагає шлях видалення акаунта в самому застосунку');
else if (!/me: null/.test(delBlock) || !/Store\.clear\(\)/.test(delBlock))
  bad('видалення акаунта лишає профіль або сховище — це неповне видалення');
else ok('очищення прогресу й видалення акаунта роблять різні речі');

['mehead', 'meav', 'mename', 'cabtabs', 'pchip', 'sigils']
  .forEach(c => css.includes('.' + c) ? null : bad('немає стилю .' + c + ' — кабінет розсиплеться'));
ok('кабінет має свої стилі');

/* ── 11. Google Play ─────────────────────────────────────────────────
   Речі, через які пакет не приймуть або приймуть і потім знімуть.
   Дізнаватись про них у Play Console, після реєстрації, підпису
   й двох тижнів закритого тесту, — найдорожчий спосіб. */

/* Політика конфіденційності обовʼязкова: без адреси не заповнити форму
   Data safety. Вона віддається з тих самих Pages, що й застосунок. */
const privPath = join(www, 'privacy.html');
if (!existsSync(privPath)) {
  bad('немає www/privacy.html — без політики конфіденційності Play не пустить');
} else {
  const priv = readFileSync(privPath, 'utf8');
  /* Найлегше місце збрехати не зі зла, а недоглядом: написати «нічого
     не передаємо» і забути, що тайл-сервер і OSRM таки дещо бачать.
     OSRM отримує справжні координати — це має бути названо. */
  if (!/OSRM/i.test(priv))
    bad('політика мовчить про OSRM, якому йдуть справжні координати — це неправда за замовчуванням');
  else if (!/OpenStreetMap|CARTO/i.test(priv))
    bad('політика мовчить про сервери карт, які бачать IP і район перегляду');
  else ok('політика конфіденційності називає й сторонні сервіси');

  if (/ПОШТА@ПРИКЛАД/.test(priv))
    console.log('  · у політиці лишилась заглушка ПОШТА@ПРИКЛАД — Play вимагає робочий контакт');
}

/* У релізній збірці WebView не має відкриватися для інспектування
   з підключеного комп'ютера. */
try {
  const capCfg = JSON.parse(readFileSync(join(root, 'capacitor.config.json'), 'utf8'));
  (capCfg.android || {}).webContentsDebuggingEnabled === false
    ? ok('налагодження WebView вимкнене для релізу')
    : bad('webContentsDebuggingEnabled не false — реліз піде з відкритим для інспектування WebView');
} catch (e) { bad('capacitor.config.json: ' + e.message); }

/* Планку targetSdk можна «полагодити», просто знизивши число в скрипті.
   Тоді збірка пройде, а Play відмовить — тобто перевірка перетвориться
   на свою протилежність. */
if (existsSync(join(root, 'scripts', 'patch-android.mjs'))) {
  const pa = readFileSync(join(root, 'scripts', 'patch-android.mjs'), 'utf8');
  const need = Number((pa.match(/PLAY_TARGET_SDK\s*=\s*(\d+)/) || [])[1]);
  if (!need) bad('у patch-android.mjs немає PLAY_TARGET_SDK — планку Play ніхто не стереже');
  else if (need < 36) bad('PLAY_TARGET_SDK знижений до ' + need + ' — Play вимагає щонайменше 36');
  else ok('планка targetSdk для Play на місці: ' + need);
}

/* ── 12. Вердикт ─────────────────────────────────────────────────────
   Мінус без причини — той самий замовчаний мінус: він каже, що щось
   не так, і не каже що. Уся цінність цієї заміни тримається на тому,
   що причина обовʼязкова. */
if (!/const VOTE_REASONS/.test(appCode))
  bad('немає VOTE_REASONS — мінус нічим пояснити');
else if (!/d\.v < 0 && !d\.reason/.test(appCode))
  bad('мінус приймається без причини — downvote знову став анонімним');
else if ((appCode.match(/d\.v < 0 && !d\.reason/g) || []).length < 2)
  bad('вимога причини стоїть лише в одному місці — інтерфейс або збереження її не питає');
else ok('мінус без причини не приймається ні в інтерфейсі, ні при збереженні');

if (/starPicker|S\.ratings/.test(appCode))
  bad('у коді лишилися пʼятизіркові оцінки поруч із вердиктом — дві шкали одночасно');
else ok('пʼятизіркова шкала прибрана цілком');

/* Спільної оцінки немає, і застосунок не має вдавати протилежне. */
if (!/Спільної оцінки місця поки немає/.test(appjs))
  bad('застосунок не каже, що спільної оцінки ще немає — мовчання тут читається як «її нема кому дати»');
else ok('відсутність спільної оцінки названа прямо');

['vtag', 'vbtn', 'reasons', 'rsn']
  .forEach(c => css.includes('.' + c) ? null : bad('немає стилю .' + c + ' — вердикт розсиплеться'));
if (/^\.stars\{/m.test(css)) bad('у CSS лишилися стилі зірок, яких більше ніхто не малює');
else ok('вердикт має свої стилі, а мертвих стилів зірок немає');

/* ── 13. Безпекова плашка ────────────────────────────────────────────
   Банер повітряної тривоги прибраний свідомо: майже в кожного вже
   є застосунок сповіщень, який робить це краще й офіційно, а наш
   показував демо-стан. Неправдиве «тривоги немає» в застосунку,
   яким користуються в Україні, — не заглушка того ж роду, що
   намальоване фото: людина може повірити.

   Це саме та річ, яку легко повернути з добрих намірів. Тому гейт. */
if (/Повітряна тривога|alarmApi|const Alarms/.test(appCode) || /alarm:/.test(data))
  bad('безпекова плашка повернулася — показувати стан тривоги з демо-даних не можна ' +
    '(а зі справжніх це робота застосунків сповіщень, не нашого)');
else if (!/HOURS_WARNING/.test(appCode))
  bad('немає нагадування про графіки роботи — прибрали плашку й нічого не лишили');
else if ((appCode.match(/HOURS_WARNING/g) || []).length < 3)
  bad('нагадування про графіки стоїть менш ніж у двох місцях — його не побачать перед виїздом');
else ok('замість стану тривоги — нагадування, що графіки плавають');

/* ── 14. Режим «уся Україна» ─────────────────────────────────────────
   Звуження до регіону — розумний стан за замовчуванням, але не вʼязниця.
   Ламається це тихо: досить одному екрану фільтрувати точки напряму
   замість regPoints(), і в режимі всієї країни він покаже лише свій
   регіон, ніде про це не сказавши. */
if (!/const isAll =/.test(appCode))
  bad('немає isAll() — режиму всієї країни нічим відрізнити');
else if (!/regPoints = \(\) => isAll\(\)/.test(appCode) ||
         !/regRoutes = \(\) => isAll\(\)/.test(appCode) ||
         !/regBadges = \(\) => isAll\(\)/.test(appCode))
  bad('точки, маршрути або нагороди не знають про режим усієї країни');
/* Одне входження — це саме визначення regPoints(). Друге вже означає,
   що хтось відфільтрував точки в обхід. */
else if ((appCode.match(/POINTS\.filter\(p => p\.reg === REG\(\)\)/g) || []).length > 1)
  bad('десь точки фільтруються по області повз regPoints() — у режимі всієї країни ' +
    'цей екран мовчки покаже лише свій регіон');
else {
  /* Той самий урок, що й з recommended(): оголосити мало, треба ще
     й викликати. Функція, яка знає про режим і нікому не потрібна,
     означає, що екран фільтрує по-своєму. */
  const idle = ['regPoints', 'regRoutes', 'regBadges']
    .filter(f => !(appCode.match(new RegExp(f + '\\(\\)', 'g')) || []).length);
  idle.length
    ? bad(idle.join(', ') + ' оголошені, але ніде не викликаються — ' +
      'десь точки, маршрути або нагороди звужуються в обхід')
    : ok('режим усієї країни проходить крізь усі списки');
}

console.log(fails ? `\n${fails} проблем.` : '\nУсе сходиться.');
process.exit(fails ? 1 : 0);
