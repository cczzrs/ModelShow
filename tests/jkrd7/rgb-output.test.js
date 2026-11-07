import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultDisplay, validateDisplay, fixed, parseBrightness, evaluateChannel,
  evaluatePixel, convertPixel, batchDisplay, resizeDisplay, DisplayState,
} from '../../src/ui/rgb-output-display.js';
import { defaultDisplay as sceneDefaultDisplay, DisplayState as SceneDisplayState } from '../../src/scene/display-state.js';

const path = index => `G1.G${Math.floor(index / 5) + 1}.Q${index % 5 + 1}`;
const outputs = Array.from({ length: 216 }, (_, index) => ({ id: path(index), source: path(index) }));
const channel = (bits, order = 'lsb-first', mapping = 'scale') => ({ kind: 'bits', bits, order, mapping });

function packedDisplay() {
  const config = defaultDisplay(1, 1);
  config.enabled = true;
  config.pixels[0] = {
    mode: 'packed', bits: outputs.slice(0, 6).map(output => output.id),
    widths: { r: 2, g: 2, b: 2 }, order: 'lsb-first', mapping: 'scale',
  };
  return config;
}

test('RGB fixed channels retain decimal/binary brightness and reject invalid levels', () => {
  const config = defaultDisplay(1, 1);
  config.pixels[0].channels = { r: fixed(255), g: fixed(127), b: fixed(0) };
  assert.equal(parseBrightness('0b11111111', 2), 255);
  assert.equal(parseBrightness('127'), 127);
  for (const invalid of ['-1', '256', '1.5']) assert.throws(() => parseBrightness(invalid));
  assert.deepEqual(Object.values(evaluatePixel(validateDisplay(config).pixels[0], new Map())).map(value => value.brightness), [255, 127, 0]);
});

test('RGB references require JKRD7 absolute JKI paths, retain duplicates, and isolate validated copies', () => {
  const config = defaultDisplay(1, 1);
  config.pixels[0].channels.r = channel([path(0), path(0)]);
  const validated = validateDisplay(config);
  assert.deepEqual(validated.pixels[0].channels.r.bits, [path(0), path(0)]);
  validated.pixels[0].channels.r.bits[0] = path(1);
  assert.equal(config.pixels[0].channels.r.bits[0], path(0));
  for (const invalid of ['Y0', 'X1', 'Q1', 'G1', 'G01.Q1', 'G1.Q0', 'observe:G1.Q1']) {
    const next = structuredClone(config);
    next.pixels[0].channels.r.bits = [invalid];
    assert.throws(() => validateDisplay(next), /无效/);
  }
});

test('bit order, rounded scaling, clipping and missing observations match the RGB readout', () => {
  const bits = outputs.slice(0, 3).map(output => output.id);
  const values = new Map(bits.map((id, index) => [id, index === 0 ? 1 : 0]));
  assert.equal(evaluateChannel(channel(bits), values).brightness, 36);
  assert.equal(evaluateChannel(channel(bits, 'msb-first'), values).brightness, 146);
  const repeated = Array(16).fill(bits[0]);
  assert.equal(evaluateChannel(channel(repeated, 'msb-first', 'direct'), values).brightness, 255);
  values.delete(bits[1]);
  const waiting = evaluateChannel(channel(bits), values);
  assert.equal(waiting.ready, false);
  assert.equal(waiting.bits, '1?0');
  assert.equal(waiting.brightness, 0);
  assert.deepEqual(waiting.missing, [`${bits[1]}（尚未输出）`]);
});

test('packed RGB channels and lossless conversion preserve the complete selected bit order', () => {
  const config = packedDisplay(), pixel = config.pixels[0];
  const values = new Map(pixel.bits.map((id, index) => [id, [1, 0, 0, 1, 1, 1][index]]));
  assert.deepEqual(Object.values(evaluatePixel(pixel, values)).map(value => value.brightness), [85, 170, 255]);
  const separated = convertPixel(pixel, 'channels');
  assert.deepEqual(convertPixel(separated, 'packed'), pixel);
  assert.deepEqual(evaluatePixel(separated, values), evaluatePixel(pixel, values));
  const invalid = structuredClone(config); invalid.pixels[0].widths.r = 3;
  assert.throws(() => validateDisplay(invalid), /位数之和/);
  assert.throws(() => convertPixel(defaultDisplay(1, 1).pixels[0], 'packed'), /无损打包/);
});

test('RGB batch binding consumes ordered observations once and rejects underfilled mappings atomically', () => {
  const config = defaultDisplay(), original = structuredClone(config);
  const next = batchDisplay(config, { start: outputs[0].id, width: 8, gray: false }, outputs);
  assert.deepEqual(next.pixels.flatMap(pixel => Object.values(pixel.channels).flatMap(value => value.bits)), outputs.map(output => output.id));
  assert.throws(() => batchDisplay(config, { start: outputs[1].id, width: 8, gray: false }, outputs), /不会重复填充/);
  assert.deepEqual(config, original);
  const wider = resizeDisplay(next, 3, 4);
  assert.deepEqual(wider.pixels[4], next.pixels[3]);
  assert.deepEqual(next.pixels[0], wider.pixels[0]);
  wider.pixels[0].channels.r.bits.reverse();
  assert.deepEqual(next.pixels[0].channels.r.bits, outputs.slice(0, 8).map(output => output.id));
});

test('RGB state refresh changes only dependent lamps and rejects invalid reconfiguration before replacing state', () => {
  const config = batchDisplay(defaultDisplay(1, 2), { start: outputs[0].id, width: 1, gray: true }, outputs);
  const state = new DisplayState(config, outputs);
  const values = new Map([[outputs[0].id, 0], [outputs[1].id, 1]]);
  assert.deepEqual(state.update(values), [0, 1]);
  assert.deepEqual(state.update(values), []);
  values.set(outputs[0].id, 1);
  assert.deepEqual(state.update(values), [0]);
  const before = structuredClone(state.config);
  assert.throws(() => state.configure({ ...config, scale: -1 }, outputs));
  assert.deepEqual(state.config, before);
  assert.equal(state.results[1].b.brightness, 255);
});

test('scene projection supports packed RGB with drawing endpoint IDs while preserving JKM default-off behavior', () => {
  assert.equal(sceneDefaultDisplay().enabled, false);
  const config = packedDisplay();
  config.pixels[0].bits = config.pixels[0].bits.map(id => `observe:${id}`);
  const state = new SceneDisplayState(config);
  const values = new Map(config.pixels[0].bits.map((id, index) => [id, [1, 0, 0, 1, 1, 1][index]]));
  assert.deepEqual(state.update(values), [0]);
  assert.deepEqual(Object.values(state.results[0]).map(value => value.brightness), [85, 170, 255]);
  config.pixels[0].widths.r = 60;
  assert.equal(state.config.pixels[0].widths.r, 2);
  values.delete(state.config.pixels[0].bits[0]);
  assert.deepEqual(state.update(values), [0]);
  assert.equal(state.results[0].r.ready, false);
  assert.equal(state.results[0].g.brightness, 170);
});
