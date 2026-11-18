// Godelea (a Godot game) as a target for hand drawings: reads the game's own
// list of pictures (assets/art/ART_MANIFEST.json) and turns each photographed
// drawing into the exact file the game expects.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { cleanDrawing, fitToCanvas } from './drawing.js';

const home = (p) => p.replace(/^~(?=\/)/, os.homedir());

// "…/GoogleDrive-*/My Drive/…": a * in one folder name matches the first
// folder there that fits (keeps the account name out of the mapping file).
async function resolveStar(p) {
  const parts = home(p).split('/');
  const i = parts.findIndex((x) => x.includes('*'));
  if (i < 0) return parts.join('/');
  const parent = parts.slice(0, i).join('/') || '/';
  const re = new RegExp(`^${parts[i].split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  const match = (await fs.readdir(parent).catch(() => [])).sort().find((n) => re.test(n));
  if (!match) throw new Error(`No folder matching ${parts[i]} in ${parent}`);
  return resolveStar([...parts.slice(0, i), match, ...parts.slice(i + 1)].join('/'));
}

export async function loadProject(mappingFile) {
  const mapping = JSON.parse(await fs.readFile(mappingFile, 'utf8'));
  const game = home(mapping.game);
  const manifest = JSON.parse(await fs.readFile(path.join(game, 'assets/art/ART_MANIFEST.json'), 'utf8'));
  return {
    mappingFile,
    mapping,
    game,
    art: path.join(game, 'assets/art'),
    photos: await resolveStar(mapping.photos),
    out: path.resolve(home(mapping.out)),
    manifest,
    byFile: new Map(manifest.files.map((e) => [e.file, e])),
  };
}

// How a drawing is placed on its canvas, by folder (rules from the manifest).
export function placement(entry) {
  const f = entry.file;
  if (f === 'hand/hand.png') return { tip: [90, 18] };
  if (f.startsWith('backgrounds/')) return { place: 'cover' };
  if (/^map\/(terrain_|water)/.test(f)) return { place: 'stretch' };
  if (/^ui\/(button|panel)/.test(f) && f !== 'ui/button_round.png') return { place: 'stretch' };
  if (f === 'ui/button_round.png' || f === 'board/bubble.png' || f.startsWith('map/node_')) return { place: 'center', margin: 0.02 };
  if (f.startsWith('icons/')) return { place: 'center', margin: 0.08, white: true };
  if (f.startsWith('characters/') || f.startsWith('scenery/')) return { place: 'bottom', margin: 0.04 };
  return { place: 'center', margin: 0.06 };
}

export function toBox([x, y, w, h]) {
  return { x, y, w, h };
}

// Small pictures need darker strokes: pencil that reads fine on paper
// disappears at 60 px on a phone.
function strength(file) {
  if (file.startsWith('weather/') || file === 'ui/button.png') return 2.2;
  if (file.startsWith('characters/') || file.startsWith('meanings/') || file.startsWith('board/')) return 1.5;
  if (file.startsWith('scenery/')) return 1.3;
  if (file.startsWith('map/terrain_')) return 1.6;
  return 1;
}

// A terrain tile is drawn as a little square with a pencil outline all round,
// but only the island's own edge should show: the sides that touch the next
// tile are cut just inside the outline, so the island doesn't look like a grid.
async function trimJoiningSides(png, part) {
  const { width: w, height: h } = await sharp(png).metadata();
  const cut = 0.17; // hand-drawn squares wobble: go well inside the outline
  const left = part.includes('l') ? 0 : Math.round(w * cut);
  const right = part.includes('r') ? 0 : Math.round(w * cut);
  const top = part.startsWith('t') ? 0 : Math.round(h * cut);
  const bottom = part.startsWith('b') ? 0 : Math.round(h * cut);
  return sharp(png).extract({ left, top, width: w - left - right, height: h - top - bottom }).png().toBuffer();
}

// Hatching leaves white paper between the strokes, which makes a tiled island
// look pale and patchy. Each whitish pixel takes on the colour of the strokes
// around it (an average of nearby coloured pixels only), so the ground reads
// as solid colour while the strokes stay visible on top.
async function paintGaps(png, amount = 0.85) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const n = w * h;
  const weighted = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4]; const g = data[i * 4 + 1]; const b = data[i * 4 + 2];
    const ink = data[i * 4 + 3] > 128 ? Math.min(1, (255 - Math.min(r, g, b)) / 120) : 0;
    weighted[i * 4] = Math.round(r * ink); weighted[i * 4 + 1] = Math.round(g * ink);
    weighted[i * 4 + 2] = Math.round(b * ink); weighted[i * 4 + 3] = Math.round(255 * ink);
  }
  const sigma = Math.max(2, Math.max(w, h) * 0.05);
  const blurred = await sharp(weighted, { raw: { width: w, height: h, channels: 4 } })
    .blur(sigma).raw().toBuffer();
  const out = Buffer.from(data);
  for (let i = 0; i < n; i++) {
    const wsum = blurred[i * 4 + 3];
    if (data[i * 4 + 3] === 0 || wsum < 8) continue;
    const local = [0, 1, 2].map((c) => Math.min(255, (blurred[i * 4 + c] * 255) / wsum));
    const white = Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) / 255; // 1 = paper
    const t = Math.pow(white, 1.5) * amount;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(data[i * 4 + c] * (1 - t) + local[c] * t);
  }
  return sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

// Pictures that must work as a backdrop or carry text get their colours
// pulled toward a target and their contrast lowered (`keep` = how much of
// the drawing's light/dark variation stays). The pencil texture remains.
//   sea: the game's pale blue, so islands (even snow) stand out
//   blue/green buttons: deep enough for the white text on them
//   game background: calm behind the board
export const TONES = {
  'map/water.png': { target: [169, 227, 247], keep: 0.35 },
  'ui/button_blue.png': { target: [45, 150, 215], keep: 0.55, solid: true },
  'ui/button_green.png': { target: [40, 165, 105], keep: 0.55, solid: true },
  'backgrounds/game.png': { keep: 0.4, lift: 10, blur: 1.2 },
};

// snow tiles: whiter, so the snow island stands out from the pale sea
const SNOW = { keep: 0.5, lift: 30 };

async function retone(png, { target, keep = 1, lift = 0, solid = false, blur = 0 }) {
  let input = solid ? await paintGaps(png, 1) : png;
  if (blur) input = await sharp(input).blur(blur).png().toBuffer();
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const mean = [0, 0, 0]; let m = 0;
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] < 128) continue;
    for (let c = 0; c < 3; c++) mean[c] += data[i * 4 + c];
    m++;
  }
  if (!m) return png;
  for (let c = 0; c < 3; c++) mean[c] /= m;
  const to = target || mean.map((v) => Math.min(255, v + lift));
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] === 0) continue;
    for (let c = 0; c < 3; c++) {
      data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(to[c] + (data[i * 4 + c] - mean[c]) * keep)));
    }
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** Makes one game picture from its line in the mapping. Returns the PNG. */
export async function buildPicture(project, pic) {
  const photo = path.join(project.photos, pic.photo);
  const entry = project.byFile.get(pic.file);
  const box = toBox(pic.box);
  const how = placement({ file: pic.file });
  const opaque = how.place === 'cover';
  let clean = await cleanDrawing(photo, {
    box, rotate: pic.rotate || 0, opaque, close: pic.close, fill: pic.fill ?? true, pad: opaque ? 0 : undefined,
    strength: pic.strength ?? strength(pic.file),
  });
  const tile = pic.file.match(/^map\/terrain_\w+_(b|bl|br|c|l|r|t|tl|tr)\.png$/);
  if (tile) clean = await paintGaps(await trimJoiningSides(clean, tile[1]));
  if (pic.file === 'map/water.png') clean = await paintGaps(await trimJoiningSides(clean, 'c'));
  if (!entry) {
    // not a picture the game has yet (a new character…): keep it as drawn
    return fitToCanvas(clean, { width: 160, height: 160, ...how });
  }
  if (entry.frames) {
    // animation: the drawing(s) as square frames, held to fill the game's frame count
    const size = entry.frame_height;
    const frames = [await fitToCanvas(clean, { width: size, height: size, ...how })];
    const hold = entry.frames / frames.length;
    const strip = [];
    for (let k = 0; k < entry.frames; k++) strip.push({ input: frames[Math.floor(k / hold)], left: k * size, top: 0 });
    return sharp({ create: { width: size * entry.frames, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(strip).png().toBuffer();
  }
  const png = await fitToCanvas(clean, { width: entry.width, height: entry.height, ...how });
  const tone = pic.tone ?? TONES[pic.file] ?? (pic.file.startsWith('map/terrain_snow_') ? SNOW : null);
  return tone ? retone(png, tone) : png;
}

// ---------- used by the web page ----------

/** Writes the mapping back, one picture per line so it stays readable. */
export async function saveMapping(project) {
  const { pictures, ...head } = project.mapping;
  const text = `{\n${Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`).join('')}`
    + `  "pictures": [\n    ${pictures.map((p) => JSON.stringify(p)).join(',\n    ')}\n  ]\n}\n`;
  await fs.writeFile(`${project.mappingFile}.tmp`, text);
  await fs.rename(`${project.mappingFile}.tmp`, project.mappingFile);
}

/** Where a mapped picture's built file lives. */
export function builtPath(project, file) {
  return file.startsWith('?')
    ? path.join(project.out, '..', 'unassigned', file.slice(1))
    : path.join(project.out, file);
}

/** Builds one picture and writes it where the game folder mirror expects it. */
export async function buildAndSave(project, pic) {
  const png = await buildPicture(project, pic);
  const target = builtPath(project, pic.file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, png);
  return target;
}

/** The game pictures that can be drawn (the manifest's "redraw" list). */
export function drawable(project) {
  return project.manifest.files.filter((e) => e.redraw);
}

/**
 * A small island made of one terrain's nine tiles on water, put together the
 * way the map does it, to see whether hand-drawn tiles join well.
 * @param {'built'|'game'} from  your drawings or the game's current tiles
 */
export async function islandPreview(project, terrain, from = 'built') {
  const dir = from === 'game' ? project.art : project.out;
  const T = 64; const COLS = 5; const ROWS = 4;
  const W = (COLS + 2) * T; const H = (ROWS + 2) * T;
  const exists = (f) => fs.access(f).then(() => true, () => false);
  const layers = [];
  const water = path.join(dir, 'map/water.png');
  if (await exists(water)) {
    for (let y = 0; y < H; y += T) for (let x = 0; x < W; x += T) layers.push({ input: water, left: x, top: y });
  }
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const v = r === 0 ? 't' : r === ROWS - 1 ? 'b' : '';
      const h = c === 0 ? 'l' : c === COLS - 1 ? 'r' : '';
      const f = path.join(dir, `map/terrain_${terrain}_${(v + h) || 'c'}.png`);
      if (await exists(f)) layers.push({ input: f, left: (c + 1) * T, top: (r + 1) * T });
    }
  }
  return sharp({ create: { width: W, height: H, channels: 4, background: '#a8dcef' } })
    .composite(layers).png().toBuffer();
}

/** Runs the game's own checker; with install=true it also copies the good files in. */
export function checkArt(project, install = false) {
  return new Promise((resolve) => {
    const args = [path.join(project.game, 'tools/check_art.py'), project.out];
    if (install) args.push('--install');
    execFile('python3', args, { cwd: project.game }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}` });
    });
  });
}
