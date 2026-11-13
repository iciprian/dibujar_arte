const $ = (sel) => document.querySelector(sel);

const els = {
  keyBanner: $('#key-banner'),
  description: $('#description'),
  apose: $('#apose'),
  imageModel: $('#image-model'),
  count: $('#count'),
  btnConcepts: $('#btn-concepts'),
  conceptsError: $('#concepts-error'),
  conceptsBlock: $('#concepts-block'),
  concepts: $('#concepts'),
  engine: $('#engine'),
  pbrWrap: $('#pbr-wrap'),
  pbr: $('#pbr'),
  btnModel: $('#btn-model'),
  modelError: $('#model-error'),
  viewer: $('#viewer'),
  placeholder: $('#viewer-placeholder'),
  placeholderImg: $('#placeholder-img'),
  placeholderText: $('#placeholder-text'),
  export: $('#export'),
  size: $('#size'),
  axis: $('#axis'),
  btnDownload: $('#btn-download'),
  dims: $('#dims'),
  library: $('#library'),
  libraryEmpty: $('#library-empty'),
};

const state = {
  config: null,
  concepts: null, // { description, prompt, imageModel, images: [] }
  selectedImage: null,
  models: [],
  currentId: null,
};

// ---------- helpers ----------

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`dibujar:${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`dibujar:${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const money = (n) => (n < 0.01 ? '<$0.01' : `~$${n.toFixed(2)}`);
const fmtCm = (n) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));

function showError(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.classList.toggle('busy', busy);
  if (label) button.textContent = label;
}

// ---------- step 1: concepts ----------

function updateConceptButton() {
  const m = state.config.imageModels.find((x) => x.id === els.imageModel.value);
  const n = Number(els.count.value);
  els.btnConcepts.textContent = `Draw ${n} concept${n > 1 ? 's' : ''} · ${money(m.pricePerImage * n)}`;
  els.btnConcepts.disabled = !state.config.hasKey;
}

async function drawConcepts() {
  showError(els.conceptsError, '');
  const description = els.description.value.trim();
  if (!description) { showError(els.conceptsError, 'Describe your character first.'); els.description.focus(); return; }
  store.set('prefs', { ...store.get('prefs', {}), imageModel: els.imageModel.value, count: els.count.value, apose: els.apose.checked });

  setBusy(els.btnConcepts, true, 'Drawing…');
  try {
    const result = await api('/api/concepts', {
      method: 'POST',
      body: JSON.stringify({
        description,
        imageModel: els.imageModel.value,
        count: Number(els.count.value),
        aPose: els.apose.checked,
      }),
    });
    state.concepts = result;
    state.selectedImage = result.images.length === 1 ? result.images[0] : null;
    store.set('concepts', result);
    renderConcepts();
  } catch (err) {
    showError(els.conceptsError, err.message);
  } finally {
    setBusy(els.btnConcepts, false);
    updateConceptButton();
  }
}

function renderConcepts() {
  const c = state.concepts;
  els.conceptsBlock.hidden = !c;
  if (!c) return;
  els.concepts.replaceChildren(...c.images.map((url, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(url === state.selectedImage));
    b.title = `Concept ${i + 1}`;
    const img = document.createElement('img');
    img.src = url;
    img.alt = `Concept ${i + 1}`;
    img.onerror = () => { b.remove(); }; // fal links expire after a while
    b.append(img);
    b.onclick = () => { state.selectedImage = url; renderConcepts(); };
    return b;
  }));
  updateModelButton();
}

// ---------- step 2: 3D ----------

function updateModelButton() {
  const e = state.config.engines.find((x) => x.id === els.engine.value);
  els.pbrWrap.hidden = e.pbrPrice == null;
  const pbr = e.pbrPrice != null && els.pbr.checked;
  const cost = e.price + (pbr ? e.pbrPrice : 0);
  els.btnModel.textContent = state.selectedImage ? `Make 3D · ${money(cost)}` : 'Pick a concept above';
  els.btnModel.disabled = !state.selectedImage || !state.config.hasKey;
}

async function makeModel() {
  showError(els.modelError, '');
  store.set('prefs', { ...store.get('prefs', {}), engine: els.engine.value, pbr: els.pbr.checked });
  setBusy(els.btnModel, true, 'Sending…');
  try {
    const meta = await api('/api/models', {
      method: 'POST',
      body: JSON.stringify({
        description: state.concepts.description,
        prompt: state.concepts.prompt,
        imageUrl: state.selectedImage,
        engine: els.engine.value,
        pbr: els.pbr.checked,
      }),
    });
    state.models.unshift(meta);
    selectModel(meta.id);
    renderLibrary();
    schedulePoll();
  } catch (err) {
    showError(els.modelError, err.message);
  } finally {
    setBusy(els.btnModel, false);
    updateModelButton();
  }
}

// ---------- viewer + export ----------

function currentModel() {
  return state.models.find((m) => m.id === state.currentId) || null;
}

function selectModel(id) {
  state.currentId = id;
  renderViewer();
  renderLibrary();
}

function renderViewer() {
  const m = currentModel();
  const ready = m?.status === 'done';

  const src = ready ? `/library/${m.id}/model.glb` : '';
  if (ready && els.viewer.getAttribute('src') !== src) els.viewer.setAttribute('src', src);
  els.viewer.hidden = !ready;
  els.placeholder.hidden = ready;
  els.export.hidden = !ready;

  if (!ready) {
    els.placeholderImg.hidden = !m;
    if (m) els.placeholderImg.src = `/library/${m.id}/concept.png`;
    els.placeholderText.className = '';
    if (!m) {
      els.placeholderText.textContent = 'Your 3D model will appear here.';
    } else if (m.status === 'error') {
      els.placeholderText.className = 'error';
      els.placeholderText.textContent = `Failed: ${m.error || 'unknown error'}`;
    } else {
      els.placeholderText.className = 'busy';
      els.placeholderText.textContent = m.progress || 'Starting…';
    }
    return;
  }
  renderDims();
}

function renderDims() {
  const m = currentModel();
  if (!m?.dims) return;
  const sizeCm = Number(els.size.value);
  const axis = els.axis.value;
  const d = m.dims; // metres
  const ref = axis === 'longest' ? Math.max(d.width, d.height, d.depth) : d[axis];
  const valid = Number.isFinite(sizeCm) && sizeCm > 0;

  els.btnDownload.setAttribute('aria-disabled', String(!valid));
  if (!valid) { els.dims.textContent = 'Enter a size above 0 cm.'; return; }

  const f = sizeCm / (ref * 100);
  const [w, h, dp] = [d.width, d.height, d.depth].map((v) => fmtCm(v * 100 * f));
  els.dims.innerHTML = '';
  els.dims.append('Final size: ');
  const strong = document.createElement('strong');
  strong.textContent = `${h} cm tall × ${w} cm wide × ${dp} cm deep`;
  els.dims.append(strong, ' · feet at 0, centred');
  els.btnDownload.href = `/api/models/${m.id}/export?size=${encodeURIComponent(sizeCm)}&axis=${axis}`;
  store.set('export', { size: els.size.value, axis });
}

// ---------- library ----------

const STATUS_TEXT = { queued: 'Starting…', generating: 'Generating…', done: 'Ready', error: 'Failed' };

function renderLibrary() {
  els.libraryEmpty.hidden = state.models.length > 0;
  els.library.replaceChildren(...state.models.map((m) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-current', String(m.id === state.currentId));
    card.onclick = () => selectModel(m.id);
    card.onkeydown = (e) => { if (e.key === 'Enter') selectModel(m.id); };

    const img = document.createElement('img');
    img.src = `/library/${m.id}/concept.png`;
    img.alt = '';
    img.loading = 'lazy';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = m.description || '(no description)';
    const status = document.createElement('span');
    status.className = `status ${m.status}`;
    const engine = state.config.engines.find((e) => e.id === m.engine)?.label ?? m.engine;
    status.textContent = `${STATUS_TEXT[m.status] ?? m.status} · ${engine}`;
    status.title = m.error || '';
    meta.append(desc, status);

    const del = document.createElement('button');
    del.className = 'delete';
    del.type = 'button';
    del.textContent = 'Delete';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this model from your library?')) return;
      await api(`/api/models/${m.id}`, { method: 'DELETE' }).catch((err) => alert(err.message));
      state.models = state.models.filter((x) => x.id !== m.id);
      if (state.currentId === m.id) state.currentId = state.models.find((x) => x.status === 'done')?.id ?? null;
      renderLibrary();
      renderViewer();
    };

    card.append(img, meta, del);
    return card;
  }));
}

let pollTimer = null;
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!state.models.some((m) => m.status === 'queued' || m.status === 'generating')) return;
  pollTimer = setTimeout(async () => {
    try {
      state.models = await api('/api/models');
      renderLibrary();
      renderViewer();
    } catch { /* server restarting; try again */ }
    schedulePoll();
  }, 3000);
}

// ---------- init ----------

function fillSelect(select, items, value) {
  select.replaceChildren(...items.map((x) => new Option(x.label, x.id)));
  if (items.some((x) => x.id === value)) select.value = value;
}

async function init() {
  state.config = await api('/api/config');
  els.keyBanner.hidden = state.config.hasKey;

  const prefs = store.get('prefs', {});
  fillSelect(els.imageModel, state.config.imageModels, prefs.imageModel ?? state.config.defaults.imageModel);
  fillSelect(els.engine, state.config.engines, prefs.engine ?? state.config.defaults.engine);
  if (prefs.count) els.count.value = prefs.count;
  if (prefs.apose != null) els.apose.checked = prefs.apose;
  if (prefs.pbr != null) els.pbr.checked = prefs.pbr;

  const exp = store.get('export', {});
  if (exp.size) els.size.value = exp.size;
  if (exp.axis) els.axis.value = exp.axis;

  // Restore the last batch of concepts so a page reload doesn't lose paid images.
  const saved = store.get('concepts', null);
  if (saved?.images?.length) {
    state.concepts = saved;
    els.description.value = saved.description;
  }

  els.imageModel.onchange = els.count.onchange = updateConceptButton;
  els.engine.onchange = els.pbr.onchange = updateModelButton;
  els.btnConcepts.onclick = drawConcepts;
  els.btnModel.onclick = makeModel;
  els.size.oninput = els.axis.onchange = renderDims;
  els.description.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) drawConcepts(); };

  updateConceptButton();
  renderConcepts();

  state.models = await api('/api/models');
  state.currentId = state.models.find((m) => m.status !== 'error')?.id ?? null;
  renderLibrary();
  renderViewer();
  schedulePoll();
}

init().catch((err) => {
  document.body.prepend(Object.assign(document.createElement('p'), { className: 'error banner', textContent: `Could not start: ${err.message}` }));
});
