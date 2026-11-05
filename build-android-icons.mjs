// Launcher icons for the Android app (Capacitor project in android/), drawn
// from the same artwork as the desktop and web icons. Run after changing
// build/icon.svg or build/icon-maskable.svg:  node build-android-icons.mjs
//
//   ic_launcher_foreground  adaptive icon (Android 8+): the full-bleed
//                           maskable artwork as the 108 dp foreground layer —
//                           its notes sit inside the 72 dp area every
//                           launcher mask shows.
//   ic_launcher             legacy square icon (Android 7): the regular icon.
//   ic_launcher_round       legacy round icon: the maskable artwork in a circle.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const res = path.join(root, 'android', 'app', 'src', 'main', 'res');
const icon = fs.readFileSync(path.join(root, 'build', 'icon.svg'));
const maskable = fs.readFileSync(path.join(root, 'build', 'icon-maskable.svg'));

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const render = (svg, size) => sharp(svg, { density: 72 * Math.max(1, size / 96) * 4 })
  .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });

for (const [name, scale] of Object.entries(DENSITIES)) {
  const dir = path.join(res, `mipmap-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const legacy = Math.round(48 * scale);
  const fg = Math.round(108 * scale);

  await render(maskable, fg).png().toFile(path.join(dir, 'ic_launcher_foreground.png'));
  await render(icon, legacy).png().toFile(path.join(dir, 'ic_launcher.png'));
  const circle = Buffer.from(
    `<svg width="${legacy}" height="${legacy}"><circle cx="${legacy / 2}" cy="${legacy / 2}" r="${legacy / 2}"/></svg>`);
  await render(maskable, legacy)
    .composite([{ input: circle, blend: 'dest-in' }])
    .png().toFile(path.join(dir, 'ic_launcher_round.png'));
  console.log(`wrote mipmap-${name} (${legacy}px, foreground ${fg}px)`);
}

// Behind the foreground: the artwork's own dark background, for the moment a
// launcher animates the layers apart.
fs.writeFileSync(path.join(res, 'values', 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#262A33</color>
</resources>
`);
console.log('wrote values/ic_launcher_background.xml');

// Launch screen: Capacitor's template ships its own logo in every
// drawable*/splash.png. Redraw each at its own size as the page background
// (manifest background_color) with the app icon in the middle.
const BG = { r: 0x14, g: 0x18, b: 0x1d, alpha: 1 };
for (const dir of fs.readdirSync(res).filter(d => d.startsWith('drawable'))) {
  const file = path.join(res, dir, 'splash.png');
  if (!fs.existsSync(file)) continue;
  const { width, height } = await sharp(file).metadata();
  const s = Math.round(Math.min(width, height) * 0.28);
  const logo = await render(icon, s).png().toBuffer();
  await sharp({ create: { width, height, channels: 4, background: BG } })
    .composite([{ input: logo, left: Math.round((width - s) / 2), top: Math.round((height - s) / 2) }])
    .png().toFile(file + '.new');
  fs.renameSync(file + '.new', file);
}
console.log('wrote drawable*/splash.png');
