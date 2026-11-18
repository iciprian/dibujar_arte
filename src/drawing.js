// Turns a phone photo of a drawing on paper into a clean game picture.
//
//   findDrawings(photo)        -> boxes around every drawing on the page
//   cleanDrawing(photo, opts)  -> one drawing cut out: paper removed,
//                                 colours brightened, transparent background
//   fitToCanvas(img, spec)     -> placed and scaled to the game's exact size
//
// No AI: just image processing, so it is free and keeps the drawing as it is.

import sharp from 'sharp';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

async function readRgb(input) {
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// ---------- paper colour ----------

// Estimates the colour of the bare paper under every pixel (it changes with
// light and shadows). Paper is the brightest *neutral* (grey-white) colour in
// each tile; a tile covered by colour (a yellow sun, a sky) has no neutral
// pixels, so it borrows the paper colour from its neighbours instead of
// mistaking the colour for paper.
function paperMap({ data, width, height }, tile) {
  const tw = Math.ceil(width / tile);
  const th = Math.ceil(height / tile);
  const tiles = new Float32Array(tw * th * 3);
  const valid = new Uint8Array(tw * th);
  // how colourful plain paper is in this photo (warm light makes it a bit yellow)
  const chromas = [];
  for (let i = 0; i < width * height; i += 97) {
    const r = data[i * 3]; const g = data[i * 3 + 1]; const b = data[i * 3 + 2];
    if (r + g + b > 300) chromas.push(Math.max(r, g, b) - Math.min(r, g, b));
  }
  chromas.sort((a, b) => a - b);
  const maxChroma = (chromas[Math.floor(chromas.length * 0.3)] ?? 10) + 14;
  const lumHist = new Uint32Array(766);
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      lumHist.fill(0);
      let n = 0; let total = 0;
      const x0 = tx * tile; const x1 = Math.min(width, x0 + tile);
      const y0 = ty * tile; const y1 = Math.min(height, y0 + tile);
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * width + x) * 3;
          const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
          total++;
          if (Math.max(r, g, b) - Math.min(r, g, b) > maxChroma) continue;
          lumHist[r + g + b]++; n++;
        }
      }
      if (n < total * 0.04 || n < 4) continue;
      // brightest 30% of the neutral pixels = paper (ink is darker)
      let acc = 0; let cut = 765;
      for (; cut > 0; cut--) { acc += lumHist[cut]; if (acc >= n * 0.3) break; }
      let sr = 0; let sg = 0; let sb = 0; let m = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * width + x) * 3;
          const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
          if (r + g + b < cut || Math.max(r, g, b) - Math.min(r, g, b) > maxChroma) continue;
          sr += r; sg += g; sb += b; m++;
        }
      }
      const t = (ty * tw + tx) * 3;
      tiles[t] = sr / m; tiles[t + 1] = sg / m; tiles[t + 2] = sb / m;
      valid[ty * tw + tx] = 1;
    }
  }
  // Paper is never much darker than the page's paper: a tile whose only
  // neutral pixels are grey pencil doesn't count as paper either.
  const lums = [];
  for (let i = 0; i < tw * th; i++) if (valid[i]) lums.push(tiles[i * 3] + tiles[i * 3 + 1] + tiles[i * 3 + 2]);
  lums.sort((a, b) => a - b);
  const pageLum = lums.length ? lums[Math.floor(lums.length * 0.75)] : 700;
  for (let i = 0; i < tw * th; i++) {
    if (valid[i] && tiles[i * 3] + tiles[i * 3 + 1] + tiles[i * 3 + 2] < pageLum * 0.8) valid[i] = 0;
  }
  // fill tiles without paper from their neighbours, ring by ring
  if (!valid.some(Boolean)) {
    for (let i = 0; i < tw * th * 3; i++) tiles[i] = pageLum / 3;
    valid.fill(1);
  }
  let missing = valid.reduce((a, v) => a + (v ? 0 : 1), 0);
  while (missing) {
    const next = valid.slice();
    for (let ty = 0; ty < th; ty++) {
      for (let tx = 0; tx < tw; tx++) {
        const j = ty * tw + tx;
        if (valid[j]) continue;
        let sr = 0; let sg = 0; let sb = 0; let m = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = tx + dx; const y = ty + dy;
            if (x < 0 || y < 0 || x >= tw || y >= th || !valid[y * tw + x]) continue;
            const k = (y * tw + x) * 3;
            sr += tiles[k]; sg += tiles[k + 1]; sb += tiles[k + 2]; m++;
          }
        }
        if (m) { tiles[j * 3] = sr / m; tiles[j * 3 + 1] = sg / m; tiles[j * 3 + 2] = sb / m; next[j] = 1; missing--; }
      }
    }
    valid.set(next);
  }
  // light changes smoothly: soften the map a little
  const smooth = new Float32Array(tiles.length);
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      for (let c = 0; c < 3; c++) {
        let s2 = 0; let m = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = tx + dx; const y = ty + dy;
            if (x < 0 || y < 0 || x >= tw || y >= th) continue;
            s2 += tiles[(y * tw + x) * 3 + c]; m++;
          }
        }
        // never darker than the tile's own paper (keeps shadows from staying)
        smooth[(ty * tw + tx) * 3 + c] = Math.max(s2 / m, tiles[(ty * tw + tx) * 3 + c] * 0.97);
      }
    }
  }
  return { tiles: smooth, tw, th, tile };
}

function paperAt(map, x, y, out) {
  const fx = clamp(x / map.tile - 0.5, 0, map.tw - 1);
  const fy = clamp(y / map.tile - 0.5, 0, map.th - 1);
  const x0 = Math.floor(fx); const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, map.tw - 1); const y1 = Math.min(y0 + 1, map.th - 1);
  const ax = fx - x0; const ay = fy - y0;
  for (let c = 0; c < 3; c++) {
    const a = map.tiles[(y0 * map.tw + x0) * 3 + c];
    const b = map.tiles[(y0 * map.tw + x1) * 3 + c];
    const d = map.tiles[(y1 * map.tw + x0) * 3 + c];
    const e = map.tiles[(y1 * map.tw + x1) * 3 + c];
    out[c] = Math.max(40, (a * (1 - ax) + b * ax) * (1 - ay) + (d * (1 - ax) + e * ax) * ay);
  }
  return out;
}

// Divides out the paper colour: paper becomes pure white, shadows vanish,
// and the drawing's colours come back to what they look like on white.
// Returns RGB plus an "ink" amount per pixel (0 = bare paper, 1 = full ink).
function flatten(img, map) {
  const { data, width, height } = img;
  const rgb = Buffer.alloc(width * height * 3);
  const ink = new Float32Array(width * height);
  const p = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      paperAt(map, x, y, p);
      const i = y * width + x;
      let lo = 1; let hi = 0;
      for (let c = 0; c < 3; c++) {
        const v = clamp(data[i * 3 + c] / p[c], 0, 1);
        rgb[i * 3 + c] = Math.round(v * 255);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      // darkness or colourfulness both count as ink
      ink[i] = Math.max(1 - lo, (hi - lo) * 1.2);
    }
  }
  return { rgb, ink, width, height };
}

// ---------- finding drawings on a page ----------

function dilate(mask, w, h, r) {
  // separable square dilation
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = -1;
    for (let x = 0; x < w + r; x++) {
      if (x < w && mask[y * w + x]) run = x;
      const t = x - r;
      if (t >= 0 && t < w && run >= 0 && x - run <= 2 * r) tmp[y * w + t] = 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let run = -1;
    for (let y = 0; y < h + r; y++) {
      if (y < h && tmp[y * w + x]) run = y;
      const t = y - r;
      if (t >= 0 && t < h && run >= 0 && y - run <= 2 * r) out[t * w + x] = 1;
    }
  }
  return out;
}

function components(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const comps = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    const c = { x0: w, y0: h, x1: 0, y1: 0, area: 0, border: false };
    label[s] = comps.length;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      const x = i % w; const y = (i - x) / w;
      c.area++;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) c.border = true;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= w * h) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === w - 1)) continue;
        if (mask[j] && label[j] < 0) { label[j] = comps.length; stack.push(j); }
      }
    }
    comps.push(c);
  }
  return { comps, label };
}

// Region of the photo that is paper (bright, not too colourful), so the
// table, the spiral, a sleeve or black bars around the photo are ignored.
function paperRegion(img) {
  const { data, width: w, height: h } = img;
  const bright = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 3]; const g = data[i * 3 + 1]; const b = data[i * 3 + 2];
    const hi = Math.max(r, g, b); const lo = Math.min(r, g, b);
    bright[i] = hi > 120 && hi - lo < 60 ? 1 : 0;
  }
  const { comps, label } = components(bright, w, h);
  let best = 0;
  comps.forEach((c, i) => { if (c.area > comps[best].area) best = i; });
  // paper = the biggest bright area plus everything it encloses (the drawings)
  const region = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) region[i] = label[i] === best ? 1 : 0;
  const outside = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x); }
  for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop();
    if (outside[i] || region[i]) continue;
    outside[i] = 1;
    const x = i % w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (i >= w) stack.push(i - w);
    if (i < w * (h - 1)) stack.push(i + w);
  }
  // shrink a little so the paper's own edge never counts as a drawing
  const grown = dilate(outside, w, h, 4);
  for (let i = 0; i < w * h; i++) region[i] = grown[i] ? 0 : 1;
  return region;
}

/**
 * Finds every separate drawing on a photographed page.
 * @returns {Promise<{width:number,height:number,boxes:{x:number,y:number,w:number,h:number}[]}>}
 *   boxes in the photo's pixels, top-to-bottom then left-to-right.
 */
export async function findDrawings(input, { gap = 0.012, minSize = 0.012 } = {}) {
  const meta = await sharp(input).metadata();
  const scale = 1024 / Math.max(meta.width, meta.height);
  const small = await readRgb(await sharp(input).resize(Math.round(meta.width * scale)).toBuffer());
  const { width: w, height: h } = small;
  const map = paperMap(small, 24);
  const flat = flatten(small, map);
  const paper = paperRegion(small);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = paper[i] && flat.ink[i] > 0.22 ? 1 : 0;
  // pieces closer than `gap` belong to the same drawing
  const joined = dilate(mask, w, h, Math.max(2, Math.round(gap * Math.max(w, h))));
  const { comps } = components(joined, w, h);
  const minPx = minSize * Math.max(w, h);
  const boxes = comps
    .filter((c) => !c.border && c.x1 - c.x0 >= minPx * 0.3 && c.y1 - c.y0 >= minPx * 0.3
      && Math.max(c.x1 - c.x0, c.y1 - c.y0) >= minPx)
    .map((c) => ({
      x: Math.round(c.x0 / scale), y: Math.round(c.y0 / scale),
      w: Math.round((c.x1 - c.x0 + 1) / scale), h: Math.round((c.y1 - c.y0 + 1) / scale),
    }));
  // reading order: rows (by centre), then left to right
  const rowH = Math.max(...boxes.map((b) => b.h), 1) * 0.5;
  boxes.sort((a, b) => {
    const ra = Math.round((a.y + a.h / 2) / rowH); const rb = Math.round((b.y + b.h / 2) / rowH);
    return ra - rb || a.x - b.x;
  });
  return { width: meta.width, height: meta.height, boxes };
}

// ---------- cleaning one drawing ----------

// Which part of the photo is the sheet of paper (computed once per photo).
const pageMasks = new Map();
export function pageMask(input) {
  const key = typeof input === 'string' ? input : null;
  if (key && pageMasks.has(key)) return pageMasks.get(key);
  const job = (async () => {
    const meta = await sharp(input).metadata();
    const scale = 1024 / Math.max(meta.width, meta.height);
    const small = await readRgb(await sharp(input).resize(Math.round(meta.width * scale)).toBuffer());
    return { mask: paperRegion(small), w: small.width, h: small.height, scale: small.width / meta.width };
  })();
  if (key) pageMasks.set(key, job);
  return job;
}

/**
 * Cuts one drawing out of a photo.
 * @param {object} o
 * @param {{x,y,w,h}} o.box    area of the photo (photo pixels, before rotating)
 * @param {number} [o.rotate]  0, 90, 180 or 270 (clockwise), applied after cutting
 * @param {boolean} [o.fill]   true: keep the area inside the outline (white
 *                             inside stays white). false: only the strokes.
 * @param {boolean} [o.opaque] true: no transparency at all (backgrounds, tiles)
 * @returns {Promise<Buffer>} PNG, trimmed to the drawing
 */
export async function cleanDrawing(input, {
  box, rotate = 0, fill = true, opaque = false, pad = 0.04, close = 0.012, strength = 1,
} = {}) {
  const meta = await sharp(input).metadata();
  const m = Math.round(Math.max(box.w, box.h) * pad);
  const x = clamp(box.x - m, 0, meta.width - 1);
  const y = clamp(box.y - m, 0, meta.height - 1);
  const cw = Math.min(meta.width - x, box.w + 2 * m);
  const ch = Math.min(meta.height - y, box.h + 2 * m);
  const crop = await sharp(input).extract({ left: x, top: y, width: cw, height: ch }).toBuffer();
  const img = await readRgb(crop);
  const { width: w, height: h } = img;
  const map = paperMap(img, Math.max(32, Math.round(Math.max(w, h) / 12)));
  const flat = flatten(img, map);
  if (strength !== 1) {
    // faint pencil: push every stroke further from white
    for (let i = 0; i < w * h; i++) {
      flat.ink[i] = Math.min(1, flat.ink[i] * strength);
      for (let c = 0; c < 3; c++) {
        const v = flat.rgb[i * 3 + c] / 255;
        flat.rgb[i * 3 + c] = Math.round(255 * clamp(1 - (1 - v) * strength, 0, 1));
      }
    }
  }
  if (!opaque) {
    // the table, black borders etc. around the page are not drawing
    const page = await pageMask(input);
    for (let yy = 0; yy < h; yy++) {
      const my = Math.min(page.h - 1, Math.floor((y + yy) * page.scale));
      for (let xx = 0; xx < w; xx++) {
        const mx = Math.min(page.w - 1, Math.floor((x + xx) * page.scale));
        if (!page.mask[my * page.w + mx]) flat.ink[yy * w + xx] = 0;
      }
    }
  }
  const out = Buffer.alloc(w * h * 4);

  // Colours: deepen pencil (it looks faint once shrunk) and brighten colour.
  for (let i = 0; i < w * h; i++) {
    let r = flat.rgb[i * 3] / 255; let g = flat.rgb[i * 3 + 1] / 255; let b = flat.rgb[i * 3 + 2] / 255;
    const l = (r + g + b) / 3;
    const sat = 1.45;
    r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
    const deepen = (v) => 1 - Math.pow(1 - clamp(v, 0, 1), 0.55); // inverse: darker strokes
    out[i * 4] = Math.round(255 * (1 - deepen(1 - r)));
    out[i * 4 + 1] = Math.round(255 * (1 - deepen(1 - g)));
    out[i * 4 + 2] = Math.round(255 * (1 - deepen(1 - b)));
    out[i * 4 + 3] = 255;
  }

  if (!opaque) {
    const lo = 0.1; const hi = 0.35;
    const strong = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) strong[i] = flat.ink[i] > hi ? 1 : 0;
    let inside = new Uint8Array(w * h);
    if (fill) {
      // close small gaps in outlines and hatching, then everything not
      // reachable from the edge of the crop is inside the drawing
      const r = Math.max(2, Math.round(Math.max(w, h) * close));
      const closed = dilate(strong, w, h, r);
      const outside = new Uint8Array(w * h);
      const stack = [];
      for (let xx = 0; xx < w; xx++) stack.push(xx, (h - 1) * w + xx);
      for (let yy = 0; yy < h; yy++) stack.push(yy * w, yy * w + w - 1);
      while (stack.length) {
        const i = stack.pop();
        if (outside[i] || closed[i]) continue;
        outside[i] = 1;
        const xx = i % w;
        if (xx > 0) stack.push(i - 1);
        if (xx < w - 1) stack.push(i + 1);
        if (i >= w) stack.push(i - w);
        if (i < w * (h - 1)) stack.push(i + w);
      }
      // undo the gap-closing growth: inside = not outside, shrunk back by r
      const outsideGrown = dilate(outside, w, h, r);
      for (let i = 0; i < w * h; i++) inside[i] = outsideGrown[i] ? 0 : 1;
    }
    for (let i = 0; i < w * h; i++) {
      const a = inside[i] ? 1 : clamp((flat.ink[i] - lo) / (hi - lo), 0, 1);
      out[i * 4 + 3] = Math.round(a * 255);
    }
    // drop specks: tiny islands of ink far from the drawing
    removeSpecks(out, w, h);
  }

  let pipeline = sharp(out, { raw: { width: w, height: h, channels: 4 } });
  if (!opaque) pipeline = sharp(await pipeline.png().toBuffer()).trim({ threshold: 1, lineArt: true });
  if (rotate) {
    pipeline = sharp(await pipeline.png().toBuffer()).rotate(rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    if (rotate % 90 && !opaque) pipeline = sharp(await pipeline.png().toBuffer()).trim({ threshold: 1 });
  }
  return pipeline.png().toBuffer();
}

function removeSpecks(rgba, w, h) {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = rgba[i * 4 + 3] > 40 ? 1 : 0;
  const { comps, label } = components(mask, w, h);
  if (!comps.length) return;
  const biggest = Math.max(...comps.map((c) => c.area));
  const keep = comps.map((c) => c.area >= biggest * 0.004);
  for (let i = 0; i < w * h; i++) {
    if (rgba[i * 4 + 3] === 0) continue;
    if (label[i] >= 0 ? !keep[label[i]] : rgba[i * 4 + 3] < 40) rgba[i * 4 + 3] = 0;
  }
}

// ---------- placing it on the game's canvas ----------

/**
 * Scales a cleaned drawing into a canvas of exactly width × height.
 * @param {'bottom'|'center'|'cover'|'stretch'} place
 *   bottom: standing on the bottom edge (characters, scenery)
 *   center: centred with a margin (icons, pictures)
 *   cover:  fills the canvas, cropping what overflows (backgrounds)
 *   stretch: fills exactly (tiles, buttons)
 */
export async function fitToCanvas(png, {
  width, height, place = 'center', margin = 0.06, white = false, tip = null,
}) {
  if (tip) return placeByTip(png, { width, height, tip });
  if (place === 'cover' || place === 'stretch') {
    let s = sharp(png).resize(width, height, { fit: place === 'cover' ? 'cover' : 'fill', kernel: 'lanczos3' });
    if (white) s = s.ensureAlpha();
    return whiten(await s.png().toBuffer(), white);
  }
  const mw = Math.round(width * (1 - 2 * margin));
  const mh = Math.round(height * (1 - (place === 'bottom' ? margin : 2 * margin)));
  const fitted = await sharp(png)
    .resize(mw, mh, { fit: 'inside', kernel: 'lanczos3' })
    .png().toBuffer({ resolveWithObject: true });
  const left = Math.round((width - fitted.info.width) / 2);
  const top = place === 'bottom' ? height - fitted.info.height : Math.round((height - fitted.info.height) / 2);
  const out = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: fitted.data, left, top }])
    .png().toBuffer();
  return whiten(out, white);
}

// White silhouette (the game's icons are white and get tinted).
async function whiten(png, white) {
  if (!white) return png;
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < info.width * info.height; i++) {
    const dark = 1 - (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 765;
    data[i * 4 + 3] = Math.round(data[i * 4 + 3] * clamp((dark - 0.08) * 3, 0, 1));
    data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

// The lesson hand: the topmost point of the drawing (the fingertip) must land
// exactly on pixel `tip` = [x, y] of the canvas.
async function placeByTip(png, { width, height, tip }) {
  const [tx, ty] = tip;
  const fitted = await sharp(png)
    .resize(Math.round(width * 0.95), Math.round((height - ty) * 0.97), { fit: 'inside', kernel: 'lanczos3' })
    .png().toBuffer({ resolveWithObject: true });
  const { data, info } = await sharp(fitted.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let fx = 0; let fy = 0;
  find: for (let y = 0; y < info.height; y++) {
    let sum = 0; let n = 0;
    for (let x = 0; x < info.width; x++) if (data[(y * info.width + x) * 4 + 3] > 128) { sum += x; n++; }
    if (n) { fx = Math.round(sum / n); fy = y; break find; }
  }
  const left = clamp(tx - fx, 0, width - info.width);
  const top = clamp(ty - fy, 0, height - info.height);
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: fitted.data, left, top }]).png().toBuffer();
}

// ---------- whole-page ink (for sheets of letters) ----------

/**
 * The whole photo with the paper divided out: rgb as it would look on pure
 * white, `ink` 0..1 per pixel, and 0 ink outside the sheet of paper.
 */
export async function inkImage(input, { maxSide = 2400 } = {}) {
  const meta = await sharp(input).metadata();
  const scale = Math.min(1, maxSide / Math.max(meta.width, meta.height));
  const img = await readRgb(await sharp(input).resize(Math.round(meta.width * scale)).toBuffer());
  const map = paperMap(img, Math.max(32, Math.round(Math.max(img.width, img.height) / 40)));
  const flat = flatten(img, map);
  const page = await pageMask(input);
  for (let y = 0; y < img.height; y++) {
    const my = Math.min(page.h - 1, Math.floor((y / scale) * page.scale));
    for (let x = 0; x < img.width; x++) {
      const mx = Math.min(page.w - 1, Math.floor((x / scale) * page.scale));
      if (!page.mask[my * page.w + mx]) flat.ink[y * img.width + x] = 0;
    }
  }
  return { ...flat, scale };
}

export { components as connectedComponents, dilate as dilateMask };

// ---------- backgrounds: gentle cleanup ----------

/**
 * A crop of the photo with only its paper made white (one correction for the
 * whole crop). Unlike cleanDrawing it keeps light crayon at its colour, which
 * suits full-screen backgrounds drawn in soft crayon.
 */
export async function whiteBalanceCrop(input, box) {
  const { data, info } = await sharp(input).extract({ left: box.x, top: box.y, width: box.w, height: box.h })
    .raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height; const ch = info.channels;
  const lum = [];
  for (let i = 0; i < n; i += 7) lum.push([data[i * ch] + data[i * ch + 1] + data[i * ch + 2], i]);
  lum.sort((a, b) => b[0] - a[0]);
  const top = lum.slice(0, Math.max(10, Math.floor(lum.length * 0.03))); // the brightest 3% is paper
  const paper = [0, 1, 2].map((c) => top.reduce((s, [, i]) => s + data[i * ch + c], 0) / top.length);
  const out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.min(255, Math.round((data[i * ch + c] * 252) / paper[c]));
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
}
