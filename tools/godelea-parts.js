// The artist's drawings of the things the game used to paint in code: map
// grounds (road, streets, fields, pond, frozen lake, lava, bunting, puddle),
// the board's reaction holder and ∧ / ∨ buttons, the start screen's bubbles
// and the fireworks of the celebrations.
//
//   node tools/godelea-parts.js
//
// Writes PNGs with transparent backgrounds into library/godelea/art (the
// mirror of the game's assets/art), at most 256 px on their long side.

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { cleanDrawing, connectedComponents, dilateMask } from '../src/drawing.js';
import { loadProject } from '../src/godelea.js';

const project = await loadProject('drawings/godelea.json');

// boxes are in the photo's pixels after turning it (rotate, clockwise degrees)
const SHEETS = [
  {
    photo: 'IMG_20261118_141347.jpg', rotate: 270,
    // which drawing is which: the artist's answers on the map-pieces page
    parts: {
      'map/road.png': [691, 99, 158, 237],          // 2: road, straight (repeated along the path)
      'map/pond.png': [1801, 65, 505, 271],         // 5: pond
      'board/holder.png': [2472, 144, 339, 361],    // 6: reaction holder
      'board/button_and.png': [1501, 384, 243, 254],  // 10
      'board/button_or.png': [1798, 378, 237, 246],   // 11
      'map/field.png': [2290, 770, 590, 420],       // 22: crop field (12 is not used)
      'map/street_cross.png': [169, 917, 231, 590], // 13: street with crossings
      'map/street_v.png': [663, 895, 223, 593],     // 14: street, straight
      'map/street_h.png': [135, 1665, 491, 214],    // 20: street, straight (across)
      'map/lava_1.png': [1022, 883, 270, 361],      // 15: lava, left stream
      'map/lava_2.png': [1300, 883, 289, 361],      // 15: lava, right stream
      'title/bubble_1.png': [1095, 1397, 181, 181], // 16
      'title/bubble_2.png': [1284, 1349, 231, 231], // 17
      'title/bubble_3.png': [1530, 1301, 217, 214], // 18
      'map/puddle.png': [2309, 1389, 548, 333],     // 19: puddle
      'map/bunting.png': [982, 1603, 714, 206],     // 21: bunting flags
    },
  },
  {
    photo: 'IMG_20261118_141332.jpg', rotate: 0,
    parts: Object.fromEntries([
      [1358, 45, 390, 420], [1852, 102, 417, 345], [146, 531, 422, 444], [725, 395, 521, 494],
      [1542, 541, 546, 469], [263, 1122, 290, 271], [648, 1229, 144, 139], [899, 1256, 119, 124],
      [1792, 1075, 427, 402], [529, 1522, 194, 236],
    ].map((b, i) => [`party/firework_${i + 1}.png`, b])),
  },
];
// the second fireworks sheet: three bursts that touch (cut by hand; `blank`
// whites out the neighbours' rays inside a cut) and ten strokes, the trails
// the rockets leave as they climb
SHEETS.push({
  photo: '1795022695926.jpg', rotate: 0,
  parts: {
    'party/firework_14.png': [1396, 35, 1384, 852],   // purple and orange
    'party/firework_15.png': [2791, 355, 521, 509],   // small orange, at the edge
    'party/firework_16.png': [1715, 752, 1573, 1372], // big red
    ...Object.fromEntries([
      [857, 301, 81, 272], [291, 1116, 97, 411], [456, 304, 81, 440], [466, 1116, 97, 298], [666, 521, 78, 213],
      [718, 1155, 87, 239], [728, 1824, 84, 288], [938, 1210, 175, 906], [1291, 1705, 71, 382], [1536, 1553, 100, 524],
    ].map((b, i) => [`party/trail_${i + 1}.png`, b])),
  },
  blank: {
    'party/firework_14.png': [[2500, 760, 290, 130]],
    'party/firework_15.png': [[2940, 740, 190, 200]],
    'party/firework_16.png': [[1656, 700, 864, 157], [3135, 740, 177, 130]],
  },
  // these two touch the red burst (and the small one the photo's edge): keep
  // only coloured ink, without the red of the big burst
  inkOnly: { 'party/firework_14.png': 'red', 'party/firework_15.png': 'red' },
});
// the pink burst at the bottom of the fireworks sheet was not found as one drawing
SHEETS[1].parts['party/firework_11.png'] = [1280, 1444, 400, 345];
SHEETS[1].parts['party/firework_12.png'] = [527, 27, 318, 373];   // blue, top
SHEETS[1].parts['party/firework_13.png'] = [1253, 1153, 227, 245]; // teal, middle

for (const sheet of SHEETS) {
  const turned = await sharp(path.join(project.photos, sheet.photo)).rotate(sheet.rotate).jpeg({ quality: 96 }).toBuffer();
  for (const [file, [x, y, w, h]] of Object.entries(sheet.parts)) {
    // fireworks are thin strokes: keep only the strokes, no filled inside
    const fill = !file.startsWith('party/');
    let photo = turned;
    const blank = sheet.blank?.[file];
    if (blank) {
      const m = await sharp(turned).metadata();
      const svg = `<svg width="${m.width}" height="${m.height}" xmlns="http://www.w3.org/2000/svg">${blank.map(([bx, by, bw, bh]) => `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="#f4f4f2"/>`).join('')}</svg>`;
      photo = await sharp(turned).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 96 }).toBuffer();
    }
    const png = sheet.inkOnly?.[file]
      ? await colourInk(photo, { x, y, w, h }, sheet.inkOnly[file])
      : await cleanDrawing(photo, { box: { x, y, w, h }, fill, strength: 1.2 });
    const out = await sharp(png).resize(256, 256, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    const target = path.join(project.out, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, out);
    console.log('✓', file);
  }
}

// Coloured marker on white paper: what is coloured stays, the paper (grey or
// white, whatever the light) goes. `drop: 'red'` also leaves out red ink.
async function colourInk(photo, { x, y, w, h }, drop) {
  const { data, info } = await sharp(photo).extract({ left: x, top: y, width: w, height: h }).raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const r = data[i * 3]; const g = data[i * 3 + 1]; const b = data[i * 3 + 2];
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    let a = Math.max(0, Math.min(255, (sat - 28) * 5));
    if (drop === 'red' && r > 2.5 * g && r > 1.6 * b) a = 0;
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a;
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).trim({ threshold: 1 }).png().toBuffer();
}

// ---------- fireworks that glow ----------
// Each drawn burst becomes a firework of light: its strokes in a vivid colour,
// a soft halo of the same colour around them and a hot white centre. Every
// burst is also made in a second classic firework colour, so a show has twice
// as many different ones.
const FW_COLOURS = [ // [r, g, b]: gold, ruby, emerald, sky, magenta, silver, orange, violet
  [255, 196, 64], [255, 70, 90], [60, 230, 140], [80, 190, 255], [255, 90, 220], [235, 240, 255], [255, 140, 40], [170, 120, 255],
];

function hueOf(data, n) {
  let r = 0; let g = 0; let b = 0; let k = 0;
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] > 150) { r += data[i * 4]; g += data[i * 4 + 1]; b += data[i * 4 + 2]; k++; }
  return k ? [r / k, g / k, b / k] : [255, 255, 255];
}

function vivid([r, g, b]) {
  // the drawn colour, much more saturated and bright
  const mx = Math.max(r, g, b, 1); const mn = Math.min(r, g, b); const l = (r + g + b) / 3;
  if (mx - mn < 30) return [255, 230, 160];
  return [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(((v - l) * 2.2 + l) * (255 / mx)))));
}

async function glow(png, colour, own = false) {
  const S = 320; const pad = 40;
  const base = await sharp(png).resize(S - 2 * pad, S - 2 * pad, { fit: 'inside' })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .resize(S, S, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = base; const n = info.width * info.height;
  // specks of the paper away from the burst go
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = data[i * 4 + 3] > 40 ? 1 : 0;
  const { comps, label } = connectedComponents(m, info.width, info.height);
  {
    const big = Math.max(1, ...comps.map((c) => c.area));
    const cx0 = info.width / 2; const cy0 = info.height / 2;
    // a burst is many separate strokes; a speck is small and sits out in a
    // corner of the cut, where no ray reaches
    const keep = comps.map((c) => {
      const d = Math.hypot((c.x0 + c.x1) / 2 - cx0, (c.y0 + c.y1) / 2 - cy0) / info.width;
      return c.area >= big * 0.08 ? d < 0.6 : d < 0.42 && c.area >= 3;
    });
    // keep only what is close to the burst's own strokes: specks and faint
    // marks of the paper away from it go
    const kept = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (label[i] >= 0 && keep[label[i]]) kept[i] = 1;
    const near = dilateMask(kept, info.width, info.height, 8);
    for (let i = 0; i < n; i++) if (!near[i]) data[i * 4 + 3] = 0;
  }
  const col = colour || vivid(hueOf(data, n));
  const alpha = Buffer.alloc(n);
  for (let i = 0; i < n; i++) alpha[i] = Math.min(255, Math.round(data[i * 4 + 3] * 1.25));
  const halo = await sharp(alpha, { raw: { width: info.width, height: info.height, channels: 1 } }).blur(9).extractChannel(0).raw().toBuffer();
  const soft = await sharp(alpha, { raw: { width: info.width, height: info.height, channels: 1 } }).blur(2.2).extractChannel(0).raw().toBuffer();
  const out = Buffer.alloc(n * 4);
  const cx = info.width / 2; const cy = info.height / 2;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = y * info.width + x;
    const stroke = Math.max(alpha[i], soft[i]) / 255;
    const h = Math.min(1, (halo[i] / 255) * 1.6) * 0.55;
    // white hot near the middle of the burst and along the brightest strokes
    const d = Math.hypot(x - cx, y - cy) / (info.width * 0.5);
    const hot = Math.max(0, 1 - d / 0.28) * 0.9 + stroke * 0.25;
    const a = Math.min(1, stroke + h * (1 - stroke));
    // a burst of several colours keeps each stroke's own colour, made vivid
    // (a little lighter, so dark inks like purple still shine at night)
    const pc = own && data[i * 4 + 3] > 20 ? vivid([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]).map((v) => v * 0.7 + 76) : col;
    for (let c = 0; c < 3; c++) {
      const v = pc[c] * (1 - hot) + 255 * hot;
      out[i * 4 + c] = Math.round(Math.min(255, v));
    }
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

const party = path.join(project.out, 'party');
const drawn = (await fs.readdir(party)).filter((f) => /^firework_\d+\.png$/.test(f)).sort((a, b) => parseInt(a.slice(9)) - parseInt(b.slice(9)));
const small = new Set(['firework_7.png', 'firework_8.png']); // the two little stars: sparks and rockets
const multi = new Set(['firework_14.png']); // purple and orange: each ray keeps its colour
let k = 0; let made = 0;
for (const f of drawn) {
  const src = await fs.readFile(path.join(party, f));
  const name = small.has(f) ? `spark_${f.slice(9, -4)}` : `fw_${String(++k).padStart(2, '0')}`;
  await fs.writeFile(path.join(party, `${name}.png`), await glow(src, null, multi.has(f)));
  made++;
  if (!small.has(f)) {
    // the same burst in another firework colour
    const c = FW_COLOURS[(k * 3) % FW_COLOURS.length];
    await fs.writeFile(path.join(party, `fw_${String(k).padStart(2, '0')}b.png`), await glow(src, c));
    made++;
  }
}
console.log(`fireworks: ${made} glowing (from ${drawn.length} drawings)`);

// ---------- trails ----------
// Her strokes become the light a rocket leaves as it climbs: vivid, with a
// soft halo, white hot at the top (where the rocket is) and fading below.
async function trail(png) {
  const W = 64; const H = 256; const pad = 12;
  const { data, info } = await sharp(png).resize(W - 2 * pad, H - 2 * pad, { fit: 'inside' })
    .resize(W, H, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const col = vivid(hueOf(data, n));
  const alpha = Buffer.alloc(n);
  for (let i = 0; i < n; i++) alpha[i] = Math.min(255, Math.round(data[i * 4 + 3] * 1.3));
  const halo = await sharp(alpha, { raw: { width: W, height: H, channels: 1 } }).blur(5).extractChannel(0).raw().toBuffer();
  let top = H; let low = 0;
  for (let i = 0; i < n; i++) if (alpha[i] > 60) { const y = Math.floor(i / W); top = Math.min(top, y); low = Math.max(low, y); }
  const out = Buffer.alloc(n * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const u = low > top ? Math.max(0, Math.min(1, (y - top) / (low - top))) : 0; // 0 at the top, 1 at the tail
    const stroke = alpha[i] / 255;
    const a = Math.min(1, stroke + Math.min(1, (halo[i] / 255) * 1.8) * 0.5 * (1 - stroke)) * (1 - 0.85 * u);
    const hot = Math.max(0, 1 - u / 0.18) * 0.85;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(col[c] * (1 - hot) + 255 * hot);
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}
const trails = (await fs.readdir(party)).filter((f) => /^trail_\d+\.png$/.test(f));
for (const f of trails) await fs.writeFile(path.join(party, `glow_${f}`), await trail(await fs.readFile(path.join(party, f))));
console.log(`trails: ${trails.length}`);
