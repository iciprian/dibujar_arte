// Builds every picture listed in drawings/godelea.json from the photos of the
// drawings, into a folder that mirrors the game's assets/art, plus a review
// sheet (game picture now  ->  your drawing) to check them.
//
//   node tools/godelea.js [drawings/godelea.json]
//
// Then, in the game:  python3 tools/check_art.py <out folder> [--install]

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { buildPicture, loadProject } from '../src/godelea.js';

const project = await loadProject(process.argv[2] || 'drawings/godelea.json');
// start clean: the folder only ever holds what the mapping lists now
const unassigned = path.join(project.out, '..', 'unassigned');
await fs.rm(project.out, { recursive: true, force: true });
await fs.rm(unassigned, { recursive: true, force: true });
await fs.mkdir(project.out, { recursive: true });

const cells = [];
for (const pic of project.mapping.pictures) {
  // drawings that aren't a game picture yet go next to the game folder, not in it
  const name = pic.file.startsWith('?') ? pic.file.slice(1) : pic.file;
  const target = pic.file.startsWith('?') ? path.join(unassigned, name) : path.join(project.out, name);
  try {
    const png = await buildPicture(project, pic);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, png);
    cells.push({ pic, png });
    console.log(`${pic.sure === false ? '?' : '✓'} ${name}`);
  } catch (err) {
    console.log(`✗ ${name}: ${err.message}`);
  }
}

// ---------- review sheet ----------
const C = 260; // cell size
const COLS = 6;
const thumb = async (input, bg) => {
  const img = await sharp(input).resize(C - 20, C / 2 - 30, { fit: 'inside', kernel: 'lanczos3' }).toBuffer();
  return sharp({ create: { width: C - 10, height: C / 2 - 20, channels: 4, background: bg } })
    .composite([{ input: img, gravity: 'center' }]).png().toBuffer();
};
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const parts = [];
let k = 0;
for (const { pic, png } of cells) {
  const x = (k % COLS) * C; const y = Math.floor(k / COLS) * C;
  const bg = pic.file.startsWith('icons/') ? '#4a7bb7' : '#cfe3cf';
  const first = pic.file.includes('/anim/') ? await sharp(png).extract({ left: 0, top: 0, width: 128, height: 128 }).toBuffer() : png;
  const old = path.join(project.art, pic.file);
  const hasOld = await fs.access(old).then(() => true, () => false);
  if (hasOld) {
    const oldImg = pic.file.includes('/anim/') ? await sharp(old).extract({ left: 0, top: 0, width: 128, height: 128 }).toBuffer() : old;
    parts.push({ input: await thumb(oldImg, '#e8e8e8'), left: x + 5, top: y + 22 });
  }
  parts.push({ input: await thumb(first, bg), left: x + 5, top: y + C / 2 + 2 });
  const label = `${pic.sure === false ? '? ' : ''}${pic.file.replace(/\.png$/, '')}`;
  parts.push({
    input: Buffer.from(`<svg width="${C}" height="22" xmlns="http://www.w3.org/2000/svg"><text x="6" y="16" font-size="14" font-family="Arial" fill="${pic.sure === false ? '#c00' : '#000'}">${esc(label)}</text></svg>`),
    left: x, top: y,
  });
  k++;
}
const rows = Math.ceil(cells.length / COLS);
const review = path.join(project.out, '..', 'review.jpg');
await sharp({ create: { width: COLS * C, height: rows * C, channels: 3, background: '#ffffff' } })
  .composite(parts).jpeg({ quality: 85 }).toFile(review);
console.log(`\n${cells.length} pictures in ${project.out}\nreview: ${review}`);
