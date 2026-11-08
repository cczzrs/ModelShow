import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeConfiguredBackend, syncSceneControlButtons } from '../../src/ui/workspace-settings.js';

const button = () => ({ attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });

test('scene control buttons reflect configured true and false defaults before any interaction', () => {
  const controls = { labels: button(), background: button() };
  syncSceneControlButtons(controls, { nodeLabelsHidden: true, blackBackground: true });
  assert.equal(controls.labels.attributes['aria-pressed'], 'true');
  assert.equal(controls.labels.textContent, '显示名称和次数');
  assert.equal(controls.background.attributes['aria-pressed'], 'true');
  syncSceneControlButtons(controls, { nodeLabelsHidden: false, blackBackground: false });
  assert.equal(controls.labels.attributes['aria-pressed'], 'false');
  assert.equal(controls.labels.textContent, '隐藏名称和次数');
  assert.equal(controls.background.attributes['aria-pressed'], 'false');
});

test('configured WebGPU startup waits for initialization while JavaScript needs no GPU', async () => {
  let calls = 0, complete;
  const gpu = { init() { calls++; return new Promise(resolve => { complete = resolve; }); } };
  assert.equal(await initializeConfiguredBackend(gpu, 'javascript'), false);
  assert.equal(calls, 0);
  let ready = false;
  const starting = initializeConfiguredBackend(gpu, 'webgpu').then(value => { ready = value; });
  await Promise.resolve();
  assert.equal(calls, 1); assert.equal(ready, false);
  complete(true); await starting;
  assert.equal(ready, true);
});

test('GPU fallback and disposal finish startup without declaring a dead backend ready', async () => {
  assert.equal(await initializeConfiguredBackend({ init: async () => false }, 'webgpu'), false);
  let disposed = true, calls = 0, complete;
  const gpu = { init() { calls++; return new Promise(resolve => { complete = resolve; }); } };
  assert.equal(await initializeConfiguredBackend(gpu, 'webgpu', () => disposed), false);
  assert.equal(calls, 0);
  disposed = false;
  const starting = initializeConfiguredBackend(gpu, 'webgpu', () => disposed);
  disposed = true; complete(true);
  assert.equal(await starting, false);
});
