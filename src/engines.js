// Model catalogue: which fal.ai endpoints we call, how we shape their input,
// and roughly what they cost (USD, from fal.ai's pricing pages, Nov 2026).

// ---------- Step 1: text -> concept image ----------

export const IMAGE_MODELS = {
  'nano-banana-2': {
    label: 'Nano Banana 2 (best at following the description)',
    endpoint: 'fal-ai/nano-banana-2',
    pricePerImage: 0.08,
    input: (prompt, count) => ({
      prompt,
      num_images: count,
      aspect_ratio: '3:4',
      output_format: 'png',
      resolution: '1K',
    }),
  },
  'flux-dev': {
    label: 'FLUX.1 dev (good, cheap)',
    endpoint: 'fal-ai/flux/dev',
    pricePerImage: 0.02, // $0.025 per megapixel, 768x1024
    input: (prompt, count) => ({
      prompt,
      num_images: count,
      image_size: 'portrait_4_3',
      output_format: 'png',
    }),
  },
  'flux-schnell': {
    label: 'FLUX.1 schnell (fastest, almost free)',
    endpoint: 'fal-ai/flux/schnell',
    pricePerImage: 0.003,
    input: (prompt, count) => ({
      prompt,
      num_images: count,
      image_size: 'portrait_4_3',
      output_format: 'png',
    }),
  },
};

export const DEFAULT_IMAGE_MODEL = 'nano-banana-2';

// The image-to-3D models work best with one subject, full body, plain
// background, filling most of the frame. We wrap the user's words with that.
export function buildConceptPrompt(description, { aPose = true } = {}) {
  const pose = aPose
    ? 'standing in a neutral A-pose with arms slightly away from the body'
    : 'standing';
  return [
    description.trim().replace(/\.*$/, '.'),
    `Full-body character, ${pose}, entire body visible from head to toe.`,
    'Single character only, front view facing the camera, centered with a small margin around it.',
    'Plain pure white background, soft even studio lighting, no cast shadows, no text, no other objects.',
    'Clean character concept suitable for 3D modeling.',
  ].join(' ');
}

// ---------- Step 2: concept image -> 3D model (GLB) ----------

export const ENGINES = {
  'hunyuan-rapid': {
    label: 'Hunyuan 3D v3.1 Rapid',
    endpoint: 'fal-ai/hunyuan-3d/v3.1/rapid/image-to-3d',
    price: 0.225,
    pbrPrice: 0.15,
    input: (imageUrl, { pbr }) => ({ input_image_url: imageUrl, enable_pbr: !!pbr }),
  },
  'hunyuan-pro': {
    label: 'Hunyuan 3D v3.1 Pro (more detail)',
    endpoint: 'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d',
    price: 0.375,
    pbrPrice: 0.15,
    input: (imageUrl, { pbr }) => ({ input_image_url: imageUrl, enable_pbr: !!pbr }),
  },
  'trellis-2': {
    label: 'TRELLIS 2',
    endpoint: 'fal-ai/trellis-2',
    price: 0.3,
    pbrPrice: null, // no PBR toggle
    input: (imageUrl) => ({ image_url: imageUrl, resolution: 1024, texture_size: 2048 }),
  },
};

export const DEFAULT_ENGINE = 'hunyuan-rapid';

export function engineCost(engineId, pbr) {
  const e = ENGINES[engineId];
  return e.price + (pbr && e.pbrPrice ? e.pbrPrice : 0);
}

// All three engines return { model_glb: { url, file_name, content_type } }.
export function extractGlbUrl(data) {
  const file = data?.model_glb;
  if (!file?.url) throw new Error('The 3D service did not return a GLB file.');
  const name = (file.file_name || file.url).toLowerCase();
  if (name.endsWith('.obj')) throw new Error('The 3D service returned an OBJ instead of a GLB. Try again or use another engine.');
  return file.url;
}

// Public (no endpoint ids / input builders) view for the browser.
export function publicCatalogue() {
  return {
    imageModels: Object.entries(IMAGE_MODELS).map(([id, m]) => ({ id, label: m.label, pricePerImage: m.pricePerImage })),
    engines: Object.entries(ENGINES).map(([id, e]) => ({ id, label: e.label, price: e.price, pbrPrice: e.pbrPrice })),
    defaults: { imageModel: DEFAULT_IMAGE_MODEL, engine: DEFAULT_ENGINE },
  };
}
