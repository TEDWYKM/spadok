/* Доналаштовує згенерований Capacitor'ом Android-проєкт.

   Папка android/ не лежить у репозиторії — її створює CI командою
   `npx cap add android`, бо Android SDK потрібен лише для збірки.
   Цей скрипт додає туди те, чого шаблон не знає:

     • дозволи на геолокацію (без них radius-перевірка не працює);
     • українську назву застосунку;
     • колір панелі й фон сплеша під палітру продукту.

   Запуск: node scripts/patch-android.mjs */

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'android', 'app');

if (!existsSync(app)) {
  console.error('Немає android/app — спершу `npx cap add android`');
  process.exit(1);
}

/* ── 1. Дозволи ──────────────────────────────────────────────────── */
const manifestPath = join(app, 'src', 'main', 'AndroidManifest.xml');
let manifest = readFileSync(manifestPath, 'utf8');

const perms = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION'
];
const lines = perms
  .filter(p => !manifest.includes(`"${p}"`))
  .map(p => `    <uses-permission android:name="${p}" />`);

/* GPS бажаний, але не обов'язковий: без нього лишається
   ручне підтвердження відвідин, тому required="false". */
const features = [
  '    <uses-feature android:name="android.hardware.location.gps" android:required="false" />'
].filter(f => !manifest.includes('android.hardware.location.gps'));

const inject = lines.concat(features).join('\n');
if (inject) {
  manifest = manifest.replace('</manifest>', inject + '\n</manifest>');
  writeFileSync(manifestPath, manifest);
  console.log('  ✓ AndroidManifest: додано дозволи');
} else {
  console.log('  · AndroidManifest: дозволи вже на місці');
}

/* ── 2. Назва застосунку ─────────────────────────────────────────── */
const stringsPath = join(app, 'src', 'main', 'res', 'values', 'strings.xml');
if (existsSync(stringsPath)) {
  let s = readFileSync(stringsPath, 'utf8');
  s = s
    .replace(/(<string name="app_name">)[^<]*(<\/string>)/, '$1Спадок$2')
    .replace(/(<string name="title_activity_main">)[^<]*(<\/string>)/, '$1Спадок$2')
    .replace(/(<string name="package_name">)[^<]*(<\/string>)/, '$1ua.spadok.app$2')
    .replace(/(<string name="custom_url_scheme">)[^<]*(<\/string>)/, '$1ua.spadok.app$2');
  writeFileSync(stringsPath, s);
  console.log('  ✓ strings.xml: назва «Спадок»');
}

/* ── 3. Палітра ──────────────────────────────────────────────────── */
const valuesDir = join(app, 'src', 'main', 'res', 'values');
mkdirSync(valuesDir, { recursive: true });
writeFileSync(join(valuesDir, 'colors.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="colorPrimary">#15242E</color>
    <color name="colorPrimaryDark">#15242E</color>
    <color name="colorAccent">#1C5849</color>
    <color name="ic_launcher_background">#F2F1E9</color>
</resources>
`);
console.log('  ✓ colors.xml: палітра продукту');

/* ── 4. Іконка запуску ───────────────────────────────────────────── */
const resDir = join(app, 'src', 'main', 'res');
const srcRes = join(root, 'android-res');
if (existsSync(srcRes)) {
  cpSync(srcRes, resDir, { recursive: true, force: true });
  console.log('  ✓ mipmap-*: іконка застосунку');

  /* Адаптивна іконка для Android 8+: фон кольором, знак — шаром. */
  const adaptive = join(resDir, 'mipmap-anydpi-v26');
  mkdirSync(adaptive, { recursive: true });
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
  writeFileSync(join(adaptive, 'ic_launcher.xml'), xml);
  writeFileSync(join(adaptive, 'ic_launcher_round.xml'), xml);
  console.log('  ✓ mipmap-anydpi-v26: адаптивна іконка');
}

/* ── 5. Версія збірки ────────────────────────────────────────────── */
const gradlePath = join(app, 'build.gradle');
if (existsSync(gradlePath)) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const code = Number(process.env.BUILD_NUMBER || 1);
  let g = readFileSync(gradlePath, 'utf8');
  g = g
    .replace(/versionCode\s+\d+/, 'versionCode ' + code)
    .replace(/versionName\s+"[^"]*"/, `versionName "${pkg.version}"`);
  writeFileSync(gradlePath, g);
  console.log(`  ✓ build.gradle: версія ${pkg.version} (${code})`);
}

console.log('Android-проєкт доналаштовано.');
