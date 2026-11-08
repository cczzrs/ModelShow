import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_CONFIG } from '../../html/config.js';
import { defaultDisplay, emptyPixel, validateDisplay } from '../../src/ui/rgb-output-display.js';
import { channelEditorValues, defaultLampIndex, RGBOutputDisplayUI } from '../../src/ui/rgb-output-ui.js';
import { importedSelection, importedImageView, fittedImageView, zoomedImageView, wheelImageScale } from '../../src/ui/rgb-image-view.js';
import { ImageInputUI } from '../../src/ui/rgb-image-ui.js';

const outputDefaults = () => structuredClone(APP_CONFIG.rgb.outputBoard);
const imageDefaults = () => structuredClone(APP_CONFIG.rgb.imageInput);

test('RGB defaults honor fixed values, bit sources and packed mode without inventing observations', () => {
  const defaults = outputDefaults();
  defaults.channel.value = 37;
  assert.deepEqual(emptyPixel(defaults), { mode: 'channels', channels: {
    r: { kind: 'fixed', value: 37 }, g: { kind: 'fixed', value: 37 }, b: { kind: 'fixed', value: 37 },
  } });
  Object.assign(defaults.channel, { kind: 'bits', bits: ['G1.Q2', 'G1.Q3'], order: 'msb-first', mapping: 'direct' });
  const channels = defaultDisplay(1, 2, defaults);
  assert.deepEqual(validateDisplay(channels), channels);
  assert.deepEqual(channels.pixels[0].channels.r, { kind: 'bits', bits: ['G1.Q2', 'G1.Q3'], order: 'msb-first', mapping: 'direct' });
  channels.pixels[0].channels.r.bits[0] = 'G1.Q4';
  assert.equal(channels.pixels[1].channels.r.bits[0], 'G1.Q2');
  assert.equal(defaults.channel.bits[0], 'G1.Q2');
  defaults.pixel.mode = 'packed';
  Object.assign(defaults.packed, { bits: ['G1.Q1', 'G1.Q2', 'G1.Q3'], widths: { r: 1, g: 1, b: 1 }, order: 'msb-first', mapping: 'direct' });
  assert.deepEqual(emptyPixel(defaults), { mode: 'packed', ...defaults.packed });
  defaults.packed.bits = [];
  assert.throws(() => emptyPixel(defaults), /观察位/);
  defaults.pixel.mode = 'channels'; defaults.channel.bits = [];
  assert.throws(() => emptyPixel(defaults), /观察位/);
});

test('RGB channel editor defaults are independent from batch defaults and format the configured radix', () => {
  const defaults = { ...APP_CONFIG.rgb.outputBoard.channel, radix: 2, value: 5, bits: ['G1.Q3'], order: 'msb-first', mapping: 'direct' };
  assert.deepEqual(channelEditorValues({ kind: 'fixed', value: 13 }, defaults), {
    kind: 'fixed', radix: 2, value: '1101', bits: ['G1.Q3'], order: 'msb-first', mapping: 'direct',
  });
  assert.deepEqual(channelEditorValues({ kind: 'bits', bits: ['G1.Q4'], order: 'lsb-first', mapping: 'scale' }, defaults), {
    kind: 'bits', radix: 2, value: '101', bits: ['G1.Q4'], order: 'lsb-first', mapping: 'scale',
  });
  assert.equal(defaultLampIndex(9, { selectedIndex: 4 }), 4);
  assert.equal(defaultLampIndex(2, { selectedIndex: 4 }), 1);
  const instance = { resetDraft() {}, render() {}, error: {} };
  RGBOutputDisplayUI.prototype.load.call(instance, defaultDisplay(1, 2), []);
  assert.equal(instance.selected, Math.min(APP_CONFIG.rgb.outputBoard.editor.selectedIndex, 1));
});

test('image import honors configured coordinates and exposes explicit center/retain policies', () => {
  const config = imageDefaults(), current = { x: 8, y: 5, width: 5, height: 4 };
  config.selection = { x: 2, y: 3, width: 6, height: 2 };
  assert.deepEqual(importedSelection(current, 20, 10, config), config.selection);
  config.import.selection = 'retain';
  assert.deepEqual(importedSelection(current, 20, 10, config), current);
  config.import.selection = 'center';
  assert.deepEqual(importedSelection(current, 20, 10, config), { x: 7, y: 3, width: 5, height: 4 });
  config.import.selection = 'configured';
  assert.deepEqual(importedSelection(current, 4, 3, config), { x: 0, y: 1, width: 4, height: 2 });
  assert.deepEqual(config.selection, { x: 2, y: 3, width: 6, height: 2 });
});

test('image view defaults honor configured placement, fit padding, scale limits and wheel sensitivity', () => {
  const config = imageDefaults(), view = { width: 200, height: 100, scale: 1, x: 0, y: 0 }, source = { width: 20, height: 10 };
  Object.assign(config.view, { fitPadding: 40, minScaleDivisor: 4, maxScale: 10, scale: 2, x: 7, y: 9 });
  assert.deepEqual(importedImageView(view, source, config), { ...view, scale: 6, x: 40, y: 20 });
  config.import.view = 'configured';
  assert.deepEqual(importedImageView(view, source, config), { ...view, scale: 2, x: 7, y: 9 });
  const zoomed = zoomedImageView(view, source, 0.01, 50, 25, config.view);
  assert.deepEqual(zoomed, { ...view, scale: 0.25, x: 37.5, y: 18.75 });
  assert.equal(zoomedImageView(view, source, 100, 0, 0, config.view).scale, 10);
  assert.equal(wheelImageScale(view, 1, 1, { linePixels: 10, sensitivity: 0.01 }), Math.exp(-0.1));
  assert.equal(wheelImageScale(view, 1, 2, { linePixels: 10, sensitivity: 0.01 }), Math.exp(-1));
  assert.deepEqual(view, { width: 200, height: 100, scale: 1, x: 0, y: 0 });
  const instance = { source, view: { ...view }, draw() {} };
  ImageInputUI.prototype.fit.call(instance);
  assert.deepEqual(instance.view, fittedImageView(view, source));
  ImageInputUI.prototype.zoom.call(instance, 2, 30, 20);
  assert.deepEqual(instance.view, zoomedImageView(fittedImageView(view, source), source, 2, 30, 20));
});
