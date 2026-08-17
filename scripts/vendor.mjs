/* Кладе Leaflet у www/vendor/leaflet, щоб карта працювала в APK
   і офлайн з першого запуску, без залежності від CDN.

   Запуск: node scripts/vendor.mjs
   Джерело: node_modules (якщо є) → unpkg.

   Якщо vendor не зібраний, застосунок сам відступає на CDN
   (див. LEAFLET_SRC у www/js/app.js), тому крок не блокуючий. */

import { mkdirSync, copyFileSync, existsSync, writeFileSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'www', 'vendor', 'leaflet');
const VERSION = '1.9.4';

mkdirSync(dest, { recursive: true });

const local = join(root, 'node_modules', 'leaflet', 'dist');

if (existsSync(join(local, 'leaflet.js'))) {
  copyFileSync(join(local, 'leaflet.js'), join(dest, 'leaflet.js'));
  copyFileSync(join(local, 'leaflet.css'), join(dest, 'leaflet.css'));
  if (existsSync(join(local, 'images'))) {
    cpSync(join(local, 'images'), join(dest, 'images'), { recursive: true });
  }
  console.log('Leaflet узято з node_modules');
} else {
  const base = `https://unpkg.com/leaflet@${VERSION}/dist/`;
  for (const f of ['leaflet.js', 'leaflet.css']) {
    const res = await fetch(base + f);
    if (!res.ok) throw new Error(`не завантажився ${f}: HTTP ${res.status}`);
    writeFileSync(join(dest, f), Buffer.from(await res.arrayBuffer()));
    console.log('  ✓', f);
  }
  /* Картинки контролів. Ми користуємось divIcon, тому без них
     карта працює — просто не валимо збірку, якщо їх немає. */
  mkdirSync(join(dest, 'images'), { recursive: true });
  for (const f of ['layers.png', 'layers-2x.png', 'marker-icon.png',
    'marker-icon-2x.png', 'marker-shadow.png']) {
    try {
      const res = await fetch(base + 'images/' + f);
      if (res.ok) writeFileSync(join(dest, 'images', f), Buffer.from(await res.arrayBuffer()));
    } catch { /* необов'язкове */ }
  }
  console.log(`Leaflet ${VERSION} завантажено з unpkg`);
}

writeFileSync(join(dest, 'VERSION'), VERSION + '\n');
