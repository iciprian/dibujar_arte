import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco, getBounds } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

import { measureGlb, resizeGlb } from '../src/glb.js';

// 1x1 white PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64',
);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

// A box from (-1,0,-0.5) to (1,4,0.5), used by two nodes, inside a scaled +
// translated parent — the kind of nesting a generator might produce.
async function makeGlb({ compress = false } = {}) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const xs = [-1, 1], ys = [0, 4], zs = [-0.5, 0.5];
  const pos = [];
  for (const x of xs) for (const y of ys) for (const z of zs) pos.push(x, y, z);
  const idx = [0, 1, 2, 1, 3, 2, 4, 6, 5, 5, 6, 7, 0, 4, 1, 1, 4, 5, 2, 3, 6, 3, 7, 6, 0, 2, 4, 2, 6, 4, 1, 5, 3, 3, 5, 7];
  const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer);
  const indices = doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(idx)).setBuffer(buffer);
  const texture = doc.createTexture('base').setImage(new Uint8Array(PNG)).setMimeType('image/png');
  const material = doc.createMaterial('skin').setBaseColorTexture(texture);
  const prim = doc.createPrimitive().setAttribute('POSITION', position).setIndices(indices).setMaterial(material);
  const mesh = doc.createMesh('body').addPrimitive(prim);

  const parent = doc.createNode('parent').setScale([0.5, 0.5, 0.5]).setTranslation([3, 1, -2]);
  parent.addChild(doc.createNode('a').setMesh(mesh));
  parent.addChild(doc.createNode('b').setMesh(mesh).setTranslation([0, 0, 0.25]));
  doc.createScene('scene').addChild(parent);
  doc.getRoot().setDefaultScene(doc.getRoot().listScenes()[0]);

  if (compress) await doc.transform(draco());
  return io.writeBinary(doc);
}

const close = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('measures the model in metres', async () => {
  const dims = await measureGlb(await makeGlb());
  close(dims.width, 1); // 2 * 0.5
  close(dims.height, 2); // 4 * 0.5
  close(dims.depth, 0.625); // (1 + 0.25) * 0.5
});

for (const compress of [false, true]) {
  test(`resizes to 15 cm tall, feet at 0, centred${compress ? ' (Draco input)' : ''}`, async () => {
    const { glb, dimsCm } = await resizeGlb(await makeGlb({ compress }), { sizeCm: 15, axis: 'height' });
    close(dimsCm.height, 15, 1e-3);
    close(dimsCm.width, 7.5, 1e-3);
    close(dimsCm.depth, 4.6875, 1e-3);

    const doc = await io.readBinary(glb);
    const scene = doc.getRoot().getDefaultScene();
    const { min, max } = getBounds(scene);
    close(max[1] - min[1], 0.15, 1e-4); // glTF metres
    close(min[1], 0, 1e-4);
    close((min[0] + max[0]) / 2, 0, 1e-4);
    close((min[2] + max[2]) / 2, 0, 1e-4);

    // Scale is baked into the vertices: no node keeps a non-identity transform.
    for (const node of doc.getRoot().listNodes()) {
      assert.deepEqual(node.getScale(), [1, 1, 1], `${node.getName()} scale`);
      assert.deepEqual(node.getTranslation(), [0, 0, 0], `${node.getName()} translation`);
    }
    assert.equal(doc.getRoot().listTextures().length, 1, 'texture kept');
  });
}

test('longest side and width axes', async () => {
  const src = await makeGlb();
  close((await resizeGlb(src, { sizeCm: 30, axis: 'longest' })).dimsCm.height, 30, 1e-3);
  const byWidth = await resizeGlb(src, { sizeCm: 10, axis: 'width' });
  close(byWidth.dimsCm.width, 10, 1e-3);
  close(byWidth.dimsCm.height, 20, 1e-3);
});

test('rejects bad sizes', async () => {
  await assert.rejects(resizeGlb(await makeGlb(), { sizeCm: 0 }), /greater than 0/);
});
