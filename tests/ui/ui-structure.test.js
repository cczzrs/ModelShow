import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_CONFIG } from '../../html/config.js';
import { defaultImageInputConfig } from '../../src/ui/image-input.js';
import { defaultDisplay, validateDisplay, resizeDisplay } from '../../src/ui/output-display.js';
import { htmlSource, staticDocument } from '../helpers/ui-harness.js';

const css = readFileSync(new URL('../../html/style.css', import.meta.url), 'utf8');
const uiFiles = ['html/main.js', 'src/ui/image-input-ui.js', 'src/ui/output-display-ui.js', 'src/ui/model-manager.js'];

test('fixed dialogs, inspector panels, RGB controls and variable templates live in HTML exactly once', () => {
  const ids = [...htmlSource.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML IDs must remain unique');
  const document = staticDocument();
  for (const id of ['image-input-dialog', 'output-display-dialog', 'import-dialog', 'model-auth-dialog']) {
    assert.equal(document.getElementById(id)?.tagName, 'dialog', id);
  }
  const inspector = document.getElementById('inspector');
  assert.deepEqual(inspector.querySelectorAll('.node-branch').map(branch => branch.querySelector('h3').textContent), [
    '状态', 'EX · 从左到右原子求值', '事件 · 触发与传播',
  ]);
  assert.deepEqual(inspector.querySelectorAll('[data-inspector-panel]').map(panel => panel.attributes.id), [
    'inspector-empty', 'inspector-input', 'inspector-output', 'inspector-jk', 'inspector-lamp',
  ]);
  const image = document.getElementById('image-input-dialog');
  for (const name of ['width', 'height', 'x', 'y', 'encoding', 'arrangement', 'bitOrder', 'background']) {
    assert.ok(image.querySelector(`[name="${name}"]`), name);
  }
  assert.equal(image.querySelectorAll('canvas').length, 2);
  const display = document.getElementById('output-display-dialog');
  assert.deepEqual(display.querySelectorAll('[data-display-channel]').map(channel => channel.dataset.displayChannel), ['r', 'g', 'b']);
  for (const channel of display.querySelectorAll('[data-display-channel]')) {
    for (const key of ['kind', 'radix', 'value', 'order', 'mapping']) {
      assert.ok(channel.querySelector(`[data-channel-field="${key}"]`), `${channel.dataset.displayChannel}: ${key}`);
    }
  }
  for (const id of ['output-row-template', 'node-button-template', 'queue-row-template', 'history-row-template', 'evaluation-step-template', 'model-option-template']) {
    assert.ok(document.getElementById(id)?.content.firstElementChild, id);
  }
  for (const name of ['lamp', 'output-option', 'bit-order']) {
    const templates = display.querySelectorAll(`[data-display-template="${name}"]`);
    assert.equal(templates.length, 1, name);
    assert.ok(templates[0].content.firstElementChild, name);
  }
  const link = document.getElementById('model-download-link');
  assert.equal(link?.tagName, 'a');
  assert.equal(link.hidden, true);
  assert.ok(!document.getElementById('display-download-link'));
  assert.equal(display.querySelectorAll('[data-display-action="export"]').length, 0);
  assert.equal(display.querySelectorAll('[data-display-info="export-panel"]').length, 0);
  assert.equal(display.querySelectorAll('[data-display-field="export-text"]').length, 0);
});

test('interface controllers clone HTML and restrict style writes to the documented dynamic variables', () => {
  const allowedVariables = new Set([
    '--queue-row-height', '--queue-total-height', '--queue-scroll-offset', '--lamp-columns', '--lamp-width', '--lamp-rgb',
  ]);
  const writtenVariables = new Set();
  for (const file of uiFiles) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/, file);
    assert.doesNotMatch(source, /(?:['"`])\s*<\/?(?:div|button|label|input|select|option|span|dialog|fieldset|canvas)\b/i, file);
    assert.doesNotMatch(source, /\b(?:const|let|function)\s+(?:el|field|button)\s*(?:=\s*(?:\([^)]*\)|\w+)\s*=>|\()/, file);
    for (const match of source.matchAll(/createElement\s*\(\s*([^)]*)\)/g)) {
      assert.match(match[1], /^['"]canvas['"]$/, `${file}: only processing canvases may be created`);
    }
    assert.doesNotMatch(source, /\.style\s*(?:\[[^\]]+\]|\.\w+)\s*=/, file);
    assert.doesNotMatch(source, /setAttribute\s*\(\s*['"]style['"]/, file);
    for (const match of source.matchAll(/\.style\.setProperty\s*\(\s*['"]([^'"]+)['"]/g)) {
      assert.ok(allowedVariables.has(match[1]), `${file}: ${match[1]}`);
      writtenVariables.add(match[1]);
      assert.ok(css.includes(`var(${match[1]}`), `${match[1]} must have its rule in CSS`);
    }
  }
  for (const name of ['--queue-row-height', '--queue-total-height', '--queue-scroll-offset', '--lamp-columns', '--lamp-rgb']) {
    assert.ok(writtenVariables.has(name), name);
  }
  assert.doesNotMatch(htmlSource, /\sstyle\s*=/i);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
});

test('the default tree is deeply frozen and preserves the agreed new-page behavior', () => {
  function inspect(value) {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) if (child && typeof child === 'object') inspect(child);
  }
  inspect(APP_CONFIG);
  assert.deepEqual(APP_CONFIG.imageInput.selection, { x: 0, y: 0, width: 3, height: 3 });
  assert.equal(APP_CONFIG.outputBoard.rows, 3);
  assert.equal(APP_CONFIG.outputBoard.cols, 3);
  assert.equal(APP_CONFIG.outputBoard.scale, 3);
  assert.equal(APP_CONFIG.outputBoard.enabled, false);
  assert.equal(APP_CONFIG.scene.layout, '5D');
  assert.equal(APP_CONFIG.playback.speed.value, 1);
  assert.equal(APP_CONFIG.playback.skipAnimation, true);
  assert.equal(APP_CONFIG.lists.queue.rowHeight, 36);
  assert.equal(APP_CONFIG.lists.history.visibleEntries, 60);
  assert.throws(() => { APP_CONFIG.outputBoard.scale = 9; }, TypeError);
});

test('runtime defaults are independent copies and missing old scale is rejected', () => {
  const first = defaultDisplay();
  const second = defaultDisplay();
  first.enabled = true;
  first.pixels[0].channels.r.value = 123;
  assert.equal(second.enabled, false);
  assert.equal(second.pixels[0].channels.r.value, 0);
  assert.equal(APP_CONFIG.outputBoard.channel.value, 0);
  const image = defaultImageInputConfig();
  image.encoding = 'gray';
  assert.equal(defaultImageInputConfig().encoding, 'rgb');
  const selection = structuredClone(APP_CONFIG.imageInput.selection);
  selection.width = 1;
  assert.equal(APP_CONFIG.imageInput.selection.width, 3);
  const legacy = defaultDisplay(1, 1);
  delete legacy.scale;
  assert.throws(() => validateDisplay(legacy));
  assert.throws(() => resizeDisplay(legacy, 2, 2));
  assert.equal(defaultDisplay().scale, 3);
  assert.equal(Object.hasOwn(legacy, 'scale'), false, 'compatibility normalization does not mutate imported data');
});
