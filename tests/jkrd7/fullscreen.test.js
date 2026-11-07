import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSceneFullscreen } from '../../src/scene/fullscreen.js';

class Events {
  listeners = new Map();
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener); this.listeners.set(type, listeners);
  }
  async emit(type, event = {}) { await Promise.all((this.listeners.get(type) ?? []).map(listener => listener(event))); }
}

/** Minimal tree/event harness for node identity and fullscreen lifecycle only. */
class Element extends Events {
  constructor(doc, name) {
    super(); this.ownerDocument = doc; this.name = name; this.children = []; this.parentNode = null;
    this.attributes = new Map(); this.disabled = false;
    const classes = new Set();
    this.classList = { contains: value => classes.has(value), toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value) };
  }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null; }
  append(...elements) { elements.forEach(element => this.insertBefore(element, null)); }
  before(element) { this.parentNode.insertBefore(element, this); }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  insertBefore(element, reference) {
    element.remove();
    const index = reference === null ? this.children.length : this.children.indexOf(reference);
    assert.notEqual(index, -1, 'reference belongs to its current parent');
    this.children.splice(index, 0, element); element.parentNode = this;
  }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  querySelector(selector) {
    if (selector !== '[data-fullscreen-label]') return null;
    for (const child of this.children) {
      if (child.attributes.has('data-fullscreen-label')) return child;
      const found = child.querySelector(selector); if (found) return found;
    }
    return null;
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() { this.ownerDocument.activeElement = this; }
  click() { return this.emit('click'); }
}

function fixture({ native = true } = {}) {
  const doc = new Events();
  doc.documentElement = new Element(doc, 'html');
  doc.fullscreenElement = null; doc.fullscreenEnabled = native; doc.modal = false;
  doc.createComment = () => new Element(doc, 'marker');
  doc.querySelector = selector => selector === 'dialog[open]' && doc.modal ? {} : null;
  const scene = new Element(doc, 'scene'), tools = new Element(doc, 'tools'), overlay = new Element(doc, 'overlay');
  const inspector = new Element(doc, 'inspector'), controls = new Element(doc, 'controls');
  const before = new Element(doc, 'before'), after = new Element(doc, 'after'), button = new Element(doc, 'fullscreen-button');
  tools.append(before, inspector, controls, after); controls.append(button);
  scene.requestFullscreen = async () => { doc.fullscreenElement = scene; await doc.emit('fullscreenchange'); };
  doc.exitFullscreen = async () => { doc.fullscreenElement = null; await doc.emit('fullscreenchange'); };
  return { doc, scene, tools, overlay, inspector, controls, before, after, button };
}

test('three-argument RGB fullscreen still moves only its inspector and restores its original position', async () => {
  const { doc, scene, tools, inspector, controls, before, after, button } = fixture();
  setupSceneFullscreen(scene, button, inspector);
  await button.click();
  assert.equal(doc.fullscreenElement, scene);
  assert.equal(inspector.parentNode, scene);
  assert.equal(controls.parentNode, tools);
  await button.click();
  assert.equal(doc.fullscreenElement, null);
  assert.deepEqual(tools.children, [before, inspector, controls, after]);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(button.textContent, '⛶ 全屏');
});

function jkmFixture(options) {
  const state = fixture(options);
  const { doc, scene, tools, inspector, controls, button } = state;
  const viewport = new Element(doc, 'viewport'), canvas = new Element(doc, 'canvas');
  viewport.append(canvas); scene.append(viewport);
  const rail = new Element(doc, 'rail'), menu = new Element(doc, 'menu');
  const icon = new Element(doc, 'svg'), label = new Element(doc, 'label');
  label.setAttribute('data-fullscreen-label', '');
  button.append(icon, label); menu.append(button); rail.append(menu); tools.append(rail);
  controls.hidden = true; inspector.hidden = false; rail.hidden = false;
  return { ...state, viewport, canvas, rail, menu, icon, label };
}

function panelFixture(options) {
  const state = jkmFixture(options);
  const area = new Element(state.doc, 'scene-area');
  area.append(state.scene, state.inspector, state.controls);
  area.requestFullscreen = async () => { state.doc.fullscreenElement = area; await state.doc.emit('fullscreenchange'); };
  let mode = 'dual';
  return {
    ...state, area, setMode: value => { mode = value; },
    resolveTarget: () => mode === 'single'
      ? { element: area, className: 'cosmic-panel-fullscreen', label: '左侧单板' }
      : { element: state.scene, className: 'scene-fullscreen', label: '双板 3D 场景' },
  };
}

for (const native of [true, false]) {
  test(`JKM ${native ? 'native' : 'fallback'} fullscreen keeps only the existing scene and Escape restores menu focus`, async () => {
    const { doc, scene, tools, inspector, controls, button, viewport, canvas, rail, menu, icon, label } = jkmFixture({ native });
    const originalTools = [...tools.children];
    const control = setupSceneFullscreen(scene, button);
    await button.click();
    assert.equal(doc.fullscreenElement, native ? scene : null);
    assert.equal(scene.classList.contains('scene-fullscreen'), true);
    assert.deepEqual(scene.children, [viewport]);
    assert.equal(viewport.children[0], canvas);
    assert.deepEqual(tools.children, originalTools);
    for (const element of [rail, inspector, controls]) assert.equal(scene.contains(element), false);
    assert.equal(button.parentNode, menu);
    assert.deepEqual(button.children, [icon, label]);
    assert.equal(label.textContent, '退出全屏');
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.deepEqual([controls.hidden, inspector.hidden, rail.hidden], [true, false, false]);
    let prevented = false;
    doc.modal = true;
    await doc.emit('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
    assert.equal(scene.classList.contains('scene-fullscreen'), true);
    assert.equal(prevented, false);
    doc.modal = false;
    await doc.emit('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
    await control.exit();
    assert.equal(prevented, true);
    assert.equal(doc.fullscreenElement, null);
    assert.equal(scene.classList.contains('scene-fullscreen'), false);
    assert.equal(doc.activeElement, button);
    assert.deepEqual(tools.children, originalTools);
    assert.deepEqual(scene.children, [viewport]);
    assert.equal(viewport.children[0], canvas);
    assert.deepEqual(button.children, [icon, label]);
    assert.equal(label.textContent, '全屏');
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.deepEqual([controls.hidden, inspector.hidden, rail.hidden], [true, false, false]);
  });

  test(`JKM ${native ? 'native' : 'fallback'} fullscreen switches targets between panels and preserves floating windows`, async () => {
    const { doc, scene, area, tools, inspector, controls, button, viewport, canvas, rail, icon, label, setMode, resolveTarget } = panelFixture({ native });
    const areaChildren = [...area.children], toolChildren = [...tools.children];
    const control = setupSceneFullscreen(scene, button, undefined, [], { resolveTarget });
    await button.click();
    assert.equal(doc.fullscreenElement, native ? scene : null);
    assert.equal(scene.classList.contains('scene-fullscreen'), true);
    assert.equal(area.classList.contains('cosmic-panel-fullscreen'), false);
    // A pending layout change cannot retarget an already-entered fullscreen.
    setMode('single'); control.refresh();
    assert.equal(button.getAttribute('aria-label'), '退出双板 3D 场景全屏');
    await control.exit();
    assert.equal(scene.classList.contains('scene-fullscreen'), false);
    await button.click();
    assert.equal(doc.fullscreenElement, native ? area : null);
    assert.equal(area.classList.contains('cosmic-panel-fullscreen'), true);
    assert.equal(scene.classList.contains('scene-fullscreen'), false);
    assert.equal(button.getAttribute('aria-label'), '退出左侧单板全屏');
    assert.equal(area.contains(rail), false);
    assert.deepEqual(area.children, areaChildren);
    assert.deepEqual(tools.children, toolChildren);
    assert.deepEqual([controls.hidden, inspector.hidden, rail.hidden], [true, false, false]);
    assert.equal(canvas.parentNode, viewport);
    assert.equal(viewport.parentNode, scene);
    let prevented = false;
    await doc.emit('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
    await control.exit();
    assert.equal(prevented, true);
    assert.equal(doc.fullscreenElement, null);
    assert.equal(area.classList.contains('cosmic-panel-fullscreen'), false);
    assert.equal(doc.activeElement, button);
    assert.deepEqual(button.children, [icon, label]);
    assert.equal(label.textContent, '全屏');
    assert.deepEqual(area.children, areaChildren);
    assert.deepEqual(tools.children, toolChildren);
    assert.deepEqual([controls.hidden, inspector.hidden, rail.hidden], [true, false, false]);
    setMode('dual'); control.refresh();
    assert.equal(button.getAttribute('aria-label'), '全屏展示双板 3D 场景');
    await button.click();
    assert.equal(scene.classList.contains('scene-fullscreen'), true);
    assert.equal(area.classList.contains('cosmic-panel-fullscreen'), false);
    await control.exit();
  });
}

test('workspace switch waits for the locked single-panel target even if the selected mode changes during entry', async () => {
  const { doc, scene, area, tools, button, viewport, canvas, setMode, resolveTarget } = panelFixture();
  const originalTools = [...tools.children];
  const originalArea = [...area.children];
  setMode('single');
  let finishEntry;
  area.requestFullscreen = () => new Promise(resolve => {
    finishEntry = async () => { doc.fullscreenElement = area; await doc.emit('fullscreenchange'); resolve(); };
  });
  const control = setupSceneFullscreen(scene, button, undefined, [], { resolveTarget });
  const entry = button.click();
  setMode('dual'); control.refresh();
  const exit = control.exit();
  await finishEntry(); await entry; await exit;
  assert.equal(doc.fullscreenElement, null);
  assert.equal(scene.classList.contains('scene-fullscreen'), false);
  assert.equal(area.classList.contains('cosmic-panel-fullscreen'), false);
  assert.deepEqual(tools.children, originalTools);
  assert.deepEqual(area.children, originalArea);
  assert.deepEqual(scene.children, [viewport]);
  assert.equal(viewport.children[0], canvas);
  assert.equal(doc.activeElement, button);
  assert.equal(button.disabled, false);
  await button.click();
  assert.equal(doc.fullscreenElement, scene);
  await control.exit();
});

test('a rejected native single-panel request falls back on the same target and clears it on exit', async () => {
  const { doc, scene, area, button, setMode, resolveTarget } = panelFixture();
  setMode('single');
  area.requestFullscreen = async () => { throw new Error('native fullscreen unavailable'); };
  const control = setupSceneFullscreen(scene, button, undefined, [], { resolveTarget });
  await button.click();
  assert.equal(doc.fullscreenElement, null);
  assert.equal(area.classList.contains('cosmic-panel-fullscreen'), true);
  assert.equal(scene.classList.contains('scene-fullscreen'), false);
  assert.match(button.title, /左侧单板.*页面内全屏/);
  setMode('dual');
  await control.exit();
  assert.equal(area.classList.contains('cosmic-panel-fullscreen'), false);
  assert.equal(button.disabled, false);
  await button.click();
  assert.equal(doc.fullscreenElement, scene);
  await control.exit();
});

test('failed native scene exit rejects a workspace switch and leaves the current scene intact', async () => {
  const { doc, scene, tools, button, viewport, canvas } = jkmFixture();
  const originalTools = [...tools.children];
  const control = setupSceneFullscreen(scene, button);
  await button.click();
  doc.exitFullscreen = async () => { throw new Error('exit refused'); };
  await assert.rejects(control.exit(), /exit refused/);
  assert.equal(doc.fullscreenElement, scene);
  assert.equal(scene.classList.contains('scene-fullscreen'), true);
  assert.deepEqual(tools.children, originalTools);
  assert.deepEqual(scene.children, [viewport]);
  assert.equal(viewport.children[0], canvas);
  assert.equal(button.disabled, false);
});
