// Drawings page: photos of paper drawings -> Godelea game pictures.

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null));
  return n;
};
const svgEl = (tag, attrs) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body && !(opts.body instanceof Blob) ? { 'content-type': 'application/json', ...opts.headers } : opts.headers,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.blob();
}

let data = null; // GET /api/godelea
let photos = [];

const FOLDER_TITLES = {
  characters: 'Characters', meanings: 'Story pictures', 'meanings/anim': 'Animated story pictures',
  scenery: 'Map scenery', map: 'Map tiles and stops', icons: 'Icons', ui: 'Buttons and panels',
  weather: 'Weather', board: 'Board', hand: 'Lesson hand', backgrounds: 'Backgrounds',
};
const builtUrl = (file) => (file.startsWith('?')
  ? `/godelea/unassigned/${encodeURIComponent(file.slice(1))}?v=${data.version}`
  : `/godelea/built/${file}?v=${data.version}`);
const gameUrl = (file) => `/godelea/game/${file}`;
const label = (file) => file.replace(/^\?/, '').replace(/\.png$/, '');

// ---------- views ----------

function show(view) {
  for (const b of document.querySelectorAll('.seg button')) b.classList.toggle('on', b.dataset.view === view);
  for (const v of ['pictures', 'photos', 'islands']) $(`#view-${v}`).hidden = v !== view;
  if (view === 'photos') renderPhotos();
  if (view === 'islands') renderIslands();
}
for (const b of document.querySelectorAll('.seg button')) b.onclick = () => show(b.dataset.view);

function thumb(src, { anim = false, icon = false } = {}) {
  const box = el('div', { className: `chk${icon ? ' white-icons' : ''}` });
  if (!src) return box;
  if (anim) {
    // an animation strip: show its first square frame
    box.append(el('div', { style: `width:92%;aspect-ratio:1;background:url("${src}") left/auto 100% no-repeat` }));
  } else {
    box.append(el('img', { src, loading: 'lazy', alt: '' }));
  }
  return box;
}

function renderPictures() {
  const root = $('#view-pictures');
  root.replaceChildren();
  const onlyTodo = $('#only-todo').checked;
  const groups = new Map();
  for (const p of data.pictures) {
    if (!groups.has(p.folder)) groups.set(p.folder, []);
    groups.get(p.folder).push(p);
  }
  let done = 0; let todo = 0;
  for (const p of data.pictures) { if (p.mapped) { done++; if (p.mapped.sure === false) todo++; } }
  $('#summary').textContent = `${done} of ${data.pictures.length} drawn · ${todo} to confirm · ${data.extras.length} not placed yet`;

  if (data.extras.length) {
    root.append(el('div', { className: 'folder' },
      el('h2', { textContent: 'Not a game picture yet' }),
      el('p', { textContent: 'Drawings that have no place in the game yet. Open one to give it a place, or keep it for a new character.' }),
      el('div', { className: 'cards' }, ...data.extras.map((x) => card({ file: x.file, mapped: x, extra: true })))));
  }
  for (const [folder, list] of groups) {
    const shown = onlyTodo ? list.filter((p) => !p.mapped || p.mapped.sure === false) : list;
    if (!shown.length) continue;
    root.append(el('div', { className: 'folder' },
      el('h2', { textContent: `${FOLDER_TITLES[folder] || folder} · ${list.filter((p) => p.mapped).length}/${list.length}` }),
      el('p', { textContent: list[0].rules || '' }),
      el('div', { className: 'cards' }, ...shown.map((p) => card(p)))));
  }
}

function card(p) {
  const anim = Boolean(p.frames);
  const icon = p.file.startsWith('icons/');
  const status = !p.mapped ? 'missing' : p.mapped.sure === false ? 'todo' : 'done';
  const size = p.frames ? `${p.frames} frames of ${p.height}px, ${p.fps} fps` : p.width ? `${p.width}×${p.height}` : 'new';
  const c = el('div', { className: `card ${status}`, title: p.shows || '' },
    el('div', { className: 'name', textContent: label(p.file).split('/').pop() }),
    el('div', { className: 'pair' },
      p.extra ? el('div') : thumb(gameUrl(p.file), { anim }),
      thumb(p.mapped ? builtUrl(p.file) : null, { anim, icon })),
    el('div', { className: 'tag', textContent: status === 'missing' ? `not drawn · ${size}` : status === 'todo' ? 'to confirm' : size }));
  c.onclick = () => {
    if (p.mapped) openEditor(p.mapped.photo, { file: p.file, ...p.mapped });
    else { pendingTarget = p.file; show('photos'); }
  };
  return c;
}

let pendingTarget = null; // picture chosen in the grid before picking a photo

async function renderPhotos() {
  $('#photos-dir').textContent = data.photosDir;
  photos = await api('/api/godelea/photos');
  $('#photos').replaceChildren(...photos.map((ph) => {
    const f = el('figure', {},
      el('img', { src: `/godelea/photo/${encodeURIComponent(ph.name)}?w=440`, loading: 'lazy', alt: '' }),
      el('figcaption', { textContent: `${ph.name}${ph.used ? ` · ${ph.used} used` : ''}` }));
    f.onclick = () => openEditor(ph.name, pendingTarget ? { file: pendingTarget } : {});
    return f;
  }));
}

function renderIslands() {
  $('#islands').replaceChildren(...data.terrains.map((t) => el('figure', {},
    el('img', { src: `/api/godelea/island/${t}?v=${data.version}`, alt: '' }),
    el('img', { src: `/api/godelea/island/${t}?from=game`, alt: '' }),
    el('figcaption', { textContent: t }))));
}

$('#only-todo').onchange = renderPictures;

$('#upload').onchange = async (e) => {
  for (const file of e.target.files) {
    try {
      await api('/api/godelea/photos', { method: 'POST', body: file, headers: { 'content-type': file.type || 'image/jpeg', 'x-filename': file.name } });
    } catch (err) { alert(`${file.name}: ${err.message}`); }
  }
  e.target.value = '';
  renderPhotos();
};

async function runCheck(install) {
  if (install && !confirm(`Copy every good picture into the game?\n\n${data.game}/assets/art\n\nThe game's current pictures with the same names are replaced (git keeps the old ones).`)) return;
  const out = $('#check-out');
  out.hidden = false;
  out.textContent = install ? 'Installing…' : 'Checking…';
  const r = await api('/api/godelea/check', { method: 'POST', body: JSON.stringify({ install }) });
  out.textContent = r.output;
}
$('#btn-check').onclick = () => runCheck(false);
$('#btn-install').onclick = () => runCheck(true);

// ---------- editor ----------

const ed = {
  photo: null, size: null, boxes: [], sel: null, rotate: 0, strength: 0, file: '', original: null,
};

function targetOptions() {
  const sel = $('#ed-target');
  sel.replaceChildren(el('option', { value: '', textContent: '— choose —' }));
  const groups = new Map();
  for (const p of data.pictures) {
    if (!groups.has(p.folder)) groups.set(p.folder, el('optgroup', { label: FOLDER_TITLES[p.folder] || p.folder }));
    groups.get(p.folder).append(el('option', { value: p.file, textContent: `${p.mapped ? (p.mapped.sure === false ? '? ' : '✓ ') : ''}${label(p.file)}` }));
  }
  const extra = el('optgroup', { label: 'Not in the game yet' });
  for (const x of data.extras) extra.append(el('option', { value: x.file, textContent: label(x.file) }));
  extra.append(el('option', { value: '__new', textContent: 'New… (give it a name)' }));
  sel.append(...groups.values(), extra);
}

async function openEditor(photo, pic = {}) {
  pendingTarget = null;
  Object.assign(ed, { photo, sel: pic.box || null, file: pic.file || '', original: pic.file ? pic : null });
  // a new drawing on a page usually needs the same turn as the others on it
  const siblings = [...data.pictures.map((p) => p.mapped), ...data.extras].filter((m) => m?.photo === photo);
  ed.rotate = pic.box ? (pic.rotate || 0) : (siblings[0]?.rotate || 0);
  ed.strength = pic.strength || 0;
  $('#editor').hidden = false;
  $('#ed-name').textContent = photo;
  targetOptions();
  $('#ed-target').value = ed.file;
  $('#ed-strength').value = ed.strength;
  $('#ed-img').src = `/godelea/photo/${encodeURIComponent(photo)}?w=1800`;
  $('#ed-fine').checked = /183(812|849|859|900|909)/.test(photo);
  await loadBoxes();
  updateSide();
}

async function loadBoxes() {
  const r = await api(`/api/godelea/photos/${encodeURIComponent(ed.photo)}/boxes${$('#ed-fine').checked ? '?fine=1' : ''}`);
  ed.size = [r.width, r.height];
  ed.boxes = r.boxes.map((b) => [b.x, b.y, b.w, b.h]);
  drawBoxes();
}
$('#ed-fine').onchange = loadBoxes;

function drawBoxes() {
  const svg = $('#ed-svg');
  const [W, H] = ed.size;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const img = $('#ed-img');
  const place = () => {
    svg.style.left = `${img.offsetLeft}px`; svg.style.top = `${img.offsetTop}px`;
    svg.style.width = `${img.clientWidth}px`; svg.style.height = `${img.clientHeight}px`;
  };
  if (img.complete) place(); else img.onload = place;
  window.onresize = place;
  svg.replaceChildren();
  const used = [...data.pictures.map((p) => p.mapped && { ...p.mapped, file: p.file }), ...data.extras]
    .filter((m) => m?.photo === ed.photo);
  const fs = Math.max(W, H) / 70;
  const add = (b, cls, text, onclick) => {
    const r = svgEl('rect', { x: b[0], y: b[1], width: b[2], height: b[3], class: `box ${cls}`, 'vector-effect': 'non-scaling-stroke' });
    r.onclick = (e) => { e.stopPropagation(); onclick(); };
    svg.append(r);
    if (text) {
      const t = svgEl('text', { x: b[0] + fs * 0.2, y: b[1] + fs, 'font-size': fs, 'stroke-width': fs * 0.18 });
      t.textContent = text;
      svg.append(t);
    }
  };
  ed.boxes.forEach((b, i) => add(b, '', String(i), () => pick(b)));
  for (const m of used) add(m.box, 'used', label(m.file).split('/').pop(), () => pick(m.box, m));
  if (ed.sel) add(ed.sel, 'sel', '', () => {});
}

function pick(box, mapped) {
  ed.sel = box;
  if (mapped) {
    ed.file = mapped.file; ed.original = mapped;
    ed.rotate = mapped.rotate || 0; ed.strength = mapped.strength || 0;
    $('#ed-target').value = ed.file; $('#ed-strength').value = ed.strength;
  }
  drawBoxes();
  updateSide();
}

// drag on the photo to draw a box by hand
{
  const svg = $('#ed-svg');
  let start = null;
  const toPhoto = (e) => {
    const r = svg.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * ed.size[0], (e.clientY - r.top) / r.height * ed.size[1]];
  };
  svg.addEventListener('pointerdown', (e) => { if (e.target === svg) { start = toPhoto(e); svg.setPointerCapture(e.pointerId); } });
  svg.addEventListener('pointermove', (e) => {
    if (!start) return;
    const p = toPhoto(e);
    ed.sel = [Math.min(start[0], p[0]), Math.min(start[1], p[1]), Math.abs(p[0] - start[0]), Math.abs(p[1] - start[1])].map(Math.round);
    drawBoxes();
  });
  svg.addEventListener('pointerup', () => { if (start) { start = null; if (ed.sel && ed.sel[2] > 10) updateSide(); } });
}

for (const b of document.querySelectorAll('[data-rot]')) {
  b.onclick = () => { ed.rotate = (((ed.rotate + Number(b.dataset.rot)) % 360) + 360) % 360; updateSide(); };
}
$('#ed-strength').oninput = () => { ed.strength = Number($('#ed-strength').value); updateSide(); };
$('#ed-target').onchange = () => {
  let v = $('#ed-target').value;
  if (v === '__new') {
    const name = prompt('Name for this drawing (letters, numbers, _ or -):', 'gato');
    const slug = (name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_-]+/g, '_');
    if (!slug) { $('#ed-target').value = ed.file; return; }
    v = `?${slug}.png`;
    $('#ed-target').append(el('option', { value: v, textContent: slug }));
    $('#ed-target').value = v;
  }
  ed.file = v;
  updateSide();
};
$('#ed-close').onclick = () => { $('#editor').hidden = true; };

let previewTimer = null;
let previewUrl = null;
function body() {
  return {
    file: ed.file, photo: ed.photo, box: ed.sel, rotate: ed.rotate,
    strength: ed.strength || undefined,
    close: ed.original?.box === ed.sel ? ed.original?.close : undefined,
  };
}
function updateSide() {
  const p = data.pictures.find((x) => x.file === ed.file);
  $('#ed-rules').textContent = p ? `${p.shows}. ${p.frames ? `${p.frames} frames of ${p.height}px` : `${p.width}×${p.height}`}. ${p.rules}` : (ed.file ? 'Not in the game yet: kept as a 160×160 picture.' : '');
  $('#ed-rot').textContent = `${ed.rotate}°`;
  $('#ed-str-val').textContent = ed.strength ? `×${ed.strength.toFixed(1)}` : 'auto';
  $('#ed-old').src = p ? gameUrl(p.file) : '';
  $('#ed-old').parentElement.style.visibility = p ? '' : 'hidden';
  $('#ed-remove').hidden = !data.pictures.some((x) => x.file === ed.file && x.mapped) && !data.extras.some((x) => x.file === ed.file);
  $('#ed-save').disabled = !(ed.file && ed.sel);
  $('#ed-error').hidden = true;
  clearTimeout(previewTimer);
  if (!ed.file || !ed.sel) return;
  previewTimer = setTimeout(async () => {
    try {
      const blob = await api('/api/godelea/preview', { method: 'POST', body: JSON.stringify(body()) });
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(blob);
      const frames = p?.frames;
      for (const id of ['#ed-new', '#ed-real']) {
        const img = $(id);
        img.src = previewUrl;
        // an animation strip: only its first frame
        img.style.objectFit = frames ? 'cover' : '';
        img.style.objectPosition = frames ? 'left' : '';
        img.style.aspectRatio = frames ? '1' : '';
      }
      const real = $('#ed-real');
      real.style.width = p ? `${frames ? p.height : p.width}px` : '160px';
      real.style.height = p ? `${p.height}px` : '160px';
    } catch (err) {
      $('#ed-error').textContent = err.message; $('#ed-error').hidden = false;
    }
  }, 250);
}

$('#ed-save').onclick = async () => {
  try {
    $('#ed-save').disabled = true;
    // moving a drawing to another picture frees the old one
    if (ed.original?.file && ed.original.file !== ed.file && ed.original.box === ed.sel) {
      await api(`/api/godelea/picture?file=${encodeURIComponent(ed.original.file)}`, { method: 'DELETE' });
    }
    await api('/api/godelea/picture', { method: 'PUT', body: JSON.stringify(body()) });
    await reload();
    ed.original = { ...body(), file: ed.file };
    drawBoxes(); updateSide();
  } catch (err) {
    $('#ed-error').textContent = err.message; $('#ed-error').hidden = false;
  } finally { $('#ed-save').disabled = false; }
};

$('#ed-remove').onclick = async () => {
  if (!confirm(`Remove your drawing from ${label(ed.file)}? (The photo stays.)`)) return;
  await api(`/api/godelea/picture?file=${encodeURIComponent(ed.file)}`, { method: 'DELETE' });
  await reload();
  ed.original = null;
  drawBoxes(); updateSide();
};

async function reload() {
  data = await api('/api/godelea');
  renderPictures();
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#editor').hidden = true; });

reload().catch((err) => {
  $('#view-pictures').replaceChildren(el('p', { className: 'error', textContent: `Could not load the game: ${err.message}` }));
});
