// The game's icon from the artist's drawing of the Godelea symbol (three
// bubbles of a piece): the window/project icon and Android's launcher icons.
//
//   node tools/godelea-icon.js
//
// Writes library/godelea/icon/: icon.png (512), android_192.png,
// android_fg_432.png (adaptive foreground, inside the safe zone),
// android_bg_432.png (cream paper), android_mono_432.png (white silhouette).

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { cleanDrawing, findDrawings } from '../src/drawing.js';
import { loadProject } from '../src/godelea.js';

const PHOTO = 'IMG_20261117_232845.jpg';
const ROTATE = 270; // photographed sideways: the orange bubble goes on top
const CREAM = { r: 0xf4, g: 0xf1, b: 0xea, alpha: 1 };

const project = await loadProject('drawings/godelea.json');
const photo = path.join(project.photos, PHOTO);
const out = path.join(project.out, '..', 'icon');
await fs.mkdir(out, { recursive: true });

// the whole symbol: every drawing found on the page, joined
const { boxes } = await findDrawings(photo, { gap: 0.03, minSize: 0.03 });
const x0 = Math.min(...boxes.map((b) => b.x)); const y0 = Math.min(...boxes.map((b) => b.y));
const x1 = Math.max(...boxes.map((b) => b.x + b.w)); const y1 = Math.max(...boxes.map((b) => b.y + b.h));
const drawing = await cleanDrawing(photo, { box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, rotate: ROTATE, strength: 1.2 });

async function fit(png, size) {
  return sharp(png).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

async function onPaper(size, inner, rounded) {
  const art = await fit(drawing, Math.round(size * inner));
  const mask = rounded
    ? Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${size * 0.19}" fill="#fff"/></svg>`)
    : null;
  let base = sharp({ create: { width: size, height: size, channels: 4, background: CREAM } })
    .composite([{ input: art, gravity: 'center' }]);
  if (mask) base = sharp(await base.png().toBuffer()).composite([{ input: mask, blend: 'dest-in' }]);
  return base.png().toBuffer();
}

await fs.writeFile(path.join(out, 'icon.png'), await onPaper(512, 0.8, true));
await fs.writeFile(path.join(out, 'android_192.png'), await onPaper(192, 0.8, true));
// adaptive icon: the launcher crops to a circle/squircle; keep the art in the
// central 66% safe zone
const fg = await fit(drawing, Math.round(432 * 0.62));
await fs.writeFile(path.join(out, 'android_fg_432.png'),
  await sharp({ create: { width: 432, height: 432, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: fg, gravity: 'center' }]).png().toBuffer());
await fs.writeFile(path.join(out, 'android_bg_432.png'),
  await sharp({ create: { width: 432, height: 432, channels: 4, background: CREAM } }).png().toBuffer());
// monochrome (Android 13 themed icons): the same shapes in white
const { data, info } = await sharp(await fs.readFile(path.join(out, 'android_fg_432.png'))).raw().toBuffer({ resolveWithObject: true });
for (let i = 0; i < info.width * info.height; i++) { data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; }
await fs.writeFile(path.join(out, 'android_mono_432.png'),
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer());
console.log(`icon from ${boxes.length} drawing(s) → ${out}`);
