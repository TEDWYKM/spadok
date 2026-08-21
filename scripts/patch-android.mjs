/* Доналаштовує згенерований Capacitor'ом Android-проєкт.

   Папка android/ не лежить у репозиторії — її створює CI командою
   `npx cap add android`, бо Android SDK потрібен лише для збірки.
   Цей скрипт додає туди те, чого шаблон не знає:

     • дозволи на геолокацію (без них radius-перевірка не працює);
     • density у configChanges — інакше WebView перезавантажується
       від зміни щільності екрана, а посеред подорожі це означає
       втрату екрана з навігацією;
     • українську назву застосунку;
     • колір панелі й фон сплеша під палітру продукту;
     • іконку запуску, зокрема адаптивну;
     • версію збірки;
     • перевірку планки targetSdk для Google Play;
     • релізний підпис зі змінних середовища.

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
let manifestChanged = false;

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
  manifestChanged = true;
  console.log('  ✓ AndroidManifest: додано дозволи');
} else {
  console.log('  · AndroidManifest: дозволи вже на місці');
}

/* ── 2. density у configChanges ──────────────────────────────────── */
/* Android 16 міняє щільність не лише при повороті, а й коли користувач
   змінює розмір вікна. Без density у списку система перестворює
   активність, WebView вантажиться наново — і людина посеред дороги
   бачить, як застосунок стартує з нуля. */
const cfgRe = /android:configChanges="([^"]*)"/;
const cfg = manifest.match(cfgRe);
if (!cfg) {
  console.error('  ✗ у AndroidManifest немає configChanges — шаблон змінився, перевірте вручну');
  process.exit(1);
} else if (!cfg[1].split('|').includes('density')) {
  manifest = manifest.replace(cfgRe, `android:configChanges="${cfg[1]}|density"`);
  manifestChanged = true;
  console.log('  ✓ AndroidManifest: density у configChanges');
} else {
  console.log('  · AndroidManifest: density уже в configChanges');
}

if (manifestChanged) writeFileSync(manifestPath, manifest);

/* ── 3. Назва застосунку ─────────────────────────────────────────── */
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

/* ── 4. Палітра ──────────────────────────────────────────────────── */
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

/* ── 5. Іконка запуску ───────────────────────────────────────────── */
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

/* ── 6. Планка targetSdk для Google Play ─────────────────────────── */
/* Найтихіший спосіб не потрапити в магазин — зібрати пакет зі старим
   targetSdk і дізнатися про це вже в Play Console, після всіх кроків.
   Тому перевіряємо тут і падаємо голосно.

   З 31.08.2026 нові застосунки й оновлення мусять цілитись в API 36
   (Android 16). Планку дає Capacitor 8; на Capacitor 6 було 34 —
   тобто нижче за вимогу, яка діяла ще з попереднього серпня. Вимога
   стосується завантаження пакета, а не публікації, тож тестові
   доріжки її теж не обходять. */
const PLAY_TARGET_SDK = 36;
const varsPath = join(root, 'android', 'variables.gradle');
if (existsSync(varsPath)) {
  const vars = readFileSync(varsPath, 'utf8');
  const got = Number((vars.match(/targetSdkVersion\s*=\s*(\d+)/) || [])[1]);
  if (!got) {
    console.error('  ✗ у variables.gradle не знайшовся targetSdkVersion');
    process.exit(1);
  }
  if (got < PLAY_TARGET_SDK) {
    console.error(`  ✗ targetSdk ${got}, а Google Play вимагає ${PLAY_TARGET_SDK}.`);
    console.error('      Такий пакет не приймуть ні в продакшн, ні в тестову доріжку.');
    console.error('      Лікується оновленням Capacitor у package.json.');
    process.exit(1);
  }
  console.log(`  ✓ targetSdk ${got} — планку Play узято`);
}

/* ── 7. Версія збірки і релізний підпис ──────────────────────────── */
/* versionCode мусить лише зростати: Play не прийме пакет із номером,
   який уже бачив. Номер запуску CI для цього годиться — він
   монотонний у межах репозиторію. */
const gradlePath = join(app, 'build.gradle');
if (existsSync(gradlePath)) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const code = Number(process.env.BUILD_NUMBER || 1);
  let g = readFileSync(gradlePath, 'utf8');
  g = g
    .replace(/versionCode\s+\d+/, 'versionCode ' + code)
    .replace(/versionName\s+"[^"]*"/, `versionName "${pkg.version}"`);

  /* Ключ і паролі приходять зі змінних середовища, а в CI — із секретів
     репозиторію. У файлі їх немає й бути не може: build.gradle лежить
     у git. Якщо змінної немає, блок лишається порожнім і debug-збірка
     працює як раніше. */
  if (!g.includes('signingConfigs')) {
    if (!/\n\s*buildTypes\s*\{/.test(g)) {
      console.error('  ✗ у build.gradle немає buildTypes — шаблон змінився, підпис не вставлено');
      process.exit(1);
    }
    const block = `
    signingConfigs {
        release {
            def ks = System.getenv("SPADOK_KEYSTORE")
            if (ks) {
                storeFile file(ks)
                storePassword System.getenv("SPADOK_KEYSTORE_PASSWORD")
                keyAlias System.getenv("SPADOK_KEY_ALIAS")
                keyPassword System.getenv("SPADOK_KEY_PASSWORD")
            }
        }
    }
`;
    g = g.replace(/(\n)(\s*)buildTypes\s*\{/, block + '$1$2buildTypes {');
    g = g.replace(/(buildTypes\s*\{\s*\n\s*release\s*\{)/,
      '$1\n            if (System.getenv("SPADOK_KEYSTORE")) signingConfig signingConfigs.release');
    console.log('  ✓ build.gradle: релізний підпис зі змінних середовища');
  }

  writeFileSync(gradlePath, g);
  console.log(`  ✓ build.gradle: версія ${pkg.version} (${code})`);
}

console.log('Android-проєкт доналаштовано.');
