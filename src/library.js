// Everything you generate is kept on disk in ./library/<id>/ :
//   meta.json    description, prompt, engine, status, size...
//   concept.png  the image the model was made from
//   model.glb    the generated 3D model (original size)

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const LIBRARY_DIR = path.resolve(process.env.LIBRARY_DIR || 'library');

const ID_RE = /^[a-z0-9-]+$/;

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function entryDir(id) {
  if (!isValidId(id)) throw new Error('Invalid id');
  return path.join(LIBRARY_DIR, id);
}

export function newId() {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14); // yyyymmddhhmmss
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

export async function saveMeta(meta) {
  const dir = entryDir(meta.id);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'meta.json');
  await fs.writeFile(`${file}.tmp`, JSON.stringify(meta, null, 2));
  await fs.rename(`${file}.tmp`, file);
  return meta;
}

export async function readMeta(id) {
  try {
    return JSON.parse(await fs.readFile(path.join(entryDir(id), 'meta.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function listMeta() {
  await fs.mkdir(LIBRARY_DIR, { recursive: true });
  const ids = (await fs.readdir(LIBRARY_DIR)).filter(isValidId);
  const metas = (await Promise.all(ids.map(readMeta))).filter(Boolean);
  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteEntry(id) {
  await fs.rm(entryDir(id), { recursive: true, force: true });
}

export async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}
