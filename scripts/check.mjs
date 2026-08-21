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

  /* ── Історико-географічні регіони ────────────────────────────────
     Точка чи маршрут без регіону провалюються між екранами: їх не
     показує жоден список, і помітити це на око майже неможливо.

     Порожній регіон тут — НЕ помилка. Набір покриває два регіони
     з пʼятнадцяти, і решта чекає на контент; вимагати точку в кожному
     означало б вимагати їх вигадати. Але порожнім він має бути
     видимо: за це відповідає окремий гейт нижче. */
  const regs = Object.keys(D.REGIONS);
  D.POINTS.forEach(p => regs.includes(p.reg)
    ? null : bad(p.id + ': невідомий або відсутній регіон — ' + p.reg));
  D.ROUTES.forEach(r => {
    if (!regs.includes(r.reg)) { bad(r.id + ': невідомий або відсутній регіон — ' + r.reg); return; }
    /* Маршрут не має права вести до чужого регіону: база в одному,
       точки в іншому — це подорож через пів країни. */
    const alien = r.days.flat().filter(id => {
      const p = D.POINTS.find(x => x.id === id);
      return p && p.reg !== r.reg;
    });
    if (alien.length) bad(r.id + ' (' + r.reg + '): точки з чужого регіону — ' + alien.join(', '));
    const base = D.POINTS.find(p => p.id === r.from);
    if (base && base.reg !== r.reg) bad(r.id + ': база ' + r.from + ' з регіону ' + base.reg);
  });

  const filled = regs.filter(k => D.POINTS.some(p => p.reg === k));
  if (!filled.length) bad('жодного наповненого регіону — застосунок порожній');
  regs.forEach(k => {
    const R = D.REGIONS[k];
    if (!R.n) bad('регіон ' + k + ' без назви');
    if (typeof R.lat !== 'number' || typeof R.lon !== 'number')
      bad('регіон ' + k + ': немає координат якоря');
    else if (R.lat < 44 || R.lat > 53 || R.lon < 22 || R.lon > 41)
      bad('регіон ' + k + ': якір поза Україною');
    /* Якір — це реальне місто, а не «десь посередині». Назване місто
       можна звірити з картою, безіменну точку — ні. */
    if (!R.anchor) bad('регіон ' + k + ': координати без назви міста-якоря');
    const has = filled.includes(k);
    if (has) {
      const base = D.POINTS.find(p => p.id === R.base);
      if (!base) bad('регіон ' + k + ': бази ' + R.base + ' не існує, а точки є');
      else if (base.reg !== k) bad('регіон ' + k + ': база ' + base.id + ' належить ' + base.reg);
      if (!D.ROUTES.some(r => r.reg === k)) bad('регіон ' + k + ': точки є, а маршрутів немає');
    } else {
      if (R.base) bad('регіон ' + k + ': база є, а точок немає — база вказує в порожнечу');
      if (D.ROUTES.some(r => r.reg === k)) bad('регіон ' + k + ': маршрут без жодної точки');
    }
  });
  ok(regs.length + ' регіонів, наповнено ' + filled.length +
    ': точки, маршрути й бази не перетинаються');

  /* Якорі не мають збігатися: два регіони в одній точці означають, що
     nearestRegion() ніколи не поверне другий із них. */
  const near = [];
  regs.forEach((a, i) => regs.slice(i + 1).forEach(b => {
    const A = D.REGIONS[a], B = D.REGIONS[b];
    const km = Math.hypot((A.lat - B.lat) * 111, (A.lon - B.lon) * 72);
    if (km < 40) near.push(a + '↔' + b + ' ' + Math.round(km) + ' км');
  }));
  near.length
    ? bad('якорі регіонів надто близько — вибір за GPS не розрізнить: ' + near.join(', '))
    : ok('якорі регіонів рознесені достатньо, щоб автовибір їх розрізняв');

  /* Нагороди, прив'язані до регіону, мусять посилатись на наявний.
     Власна нагорода потрібна тільки наповненому: у порожньому її
     нема за що дати. */
  D.BADGES.forEach(b => {
    if (b.reg && !regs.includes(b.reg)) bad('нагорода ' + b.id + ': невідомий регіон ' + b.reg);
  });
  filled.forEach(k => D.BADGES.some(b => b.reg === k)
    ? null : bad('у наповненому регіоні ' + k + ' немає жодної власної нагороди'));
  const ghost = D.BADGES.filter(b => b.reg && !filled.includes(b.reg)).map(b => b.id);
  ghost.length
    ? bad('нагороди прив\'язані до порожніх регіонів: ' + ghost.join(', '))
    : ok('нагороди розподілені по наповнених регіонах');

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

/* ── 15. Описи маршрутів і смуга помітності ──────────────────────────
   Маршрут без опису — набір точок, який доводиться розгадувати з мапи.
   А смуга помітності — те місце, де найлегше непомітно повернути
   вигаданий рейтинг: досить показати саме число, і «68» почитається
   як бал із тисячі відгуків. Тому обидва гейти стоять тут. */
if (D) {
  const noF = D.ROUTES.filter(r => !r.f || r.f.length < 120).map(r => r.id);
  noF.length
    ? bad('маршрути без опису або з надто коротким: ' + noF.join(', '))
    : ok(`усі ${D.ROUTES.length} маршрутів мають опис`);

  const same = D.ROUTES.filter(r => r.f && r.why && r.f.indexOf(r.why) === 0).map(r => r.id);
  same.length
    ? bad('опис маршруту починається тим самим рядком, що й тизер: ' + same.join(', '))
    : ok('опис маршруту не переказує тизер');
}

const bandsSrc = (data.match(/const POP_BANDS=\[[\s\S]*?\n\];/) || [''])[0];
if (!bandsSrc) bad('немає POP_BANDS — помітність нема чим перетворити на слово');
else {
  const mins = [...bandsSrc.matchAll(/min:(\d+)/g)].map(m => +m[1]);
  if (mins.length < 3) bad('смуга помітності надто груба: рівнів ' + mins.length);
  else if (mins[mins.length - 1] !== 0)
    bad('нижній рівень смуги не з нуля — точки нижче порога лишаться без підпису');
  else if (mins.some((v, i) => i && v >= mins[i - 1]))
    bad('пороги POP_BANDS не спадають — find() поверне не той рівень');
  else ok(`смуга помітності: ${mins.length} рівнів, від 0 і без розривів`);
}

/* Число назовні не виходить. Смуга — слово, і поруч із нею завжди
   стоїть пояснення, звідки воно взялося. */
if (!/const popTag =/.test(appCode))
  bad('немає popTag() — помітність нема чим показати');
else if (/popTag\([^)]*\)[\s\S]{0,60}Math\.round\(routePop/.test(appCode))
  bad('поруч зі смугою виводиться саме число pop — воно читається як бал');
else if (!/const POP_NOTE =/.test(appCode))
  bad('немає POP_NOTE — смуга показується без пояснення, звідки взялася');
else if ((appCode.match(/POP_NOTE/g) || []).length < 3)
  bad('пояснення помітності стоїть менш ніж у двох місцях — його не побачать');
else if (!/ставить редакція/.test(appCode) || !/не оцінки користувачів/.test(appCode))
  bad('пояснення помітності не каже прямо, що це не оцінки користувачів');
else ok('помітність показана словом, і поруч сказано, що це не оцінки людей');

if (!/\.pop\.rare/.test(css) || !/\.pop\.top/.test(css))
  bad('смуга помітності без стилів — усі рівні виглядатимуть однаково');
else ok('рівні помітності мають різний вигляд');

/* ── 16. День і ніч у дорозі ─────────────────────────────────────────
   Раніше дорожній режим вмикав темну карту завжди. Найлегша регресія
   тут — лишити десь старий вираз темності, і тоді підкладка, кольори
   позначок і легенда почнуть розходитись між собою. */
if (/cfg\.nav \? 'dark'/.test(appCode))
  bad('дорожній режим знову жорстко бере темні плитки — перемикач ні на що не впливає');
else if (!/const darkTiles =/.test(appCode))
  bad('немає darkTiles() — темність підкладки нема звідки взяти однаково');
else if (/V\.road \|\| V\.tiles === 'dark'/.test(appCode))
  bad('десь лишився старий вираз темності повз darkTiles() — позначки розійдуться з картою');
else if ((appCode.match(/darkTiles\(\)/g) || []).length < 5)
  bad('darkTiles() викликається рідше, ніж є місць, залежних від темності підкладки');
else ok('темність підкладки береться в одному місці й тим самим способом');

if (!/const NIGHT_MODES = \['auto', 'day', 'night'\]/.test(appCode))
  bad('немає трьох режимів підкладки: авто, день, ніч');
else if (!/data-act="night"/.test(appCode))
  bad('перемикача день/ніч немає на екрані подорожі');
else if (!/night: 'auto'/.test(appCode) || !/S\.night/.test(appCode))
  bad('вибір підкладки не зберігається — уночі за кермом його ставили б щоразу наново');
else ok('перемикач день/ніч є, має три стани й переживає перезапуск');

/* Найцінніше в «авто» — що це розрахунок, а не таблиця й не здогад.
   Тому формулу тут запускають по-справжньому і звіряють із тим, що
   про Україну відомо: літній день у Львові близько 16 годин, зимовий
   близько восьми, і схід завжди раніший за захід. */
const sunSrc = (appCode.match(/function sunTimes\([\s\S]*?\n\}/) || [''])[0];
if (!sunSrc) bad('немає sunTimes() — «авто» нема на чому рахувати');
else {
  try {
    const sctx = { console, Math, Date };
    vm.createContext(sctx);
    new vm.Script(sunSrc + '\n;globalThis.__s=sunTimes;').runInContext(sctx);
    const sun = sctx.__s;
    const jun = sun(49.84, 24.03, Date.UTC(2026, 5, 21, 10));
    const dec = sun(49.84, 24.03, Date.UTC(2026, 11, 21, 10));
    const hrs = t => (t.set - t.rise) / 36e5;
    if (!jun || !dec) bad('sunTimes() не порахував схід і захід для Львова');
    else if (!(jun.rise < jun.set && dec.rise < dec.set))
      bad('sunTimes(): схід пізніше за захід — доба зібрана неправильно');
    else if (!(hrs(jun) > 15.5 && hrs(jun) < 17))
      bad('літній день у Львові вийшов ' + hrs(jun).toFixed(1) + ' год замість ~16,3');
    else if (!(hrs(dec) > 7.5 && hrs(dec) < 8.7))
      bad('зимовий день у Львові вийшов ' + hrs(dec).toFixed(1) + ' год замість ~8,1');
    else ok('сонце рахується: літній день ' + hrs(jun).toFixed(1) +
      ' год, зимовий ' + hrs(dec).toFixed(1) + ' год');
  } catch (e) { bad('sunTimes() не запустився: ' + e.message); }
}

if (!/\.roadday/.test(css)) bad('денний дорожній режим без стилів — темна плашка на світлій карті');
else ok('дорожній інтерфейс має денний вигляд');

/* ── 17. Про проєкт ──────────────────────────────────────────────────
   Екран, який пояснює, хто це зробив і навіщо. Для Play він же несе
   політику приватності всередині застосунку. Головний ризик тут —
   не верстка, а вигадана адреса соцмережі: @spadok може належати
   комусь іншому, і застосунок відправив би туди людину від нашого імені. */
if (!/const ABOUT=/.test(data)) bad('немає ABOUT — текст «про проєкт» ніде не лежить');
else if (!/ветеран/.test(data)) bad('у «про проєкт» зник рядок про автора');
else if (!/відновлення пам/.test(data))
  bad('у «про проєкт» немає рядка про частину прибутку на відновлення памʼяток');
else if (!/const LINKS=/.test(data)) bad('немає LINKS — соцмережам ніде лежати');
else if (!/function scrAbout/.test(appCode)) bad('екран «про проєкт» не побудований');
else if (!/about: scrAbout/.test(appCode)) bad('екран «про проєкт» не підключений до render()');
else if (!/data-act="about"/.test(appCode)) bad('до «про проєкт» немає жодних дверей');
else if (!/privacy\.html/.test(appCode))
  bad('політика приватності не відкривається зсередини застосунку — Play цього вимагає');
else ok('екран «про проєкт» на місці: автор, мета, гроші, приватність');

const linksSrc = (data.match(/const LINKS=\{[\s\S]*?\n\};/) || [''])[0];
if (linksSrc) {
  ['Telegram', 'Instagram', 'YouTube'].forEach(n =>
    linksSrc.includes(n) ? null : bad('у соцмережах немає ' + n));
  const empty = [...linksSrc.matchAll(/n:'([^']+)',d:'[^']*',url:''/g)].map(m => m[1]);
  if (empty.length) {
    console.log('  · адреси ще не заповнені: ' + empty.join(', '));
    if (!/ще не створено/.test(appCode))
      bad('порожній канал показується без позначки — вийде мертве посилання');
    else ok('канали без адреси показані вимкненими, а не мертвими посиланнями');
  } else ok('усі адреси соцмереж заповнені');
}

if (/const GIVING=\{share:'',to:''\}/.test(data))
  console.log('  · конкретна частка прибутку ще не названа: на екрані стоїть тільки загальна ' +
    'обіцянка. Число й отримувача варто назвати — обіцянку з цифрою запамʼятовують');

/* ── 18. Порожній регіон ─────────────────────────────────────────────
   Поділ на 15 історико-географічних регіонів означає, що 13 із них
   поки порожні. Це чесний стан набору, але він мусить бути видимим
   і не мусить нікуди падати: у порожнього регіону немає бази, і
   старе P(reg().base) на ній би зламалось. */
if (/P\(reg\(\)\.base\)/.test(appCode))
  bad('відстані досі міряються від P(reg().base) — у порожньому регіоні бази немає, буде null');
else if (!/const regOrigin =/.test(appCode))
  bad('немає regOrigin() — нема звідки міряти в регіоні без бази');
else if (!/const regFilled =/.test(appCode))
  bad('немає regFilled() — порожній регіон нічим відрізнити від наповненого');
else ok('регіон без бази не ламає відстані: є regOrigin() і regFilled()');

/* Автовибір не має права мовчки лишити людину на порожній карті —
   але й не має права збрехати про те, де вона є. Тому «вся Україна»
   плюс пояснення, а не тихе перекидання в сусідній регіон. */
const autoSrc = (appCode.match(/function autoRegion\(\)[\s\S]*?\n\}/) || [''])[0];
if (!autoSrc) bad('немає autoRegion()');
else if (!/regFilled\(k\)/.test(autoSrc))
  bad('автовибір не перевіряє, чи є в регіоні точки — людина відкриє порожню карту');
else if (!/V\.region = ALL/.test(autoSrc))
  bad('автовибір не має запасного варіанту для порожнього регіону');
else if (!/emptyHome/.test(autoSrc))
  bad('автовибір перекидає в «усю Україну» мовчки — людина не зрозуміє, що сталося');
else ok('у порожньому регіоні автовибір показує всю Україну і каже, чому');

if (!/regFilled\(REG\(\)\)/.test(appCode))
  bad('порожній регіон не має власного стану в списку — покаже «немає точок за фільтром»');
else if (!/data-goreg="' \+ ALL/.test(appCode))
  bad('із порожнього регіону немає виходу в один тап');
else ok('порожній регіон пояснений і має вихід в «усю Україну»');

/* Назва регіону обіцяє більше, ніж у наборі є: «Галичина» — три
   області, а точки поки з однієї. Про це мусить бути сказано. */
if (D) {
  const partial = Object.keys(D.REGIONS).filter(k =>
    D.POINTS.some(p => p.reg === k) && !D.REGIONS[k].covers);
  partial.length
    ? bad('наповнені регіони без уточнення covers: ' + partial.join(', ') +
      ' — назва обіцяє більше, ніж у наборі є')
    : ok('наповнені регіони чесно кажуть, що саме вже покрито');
}
if (!/reg\(\)\.covers/.test(appCode))
  bad('уточнення covers ніде не показується — лежить у даних і мовчить');
else ok('уточнення про покриття видно на головному екрані');

/* Вибір регіону за положенням запускається по-справжньому — на містах,
   про які немає двох думок. Найдорожча помилка тут тиха: людина стоїть
   під галицькою фортецею, а застосунок каже їй «ви на Волині, тут
   порожньо». Саме так і було, доки вибір спирався лише на якорі:
   Броди ближчі до Луцька, ніж до Львова. */
const nearSrc = (appCode.match(/function nearestRegion\([\s\S]*?\n\}/) || [''])[0];
if (!nearSrc) bad('немає nearestRegion() — регіон нема чим обрати за положенням');
else if (!/POINTS\.forEach/.test(nearSrc))
  bad('вибір регіону спирається лише на якорі — біля меж він помиляється системно');
else if (D) {
  try {
    const nctx = { console, Math };
    vm.createContext(nctx);
    new vm.Script(data +
      '\nconst R_=6371, rad_=x=>x*Math.PI/180;' +
      '\nfunction dist(a,b){const dLa=rad_(b.lat-a.lat),dLo=rad_(b.lon-a.lon);' +
      'const x=Math.sin(dLa/2)**2+Math.cos(rad_(a.lat))*Math.cos(rad_(b.lat))*Math.sin(dLo/2)**2;' +
      'return 2*R_*Math.asin(Math.sqrt(x));}\n' + nearSrc +
      '\n;globalThis.__n=nearestRegion;').runInContext(nctx);
    const expect = [
      ['Броди', 50.0793, 25.1497, 'halych'],
      ['Тернопіль', 49.55, 25.59, 'halych'],
      ['Київ', 50.4501, 30.5234, 'naddnipro'],
      ['Харків', 49.9935, 36.2304, 'slobozhanshchyna'],
      ['Ужгород', 48.6208, 22.2879, 'zakarpattia'],
      ['Чернівці', 48.2921, 25.9358, 'bukovyna'],
      ['Рівне', 50.62, 26.25, 'volyn'],
      ['Одеса', 46.48, 30.73, 'prychornomoria'],
      ['Житомир', 50.25, 28.66, 'polissia'],
      ['Сімферополь', 44.9521, 34.1024, 'krym']
    ];
    const miss = expect.filter(([, la, lo, want]) =>
      nctx.__n({ lat: la, lon: lo }) !== want);
    miss.length
      ? bad('вибір регіону за положенням помиляється: ' + miss.map(([n, la, lo, w]) =>
        n + ' → ' + nctx.__n({ lat: la, lon: lo }) + ', а мало бути ' + w).join('; '))
      : ok('регіон за положенням правильний у всіх ' + expect.length + ' містах-перевірках');
  } catch (e) { bad('nearestRegion() не запустився: ' + e.message); }
}

/* Літерал «від Львова» був правдою, доки регіон був один. */
if (/від Львова/.test(appCode))
  bad('у шапці лишилось «від Львова» словом — брехня в кожному іншому регіоні');
else ok('точка відліку називається за регіоном, а не літералом');

console.log(fails ? `\n${fails} проблем.` : '\nУсе сходиться.');
process.exit(fails ? 1 : 0);
