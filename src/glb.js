// Measuring and resizing GLB files.
//
// glTF's unit is the metre, so "15 cm tall" means the model's Y extent must be
// 0.15. We bake the scale into the vertex data (rather than leaving a scaled
// parent node) so every tool — Blender, Unity, three.js, AR viewers — sees the
// real size with a clean scale of 1.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds, transformMesh } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

export const AXES = {
  width: 0, // X
  height: 1, // Y (glTF is Y-up)
  depth: 2, // Z
  longest: -1,
};

let ioPromise;
function getIO() {
  ioPromise ??= (async () => {
    await MeshoptDecoder.ready;
    await MeshoptEncoder.ready;
    return new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
        'draco3d.encoder': await draco3d.createEncoderModule(),
        'meshopt.decoder': MeshoptDecoder,
        'meshopt.encoder': MeshoptEncoder,
      });
  })();
  return ioPromise;
}

function mainScene(doc) {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new Error('GLB has no scene.');
  return scene;
}

function boxOf(scene) {
  const { min, max } = getBounds(scene);
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (!size.every(Number.isFinite) || Math.max(...size) <= 0) {
    throw new Error('Could not measure the model (it looks empty).');
  }
  return { min, max, size };
}

/** Size of the model in metres: { width, height, depth }. */
export async function measureGlb(input) {
  const io = await getIO();
  const doc = typeof input === 'string' ? await io.read(input) : await io.readBinary(input);
  const { size } = boxOf(mainScene(doc));
  return { width: size[0], height: size[1], depth: size[2] };
}

function axisIndex(axis, size) {
  if (!(axis in AXES)) throw new Error(`Unknown axis "${axis}".`);
  const i = AXES[axis];
  return i === -1 ? size.indexOf(Math.max(...size)) : i;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// Bake every node's world transform into its mesh vertices, then reset all
// node transforms to identity. (We don't use gltf-transform's
// clearNodeTransform: it composes child × parent, which mis-scales children.)
function bakeTransforms(scene) {
  const nodes = [];
  scene.traverse((node) => nodes.push(node));
  const world = new Map(nodes.map((n) => [n, n.getWorldMatrix()]));
  for (const node of nodes) {
    let mesh = node.getMesh();
    if (!mesh) continue;
    // transformMesh edits in place; give this node its own copy if shared.
    if (mesh.listParents().filter((p) => p.propertyType === 'Node').length > 1) {
      mesh = mesh.clone();
      node.setMesh(mesh);
    }
    transformMesh(mesh, world.get(node));
  }
  for (const node of nodes) node.setMatrix(IDENTITY);
}

/**
 * Resize a GLB so that `axis` measures exactly `sizeCm`, keeping proportions.
 * The model is also centred on X/Z with its lowest point at Y=0 (feet on the floor).
 * Returns { glb: Uint8Array, dimsCm: { width, height, depth } }.
 */
export async function resizeGlb(input, { sizeCm, axis = 'height' }) {
  if (!(sizeCm > 0)) throw new Error('Size must be greater than 0 cm.');
  const io = await getIO();
  const doc = typeof input === 'string' ? await io.read(input) : await io.readBinary(input);
  const root = doc.getRoot();
  const scene = mainScene(doc);

  const { min, max, size } = boxOf(scene);
  const f = sizeCm / 100 / size[axisIndex(axis, size)];
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;

  // One wrapper node holding scale + recentre. Column-major 4x4.
  const wrapper = doc.createNode('model').setMatrix([
    f, 0, 0, 0,
    0, f, 0, 0,
    0, 0, f, 0,
    -cx * f, -min[1] * f, -cz * f, 1,
  ]);
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    wrapper.addChild(child);
  }
  scene.addChild(wrapper);

  // Baking is unsafe for skinned/animated models or ones with cameras/lights.
  // Generated models have none of these; if one does, the wrapper node's
  // transform alone still gives the correct size.
  const plain = root.listSkins().length === 0 && root.listAnimations().length === 0
    && root.listCameras().length === 0 && !root.listNodes().some((n) => n.getExtension('KHR_lights_punctual'));
  if (plain) bakeTransforms(scene);

  const out = boxOf(scene);
  const glb = await io.writeBinary(doc);
  return {
    glb,
    dimsCm: { width: out.size[0] * 100, height: out.size[1] * 100, depth: out.size[2] * 100 },
  };
}
