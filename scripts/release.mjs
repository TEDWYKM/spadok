/* Один крок релізу. Запуск:

     node scripts/release.mjs           patch:  0.3.0 → 0.3.1
     node scripts/release.mjs minor              0.3.0 → 0.4.0
     node scripts/release.mjs major              0.3.0 → 1.0.0
     node scripts/release.mjs 1.2.3     рівно ця версія

   Що робить: піднімає версію в package.json, вписує її в www/sw.js
   і www/js/data.js, рахує відбиток оболонки й записує release.json.

   Навіщо це окремою командою, а не руками: версія в sw.js — єдине,
   за чим браузер розуміє, що застосунок оновився. Вона пролежала
   'v1' сім релізів поспіль, і всі, хто вже відкривав застосунок,
   бачили стару оболонку з кешу. Помилка непомітна зсередини: у автора
   все свіже, бо він щоразу відкриває з диска.

   Після цієї команди check.mjs звіряє відбиток. Якщо оболонку змінили,
   а release.mjs не запустили — збірка падає й каже, які саме файли. */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { root, SHELL_FILES, WHERE, STAMP, fingerprint, readVersion } from './version.mjs';

const arg = (process.argv[2] || 'patch').trim();

const cur = readVersion('package.json');
if (!/^\d+\.\d+\.\d+$/.test(cur || '')) {
  console.error(`  ✗ у package.json версія «${cur}» не схожа на major.minor.patch`);
  process.exit(1);
}

function next(from, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [a, b, c] = from.split('.').map(Number);
  if (how === 'major') return `${a + 1}.0.0`;
  if (how === 'minor') return `${a}.${b + 1}.0`;
  if (how === 'patch') return `${a}.${b}.${c + 1}`;
  console.error(`  ✗ не розумію «${how}». Можна: patch, minor, major або точну версію 1.2.3`);
  process.exit(1);
}

const v = next(cur, arg);
if (v === cur) {
  console.error(`  ✗ ${v} — це вже поточна версія. Нова має відрізнятись`);
  process.exit(1);
}

/* Що змінилося з минулого релізу — читаємо ДО того, як перезапишемо
   штамп. Це не перевірка, а підказка для нотаток до релізу. */
const before = existsSync(STAMP) ? JSON.parse(readFileSync(STAMP, 'utf8')) : null;
const was = fingerprint();
const changed = before
  ? SHELL_FILES.filter(f => was.files[f] !== (before.files || {})[f])
  : SHELL_FILES;

/* Версія в трьох файлах. Заміна точкова, по якорю на початку рядка:
   переписувати package.json через JSON.stringify означало б мовчки
   переформатувати чужий файл. */
for (const [key, w] of Object.entries(WHERE)) {
  const path = join(root, w.file);
  const src = readFileSync(path, 'utf8');
  if (!w.re.test(src)) {
    console.error(`  ✗ у ${w.file} немає рядка з версією — якір загубився, правити руками`);
    process.exit(1);
  }
  writeFileSync(path, src.replace(w.re, (_, a, __, c) => a + v + c));
  console.log(`  · ${w.file} → ${v}`);
}

/* Відбиток рахуємо ПІСЛЯ запису версій: sw.js і data.js уже містять
   нову версію, і саме цей стан ми випускаємо. */
const fp = fingerprint();
writeFileSync(STAMP, JSON.stringify({
  _: 'Пише scripts/release.mjs, звіряє scripts/check.mjs. Руками не правити.',
  version: v,
  digest: fp.digest,
  files: fp.files
}, null, 2) + '\n');

console.log(`  · release.json → ${v} (${fp.digest})`);
console.log(`\nВерсія ${cur} → ${v}.`);
if (before) {
  console.log(changed.length
    ? 'З минулого релізу змінилося: ' + changed.map(f => f.replace('www/', '')).join(', ')
    : 'Оболонка не змінилася — версія піднята вручну.');
}
console.log('Далі: node scripts/check.mjs, потім коміт і publish.cmd.');
