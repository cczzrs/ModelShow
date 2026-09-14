import test from 'node:test';
import assert from 'node:assert/strict';
import { OutputDisplayUI } from '../../src/output/output-display-ui.js';
import { APP_CONFIG } from '../../src/config.js';
import { defaultDisplay, convertPixel } from '../../src/output/output-display.js';

// Replace only the native DOM boundary. The real controller initializes the
// static fixture, delegates events, validates drafts, applies and exports.
class Element {
  constructor(tag = 'div', attributes = {}) {
    this.tag = tag;
    this.attributes = { ...attributes };
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.classes = new Set();
    this.styles = new Map();
    this.style = { setProperty: (key, value) => this.styles.set(key, String(value)) };
    this.classList = {
      toggle: (key, enabled) => enabled ? this.classes.add(key) : this.classes.delete(key),
      contains: key => this.classes.has(key),
    };
    this._value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.open = false;
    for (const [key, value] of Object.entries(attributes)) this.setAttribute(key, value);
  }

  set value(value) {
    this._value = String(value);
  }

  get value() {
    return this._value;
  }

  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key.startsWith('data-')) {
      this.dataset[key.slice(5).replace(/-([a-z])/g, (match, letter) => letter.toUpperCase())] = String(value);
    }
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...children);
    if (this.tag === 'select') this.value = children[0]?.value ?? '';
  }

  matches(selector) {
    const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    assert.ok(match, `fixture must support selector: ${selector}`);
    return Object.hasOwn(this.attributes, match[1]) && (match[2] === undefined || this.attributes[match[1]] === match[2]);
  }

  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector) {
    return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null;
  }

  contains(element) {
    return element === this || this.children.some(child => child.contains(element));
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  emit(type) {
    const event = { target: this };
    let element = this;
    while (element) {
      for (const handler of element.listeners.get(type) ?? []) handler(event);
      element = element.parentElement;
    }
  }

  click() {
    if (!this.disabled) this.emit('click');
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  cloneNode() {
    const clone = new Element(this.tag, this.attributes);
    clone.textContent = this.textContent;
    clone.append(...this.children.map(child => child.cloneNode(true)));
    return clone;
  }
}

function fixture() {
  const root = new Element('dialog');
  const append = (parent, tag, attributes) => {
    const element = new Element(tag, attributes);
    parent.append(element);
    return element;
  };
  for (const name of ['enabled', 'rows', 'cols', 'scale', 'width', 'gray', 'packed-r-width', 'packed-g-width', 'packed-b-width']) {
    append(root, 'input', { 'data-display-field': name });
  }
  for (const name of ['start', 'order', 'mapping', 'mode', 'packed-order', 'packed-mapping']) {
    append(root, 'select', { 'data-display-field': name });
  }
  append(root, 'textarea', { 'data-display-field': 'export-text' });
  for (const name of ['error', 'required', 'preview-size', 'preview', 'editor', 'editor-title', 'readout', 'export-panel']) {
    append(root, 'div', { 'data-display-info': name });
  }
  for (const name of ['close', 'resize', 'batch', 'convert', 'apply-lamp', 'export']) {
    append(root, 'button', { 'data-display-action': name });
  }
  const channels = append(root, 'div', { 'data-display-region': 'channels' });
  const packed = append(root, 'div', { 'data-display-region': 'packed' });
  for (const key of ['r', 'g', 'b']) {
    const channel = append(channels, 'fieldset', { 'data-display-channel': key });
    for (const name of ['kind', 'radix', 'order', 'mapping']) append(channel, 'select', { 'data-channel-field': name });
    append(channel, 'input', { 'data-channel-field': 'value' });
    append(channel, 'div', { 'data-channel-region': 'fixed' });
    const bits = append(channel, 'div', { 'data-channel-region': 'bits' });
    const editor = append(bits, 'div', { 'data-bit-editor': key });
    append(editor, 'textarea', { 'data-bits-field': 'area' });
    append(editor, 'select', { 'data-bits-field': 'add' });
    append(editor, 'div', { 'data-bits-field': 'list' });
    append(editor, 'button', { 'data-bit-action': 'append' });
  }
  const editor = append(packed, 'div', { 'data-bit-editor': 'packed' });
  append(editor, 'textarea', { 'data-bits-field': 'area' });
  append(editor, 'select', { 'data-bits-field': 'add' });
  append(editor, 'div', { 'data-bits-field': 'list' });
  append(editor, 'button', { 'data-bit-action': 'append' });

  const lamp = new Element('button', { 'data-display-action': 'select-lamp' });
  const option = new Element('option');
  const bit = new Element('div', { 'data-bit-index': '' });
  append(bit, 'span', { 'data-bit-label': '' });
  for (const name of ['up', 'down', 'remove']) append(bit, 'button', { 'data-bit-action': name });
  for (const [name, content] of [['lamp', lamp], ['output-option', option], ['bit-order', bit]]) {
    const template = append(root, 'template', { 'data-display-template': name });
    template.content = { firstElementChild: content };
  }
  return root;
}

function harness(config = defaultDisplay(1, 2)) {
  const root = fixture();
  const applied = [];
  const outputs = Array.from({ length: 24 }, (value, index) => ({ id: `Y${index}` }));
  const ui = new OutputDisplayUI(root, value => applied.push(structuredClone(value)), () => JSON.stringify({ outputDisplay: ui.config }));
  ui.load(config, outputs);
  return {
    ui,
    root,
    applied,
    action: name => root.querySelector(`[data-display-action="${name}"]`).click(),
  };
}

function bitsDraft(ui) {
  for (const [index, key] of ['r', 'g', 'b'].entries()) {
    const channel = ui.channelControls.get(key);
    channel.kind.value = 'bits';
    channel.kind.emit('change');
    ui.bitEditors.get(key).area.value = `Y${index * 2}, Y${index * 2 + 1}`;
    ui.bitEditors.get(key).area.emit('input');
  }
}

test('static controls initialize from frozen defaults and reopening keeps the draft with one event binding', () => {
  const h = harness();
  const red = h.ui.channelControls.get('r').value;
  assert.equal(h.ui.width.value, String(APP_CONFIG.outputBoard.batch.width));
  assert.equal(h.ui.gray.checked, true);
  assert.equal(h.ui.rows.min, 1);
  assert.equal(h.ui.scale.max, 8);
  h.ui.open();
  red.value = '123';
  for (let index = 0; index < 4; index++) {
    h.action('close');
    h.ui.open();
  }
  assert.equal(h.ui.channelControls.get('r').value, red);
  assert.equal(red.value, '123');
  assert.equal(h.ui.config.pixels[0].channels.r.value, 0);
  assert.deepEqual([...h.root.listeners].map(([type, handlers]) => [type, handlers.size]), [['click', 1], ['input', 1], ['change', 1]]);
  h.action('apply-lamp');
  assert.equal(h.applied.length, 1);
  assert.equal(h.ui.config.pixels[0].channels.r.value, 123);
  assert.equal(APP_CONFIG.outputBoard.channel.value, 0);
});

test('export uses applied values and invalid brightness cannot replace a valid lamp or clear its draft', () => {
  const h = harness();
  h.ui.channelControls.get('r').value.value = '51';
  h.action('apply-lamp');
  h.ui.channelControls.get('r').value.value = '999';
  h.action('export');
  assert.equal(JSON.parse(h.ui.exportText.value).outputDisplay.pixels[0].channels.r.value, 51);
  h.action('apply-lamp');
  assert.equal(h.applied.length, 1);
  assert.equal(h.ui.config.pixels[0].channels.r.value, 51);
  assert.equal(h.ui.channelControls.get('r').value.value, '999');
  assert.match(h.ui.error.textContent, /0～255/);
});

test('lossless conversion uses current edits but only the apply button saves the converted lamp', () => {
  const h = harness();
  bitsDraft(h.ui);
  const original = structuredClone(h.ui.config);
  const draft = h.ui.readDraft();
  h.action('convert');
  assert.equal(h.applied.length, 0);
  assert.deepEqual(h.ui.config, original);
  assert.equal(h.ui.channelRegion.hidden, true);
  assert.equal(h.ui.packedRegion.hidden, false);
  assert.deepEqual(h.ui.readDraft(), convertPixel(draft, 'packed'));
  h.action('convert');
  assert.deepEqual(h.ui.readDraft(), draft);
  h.action('apply-lamp');
  assert.equal(h.applied.length, 1);
  assert.deepEqual(h.ui.config.pixels[0], draft);
});

test('failed lossless conversion retains the fixed-channel draft, mode and applied configuration', () => {
  const h = harness();
  h.ui.channelControls.get('r').value.value = '87';
  const draft = h.ui.readDraft();
  const applied = structuredClone(h.ui.config);
  h.action('convert');
  assert.equal(h.applied.length, 0);
  assert.deepEqual(h.ui.readDraft(), draft);
  assert.deepEqual(h.ui.config, applied);
  assert.equal(h.ui.mode.value, 'channels');
  assert.equal(h.ui.channelRegion.hidden, false);
  assert.match(h.ui.error.textContent, /无损打包/);
});

test('channel source and radix changes preserve static controls and validated numeric brightness', () => {
  const h = harness();
  const red = h.ui.channelControls.get('r');
  const original = { ...red };
  red.value.value = '165';
  red.radix.value = '2';
  red.radix.emit('change');
  assert.equal(red.value.value, '10100101');
  red.kind.value = 'bits';
  red.kind.emit('change');
  assert.equal(red.fixedRegion.hidden, true);
  assert.equal(red.bitsRegion.hidden, false);
  red.kind.value = 'fixed';
  red.kind.emit('change');
  assert.equal(red.value, original.value);
  assert.equal(h.ui.readDraft().channels.r.value, 165);
  red.value.value = '102';
  red.radix.value = '10';
  red.radix.emit('change');
  assert.equal(red.radix.value, '2');
  assert.equal(red.value.value, '102');
  assert.match(h.ui.error.textContent, /二进制整数/);
});

test('template bit rows reorder, append and remove within the draft; applying preserves the visible order', () => {
  const h = harness();
  bitsDraft(h.ui);
  const editor = h.ui.bitEditors.get('r');
  editor.list.children[1].querySelector('[data-bit-action="up"]').click();
  assert.equal(editor.area.value, 'Y1, Y0');
  editor.add.value = 'Y8';
  editor.box.querySelector('[data-bit-action="append"]').click();
  assert.equal(editor.area.value, 'Y1, Y0, Y8');
  editor.list.children[1].querySelector('[data-bit-action="remove"]').click();
  assert.equal(editor.area.value, 'Y1, Y8');
  assert.equal(h.applied.length, 0);
  h.action('apply-lamp');
  assert.deepEqual(h.ui.config.pixels[0].channels.r.bits, ['Y1', 'Y8']);
  assert.equal(editor.list.children[0].querySelector('[data-bit-action="up"]').disabled, true);
  assert.equal(editor.list.children.at(-1).querySelector('[data-bit-action="down"]').disabled, true);
});

test('preview values use bounded CSS variables and classes while selection loads the corresponding saved lamp', () => {
  const config = defaultDisplay(1, 2);
  config.pixels[0].channels = { r: { kind: 'fixed', value: 255 }, g: { kind: 'fixed', value: 255 }, b: { kind: 'fixed', value: 255 } };
  config.pixels[1].channels.r = { kind: 'bits', bits: ['Y0'], order: 'lsb-first', mapping: 'scale' };
  const h = harness(config);
  h.ui.open();
  assert.equal(h.ui.preview.styles.get('--lamp-columns'), '2');
  assert.equal(h.ui.previewButtons[0].styles.get('--lamp-rgb'), '255,255,255');
  assert.equal(h.ui.previewButtons[0].classList.contains('dark-label'), true);
  assert.equal(h.ui.previewButtons[1].classList.contains('not-ready'), true);
  h.ui.channelControls.get('r').value.value = '111';
  h.ui.previewButtons[1].click();
  assert.equal(h.ui.selected, 1);
  assert.equal(h.ui.channelControls.get('r').kind.value, 'bits');
  h.ui.update(new Map([['Y0', 1]]));
  assert.equal(h.ui.previewButtons[1].styles.get('--lamp-rgb'), '255,0,0');
  assert.equal(h.ui.previewButtons[1].classList.contains('not-ready'), false);
  assert.match(h.ui.readout.textContent, /十进制：1 · 亮度：255/);
  assert.equal(h.ui.config.pixels[0].channels.r.value, 255);
});

test('batch and resize retain validated display behavior while dispose removes listeners without removing static HTML', () => {
  const h = harness();
  h.ui.width.value = '1';
  h.ui.width.emit('input');
  assert.match(h.ui.required.textContent, /需要 2 个 Yi/);
  h.action('batch');
  assert.deepEqual(h.ui.config.pixels[1].channels.r.bits, ['Y1']);
  h.ui.rows.value = '2';
  h.action('resize');
  assert.equal(h.ui.config.pixels.length, 4);
  assert.deepEqual(h.ui.config.pixels[1].channels.r.bits, ['Y1']);
  h.ui.open();
  const children = [...h.root.children];
  h.ui.dispose();
  h.ui.dispose();
  assert.equal(h.root.open, false);
  assert.deepEqual(h.root.children, children);
  assert.ok([...h.root.listeners.values()].every(handlers => handlers.size === 0));
  const count = h.applied.length;
  h.action('apply-lamp');
  h.ui.open();
  assert.equal(h.applied.length, count);
  assert.equal(h.root.open, false);
});
