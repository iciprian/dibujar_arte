import path from 'node:path';
import express from 'express';
import { fal } from '@fal-ai/client';

import {
  ENGINES, IMAGE_MODELS, buildConceptPrompt, engineCost, extractGlbUrl, publicCatalogue,
} from './src/engines.js';
import { AXES, measureGlb, resizeGlb } from './src/glb.js';
import {
  LIBRARY_DIR, deleteEntry, download, entryDir, isValidId, listMeta, newId, readMeta, saveMeta,
} from './src/library.js';
import { godeleaRoutes } from './src/godelea-routes.js';

// fal's client reads FAL_KEY from the environment (loaded from .env by `npm start`).
const PORT = Number(process.env.PORT) || 3737;
const HOST = '127.0.0.1'; // only reachable from this Mac
const hasKey = () => Boolean(process.env.FAL_KEY);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(import.meta.dirname, 'public')));
app.use('/library', express.static(LIBRARY_DIR));
app.get('/vendor/model-viewer.min.js', (req, res) => {
  res.sendFile(path.join(import.meta.dirname, 'node_modules/@google/model-viewer/dist/model-viewer.min.js'));
});

// ---------- background 3D jobs ----------

const progress = new Map(); // id -> human-readable status text while a job runs
const deleted = new Set();

async function runJob(meta) {
  const engine = ENGINES[meta.engine];
  try {
    if (!meta.requestId) {
      progress.set(meta.id, 'Sending to fal.ai…');
      const { request_id } = await fal.queue.submit(engine.endpoint, {
        input: engine.input(meta.conceptUrl, { pbr: meta.pbr }),
      });
      meta.requestId = request_id;
      meta.status = 'generating';
      if (!deleted.has(meta.id)) await saveMeta(meta);
    }
    await fal.queue.subscribeToStatus(engine.endpoint, {
      requestId: meta.requestId,
      mode: 'polling',
      pollInterval: 3000,
      onQueueUpdate: (u) => {
        progress.set(meta.id, u.status === 'IN_QUEUE'
          ? `Waiting in fal.ai queue${Number.isFinite(u.queue_position) ? ` (position ${u.queue_position + 1})` : ''}…`
          : 'Building the 3D model (usually 1–3 min)…');
      },
    });
    const { data } = await fal.queue.result(engine.endpoint, { requestId: meta.requestId });
    if (deleted.has(meta.id)) return;
    progress.set(meta.id, 'Downloading model…');
    const glbPath = path.join(entryDir(meta.id), 'model.glb');
    await download(extractGlbUrl(data), glbPath);
    meta.dims = await measureGlb(glbPath);
    meta.status = 'done';
    meta.finishedAt = new Date().toISOString();
  } catch (err) {
    console.error(`[${meta.id}]`, err);
    meta.status = 'error';
    meta.error = errorMessage(err);
  } finally {
    progress.delete(meta.id);
    if (deleted.has(meta.id)) await deleteEntry(meta.id);
    else await saveMeta(meta);
  }
}

// Pick up jobs that were running when the server last stopped.
async function resumeJobs() {
  for (const meta of await listMeta()) {
    if (meta.status !== 'queued' && meta.status !== 'generating') continue;
    if (meta.requestId) {
      console.log(`Resuming ${meta.id}`);
      runJob(meta);
    } else {
      meta.status = 'error';
      meta.error = 'The app was stopped before this started. Make it again.';
      await saveMeta(meta);
    }
  }
}

function errorMessage(err) {
  const detail = err?.body?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map((d) => d.msg || JSON.stringify(d)).join('; ');
  if (err?.status === 401 || err?.status === 403) return 'fal.ai rejected the API key. Check FAL_KEY in .env.';
  return err?.message || String(err);
}

const withProgress = (meta) => ({ ...meta, progress: progress.get(meta.id) ?? null });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function requireKey() {
  if (!hasKey()) throw new HttpError(400, 'No fal.ai key yet: put FAL_KEY=... in the .env file and restart.');
}

// ---------- API ----------

app.get('/api/config', (req, res) => {
  res.json({ hasKey: hasKey(), axes: Object.keys(AXES), ...publicCatalogue() });
});

// Step 1: description -> concept images
app.post('/api/concepts', async (req, res) => {
  requireKey();
  const { description, imageModel, count = 2, aPose = true } = req.body ?? {};
  if (typeof description !== 'string' || !description.trim()) throw new HttpError(400, 'Describe your character first.');
  if (description.length > 2000) throw new HttpError(400, 'Description is too long (max 2000 characters).');
  const model = IMAGE_MODELS[imageModel];
  if (!model) throw new HttpError(400, 'Unknown image model.');
  const n = Math.min(4, Math.max(1, Math.round(Number(count)) || 1));

  const prompt = buildConceptPrompt(description, { aPose: Boolean(aPose) });
  const { data } = await fal.subscribe(model.endpoint, { input: model.input(prompt, n) });
  const images = (data?.images ?? []).map((i) => i.url).filter(Boolean);
  if (!images.length) throw new HttpError(502, 'No images came back (a safety filter may have blocked them). Try rewording.');
  res.json({ description, prompt, imageModel, images });
});

// Step 2: concept image -> 3D model (runs in the background)
app.post('/api/models', async (req, res) => {
  requireKey();
  const { description = '', prompt = '', imageUrl, engine, pbr = false } = req.body ?? {};
  if (typeof imageUrl !== 'string' || !/^https:\/\//.test(imageUrl)) throw new HttpError(400, 'Pick a concept image first.');
  if (!ENGINES[engine]) throw new HttpError(400, 'Unknown 3D engine.');

  const meta = {
    id: newId(),
    createdAt: new Date().toISOString(),
    description: String(description).slice(0, 2000),
    prompt: String(prompt).slice(0, 4000),
    conceptUrl: imageUrl,
    engine,
    pbr: Boolean(pbr) && ENGINES[engine].pbrPrice != null,
    cost: engineCost(engine, pbr),
    status: 'queued',
    requestId: null,
    dims: null,
    error: null,
  };
  await saveMeta(meta);
  await download(imageUrl, path.join(entryDir(meta.id), 'concept.png'));
  runJob(meta); // not awaited: the browser polls /api/models
  res.status(201).json(withProgress(meta));
});

app.get('/api/models', async (req, res) => {
  res.json((await listMeta()).map(withProgress));
});

app.get('/api/models/:id', async (req, res) => {
  const meta = isValidId(req.params.id) && (await readMeta(req.params.id));
  if (!meta) throw new HttpError(404, 'Not found.');
  res.json(withProgress(meta));
});

app.delete('/api/models/:id', async (req, res) => {
  const meta = isValidId(req.params.id) && (await readMeta(req.params.id));
  if (!meta) throw new HttpError(404, 'Not found.');
  if (progress.has(meta.id)) {
    deleted.add(meta.id); // the running job cleans up when it ends
    if (meta.requestId) fal.queue.cancel(ENGINES[meta.engine].endpoint, { requestId: meta.requestId }).catch(() => {});
  } else {
    await deleteEntry(meta.id);
  }
  res.status(204).end();
});

// Export: the GLB resized so the chosen axis measures exactly `size` cm.
app.get('/api/models/:id/export', async (req, res) => {
  const meta = isValidId(req.params.id) && (await readMeta(req.params.id));
  if (!meta || meta.status !== 'done') throw new HttpError(404, 'Model not ready.');
  const sizeCm = Number(req.query.size);
  const axis = String(req.query.axis || 'height');
  if (!Number.isFinite(sizeCm) || sizeCm <= 0 || sizeCm > 100000) throw new HttpError(400, 'Size must be a number of cm above 0.');
  if (!(axis in AXES)) throw new HttpError(400, 'Unknown axis.');

  const { glb } = await resizeGlb(path.join(entryDir(meta.id), 'model.glb'), { sizeCm, axis });
  const slug = (meta.description || 'character')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean).slice(0, 5).join('-') || 'character';
  const sizeLabel = String(Math.round(sizeCm * 100) / 100).replace('.', '_');
  res.type('model/gltf-binary').attachment(`${slug}_${sizeLabel}cm.glb`).send(Buffer.from(glb));
});

// ---------- hand drawings -> Godelea pictures (drawings.html) ----------
godeleaRoutes(app, HttpError);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err instanceof HttpError ? err.message : errorMessage(err) });
});

app.listen(PORT, HOST, async () => {
  console.log(`\n  Dibujar Arte → http://127.0.0.1:${PORT}\n`);
  if (!hasKey()) console.log('  ⚠ No FAL_KEY found. Copy .env.example to .env and add your key from https://fal.ai/dashboard/keys\n');
  await resumeJobs();
});
