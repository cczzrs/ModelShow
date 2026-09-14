import * as THREE from 'three/webgpu';
import { cameraProjectionMatrix, cameraViewMatrix, modelWorldMatrix, positionGeometry, instancedBufferAttribute, texture, uv, vec4 } from 'three/tsl';

const CELL = 64, ATLAS_SIZE = 1024, FONT_SIZE = 32;
const DEFAULT_SCALE = [1.35, .3375, 1];
const attributeSizes = { center: 3, offset: 2, size: 2, rect: 4, tint: 3 };

/** A white glyph atlas: changing a number changes instance UVs, never a texture. */
class GlyphAtlas {
  constructor(createCanvas) {
    this.canvas = createCanvas(); this.canvas.width = this.canvas.height = ATLAS_SIZE;
    this.context = this.canvas.getContext('2d');
    this.context.font = `500 ${FONT_SIZE}px ui-monospace, SFMono-Regular, monospace`;
    this.context.textAlign = 'center'; this.context.textBaseline = 'middle'; this.context.fillStyle = '#ffffff';
    this.glyphs = new Map(); this.dirty = false;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.generateMipmaps = false;
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    // All ordinary node IDs, state markers and execution counts are resident up front.
    for (const c of Array.from({length: 95}, (_, i) => String.fromCharCode(32 + i)).concat('次')) this.get(c);
  }
  get(character) {
    if (this.glyphs.has(character)) return this.glyphs.get(character);
    if (this.glyphs.size >= (ATLAS_SIZE / CELL) ** 2) return this.glyphs.get('?');
    const index = this.glyphs.size, x = index % 16 * CELL, y = Math.floor(index / 16) * CELL;
    this.context.fillText(character, x + CELL / 2, y + CELL / 2);
    const glyph = {
      advance: this.context.measureText(character).width,
      rect: [x / ATLAS_SIZE, 1 - (y + CELL) / ATLAS_SIZE, CELL / ATLAS_SIZE, CELL / ATLAS_SIZE],
    };
    this.glyphs.set(character, glyph); this.dirty = true;
    return glyph;
  }
  flush() { if (this.dirty) { this.texture.needsUpdate = true; this.dirty = false; } }
}

class LabelPage {
  constructor(atlas, capacity, renderOrder) {
    this.capacity = capacity; this.used = 0; this.dirty = false; this.visibleSlots = 0;
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setIndex(plane.index.clone());
    for (const name of ['position', 'normal', 'uv']) this.geometry.setAttribute(name, plane.getAttribute(name).clone());
    plane.dispose(); this.geometry.instanceCount = 0;
    this.attributes = {};
    for (const [name, size] of Object.entries(attributeSizes)) {
      const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size).setUsage(THREE.DynamicDrawUsage);
      this.attributes[name] = attribute; this.geometry.setAttribute(`label_${name}`, attribute);
    }
    const node = name => instancedBufferAttribute(this.attributes[name]);
    const center = cameraViewMatrix.mul(modelWorldMatrix).mul(vec4(node('center'), 1));
    const aligned = positionGeometry.xy.mul(node('size')).add(node('offset'));
    const rect = node('rect'), sample = texture(atlas.texture, uv().mul(rect.zw).add(rect.xy));
    this.material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
    // A clip-space vertex node keeps every instance facing the camera in all 360° views.
    this.material.vertexNode = cameraProjectionMatrix.mul(vec4(center.xy.add(aligned), center.zw));
    this.material.colorNode = sample.rgb.mul(node('tint'));
    this.material.opacityNode = sample.a;
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = renderOrder; this.mesh.visible = false;
    this.mesh.name = 'Batched node labels';
  }
  reserve(length) {
    const slot = { page: this, start: this.used, length, visible: false }; this.used += length;
    this.geometry.instanceCount = this.used; return slot;
  }
  hide(slot) {
    if (slot.visible) { slot.visible = false; this.visibleSlots--; this.mesh.visible = this.visibleSlots > 0; }
    this.attributes.size.array.fill(0, slot.start * 2, (slot.start + slot.length) * 2); this.dirty = true;
  }
  write(slot, label, glyphs) {
    if (!slot.visible) { slot.visible = true; this.visibleSlots++; this.mesh.visible = true; }
    const ratio = label.fontSize / FONT_SIZE, width = glyphs.reduce((sum, glyph) => sum + glyph.advance, 0);
    let advance = -width / 2;
    const r = label.textColor.r * label.color.r, g = label.textColor.g * label.color.g, b = label.textColor.b * label.color.b;
    for (let i = 0; i < slot.length; i++) {
      const index = slot.start + i, glyph = glyphs[i];
      if (!glyph) { this.attributes.size.array.fill(0, index * 2, index * 2 + 2); continue; }
      this.attributes.center.array[index * 3] = label.position.x;
      this.attributes.center.array[index * 3 + 1] = label.position.y;
      this.attributes.center.array[index * 3 + 2] = label.position.z;
      this.attributes.offset.array.set([(advance + glyph.advance / 2) * ratio / 256 * label.scale.x, 0], index * 2);
      this.attributes.size.array.set([CELL * ratio / 256 * label.scale.x, CELL * ratio / 64 * label.scale.y], index * 2);
      this.attributes.rect.array.set(glyph.rect, index * 4);
      this.attributes.tint.array[index * 3] = r;
      this.attributes.tint.array[index * 3 + 1] = g;
      this.attributes.tint.array[index * 3 + 2] = b;
      advance += glyph.advance;
    }
    this.dirty = true;
  }
  flush() {
    if (!this.dirty) return;
    for (const attribute of Object.values(this.attributes)) attribute.needsUpdate = true;
    this.dirty = false;
  }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

class LabelHandle {
  constructor(text, { color = '#a5bcd3', size = 22, scale = DEFAULT_SCALE, renderOrder = 4 } = {}) {
    this.text = String(text); this.textColor = new THREE.Color(color); this.fontSize = size;
    this.position = new THREE.Vector3(); this.scale = new THREE.Vector3().fromArray(scale);
    this.color = new THREE.Color(0xffffff); this.visible = true; this.renderOrder = renderOrder;
    this.slot = null; this.dirty = true; this.wasVisible = false; this.snapshot = new Float64Array(14).fill(NaN);
  }
  setText(text, color, size = this.fontSize) {
    text = String(text);
    if (text !== this.text || size !== this.fontSize) { this.text = text; this.fontSize = size; this.dirty = true; }
    if (color !== undefined) this.textColor.set(color);
    return this;
  }
  changed() {
    const p = this.position, s = this.scale, c = this.color, t = this.textColor, old = this.snapshot;
    const changed = this.dirty || p.x !== old[0] || p.y !== old[1] || p.z !== old[2] || s.x !== old[3] || s.y !== old[4] || s.z !== old[5]
      || c.r !== old[6] || c.g !== old[7] || c.b !== old[8] || t.r !== old[9] || t.g !== old[10] || t.b !== old[11]
      || this.fontSize !== old[12] || this.renderOrder !== old[13];
    if (changed) {
      old[0] = p.x; old[1] = p.y; old[2] = p.z; old[3] = s.x; old[4] = s.y; old[5] = s.z;
      old[6] = c.r; old[7] = c.g; old[8] = c.b; old[9] = t.r; old[10] = t.g; old[11] = t.b;
      old[12] = this.fontSize; old[13] = this.renderOrder;
    }
    return changed;
  }
}

/**
 * A few instanced draws replace the per-node Sprite/material/CanvasTexture objects.
 * Add group to the scene once. Handles expose position/scale/color/visible plus setText().
 * Call flush() before rendering; it does no atlas painting or buffer writes for unchanged labels.
 * clear() releases page resources for model replacement, retaining the shared glyph atlas.
 */
export class NodeLabels {
  constructor({ pageCapacity = 8192, createCanvas = () => document.createElement('canvas') } = {}) {
    if (!Number.isSafeInteger(pageCapacity) || pageCapacity < 1) throw new Error('Label page capacity must be a positive integer');
    this.pageCapacity = pageCapacity; this.createCanvas = createCanvas;
    this.group = new THREE.Group(); this.group.name = 'Node labels';
    this.labels = new Set(); this.pages = []; this.atlas = null;
  }
  add(text, options) { const label = new LabelHandle(text, options); this.labels.add(label); return label; }
  reserve(label, length) {
    // Counts can gain digits without moving on every update.
    const capacity = Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(1, length))));
    let page = this.pages.find(page => page.mesh.renderOrder === label.renderOrder && page.capacity - page.used >= capacity);
    if (!page) {
      this.atlas ??= new GlyphAtlas(this.createCanvas);
      page = new LabelPage(this.atlas, Math.max(this.pageCapacity, capacity), label.renderOrder);
      this.pages.push(page); this.group.add(page.mesh);
    }
    return page.reserve(capacity);
  }
  flush() {
    for (const label of this.labels) {
      if (!label.visible || !label.text) {
        if (label.wasVisible && label.slot) label.slot.page.hide(label.slot);
        label.wasVisible = false;
        continue; // Hidden counts retain text only, and consume no glyph/texture updates.
      }
      if (!label.changed() && label.wasVisible) continue;
      this.atlas ??= new GlyphAtlas(this.createCanvas);
      const glyphs = Array.from(label.text, character => this.atlas.get(character));
      if (!label.slot || label.slot.length < glyphs.length || label.slot.page.mesh.renderOrder !== label.renderOrder) {
        if (label.slot) label.slot.page.hide(label.slot);
        label.slot = this.reserve(label, glyphs.length);
      }
      label.slot.page.write(label.slot, label, glyphs);
      label.dirty = false; label.wasVisible = true;
    }
    this.atlas?.flush(); for (const page of this.pages) page.flush();
  }
  clear() {
    for (const page of this.pages) page.dispose();
    this.group.clear(); this.pages = []; this.labels.clear();
  }
  dispose() { this.clear(); this.atlas?.texture.dispose(); this.atlas = null; }
}
