// Builds Godelea's fonts from the photographed sheet of hand-written letters.
//
//   node tools/handfont.js
//
// Writes library/godelea/fonts/{hand,hand_bold,hand_color}.{fnt,png} and a
// preview sheet. The layout below says what each row of the sheet holds.

import path from 'node:path';
import sharp from 'sharp';

import { loadProject } from '../src/godelea.js';
import { buildFonts } from '../src/handfont.js';

const project = await loadProject('drawings/godelea.json');
const SHEET = {
  photo: 'IMG_20261117_230147.jpg',
  // top to bottom, as written on the sheet
  rows: [
    { set: 'grey', kind: 'lower', chars: 'abcdefghijkl' },
    { set: 'grey', kind: 'lower', chars: 'mnopqrstuv' },
    { set: 'grey', kind: 'lower', chars: 'wxyzñ' },
    { set: 'grey', kind: 'upper', chars: 'ABCDEFGHIJKL' },
    { set: 'grey', kind: 'upper', chars: 'MNOPQRSTUV' },
    { set: 'grey', kind: 'upper', chars: 'WXYZÑ.!¡?¿' },
    { set: 'blue', kind: 'punct', chars: '!?¡¿' },
    { set: 'blue', kind: 'upper', chars: 'ABCDEFGHIJKL' },
    { set: 'blue', kind: 'upper', chars: 'MNOPQRSTUV' },
    { set: 'blue', kind: 'upper', chars: 'WXYZÑ.' },
    { set: 'red', kind: 'lower', chars: 'abcdefghijkl' },
    { set: 'red', kind: 'lower', chars: 'mnopqrstuv' },
    { set: 'red', kind: 'lower', chars: 'wxyzñ.' },
  ],
};
const out = path.join(project.out, '..', 'fonts');

// the second sheet: digits, brackets and signs, in a thinner black pen
const SYMBOLS = {
  photo: '1794970160956.jpg',
  rowMode: 'gaps', // rows of small marks only: split by the gaps between rows
  rows: [
    { set: 'sym', kind: 'punct', chars: '0123456789', xMax: 0.8 }, // then a "10"
    { set: 'sym', kind: 'punct', chars: '()', xMax: 0.24 }, // then a mark and ∧ ∨ drawn again below
    { set: 'sym', kind: 'skip', chars: '' }, // P(x)  ∀x.P(x): examples
    { set: 'sym', kind: 'skip', chars: '' }, // a comma (drawn again below)
    { set: 'sym', kind: 'skip', chars: '' }, // mⁿ: how powers could look
    { set: 'sym', kind: 'punct', chars: '□' },
    { set: 'sym', kind: 'punct', chars: '✗' },
    { set: 'sym', kind: 'lower', chars: 'áéíóü' },
    { set: 'sym', kind: 'punct', chars: ',;:-…\'"', drop: '…' }, // its … are ticks: made from the dot instead
    { set: 'sym', kind: 'punct', chars: '¬∧∨→↔⊥' },
    { set: 'sym', kind: 'punct', chars: '∀∃·+=×' },
  ],
};

const r = await buildFonts({
  sheets: [
    { photo: path.join(project.photos, SHEET.photo), rows: SHEET.rows },
    { photo: path.join(project.photos, SYMBOLS.photo), rows: SYMBOLS.rows, rowMode: SYMBOLS.rowMode },
  ],
  size: 128,
  out,
  // ★ ✓ ▶ in texts come from the drawn menu signs
  icons: Object.fromEntries(['star', 'checkmark', 'play'].map((n) => [n, path.join(project.out, `icons/${n}.png`)])),
  fonts: [
    // everyday text: the grey letters, white so the game colours them
    { name: 'hand', mode: 'mask', bold: 2, sets: { upper: 'grey', lower: 'grey', punct: 'grey' }, extra: ['sym'] },
    // buttons and headings: the same letters with thicker strokes
    { name: 'hand_bold', mode: 'mask', bold: 5, sets: { upper: 'grey', lower: 'grey', punct: 'grey' }, extra: ['sym'] },
    // white titles: thick strokes with a dark edge, so they read on light
    // backgrounds (Godot cannot outline a drawn font)
    { name: 'hand_outlined', mode: 'mask', bold: 5, edge: { px: 9, rgb: [44, 51, 80], alpha: 0.9 }, sets: { upper: 'grey', lower: 'grey', punct: 'grey' }, extra: ['sym'] },
    // emphasis: blue capitals, red small letters, in their own colours
    { name: 'hand_color', mode: 'colour', bold: 1, sets: { upper: 'blue', lower: 'red', punct: 'blue' } },
  ],
});
if (r.problems.length) {
  console.log(r.problems.join('\n'));
  process.exit(1);
}
for (const f of r.results) console.log(`${f.name}: ${f.count} characters, atlas ${f.width}×${f.height}\n  ${f.chars}`);
console.log('scales', Object.fromEntries(Object.entries(r.scales).map(([k, v]) => [k, v && v.toFixed(2)])));

// preview: every atlas on a light and a dark background
const tiles = [];
let y = 0;
for (const f of r.results) {
  const png = path.join(out, `${f.name}.png`);
  const meta = await sharp(png).metadata();
  const w = 1400; const h = Math.round(meta.height * (w / meta.width));
  const img = await sharp(png).resize(w, h).toBuffer();
  tiles.push({ input: { create: { width: w, height: h, channels: 4, background: f.name === 'hand_color' ? '#fffdf8' : '#3e6fa8' } }, left: 0, top: y });
  tiles.push({ input: img, left: 0, top: y });
  y += h + 10;
}
await sharp({ create: { width: 1400, height: y, channels: 3, background: '#000' } }).composite(tiles).png().toFile(path.join(out, 'preview.png'));
console.log(`preview: ${path.join(out, 'preview.png')}`);
