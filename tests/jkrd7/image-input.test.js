import test from 'node:test';
import assert from 'node:assert/strict';
import { pixelsToBatches } from '../../src/ui/image-input.js';

test('image pixels become separate ordered one-hot batches, with luminance and explicit zero', () => {
  const rgba = new Uint8ClampedArray([0,0,0,255, 255,255,255,255, 255,0,0,255, 0,255,0,255]);
  assert.deepEqual(pixelsToBatches(rgba, 4, {zero:'G1.Q1',one:'G1.Q2',threshold:128}), [['G1.Q1'],['G1.Q2'],['G1.Q1'],['G1.Q2']]);
  assert.deepEqual(pixelsToBatches(rgba, 1, {zero:'G1.Q1',one:'G1.Q2',threshold:0}), [['G1.Q2']]);
  assert.throws(() => pixelsToBatches(rgba,5,{zero:'G1.Q1',one:'G1.Q2',threshold:128}));
  assert.throws(() => pixelsToBatches(rgba,1,{zero:'G1.Q1',one:'G1.Q1',threshold:128}));
});
