import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeLabels } from '../src/node-labels.js';

function fixture(options = {}) {
  const draws = [];
  const context = { fillText(text, x, y) { draws.push([text, x, y]); }, measureText(text) { return { width: text === '次' ? 32 : 19.2 }; } };
  const labels = new NodeLabels({ createCanvas: () => ({ width: 0, height: 0, getContext: () => context }), ...options });
  return { labels, draws };
}

test('one glyph atlas and a few instanced draws cover a thousand node titles and counts', () => {
  const { labels, draws } = fixture();
  for (let i = 0; i < 1000; i++) {
    labels.add(`Q${i}`).position.set(i, 2, 3);
    labels.add('0 次', { color: '#5c7a96', size: 17 }).position.set(i, 1, 3);
  }
  labels.flush();
  assert.equal(labels.pages.length, 1);
  assert.equal(labels.group.children.length, 1);
  assert.equal(draws.length, 96, 'glyphs are painted once regardless of label count');
  const page = labels.pages[0];
  assert.ok(page.geometry.isInstancedBufferGeometry);
  assert.equal(page.geometry.instanceCount, 7980);
  assert.ok(page.material.isMeshBasicNodeMaterial);
  assert.ok(page.material.vertexNode, 'clip-space vertex expression performs camera-facing placement');
  assert.equal(page.material.depthTest, false); assert.equal(page.material.depthWrite, false);
  assert.equal(page.material.fog, false); assert.equal(page.mesh.frustumCulled, false);
  labels.dispose();
});

test('changing counts, colors and layout reuses the atlas and handles without repainting glyphs', () => {
  const { labels, draws } = fixture();
  const count = labels.add('0 次', { color: '#5c7a96', size: 17 }); count.position.set(1, 2, 3);
  labels.flush();
  const atlas = labels.atlas.texture, version = atlas.version, drawCount = draws.length;
  for (const value of [1, 641, 1000, 1001, 999999, 0]) {
    count.setText(`${value} 次`, value > 1000 ? '#ff697e' : '#5c7a96'); labels.flush();
    assert.equal(labels.atlas.texture, atlas); assert.equal(atlas.version, version); assert.equal(draws.length, drawCount);
    const attributeVersion = count.slot.page.attributes.rect.version;
    labels.flush(); assert.equal(count.slot.page.attributes.rect.version, attributeVersion, 'unchanged labels do not upload buffers');
  }
  const before = count.slot.page.attributes.tint.version;
  count.color.setHex(0x85efd0); count.position.set(4, 5, 6); labels.flush();
  assert.equal(count.slot.page.attributes.tint.version, before + 1);
  assert.deepEqual(Array.from(count.slot.page.attributes.center.array.slice(count.slot.start * 3, count.slot.start * 3 + 3)), [4, 5, 6]);
  labels.dispose();
});

test('hidden labels avoid text processing and updates, while q markers keep their own draw layer', () => {
  const { labels, draws } = fixture();
  const title = labels.add('Q2');
  const count = labels.add('0 次', { size: 17 });
  const state = labels.add('q', { size: 30, scale: [.46, .115, 1], renderOrder: 6 });
  labels.flush();
  const normalPage = title.slot.page, statePage = state.slot.page;
  assert.notEqual(normalPage, statePage); assert.equal(statePage.mesh.renderOrder, 6);
  title.visible = count.visible = false; labels.flush();
  assert.equal(normalPage.mesh.visible, false); assert.equal(statePage.mesh.visible, true);
  const version = normalPage.attributes.rect.version, atlasVersion = labels.atlas.texture.version, drawCount = draws.length;
  count.setText('新字'); labels.flush(); labels.flush();
  assert.equal(normalPage.attributes.rect.version, version);
  assert.equal(labels.atlas.texture.version, atlasVersion); assert.equal(draws.length, drawCount);
  count.visible = true; labels.flush();
  assert.equal(normalPage.mesh.visible, true); assert.equal(draws.length, drawCount + 2);
  assert.equal(labels.atlas.texture.version, atlasVersion + 1);
  labels.dispose();
});

test('label dimensions match the old 256 by 64 sprite canvas and camera-space glyph offsets', () => {
  const { labels } = fixture();
  const title = labels.add('Q1'); title.position.set(5, 4, 3); labels.flush();
  const { page, start } = title.slot;
  const size = Array.from(page.attributes.size.array.slice(start * 2, start * 2 + 2));
  assert.ok(Math.abs(size[0] - 64 * (22 / 32) / 256 * 1.35) < 1e-6);
  assert.ok(Math.abs(size[1] - 64 * (22 / 32) / 64 * .3375) < 1e-6);
  const first = page.attributes.offset.array[start * 2], second = page.attributes.offset.array[(start + 1) * 2];
  assert.equal(first, -second, 'two-character label is centered around its world position');
  assert.deepEqual(Array.from(page.attributes.center.array.slice(start * 3, start * 3 + 3)), [5, 4, 3]);
  labels.dispose();
});

test('growth clears stale glyph instances and empty text suppresses previous content', () => {
  const { labels } = fixture({ pageCapacity: 4 });
  const label = labels.add('1'); labels.flush(); const old = label.slot;
  label.setText('123456'); labels.flush();
  assert.notEqual(label.slot, old); assert.equal(old.page.attributes.size.array[old.start * 2], 0);
  assert.equal(old.page.mesh.visible, false);
  label.setText(''); labels.flush(); assert.equal(label.slot.page.mesh.visible, false);
  label.setText('2'); labels.flush(); assert.equal(label.slot.page.mesh.visible, true);
  assert.equal(label.slot.page.attributes.size.array[(label.slot.start + 1) * 2], 0);
  labels.dispose();
});

test('model replacement disposes page resources once and retains the shared atlas until final disposal', () => {
  const { labels } = fixture(); labels.add('Q0'); labels.flush();
  const atlas = labels.atlas.texture; let textures = 0, geometries = 0, materials = 0;
  atlas.addEventListener('dispose', () => textures++);
  for (const page of labels.pages) {
    page.geometry.addEventListener('dispose', () => geometries++);
    page.material.addEventListener('dispose', () => materials++);
  }
  labels.clear(); assert.equal(textures, 0); assert.equal(geometries, 1); assert.equal(materials, 1);
  assert.equal(labels.group.children.length, 0); assert.equal(labels.labels.size, 0);
  labels.add('X9'); labels.flush(); assert.equal(labels.atlas.texture, atlas);
  labels.dispose(); labels.dispose(); assert.equal(textures, 1);
});
