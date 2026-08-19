/* Спільне для scripts/release.mjs і scripts/check.mjs: де живе версія
   і що саме вважається «оболонкою», зміна якої вимагає нової версії.

   Один список на два скрипти навмисно. Якби кожен тримав свій, вони
   б розійшлися при першому ж додаванні файлу — і перевірка почала б
   мовчки пропускати те, що реліз змінює. */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* Файли, які їдуть на пристрій і які кешує service worker.
   www/vendor/ навмисно немає: Leaflet кладе туди scripts/vendor.mjs
   під час збірки, у git його не існує, і відбиток стрибав би залежно
   від того, встигли ви запустити vendor чи ні. Версія Leaflet і так
   зафіксована в package.json. */
export const SHELL_FILES = [
  'www/index.html',
  'www/manifest.webmanifest',
  'www/css/app.css',
  'www/js/data.js',
  'www/js/app.js',
  'www/sw.js',
  'www/icons/icon-192.png',
  'www/icons/icon-512.png',
  'www/icons/maskable-192.png',
  'www/icons/maskable-512.png'
];

const sha = buf => createHash('sha256').update(buf).digest('hex').slice(0, 16);

/* Відбиток оболонки: по файлу окремо — щоб у разі розбіжності можна
   було назвати винного, — і один спільний для швидкого порівняння. */
export function fingerprint() {
  const files = {};
  for (const f of SHELL_FILES) files[f] = sha(readFileSync(join(root, f)));
  const all = createHash('sha256');
  for (const f of SHELL_FILES) all.update(f + ':' + files[f] + '\n');
  return { files, digest: all.digest('hex').slice(0, 16) };
}

/* Версія лежить у трьох файлах, і кожен потрібен свій:

     package.json    джерело правди, звідси release.mjs бере попередню;

     www/sw.js       від неї залежить ім'я кешу оболонки. Головне навіть
                     не це: доки байти sw.js не змінилися, браузер вважає
                     service worker тим самим і не переустановлює його —
                     а той офлайн віддає стару оболонку. Саме тому
                     'v1', що не мінялася сім релізів, тримала людей
                     на застосунку місячної давнини;

     www/js/data.js  щоб застосунок міг показати версію в профілі.
                     На питання «чому я не бачу змін» має бути відповідь
                     на екрані, а не в здогадках.

   Четверте місце — release.json: там записано, яка версія вже випущена
   і з яким відбитком. check.mjs звіряє всі чотири. */
export const WHERE = {
  'package.json':   { file: 'package.json',   re: /^(\s*"version"\s*:\s*")([^"]+)(")/m },
  'www/sw.js':      { file: 'www/sw.js',      re: /^(const VERSION = ')([^']+)(')/m },
  'www/js/data.js': { file: 'www/js/data.js', re: /^(const APP_VERSION = ')([^']+)(')/m }
};

export function readVersion(key) {
  const w = WHERE[key];
  const m = readFileSync(join(root, w.file), 'utf8').match(w.re);
  return m ? m[2] : null;
}

export const STAMP = join(root, 'release.json');
