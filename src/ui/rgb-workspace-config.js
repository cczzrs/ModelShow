import { compileModel } from '../jk/model-schema.js';
import { validateRGBBindings } from '../jk/rgb-workspace.js';
import { CHANNELS, validateDisplay, displayConnections } from './rgb-output-display.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const compile = model => model?.jki instanceof Map ? model : compileModel(model);

function exactFields(value, fields, label) {
  if (!object(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) {
    throw new Error(`${label} 必须恰好包含 ${fields.join('、')}`);
  }
}

function displayFields(display) {
  exactFields(display, ['version', 'enabled', 'rows', 'cols', 'scale', 'pixels'], 'RGB display');
  if (!Array.isArray(display.pixels)) throw new Error('RGB display.pixels 必须是数组');
  for (const [index, pixel] of display.pixels.entries()) {
    const label = `RGB display.pixels[${index}]`;
    if (pixel?.mode === 'channels') {
      exactFields(pixel, ['mode', 'channels'], label);
      exactFields(pixel.channels, CHANNELS, `${label}.channels`);
      for (const key of CHANNELS) {
        const channel = pixel.channels[key];
        exactFields(channel, channel?.kind === 'fixed' ? ['kind', 'value'] : ['kind', 'bits', 'order', 'mapping'], `${label}.channels.${key}`);
      }
    } else {
      exactFields(pixel, ['mode', 'bits', 'widths', 'order', 'mapping'], label);
      exactFields(pixel.widths, CHANNELS, `${label}.widths`);
    }
  }
}

/** Separate UI settings file. Validation never updates JKM, bindings or live state. */
export function validateRGBConfig(raw, model) {
  const compiled = compile(model);
  exactFields(raw, ['rgb', 'model', 'bindings', 'display'], 'RGB 工作区配置');
  if (raw.rgb !== 1) throw new Error('不支持的 RGB 工作区配置版本');
  if (typeof raw.model !== 'string' || raw.model !== compiled.name) {
    throw new Error('RGB 配置的 model 必须与当前 JKM 名称一致');
  }
  const bindings = validateRGBBindings(raw.bindings, compiled);
  displayFields(raw.display);
  const display = validateDisplay(raw.display);
  const read = new Set(bindings.observe.read);
  for (const { source } of displayConnections(display)) {
    if (!read.has(source)) throw new Error(`画板引用 ${source} 不在 bindings.observe.read 中`);
  }
  return { rgb: 1, model: compiled.name, bindings, display };
}

export function captureRGBConfig(model, bindings, display) {
  const compiled = compile(model);
  return validateRGBConfig({ rgb: 1, model: compiled.name, bindings, display }, compiled);
}
