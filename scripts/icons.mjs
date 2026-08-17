/* Генерує іконки застосунку з одного SVG-джерела.
   Запуск: node scripts/icons.mjs

   Растеризатор шукається в такому порядку: rsvg-convert → headless
   Chromium → ImageMagick. Готові PNG лежать у репозиторії, тому
   збірці в CI цей скрипт не потрібен — він для оновлення знака. */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www', 'icons');
mkdirSync(out, { recursive: true });

/* Знак: наріжна вежа й мур — те саме, що маркер «замок» на карті.
   safe — частка, у яку вписаний малюнок (для maskable потрібен запас). */
function svg(size, safe, opts = {}) {
  const pad = size * (1 - safe) / 2;
  const s = size * safe;
  const x = v => (pad + v * s).toFixed(2);
  const bg = opts.transparent
    ? ''
    : opts.round
      ? `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#F2F1E9"/>`
      : `<rect width="${size}" height="${size}" fill="#F2F1E9"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${bg}
  <g fill="none" stroke="#1C5849" stroke-width="${(s * 0.055).toFixed(2)}"
     stroke-linejoin="round" stroke-linecap="round">
    <path d="M${x(0.16)} ${x(0.82)} L${x(0.16)} ${x(0.34)} L${x(0.30)} ${x(0.34)} L${x(0.30)} ${x(0.82)}"/>
    <path d="M${x(0.70)} ${x(0.82)} L${x(0.70)} ${x(0.34)} L${x(0.84)} ${x(0.34)} L${x(0.84)} ${x(0.82)}"/>
    <path d="M${x(0.30)} ${x(0.50)} L${x(0.70)} ${x(0.50)} L${x(0.70)} ${x(0.82)} L${x(0.30)} ${x(0.82)} Z"/>
    <path d="M${x(0.13)} ${x(0.34)} L${x(0.23)} ${x(0.20)} L${x(0.33)} ${x(0.34)}"/>
    <path d="M${x(0.67)} ${x(0.34)} L${x(0.77)} ${x(0.20)} L${x(0.87)} ${x(0.34)}"/>
    <path d="M${x(0.30)} ${x(0.50)} L${x(0.50)} ${x(0.38)} L${x(0.70)} ${x(0.50)}"/>
  </g>
  <rect x="${x(0.45)}" y="${x(0.62)}" width="${(s * 0.10).toFixed(2)}" height="${(s * 0.20).toFixed(2)}"
        fill="#A8542B"/>
</svg>`;
}

const CHROME = [
  process.env.CHROME_BIN,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome'
].filter(Boolean).find(p => existsSync(p));

function rasterize(svgText, size, png) {
  const tmp = join(out, '.tmp.svg');
  writeFileSync(tmp, svgText);
  try {
    try {
      execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', png, tmp],
        { stdio: 'ignore' });
      return;
    } catch { /* далі пробуємо Chromium */ }

    if (CHROME) {
      const html = join(out, '.tmp.html');
      writeFileSync(html, `<!DOCTYPE html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;
overflow:hidden;background:#F2F1E9;line-height:0}
svg{display:block;width:${size}px;height:${size}px}</style>
${svgText}`);
      execFileSync(CHROME, [
        '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--window-size=${size},${size}`,
        `--screenshot=${png}`,
        html
      ], { stdio: 'ignore' });
      unlinkSync(html);
      if (existsSync(png)) return;
    }

    execFileSync('convert', ['-background', 'none', '-density', '384', tmp,
      '-resize', `${size}x${size}`, png], { stdio: 'ignore' });
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

function render(dir, name, size, safe, opts) {
  mkdirSync(dir, { recursive: true });
  const png = join(dir, name);
  rasterize(svg(size, safe, opts), size, png);
  if (!existsSync(png)) throw new Error('не вдалося растеризувати ' + name);
  console.log('  ✓', join(dir, name).replace(root + '/', ''));
}

console.log('Іконки PWA:');
render(out, 'icon-192.png', 192, 0.86);
render(out, 'icon-512.png', 512, 0.86);
/* maskable: Android обрізає до 80% — тримаємо знак усередині. */
render(out, 'maskable-192.png', 192, 0.62);
render(out, 'maskable-512.png', 512, 0.62);
writeFileSync(join(out, 'icon.svg'), svg(512, 0.86));
console.log('  ✓ www/icons/icon.svg (джерело)');

/* ── Іконки запуску Android ───────────────────────────────────────
   Лежать у android-res/ і копіюються в згенерований проєкт
   скриптом patch-android.mjs. Так знак застосунку живе в репозиторії,
   а не залежить від шаблону Capacitor. */
const DENSITIES = [
  ['mdpi', 48, 108], ['hdpi', 72, 162], ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324], ['xxxhdpi', 192, 432]
];

console.log('Іконки Android:');
for (const [d, launcher, adaptive] of DENSITIES) {
  const dir = join(root, 'android-res', 'mipmap-' + d);
  render(dir, 'ic_launcher.png', launcher, 0.78);
  render(dir, 'ic_launcher_round.png', launcher, 0.70, { round: true });
  /* Адаптивна іконка: 108dp полотно, видимі ~72dp по центру. */
  render(dir, 'ic_launcher_foreground.png', adaptive, 0.44, { transparent: true });
}
