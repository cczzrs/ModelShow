import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_CONFIG } from '../../html/config.js';
import { modelDefaults } from '../../src/ui/model-defaults.js';
import { compileModel } from '../../src/jk/model-schema.js';
import { JKEngine } from '../../src/jk/engine.js';

const pool = JSON.parse(readFileSync(new URL('../../html/example.json', import.meta.url)));
const example = name => compileModel(pool.permanent.find(entry => entry.model.jkm === name).model);

test('changing the startup example uses its own path and legal input/observation defaults', () => {
  const config = structuredClone(APP_CONFIG.model);
  config.example = 'M_FLOW';
  const model = example(config.example), settings = modelDefaults(model, { builtin: true, config });
  assert.equal(settings.path, 'examples/M_FLOW.jkm.json');
  assert.deepEqual(settings.observe, { watch: [], read: [] });
  const engine = new JKEngine(model, { observe: settings.observe });
  assert.equal(engine.injectBatch(settings.input), settings.input.length);
  assert.equal(settings.input.every(path => model.inputs.includes(path)), true);
  const ascii = modelDefaults(example('ASCII_DIGITS'), { builtin: true, config });
  assert.deepEqual(ascii.observe, APP_CONFIG.model.presets.ASCII_DIGITS.observe);
  assert.deepEqual(ascii.input, APP_CONFIG.model.presets.ASCII_DIGITS.input);
});

test('fallback input range and model-specific overrides read config and never mutate the tree', () => {
  const config = structuredClone(APP_CONFIG.model), model = example('M_FLOW');
  config.defaults.input = { startIndex: 1, count: 2 };
  const fallback = modelDefaults(model, { config });
  assert.deepEqual(fallback.input, model.inputs.slice(1, 3));
  config.presets.M_FLOW = { path: 'custom/flow.jkm.json', input: [model.inputs[2]], observe: { watch: [model.inputs[2]], read: [model.inputs[0]] } };
  const before = structuredClone(config), custom = modelDefaults(model, { builtin: true, config });
  assert.equal(custom.path, 'custom/flow.jkm.json');
  assert.deepEqual(custom.input, [model.inputs[2]]);
  const engine = new JKEngine(model, { observe: custom.observe });
  assert.equal(engine.injectBatch(custom.input), 1);
  custom.input.push('G999.Q1'); custom.observe.read.length = 0;
  assert.deepEqual(config, before);
  assert.deepEqual(modelDefaults(model, { config }).input, fallback.input);
});
