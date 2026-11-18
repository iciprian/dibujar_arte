// A font from a photographed sheet of hand-written letters.
//
// The sheet is read row by row: each row's expected characters are listed in
// the layout, the pieces of ink on that row are grouped into that many
// letters (a dot joins its i, a tilde its ñ, a broken H stays one letter),
// every letter sits on its row's writing line, and each set is scaled so its
// capitals and its small letters have the same height as every other set.
//
// Output: BMFont text files (.fnt) with a PNG atlas, which Godot loads as a
// FontFile. A "mask" set is white (the game colours it like any text); a
// "colour" set keeps the drawn colours (the game shows it with white text
// colour so the colours survive).

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { connectedComponents, dilateMask, inkImage } from './drawing.js';

const DESCENDERS = new Set([...'gjpqy¿¡,;']);
// marks that float above the writing line (placed by the line, not their bottom)
const FLOATING = new Set([...'\'"-·+=×¬→↔⇒^']);
const XHEIGHT = new Set([...'acemnorsuvwxz']); // small letters with no ascender or descender

/** Font metrics in atlas pixels for a font of `size` px. */
export function metrics(size) {
  return {
    size,
    capH: Math.round(size * 0.70),
    xH: Math.round(size * 0.50),
    ascent: Math.round(size * 0.98), // room for accents over capitals
    descent: Math.round(size * 0.30),
    side: Math.round(size * 0.025), // space before and after each letter
    space: Math.round(size * 0.30),
  };
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * Reads the letters of one sheet.
 * @param {string} photo
 * @param {{set: string, kind: 'upper'|'lower'|'punct', chars: string}[]} rows  top to bottom
 * @returns {Promise<{glyphs: object[], problems: string[]}>} glyph = {ch, set, kind, rgba, w, h, top, bottom, baseline}
 */
export async function readSheet(photo, rows, { rowMode = 'letters' } = {}) {
  const img = await inkImage(photo, { maxSide: 4000 });
  const { width: w, height: h } = img;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = img.ink[i] > 0.25 ? 1 : 0;
  const joined = dilateMask(mask, w, h, Math.max(1, Math.round(w / 800)));
  const { comps, label } = connectedComponents(joined, w, h);
  comps.forEach((c, i) => { c.id = i; c.cy = (c.y0 + c.y1) / 2; c.cx = (c.x0 + c.x1) / 2; });
  const minArea = (w / 1000) ** 2 * 30;
  let pieces = comps.filter((c) => !c.border && c.area >= minArea);

  // rows of a sparse sheet (symbols, some rows of small marks only): the
  // biggest vertical gaps between pieces split it
  if (rowMode === 'gaps') return readRows(img, label, rows, splitByGaps(pieces, rows.length));
  // rows: letter-sized pieces that overlap vertically form a row; then the
  // small pieces (dots, tildes, accents) join the nearest row
  const medH = median(pieces.map((c) => c.y1 - c.y0));
  const isBig = (c) => c.y1 - c.y0 >= medH * 0.3;
  const bigs = pieces.filter(isBig).sort((a, b) => a.cy - b.cy);
  const bands = [];
  for (const c of bigs) {
    const row = bands.find((r) => c.cy >= r.y0 && c.cy <= r.y1);
    if (row) { row.items.push(c); row.y0 = Math.min(row.y0, median([...row.items.map((x) => x.y0)])); }
    else bands.push({ y0: c.y0, y1: c.y1, items: [c] });
  }
  for (const r of bands) { r.y0 = median(r.items.map((x) => x.y0)); r.y1 = median(r.items.map((x) => x.y1)); }
  // merge rows that are really one: letters hanging below the line (g, j, ¿)
  // make their own band that overlaps the row a good part of its height
  let merged = true;
  while (merged) {
    merged = false;
    bands.sort((a, b) => a.y0 - b.y0);
    for (let i = 1; i < bands.length; i++) {
      const a = bands[i - 1]; const b = bands[i];
      const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (overlap > 0.3 * Math.min(a.y1 - a.y0, b.y1 - b.y0)) {
        a.items.push(...b.items); a.y0 = Math.min(a.y0, b.y0); a.y1 = Math.max(a.y1, b.y1);
        bands.splice(i, 1); merged = true; break;
      }
    }
  }
  // a thin band with one or two pieces is the tildes/accents over a row:
  // it belongs to the row just below it
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (b.items.length <= 2 && b.y1 - b.y0 < medH * 0.5 && i + 1 < bands.length) {
      bands[i + 1].items.push(...b.items);
      bands[i + 1].y0 = Math.min(bands[i + 1].y0, b.y0);
      bands.splice(i--, 1);
    }
  }
  const medW = median(bigs.map((c) => c.x1 - c.x0));
  for (const c of pieces.filter((x) => !isBig(x))) {
    let best = null; let bestD = Infinity;
    for (const r of bands) {
      const d = c.cy < r.y0 ? r.y0 - c.cy : c.cy > r.y1 ? c.cy - r.y1 : 0;
      if (d < bestD) { bestD = d; best = r; }
    }
    // a speck far from any letter of its row is dirt on the paper
    const nearX = Math.min(...best.items.filter(isBig).map((x) => Math.max(0, x.x0 - c.x1, c.x0 - x.x1)));
    // a drawn full stop is a solid blob; dirt is a faint speck
    let ink = 0; let n = 0;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) { ink += img.ink[y * w + x]; n++; }
    const solid = n ? ink / n : 0;
    const isPunct = solid > 0.17 && (c.y1 - c.y0) > medH * 0.1; // drawn dots ~0.23, dirt ~0.10
    if (process.env.HANDFONT_DEBUG) console.log('small piece', Math.round(c.cx), Math.round(c.cy), 'h', c.y1 - c.y0, 'solid', solid.toFixed(2), 'nearX', Math.round(nearX), 'medW', Math.round(medW));
    if (nearX > medW * 1.2 && !isPunct) continue;
    best.items.push(c);
  }
  if (bands.length !== rows.length) {
    return { glyphs: [], problems: [`found ${bands.length} rows of letters, the layout has ${rows.length}: ` + bands.map((r) => `${Math.round(r.y0)}-${Math.round(r.y1)}:${r.items.length}`).join(" ") + ` medH ${medH}`] };
  }
  return readRows(img, label, rows, bands.map((r) => r.items));
}

function splitByGaps(pieces, n) {
  const sorted = [...pieces].sort((a, b) => a.cy - b.cy);
  // gap between a piece and everything above it (rows overlap little)
  const gaps = [];
  let lowest = -Infinity;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) gaps.push({ i, g: sorted[i].y0 - lowest });
    lowest = Math.max(lowest, sorted[i].y1);
  }
  const cuts = gaps.sort((a, b) => b.g - a.g).slice(0, n - 1).map((x) => x.i).sort((a, b) => a - b);
  const out = [];
  let start = 0;
  for (const c of [...cuts, sorted.length]) { out.push(sorted.slice(start, c)); start = c; }
  return out;
}

/** The letters of each row, from the pieces of ink found on it. */
function readRows(img, label, rows, rowsItems) {
  const { width: w, height: h } = img;
  if (rowsItems.length !== rows.length) {
    return { glyphs: [], problems: [`found ${rowsItems.length} rows, the layout has ${rows.length}`] };
  }

  const problems = [];
  const glyphs = [];
  rows.forEach((row, r) => {
    if (row.kind === 'skip') return; // a row of examples, not characters
    const chars = [...row.chars];
    if (row.xMax) rowsItems[r] = rowsItems[r].filter((c) => c.x0 < w * row.xMax); // what follows is not wanted
    // left to right; then join the pieces that overlap most until the count fits
    let groups = rowsItems[r].sort((a, b) => a.x0 - b.x0).map((c) => ({ parts: [c], x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 }));
    // drop specks far smaller than the row's letters once there are too many pieces
    const typical = median(groups.map((g) => (g.x1 - g.x0) * (g.y1 - g.y0)));
    while (groups.length > chars.length) {
      let best = -1; let bestScore = Infinity;
      for (let i = 0; i + 1 < groups.length; i++) {
        const a = groups[i]; const b = groups[i + 1];
        const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const narrow = Math.min(a.x1 - a.x0, b.x1 - b.x0) || 1;
        // overlapping a lot = same letter (dot over i, bar of a broken H);
        // otherwise the closest pair, small pieces first
        const small = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0)) / typical;
        const score = overlap > 0 ? -overlap / narrow : (-overlap / narrow) * Math.min(1, small + 0.2);
        if (score < bestScore) { bestScore = score; best = i; }
      }
      const a = groups[best]; const b = groups[best + 1];
      groups.splice(best, 2, {
        parts: [...a.parts, ...b.parts],
        x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1),
      });
    }
    if (groups.length !== chars.length) {
      problems.push(`row ${r + 1} (${row.chars}): found ${groups.length} letters, expected ${chars.length}`);
      return;
    }
    // the writing line: letters that sit on it keep their own bottom (rows
    // drift and slope); letters hanging below use a line fitted through the
    // others' bottoms
    const sits = (i) => !DESCENDERS.has(chars[i]) && !FLOATING.has(chars[i]) && chars[i] !== 'Q';
    let pts = groups.map((g, i) => ({ x: (g.x0 + g.x1) / 2, y: g.y1, ok: sits(i) })).filter((p) => p.ok);
    if (!pts.length) pts = [{ x: 0, y: Math.max(...groups.map((g) => g.y1)) }];
    const fit = (list) => {
      const n = list.length; const mx = list.reduce((a, p) => a + p.x, 0) / n; const my = list.reduce((a, p) => a + p.y, 0) / n;
      const sxx = list.reduce((a, p) => a + (p.x - mx) ** 2, 0) || 1;
      const k = list.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) / sxx;
      return (x) => my + k * (x - mx);
    };
    // a slope needs several letters; from two or three it would tilt wildly
    // when carried over to the marks further along the row
    const flat = median(pts.map((p) => p.y));
    let line = pts.length >= 4 ? fit(pts) : () => flat;
    const resid = pts.map((p) => Math.abs(p.y - line(p.x)));
    const lim = Math.max(3, median(resid) * 2.5);
    const good = pts.filter((p, j) => resid[j] <= lim);
    if (good.length >= 4) line = fit(good);
    groups.forEach((g, i) => {
      const baseline = sits(i) ? g.y1 : line((g.x0 + g.x1) / 2);
      const ids = new Set(g.parts.map((p) => p.id));
      const pad = 3;
      const x0 = Math.max(0, g.x0 - pad); const y0 = Math.max(0, g.y0 - pad);
      const gw = Math.min(w, g.x1 + pad + 1) - x0; const gh = Math.min(h, g.y1 + pad + 1) - y0;
      const rgba = Buffer.alloc(gw * gh * 4);
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          const src = (y0 + y) * w + (x0 + x);
          if (!ids.has(label[src])) continue; // a neighbour's stroke
          const a = Math.min(1, Math.max(0, (img.ink[src] - 0.1) / 0.3));
          const o = (y * gw + x) * 4;
          rgba[o] = img.rgb[src * 3]; rgba[o + 1] = img.rgb[src * 3 + 1]; rgba[o + 2] = img.rgb[src * 3 + 2];
          rgba[o + 3] = Math.round(a * 255);
        }
      }
      if ((row.drop || '').includes(chars[i])) return; // read only to keep the count right
      glyphs.push({ ch: chars[i], set: row.set, kind: row.kind, rgba, w: gw, h: gh, top: y0, bottom: y0 + gh, baseline });
    });
  });
  return { glyphs, problems };
}

/** How much each (set, kind) must be scaled so all sets share the same heights. */
export function scales(glyphs, m) {
  const out = {};
  const by = (set, kind, pick) => glyphs.filter((g) => g.set === set && g.kind === kind && pick(g.ch));
  for (const set of new Set(glyphs.map((g) => g.set))) {
    const caps = by(set, 'upper', (c) => /[A-ZÑ]/.test(c) && c !== 'Q' && c !== 'J');
    const small = by(set, 'lower', (c) => XHEIGHT.has(c));
    const capH = median(caps.map((g) => g.baseline - g.top - 3));
    const xH = median(small.map((g) => g.baseline - g.top - 3));
    out[`${set}/upper`] = capH ? m.capH / capH : null;
    out[`${set}/lower`] = xH ? m.xH / xH : null;
  }
  // a sheet of symbols: everything on it follows its digits (as tall as capitals)
  for (const set of new Set(glyphs.map((g) => g.set))) {
    const digits = glyphs.filter((g) => g.set === set && /[0-9]/.test(g.ch));
    if (digits.length >= 4) {
      const dH = median(digits.map((g) => g.baseline - g.top - 3));
      out[`${set}/digits`] = m.capH * 0.95 / dH;
    }
  }
  // punctuation rows follow their set's capitals (or small letters)
  for (const set of new Set(glyphs.map((g) => g.set))) {
    if (out[`${set}/digits`]) {
      out[`${set}/punct`] = out[`${set}/upper`] = out[`${set}/lower`] = out[`${set}/digits`];
      continue;
    }
    out[`${set}/punct`] = out[`${set}/upper`] || out[`${set}/lower`];
    out[`${set}/upper`] ||= out[`${set}/lower`];
    out[`${set}/lower`] ||= out[`${set}/upper`];
  }
  return out;
}

/** About how thick a glyph's strokes are, in px: twice its ink over its outline. */
function thickness(g) {
  let area = 0; let edge = 0;
  const on = (x, y) => x >= 0 && y >= 0 && x < g.w && y < g.h && g.data[(y * g.w + x) * 4 + 3] > 128;
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    if (!on(x, y)) continue;
    area++;
    if (!on(x - 1, y) || !on(x + 1, y) || !on(x, y - 1) || !on(x, y + 1)) edge++;
  }
  return edge ? (2 * area) / edge : 0;
}

/** Scales one glyph and turns it white (mask) or keeps and brightens its colour. */
async function finishGlyph(g, scale, { mode, bold = 0, condense = 1, edge = null, soft = 1.1 }) {
  const tw = Math.max(1, Math.round(g.w * scale * condense)); const th = Math.max(1, Math.round(g.h * scale));
  let { data } = await sharp(g.rgba, { raw: { width: g.w, height: g.h, channels: 4 } })
    .resize(tw, th, { kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true });
  data = Buffer.from(data);
  // room around the letter for what grows: thicker strokes, the soft edge and
  // the dark edge (without it the strokes were cut off at the letter's box)
  const pad = (edge ? edge.px : 0) + bold + Math.ceil(soft * 3) + 2;
  const W = tw + 2 * pad; const H = th + 2 * pad;
  const big = Buffer.alloc(W * H * 4);
  for (let y = 0; y < th; y++) data.copy(big, ((y + pad) * W + pad) * 4, y * tw * 4, (y + 1) * tw * 4);
  data = big;
  g = { ...g, top: g.top - pad / scale };
  if (bold) data = growAlpha(data, W, H, bold);
  if (soft) data = await softEdges(data, W, H, soft);
  const fill = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) fill[i] = data[i * 4 + 3];
  const ring = edge ? await softEdges(growAlpha(Buffer.from(data), W, H, edge.px), W, H, soft) : null;
  for (let i = 0; i < W * H; i++) {
    if (mode === 'mask') {
      if (edge) {
        // white letter over a dark edge (Godot cannot outline a drawn font)
        const af = fill[i] / 255; const ab = (ring[i * 4 + 3] / 255) * edge.alpha;
        const a = af + ab * (1 - af);
        for (let c = 0; c < 3; c++) data[i * 4 + c] = a ? Math.round((255 * af + edge.rgb[c] * ab * (1 - af)) / a) : 0;
        data[i * 4 + 3] = Math.round(a * 255);
      } else {
        data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255;
      }
    } else {
      // marker colour, deeper and more saturated than the photo so it reads small
      const r = data[i * 4]; const gg = data[i * 4 + 1]; const b = data[i * 4 + 2];
      const l = (r + gg + b) / 3;
      for (const [c, v] of [[0, r], [1, gg], [2, b]]) data[i * 4 + c] = Math.max(0, Math.min(255, Math.round((l + (v - l) * 1.7) * 0.74)));
    }
  }
  return trimGlyph(g, scale, data, W, H);
}

/** Rounder, softer stroke edges: the alpha is blurred a little and firmed up again. */
async function softEdges(data, w, h, sigma) {
  const alpha = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = data[i * 4 + 3];
  const blurred = await sharp(alpha, { raw: { width: w, height: h, channels: 1 } }).blur(Math.max(0.3, sigma)).extractChannel(0).raw().toBuffer();
  if (blurred.length !== w * h) throw new Error(`softEdges: ${blurred.length} bytes for ${w}x${h}`);
  for (let i = 0; i < w * h; i++) {
    // firm the middle, keep a soft rim: smoothstep on the blurred alpha
    const t = Math.min(1, Math.max(0, (blurred[i] / 255 - 0.12) / 0.6));
    data[i * 4 + 3] = Math.round(255 * t * t * (3 - 2 * t));
  }
  return data;
}

function trimGlyph(g, scale, data, tw, th) {
  // trim to the ink (the crop had a margin): keeps letter spacing even
  let x0 = tw; let x1 = -1; let y0 = th; let y1 = -1;
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    if (data[(y * tw + x) * 4 + 3] > 6) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = tw - 1; y1 = th - 1; }
  const cw = x1 - x0 + 1; const ch = y1 - y0 + 1;
  const cut = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) data.copy(cut, y * cw * 4, ((y0 + y) * tw + x0) * 4, ((y0 + y) * tw + x1 + 1) * 4);
  return {
    ch: g.ch, w: cw, h: ch, data: cut,
    // offset of the glyph's top above the writing line, in atlas px
    rise: Math.round((g.baseline - g.top) * scale) - y0,
  };
}

/** How much to narrow a set so its small letters are about as wide as an everyday font's. */
function condenseFor(glyphs, sc, m) {
  const lower = glyphs.filter((g) => g.kind === 'lower' && /[a-z]/.test(g.ch));
  if (!lower.length) return 1;
  const avg = lower.reduce((s, g) => s + g.w * sc[`${g.set}/lower`], 0) / lower.length; // includes crop margin
  const target = m.size * 0.5;
  return Math.max(0.72, Math.min(1, target / avg));
}

/** Thicker strokes, grown with a round brush; new pixels take the colour of the stroke they grow from. */
function growAlpha(data, w, h, r) {
  const src = Buffer.from(data);
  const offs = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + r * 0.6) offs.push([dx, dy]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    let best = src[i * 4 + 3]; let from = i;
    for (const [dx, dy] of offs) {
      const xx = x + dx; const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (src[j * 4 + 3] > best) { best = src[j * 4 + 3]; from = j; }
    }
    if (from !== i) { data[i * 4] = src[from * 4]; data[i * 4 + 1] = src[from * 4 + 1]; data[i * 4 + 2] = src[from * 4 + 2]; data[i * 4 + 3] = best; }
  }
  return data;
}

// ---------- characters nobody drew, made from drawn strokes ----------

function blank(w, h) { return { w, h, data: Buffer.alloc(w * h * 4) }; }

async function rasterRotate(g, deg) {
  const out = await sharp(g.data, { raw: { width: g.w, height: g.h, channels: 4 } })
    .rotate(deg, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).trim({ threshold: 1 }).raw().toBuffer({ resolveWithObject: true })
    .catch(() => null);
  return out ? { w: out.info.width, h: out.info.height, data: Buffer.from(out.data) } : g;
}

async function resizeG(g, w, h) {
  const { data, info } = await sharp(g.data, { raw: { width: g.w, height: g.h, channels: 4 } })
    .resize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height, data: Buffer.from(data) };
}

/** Puts parts ({g, x, y} with y = top above the writing line) into one glyph. */
function compose(ch, parts) {
  const x0 = Math.min(...parts.map((p) => p.x));
  const x1 = Math.max(...parts.map((p) => p.x + p.g.w));
  const top = Math.max(...parts.map((p) => p.y));
  const bottom = Math.min(...parts.map((p) => p.y - p.g.h));
  const w = Math.ceil(x1 - x0); const h = Math.ceil(top - bottom);
  const out = blank(w, h);
  for (const p of parts) {
    const ox = Math.round(p.x - x0); const oy = Math.round(top - p.y);
    for (let y = 0; y < p.g.h; y++) for (let x = 0; x < p.g.w; x++) {
      const s = (y * p.g.w + x) * 4; const a = p.g.data[s + 3];
      if (!a) continue;
      const tx = ox + x; const ty = oy + y;
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
      const d = (ty * w + tx) * 4;
      if (a > out.data[d + 3]) { out.data.set(p.g.data.subarray(s, s + 4), d); }
    }
  }
  return { ch, ...out, rise: Math.round(top) };
}

function tint(g, rgb) {
  const data = Buffer.from(g.data);
  for (let i = 0; i < g.w * g.h; i++) { data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; }
  return { ...g, data };
}

function meanColour(glyphs) {
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (const gl of glyphs) for (let i = 0; i < gl.w * gl.h; i++) {
    if (gl.data[i * 4 + 3] < 200) continue;
    r += gl.data[i * 4]; g += gl.data[i * 4 + 1]; b += gl.data[i * 4 + 2]; n++;
  }
  return n ? [r / n, g / n, b / n].map(Math.round) : [255, 255, 255];
}

/**
 * Adds what the sheet lacks, from the set's own strokes: accented vowels,
 * ü, comma, colon, semicolon, hyphen, apostrophe, ellipsis.
 * `stroke`: a short straight stroke (from a drawn "!"), `dot`: a drawn ".".
 */
async function synthesize(map, m, { stroke, dot, upperColour, lowerColour }) {
  const add = (g) => { if (!map.has(g.ch)) map.set(g.ch, g); };
  // the accent: the one drawn over á if there is one, else a turned stroke
  const drawnA = map.get('á');
  const accent = (drawnA && await accentOf(drawnA, m)) || await resizeG(await rasterRotate(stroke, 38), m.size * 0.13, m.size * 0.2);
  const smallDot = await resizeG(dot, dot.w * 0.85, dot.h * 0.85);
  const accFor = (base) => (/[A-ZÁÉÍÓÚÑ]/.test(base.ch) ? (upperColour ? tint(accent, upperColour) : accent) : (lowerColour ? tint(accent, lowerColour) : accent));
  const dotFor = (base) => (/[A-Z]/.test(base.ch) ? (upperColour ? tint(smallDot, upperColour) : smallDot) : (lowerColour ? tint(smallDot, lowerColour) : smallDot));
  for (const [plain, accented] of [['a', 'á'], ['e', 'é'], ['o', 'ó'], ['u', 'ú'], ['A', 'Á'], ['E', 'É'], ['I', 'Í'], ['O', 'Ó'], ['U', 'Ú']]) {
    const base = map.get(plain);
    if (!base) continue;
    const acc = accFor(base);
    const gap = m.size * 0.06;
    add(compose(accented, [{ g: base, x: 0, y: base.rise }, { g: acc, x: (base.w - acc.w) / 2 + base.w * 0.08, y: base.rise + gap + acc.h }]));
  }
  // í: a dotless i would need drawing; the accent goes on the i's own stem
  const i = map.get('i');
  if (i) {
    const stem = await trimTop(i, 0.28); // cut the dot off
    const acc = accFor(i);
    add(compose('í', [{ g: stem, x: 0, y: stem.rise }, { g: acc, x: (stem.w - acc.w) / 2 + stem.w * 0.1, y: stem.rise + m.size * 0.06 + acc.h }]));
  }
  const u = map.get('u');
  if (u) {
    const d = dotFor(u);
    const y = u.rise + m.size * 0.08 + d.h;
    add(compose('ü', [{ g: u, x: 0, y: u.rise }, { g: d, x: u.w * 0.22 - d.w / 2, y }, { g: d, x: u.w * 0.78 - d.w / 2, y }]));
  }
  const d0 = dotFor({ ch: '.' });
  const tail = await resizeG(await rasterRotate(stroke, 20), m.size * 0.07, m.size * 0.16);
  const tl = lowerColour ? tint(tail, lowerColour) : tail;
  add(compose(',', [{ g: d0, x: 0, y: d0.h }, { g: tl, x: d0.w * 0.25, y: d0.h * 0.4 }]));
  add(compose(':', [{ g: d0, x: 0, y: d0.h }, { g: d0, x: 0, y: m.xH * 0.75 }]));
  const comma = map.get(',');
  if (comma) add(compose(';', [{ g: comma, x: 0, y: comma.rise }, { g: d0, x: 0, y: m.xH * 0.75 }]));
  add(compose('…', [0, 1, 2].map((k) => ({ g: d0, x: k * d0.w * 1.6, y: d0.h }))));
  const bar = await resizeG(await rasterRotate(stroke, 90), m.size * 0.26, Math.max(4, stroke.w * (m.size * 0.26) / stroke.h * 0.9));
  const hy = lowerColour ? tint(bar, lowerColour) : bar;
  add(compose('-', [{ g: hy, x: 0, y: m.xH * 0.55 + hy.h / 2 }]));
  const apo = await resizeG(stroke, stroke.w * (m.size * 0.18) / stroke.h, m.size * 0.18);
  const ap = upperColour ? tint(apo, upperColour) : apo;
  add(compose("'", [{ g: ap, x: 0, y: m.capH }]));
  add(compose('"', [{ g: ap, x: 0, y: m.capH }, { g: ap, x: ap.w * 2.2, y: m.capH }]));
}

// ---------- symbols, from the same strokes ----------

/** A straight bar `len` px long from the drawn stroke, turned `deg` (0 = upright). */
async function bar(stroke, len, deg) {
  const thick = Math.max(3, stroke.w);
  const upright = await resizeG(stroke, thick, Math.max(4, len));
  return deg ? rasterRotate(upright, deg) : upright;
}

/** Parts placed by their centre: {g, cx, cy} (cy above the writing line). */
function composeC(ch, parts) {
  return compose(ch, parts.map((p) => ({ g: p.g, x: p.cx - p.g.w / 2, y: p.cy + p.g.h / 2 })));
}

async function fromImage(file, h, tint) {
  try {
    const { data, info } = await sharp(file).trim({ threshold: 1 }).resize({ height: Math.round(h) }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const g = { w: info.width, h: info.height, data: Buffer.from(data) };
    return tint ? { ...g, data: tintData(g, tint) } : g;
  } catch { return null; }
}

function tintData(g, rgb) {
  const d = Buffer.from(g.data);
  for (let i = 0; i < g.w * g.h; i++) { d[i * 4] = rgb[0]; d[i * 4 + 1] = rgb[1]; d[i * 4 + 2] = rgb[2]; }
  return d;
}

/**
 * The symbols the game writes in plain text (tool buttons…): logic signs
 * made of drawn strokes, ∀ ∃ from the drawn A and E, ★ ✓ ▶ from the drawn
 * menu signs (white pictures).
 */
async function symbols(map, m, { stroke: leaning, colour, icons = {} }) {
  const add = (g) => { if (g && !map.has(g.ch)) map.set(g.ch, g); };
  const stroke = await upright(leaning);
  const st = colour ? { ...stroke, data: tintData(stroke, colour) } : stroke;
  const em = m.size; const mid = m.xH * 0.55;
  const H = async (len) => bar(st, len, 90);
  const slant = async (len, deg) => bar(st, len, deg);
  const shaft = await H(em * 0.5);
  const head = em * 0.17;
  const tip = async (cx, cy, dir) => [ // two short bars meeting at (cx, cy)
    ...(await Promise.all([40, -40].map(async (a) => {
      const g = await bar(st, head, 90 + a * dir);
      const rad = (a * Math.PI) / 180;
      return { g, cx: cx - dir * Math.cos(rad) * head * 0.45, cy: cy + Math.sin(rad) * head * 0.45 };
    }))),
  ];
  add(composeC('¬', [{ g: await H(em * 0.36), cx: 0, cy: mid + em * 0.05 }, { g: await bar(st, em * 0.14, 0), cx: em * 0.17, cy: mid - em * 0.02 }]));
  const up = em * 0.42;
  add(composeC('∧', [{ g: await slant(up, 22), cx: -em * 0.08, cy: mid }, { g: await slant(up, -22), cx: em * 0.08, cy: mid }]));
  add(composeC('∨', [{ g: await slant(up, -22), cx: -em * 0.08, cy: mid }, { g: await slant(up, 22), cx: em * 0.08, cy: mid }]));
  add(composeC('→', [{ g: shaft, cx: 0, cy: mid }, ...(await tip(em * 0.25, mid, 1))]));
  add(composeC('↔', [{ g: shaft, cx: 0, cy: mid }, ...(await tip(em * 0.25, mid, 1)), ...(await tip(-em * 0.25, mid, -1))]));
  add(composeC('⇒', [{ g: shaft, cx: 0, cy: mid + em * 0.06 }, { g: shaft, cx: 0, cy: mid - em * 0.06 }, ...(await tip(em * 0.27, mid, 1))]));
  add(composeC('⊥', [{ g: await bar(st, em * 0.5, 0), cx: 0, cy: em * 0.27 }, { g: await H(em * 0.42), cx: 0, cy: em * 0.02 }]));
  const plusV = await bar(st, em * 0.36, 0); const plusH = await H(em * 0.36);
  add(composeC('+', [{ g: plusV, cx: 0, cy: mid }, { g: plusH, cx: 0, cy: mid }]));
  add(composeC('=', [{ g: plusH, cx: 0, cy: mid + em * 0.07 }, { g: plusH, cx: 0, cy: mid - em * 0.07 }]));
  add(composeC('×', [{ g: await slant(em * 0.34, 45), cx: 0, cy: mid }, { g: await slant(em * 0.34, -45), cx: 0, cy: mid }]));
  const A = map.get('A'); const E = map.get('E'); const o = map.get('o');
  if (A) { const r = await rasterRotate(A, 180); add({ ch: '∀', ...r, rise: m.capH }); }
  if (E) {
    const { data, info } = await sharp(E.data, { raw: { width: E.w, height: E.h, channels: 4 } }).flop().raw().toBuffer({ resolveWithObject: true });
    add({ ch: '∃', w: info.width, h: info.height, data: Buffer.from(data), rise: E.rise });
  }
  if (o) {
    const small = em * 0.2;
    add(compose('⊕', [{ g: o, x: 0, y: o.rise }, { g: await bar(st, small, 0), x: o.w / 2 - st.w / 2, y: o.rise * 0.5 + small / 2 }, { g: await H(small), x: o.w / 2 - small / 2, y: o.rise * 0.5 + st.w / 2 }]));
  }
  for (const [ch, file, h, rise] of [['★', icons.star, m.capH, m.capH], ['✓', icons.checkmark, m.capH * 0.9, m.capH * 0.9], ['▶', icons.play, m.capH * 0.8, m.capH * 0.8]]) {
    if (!file) continue;
    let g = await fromImage(file, h, colour);
    if (g && ch === '▶') g = await cropLeft(g, 0.68); // the drawn sign is ▶|: keep the triangle
    if (g) add({ ch, ...g, rise });
  }
  // small digits under the line (x₁) and ^ from the drawn ones
  for (let k = 0; k <= 9; k++) {
    const dg = map.get(String(k));
    if (!dg) continue;
    const small = await resizeG(dg, dg.w * 0.6, dg.h * 0.6);
    add({ ch: String.fromCodePoint(0x2080 + k), ...small, rise: Math.round(small.h * 0.55) });
  }
  const wedge = map.get('∧');
  if (wedge) {
    const small = await resizeG(wedge, wedge.w * 0.6, wedge.h * 0.6);
    add({ ch: '^', ...small, rise: m.capH });
  }
  const d = map.get('.');
  if (d) {
    add(composeC('·', [{ g: d, cx: 0, cy: mid }]));
    add(composeC('•', [{ g: await resizeG(d, d.w * 1.5, d.h * 1.5), cx: 0, cy: mid }]));
  }
}

/** The stroke stood up straight: the turn that makes it narrowest. */
async function upright(g) {
  let best = g; let bestW = Infinity;
  for (let deg = -30; deg <= 30; deg += 2) {
    const r = deg ? await rasterRotate(g, deg) : g;
    if (r.w < bestW) { bestW = r.w; best = r; }
  }
  return best;
}

async function cropLeft(g, frac) {
  const w = Math.max(1, Math.round(g.w * frac));
  const { data, info } = await sharp(g.data, { raw: { width: g.w, height: g.h, channels: 4 } }).extract({ left: 0, top: 0, width: w, height: g.h }).trim({ threshold: 1 }).raw().toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height, data: Buffer.from(data) };
}

/** The accent of a drawn á: what is above its small letter. */
async function accentOf(g, m) {
  const cut = Math.max(1, Math.round(g.rise - m.xH * 1.08));
  if (cut >= g.h || cut < 4) return null;
  const data = Buffer.from(g.data.subarray(0, cut * g.w * 4));
  try {
    const { data: d, info } = await sharp(data, { raw: { width: g.w, height: cut, channels: 4 } }).trim({ threshold: 1 }).raw().toBuffer({ resolveWithObject: true });
    return { w: info.width, h: info.height, data: Buffer.from(d) };
  } catch { return null; }
}

async function trimTop(g, frac) {
  const cut = Math.round(g.h * frac);
  const data = Buffer.from(g.data);
  data.fill(0, 0, cut * g.w * 4);
  const out = await sharp(data, { raw: { width: g.w, height: g.h, channels: 4 } }).trim({ threshold: 1 }).raw().toBuffer({ resolveWithObject: true });
  return { ch: g.ch, w: out.info.width, h: out.info.height, data: Buffer.from(out.data), rise: g.rise - (g.h - out.info.height) + (g.h - cut - out.info.height) * 0 };
}

/** The straight stroke of a drawn "!" (without its dot), to make accents and hyphens. */
function strokeOf(bang) {
  // keep the tallest connected run from the top: everything above the lowest gap
  let lastInk = 0; let gapAt = bang.h;
  const rowInk = (y) => { let s = 0; for (let x = 0; x < bang.w; x++) s += bang.data[(y * bang.w + x) * 4 + 3]; return s; };
  for (let y = 0; y < bang.h; y++) { if (rowInk(y) > 0) lastInk = y; else if (lastInk && y - lastInk > 1) { gapAt = y; break; } }
  const h = Math.max(4, gapAt);
  const data = Buffer.from(bang.data.subarray(0, h * bang.w * 4));
  return { w: bang.w, h, data };
}

// ---------- BMFont + atlas ----------

function pack(glyphs, pad = 4, maxW = 2048) {
  const sorted = [...glyphs].sort((a, b) => b.h - a.h);
  let x = pad; let y = pad; let rowH = 0;
  for (const g of sorted) {
    if (x + g.w + pad > maxW) { x = pad; y += rowH + pad; rowH = 0; }
    g.ax = x; g.ay = y;
    x += g.w + pad; rowH = Math.max(rowH, g.h);
  }
  return { width: maxW, height: y + rowH + pad };
}

/**
 * Writes `<name>.fnt` + `<name>.png` into dir.
 * @param {Map<string, {w,h,data,rise}>} map
 */
export async function writeFont(dir, name, map, m) {
  const glyphs = [...map.values()];
  const { width, height } = pack(glyphs);
  const atlas = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(glyphs.map((g) => ({ input: g.data, raw: { width: g.w, height: g.h, channels: 4 }, left: g.ax, top: g.ay })))
    .png().toBuffer();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.png`), atlas);
  const base = m.ascent;
  const lines = [
    `info face="${name}" size=${m.size} bold=0 italic=0 charset="" unicode=1 stretchH=100 smooth=1 aa=1 padding=0,0,0,0 spacing=0,0`,
    `common lineHeight=${m.ascent + m.descent} base=${base} scaleW=${width} scaleH=${height} pages=1 packed=0 alphaChnl=0 redChnl=0 greenChnl=0 blueChnl=0`,
    `page id=0 file="${name}.png"`,
    `chars count=${glyphs.length + 1}`,
    `char id=32 x=0 y=0 width=0 height=0 xoffset=0 yoffset=0 xadvance=${m.space} page=0 chnl=15`,
  ];
  for (const g of glyphs.sort((a, b) => a.ch.codePointAt(0) - b.ch.codePointAt(0))) {
    // spacing follows the letter's body above the writing line, so hooks
    // below it (j, g, p, y) can tuck under the neighbour instead of pushing it away
    let bx0 = g.w; let bx1 = -1;
    const lineRow = Math.min(g.h, Math.max(0, g.rise));
    for (let y = 0; y < lineRow; y++) for (let x = 0; x < g.w; x++) {
      if (g.data[(y * g.w + x) * 4 + 3] > 60) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; }
    }
    if (bx1 < 0 || bx1 - bx0 < g.w * 0.35) { bx0 = 0; bx1 = g.w - 1; }
    const xoff = m.side - bx0;
    const adv = (bx1 - bx0 + 1) + 2 * m.side;
    lines.push(`char id=${g.ch.codePointAt(0)} x=${g.ax} y=${g.ay} width=${g.w} height=${g.h} xoffset=${xoff} yoffset=${base - g.rise} xadvance=${adv} page=0 chnl=15`);
  }
  await fs.writeFile(path.join(dir, `${name}.fnt`), `${lines.join('\n')}\n`);
  return { width, height, count: glyphs.length };
}

/**
 * The whole job for one sheet: reads it and writes one font per output.
 * @param {object} cfg {photo, rows, size, out, fonts: [{name, sets: {upper: set, lower: set, punct: set}, mode, bold}]}
 */
export async function buildFonts(cfg) {
  const m = metrics(cfg.size);
  const sheets = cfg.sheets || [{ photo: cfg.photo, rows: cfg.rows }];
  const glyphs = []; const problems = [];
  for (const sh of sheets) {
    const r = await readSheet(sh.photo, sh.rows, { rowMode: sh.rowMode });
    glyphs.push(...r.glyphs);
    problems.push(...r.problems.map((p) => `${path.basename(sh.photo)}: ${p}`));
  }
  if (problems.length) return { problems };
  const sc = scales(glyphs, m);
  const results = [];
  for (const font of cfg.fonts) {
    const map = new Map();
    const extra = new Set(font.extra || []);
    const want = (g) => font.sets[g.kind === 'punct' ? 'punct' : g.kind] === g.set
      || (g.kind === 'punct' && font.sets.punctFallback === g.set);
    const mine = glyphs.filter(want);
    const condense = condenseFor(mine, sc, m);
    const opts = { mode: font.mode, bold: font.bold || 0, condense, edge: font.edge || null };
    for (const g of mine) {
      if (map.has(g.ch)) continue;
      map.set(g.ch, await finishGlyph(g, sc[`${g.set}/${g.kind}`], opts));
    }
    // characters from other sheets (symbols in another pen): their strokes
    // are thickened to match the letters'
    const more = glyphs.filter((g) => extra.has(g.set) && !map.has(g.ch));
    if (more.length) {
      const letters = [...map.values()].filter((g) => /[a-zA-Z]/.test(g.ch));
      const plain = { ...opts, bold: 0, edge: null };
      const probe = await Promise.all(more.slice(0, 12).map((g) => finishGlyph(g, sc[`${g.set}/${g.kind}`], plain)));
      const lettersPlain = await Promise.all(glyphs.filter(want).filter((g) => /[a-z]/.test(g.ch)).slice(0, 12)
        .map((g) => finishGlyph(g, sc[`${g.set}/${g.kind}`], plain)));
      const grow = Math.max(0, Math.round((median(lettersPlain.map(thickness)) - median(probe.map(thickness))) / 2));
      for (const g of more) {
        if (map.has(g.ch)) continue;
        map.set(g.ch, await finishGlyph(g, sc[`${g.set}/${g.kind}`], { ...opts, bold: (opts.bold || 0) + grow }));
      }
      void letters;
    }
    // strokes for the made-up characters come from this font's own "!" and "."
    const bang = map.get('!'); const dot = map.get('.');
    if (bang && dot) {
      const colours = font.mode === 'colour' ? {
        upperColour: meanColour([...map.values()].filter((g) => /[A-Z]/.test(g.ch))),
        lowerColour: meanColour([...map.values()].filter((g) => /[a-z]/.test(g.ch))),
      } : {};
      await synthesize(map, m, { stroke: strokeOf(bang), dot, ...colours });
      await symbols(map, m, { stroke: strokeOf(bang), colour: colours.upperColour, icons: cfg.icons || {} });
    }
    results.push({ name: font.name, condense: condense.toFixed(2), ...(await writeFont(cfg.out, font.name, map, m)), chars: [...map.keys()].join('') });
  }
  return { problems, results, scales: sc };
}
