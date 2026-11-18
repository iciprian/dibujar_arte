import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';

import { cleanDrawing, findDrawings, fitToCanvas } from '../src/drawing.js';

// A fake photo: greyish paper with a shadow gradient, a red disc and a blue square.
async function fakePhoto() {
  const svg = `<svg width="800" height="500" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g"><stop offset="0" stop-color="#d8d4cc"/><stop offset="1" stop-color="#a9a59e"/></linearGradient></defs>
    <rect width="800" height="500" fill="url(#g)"/>
    <circle cx="200" cy="250" r="90" fill="#d23" stroke="#222" stroke-width="6"/>
    <rect x="500" y="170" width="160" height="160" fill="none" stroke="#2255cc" stroke-width="8"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

const pixel = async (png, x, y) => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return [...data.subarray(i, i + 4)];
};

test('finds each drawing on the page', async () => {
  const { boxes } = await findDrawings(await fakePhoto());
  assert.equal(boxes.length, 2);
  assert.ok(boxes[0].x < 150 && boxes[0].x + boxes[0].w > 280, 'disc first (left to right)');
});

test('cuts a drawing out: paper transparent, colour kept, inside of an outline kept white', async () => {
  const photo = await fakePhoto();
  const disc = await cleanDrawing(photo, { box: { x: 100, y: 150, w: 200, h: 200 } });
  const meta = await sharp(disc).metadata();
  const [r, g, b, a] = await pixel(disc, Math.round(meta.width / 2), Math.round(meta.height / 2));
  assert.equal(a, 255);
  assert.ok(r > 180 && g < 100 && b < 120, `centre stays red, got ${r},${g},${b}`);
  assert.equal((await pixel(disc, 0, 0))[3], 0, 'corner is transparent');

  // the square is only an outline on the darker (shadowed) side of the paper
  const square = await cleanDrawing(photo, { box: { x: 490, y: 160, w: 180, h: 180 } });
  const sm = await sharp(square).metadata();
  const inside = await pixel(square, Math.round(sm.width / 2), Math.round(sm.height / 2));
  assert.equal(inside[3], 255, 'inside the outline is filled');
  assert.ok(Math.min(...inside.slice(0, 3)) > 225, `…and white despite the shadow, got ${inside}`);
});

test('fits exactly into the game size, standing on the bottom edge', async () => {
  const disc = await cleanDrawing(await fakePhoto(), { box: { x: 100, y: 150, w: 200, h: 200 } });
  const png = await fitToCanvas(disc, { width: 120, height: 160, place: 'bottom', margin: 0 });
  const meta = await sharp(png).metadata();
  assert.deepEqual([meta.width, meta.height], [120, 160]);
  assert.equal((await pixel(png, 60, 2))[3], 0, 'empty above');
  assert.ok((await pixel(png, 60, 158))[3] > 0, 'touches the bottom');
});

test('the hand: its topmost point lands on the given pixel', async () => {
  const svg = '<svg width="100" height="200" xmlns="http://www.w3.org/2000/svg"><path d="M50 0 L90 200 L10 200 Z" fill="#000"/></svg>';
  const png = await fitToCanvas(await sharp(Buffer.from(svg)).png().toBuffer(), { width: 336, height: 345, tip: [90, 18] });
  const near = await pixel(png, 90, 20);
  assert.ok(near[3] > 0, 'something at the tip');
  assert.equal((await pixel(png, 90, 10))[3], 0, 'nothing above it');
});
