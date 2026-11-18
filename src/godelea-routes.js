// Web API for the "Drawings" page: photos of paper drawings -> Godelea pictures.

import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import sharp from 'sharp';

import { findDrawings } from './drawing.js';
import {
  buildAndSave, buildPicture, builtPath, checkArt, drawable, islandPreview, loadProject, saveMapping,
} from './godelea.js';

const MAPPING = path.resolve(process.env.GODELEA_MAPPING || 'drawings/godelea.json');
const PHOTO_RE = /^[\w .()-]+\.(jpe?g|png|webp|heic)$/i;
const EXTRA_RE = /^\?[\w-]+\.png$/; // a drawing that isn't a game picture yet
const TERRAINS = ['grass', 'snow', 'desert', 'earth', 'stone', 'sand'];

export function godeleaRoutes(app, HttpError) {
  let projectPromise = null;
  const project = () => (projectPromise ??= loadProject(MAPPING));
  // every change bumps this so the page never shows a stale cached picture
  let version = Date.now();

  const photoPath = async (name) => {
    if (!PHOTO_RE.test(name)) throw new HttpError(400, 'Bad photo name.');
    return path.join((await project()).photos, name);
  };

  // static files: the game's current pictures, the built ones, the unassigned ones
  app.use('/godelea/game', async (req, res, next) => express.static((await project()).art)(req, res, next));
  app.use('/godelea/built', async (req, res, next) => express.static((await project()).out)(req, res, next));
  app.use('/godelea/unassigned', async (req, res, next) => express.static(path.join((await project()).out, '..', 'unassigned'))(req, res, next));

  app.get('/api/godelea', async (req, res) => {
    const p = await project();
    const byFile = new Map(p.mapping.pictures.map((pic) => [pic.file, pic]));
    const pictures = drawable(p).filter((e) => e.folder !== 'glyphs').map((e) => ({
      file: e.file, folder: e.folder, shows: e.shows, width: e.width, height: e.height,
      frames: e.frames, fps: e.fps, rules: e.rules, transparent: e.transparent,
      mapped: byFile.get(e.file) || null,
    }));
    const extras = p.mapping.pictures.filter((pic) => pic.file.startsWith('?'));
    res.json({ game: p.game, photosDir: p.photos, pictures, extras, terrains: TERRAINS, version });
  });

  app.get('/api/godelea/photos', async (req, res) => {
    const p = await project();
    const names = (await fs.readdir(p.photos)).filter((n) => PHOTO_RE.test(n)).sort();
    const used = new Map();
    for (const pic of p.mapping.pictures) used.set(pic.photo, (used.get(pic.photo) || 0) + 1);
    res.json(names.map((name) => ({ name, used: used.get(name) || 0 })));
  });

  // a photo, made small enough for the page (the boxes are in full-size pixels)
  app.get('/godelea/photo/:name', async (req, res) => {
    const file = await photoPath(req.params.name);
    const w = Math.min(2400, Math.max(100, Number(req.query.w) || 1400));
    res.type('jpeg').set('Cache-Control', 'max-age=3600')
      .send(await sharp(file).resize({ width: w, height: w, fit: 'inside' }).jpeg({ quality: 82 }).toBuffer());
  });

  const boxCache = new Map();
  app.get('/api/godelea/photos/:name/boxes', async (req, res) => {
    const file = await photoPath(req.params.name);
    const fine = req.query.fine === '1';
    const key = `${file}|${fine}`;
    if (!boxCache.has(key)) {
      boxCache.set(key, findDrawings(file, fine ? { gap: 0.004, minSize: 0.015 } : { gap: 0.012, minSize: 0.03 }));
    }
    try {
      res.json(await boxCache.get(key));
    } catch (err) {
      boxCache.delete(key);
      throw err;
    }
  });

  // upload a new photo (raw image body) into the photos folder
  app.post('/api/godelea/photos', express.raw({ type: 'image/*', limit: '40mb' }), async (req, res) => {
    const name = path.basename(String(req.get('x-filename') || ''));
    const file = await photoPath(name);
    if (!req.body?.length) throw new HttpError(400, 'No image received.');
    await sharp(req.body).metadata().catch(() => { throw new HttpError(400, 'That file is not an image.'); });
    await fs.writeFile(file, req.body, { flag: 'wx' }).catch((err) => {
      if (err.code === 'EEXIST') throw new HttpError(409, 'A photo with that name is already there.');
      throw err;
    });
    res.json({ name });
  });

  const readPic = async (body) => {
    const p = await project();
    const file = String(body.file || '');
    if (!p.byFile.get(file)?.redraw && !EXTRA_RE.test(file)) throw new HttpError(400, 'Unknown game picture.');
    await photoPath(String(body.photo || ''));
    const box = Array.isArray(body.box) && body.box.length === 4 && body.box.every(Number.isFinite)
      ? body.box.map(Math.round) : null;
    if (!box || box[2] < 4 || box[3] < 4) throw new HttpError(400, 'Bad box.');
    const pic = { file, photo: body.photo, box };
    const rotate = Number(body.rotate) || 0;
    if (rotate) pic.rotate = ((rotate % 360) + 360) % 360;
    if (body.strength != null && Number(body.strength) !== 0) pic.strength = Math.min(4, Math.max(0.3, Number(body.strength)));
    if (body.close != null) pic.close = Math.min(0.2, Math.max(0.002, Number(body.close)));
    if (body.sure === false) pic.sure = false;
    return pic;
  };

  // what a drawing would look like, without saving anything
  app.post('/api/godelea/preview', async (req, res) => {
    const p = await project();
    const png = await buildPicture(p, await readPic(req.body));
    res.type('png').send(png);
  });

  // save a drawing as a game picture (replaces whatever was assigned before)
  app.put('/api/godelea/picture', async (req, res) => {
    const p = await project();
    const pic = await readPic(req.body);
    await buildAndSave(p, pic);
    const i = p.mapping.pictures.findIndex((x) => x.file === pic.file);
    if (i >= 0) p.mapping.pictures[i] = pic; else p.mapping.pictures.push(pic);
    await saveMapping(p);
    version = Date.now();
    res.json({ ok: true, version });
  });

  app.delete('/api/godelea/picture', async (req, res) => {
    const p = await project();
    const file = String(req.query.file || '');
    const i = p.mapping.pictures.findIndex((x) => x.file === file);
    if (i < 0) throw new HttpError(404, 'Not assigned.');
    p.mapping.pictures.splice(i, 1);
    await saveMapping(p);
    await fs.rm(builtPath(p, file), { force: true });
    version = Date.now();
    res.json({ ok: true, version });
  });

  app.get('/api/godelea/island/:terrain', async (req, res) => {
    if (!TERRAINS.includes(req.params.terrain)) throw new HttpError(404, 'Unknown terrain.');
    const png = await islandPreview(await project(), req.params.terrain, req.query.from === 'game' ? 'game' : 'built');
    res.type('png').send(png);
  });

  // the game's own checker; install=true copies the good pictures into the game
  app.post('/api/godelea/check', async (req, res) => {
    res.json(await checkArt(await project(), req.body?.install === true));
  });
}
