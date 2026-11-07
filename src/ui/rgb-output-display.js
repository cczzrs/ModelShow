import { APP_CONFIG } from '../../html/config.js';
import { JKI_PATH } from '../jk/node-id.js';

/** Output-only projection. Never publishes events or changes the JK engine. */
export const CHANNELS = Object.freeze(['r', 'g', 'b']);
const DEFAULTS = APP_CONFIG.rgb.outputBoard;

function fail(message) {
  throw new Error(message);
}

function integer(value, min, max, label) {
  if (Number.isInteger(value) && value >= min && value <= max) return value;
  return fail(`${label} 必须为 ${min}～${max} 的整数`);
}

function choice(value, values, label) {
  return values.includes(value) ? value : fail(`${label} 无效`);
}

export const fixed = value => ({ kind: 'fixed', value });

export function emptyPixel() {
  return {
    mode: 'channels',
    channels: {
      r: fixed(DEFAULTS.channel.value),
      g: fixed(DEFAULTS.channel.value),
      b: fixed(DEFAULTS.channel.value),
    },
  };
}

export function defaultDisplay(rows = DEFAULTS.rows, cols = DEFAULTS.cols) {
  const limits = DEFAULTS.limits.dimension;
  integer(rows, limits.min, limits.max, '行数');
  integer(cols, limits.min, limits.max, '列数');
  return {
    version: DEFAULTS.version,
    enabled: DEFAULTS.enabled,
    rows,
    cols,
    scale: DEFAULTS.scale,
    pixels: Array.from({ length: rows * cols }, emptyPixel),
  };
}

function bitList(bits, max = DEFAULTS.limits.channelBits.max) {
  if (!Array.isArray(bits) || bits.length < 1 || bits.length > max) {
    fail(`观察位 列表需要 1～${max} 位`);
  }
  return bits.map(id => typeof id === 'string' && JKI_PATH.test(id)
    ? id
    : fail(`无效 观察位：${String(id)}`));
}

const order = value => choice(value, ['lsb-first', 'msb-first'], '位序');
const mapping = value => choice(value, ['scale', 'direct'], '亮度换算');

function channel(config) {
  if (!config || typeof config !== 'object') fail('缺少通道配置');
  if (config.kind === 'fixed') {
    const limits = DEFAULTS.limits.brightness;
    return fixed(integer(config.value, limits.min, limits.max, '固定亮度'));
  }
  if (config.kind !== 'bits') fail('通道来源无效');
  return {
    kind: 'bits',
    bits: bitList(config.bits),
    order: order(config.order),
    mapping: mapping(config.mapping),
  };
}

export function validateDisplay(raw) {
  if (!raw || raw.version !== 1) fail('不支持的画板配置版本');
  if (typeof raw.enabled !== 'boolean') fail('显示开关必须为布尔值');
  const limits = DEFAULTS.limits;
  const rows = integer(raw.rows, limits.dimension.min, limits.dimension.max, '行数');
  const cols = integer(raw.cols, limits.dimension.min, limits.dimension.max, '列数');
  const scale = raw.scale;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < limits.scale.min || scale > limits.scale.max) {
    fail(`画板大小必须为 ${limits.scale.min}～${limits.scale.max} 倍`);
  }
  if (!Array.isArray(raw.pixels) || raw.pixels.length !== rows * cols) {
    fail('灯数量必须等于行数 × 列数');
  }
  const pixels = raw.pixels.map((pixel, index) => {
    try {
      if (pixel?.mode === 'channels') {
        return {
          mode: 'channels',
          channels: Object.fromEntries(CHANNELS.map(key => [key, channel(pixel.channels?.[key] ?? fixed(DEFAULTS.channel.value))])),
        };
      }
      if (pixel?.mode !== 'packed') fail('灯配置模式无效');
      const widths = Object.fromEntries(CHANNELS.map(key => [
        key,
        integer(pixel.widths?.[key], limits.channelBits.min, limits.channelBits.max, `${key.toUpperCase()} 位数`),
      ]));
      const bits = bitList(pixel.bits, limits.channelBits.max * CHANNELS.length);
      if (bits.length !== Object.values(widths).reduce((total, width) => total + width, 0)) {
        fail('打包 观察位 数量必须等于 R/G/B 位数之和');
      }
      return { mode: 'packed', bits, widths, order: order(pixel.order), mapping: mapping(pixel.mapping) };
    } catch (error) {
      fail(`灯 ${index + 1}：${error.message}`);
    }
  });
  return { version: 1, enabled: raw.enabled, rows, cols, scale, pixels };
}

export function loadDisplay(raw) {
  try {
    return { config: raw === undefined ? defaultDisplay() : validateDisplay(raw), error: null };
  } catch (error) {
    return { config: defaultDisplay(), error: `输出渲染配置无效，画板已禁用：${error.message}` };
  }
}

export function channelsOf(pixel) {
  if (pixel.mode === 'channels') return pixel.channels;
  let offset = 0;
  return Object.fromEntries(CHANNELS.map(key => {
    const bits = pixel.bits.slice(offset, offset += pixel.widths[key]);
    return [key, { kind: 'bits', bits, order: pixel.order, mapping: pixel.mapping }];
  }));
}

export function convertPixel(pixel, mode) {
  if (pixel.mode === mode) return structuredClone(pixel);
  const channels = channelsOf(pixel);
  if (mode === 'channels') return { mode, channels: structuredClone(channels) };
  const values = CHANNELS.map(key => channels[key]);
  if (values.some(config => config.kind !== 'bits') || values.some(config => config.order !== values[0].order || config.mapping !== values[0].mapping)) {
    fail('无损打包需要三个通道均使用 观察位，且位序和亮度换算相同；可先编辑通道再转换');
  }
  return {
    mode: 'packed',
    bits: values.flatMap(config => config.bits),
    widths: Object.fromEntries(CHANNELS.map(key => [key, channels[key].bits.length])),
    order: values[0].order,
    mapping: values[0].mapping,
  };
}

export function parseBrightness(text, radix = DEFAULTS.channel.radix) {
  const input = String(text).trim();
  if (radix === 2 ? !/^(?:0b)?[01]+$/i.test(input) : !/^\d+$/.test(input)) {
    fail(radix === 2 ? '请输入二进制整数' : '请输入十进制整数');
  }
  const value = BigInt(radix === 2 ? '0b' + input.replace(/^0b/i, '') : input);
  if (value > BigInt(DEFAULTS.limits.brightness.max)) {
    fail(`固定亮度必须为 ${DEFAULTS.limits.brightness.min}～${DEFAULTS.limits.brightness.max}`);
  }
  return Number(value);
}

export function evaluateChannel(config, values, errors = new Map()) {
  if (config.kind === 'fixed') {
    return { ready: true, bits: null, value: String(config.value), brightness: config.value, missing: [] };
  }
  const missing = config.bits.filter(id => errors.has(id) || !values.has(id) || ![0, 1].includes(values.get(id)));
  if (missing.length) {
    return {
      ready: false,
      bits: config.bits.map(id => [0, 1].includes(values.get(id)) && !errors.has(id) ? values.get(id) : '?').join(''),
      value: null,
      brightness: 0,
      missing: [...new Set(missing)].map(id => `${id}（${errors.get(id) ?? (values.has(id) ? '未输出' : '尚未输出')}）`),
    };
  }
  const bits = config.bits.map(id => values.get(id));
  const significant = config.order === 'lsb-first' ? [...bits].reverse() : bits;
  const value = BigInt('0b' + significant.join(''));
  const max = (1n << BigInt(bits.length)) - 1n;
  const brightnessMax = BigInt(DEFAULTS.limits.brightness.max);
  const brightness = Number(config.mapping === 'direct'
    ? (value > brightnessMax ? brightnessMax : value)
    : (value * brightnessMax + max / 2n) / max);
  return { ready: true, bits: bits.join(''), value: value.toString(), brightness, missing: [] };
}

export function evaluatePixel(pixel, values, errors) {
  const channels = channelsOf(pixel);
  return Object.fromEntries(CHANNELS.map(key => [key, evaluateChannel(channels[key], values, errors)]));
}

export function resizeDisplay(config, rows, cols) {
  config = validateDisplay(config);
  const next = defaultDisplay(rows, cols);
  next.enabled = config.enabled;
  next.scale = config.scale;
  for (let row = 0; row < Math.min(rows, config.rows); row++) {
    for (let col = 0; col < Math.min(cols, config.cols); col++) {
      next.pixels[row * cols + col] = structuredClone(config.pixels[row * config.cols + col]);
    }
  }
  return next;
}

export function batchDisplay(config, {
  start,
  width = DEFAULTS.batch.width,
  order: bitOrder = DEFAULTS.batch.order,
  mapping: map = DEFAULTS.batch.mapping,
  gray = DEFAULTS.batch.gray,
}, outputs) {
  integer(width, DEFAULTS.limits.channelBits.min, DEFAULTS.limits.channelBits.max, '通道位数');
  const ids = outputs.map(output => output.id);
  const at = ids.indexOf(start);
  const required = config.rows * config.cols * width * (gray ? 1 : CHANNELS.length);
  if (at < 0 || ids.length - at < required) {
    fail(`需要 ${required} 个 观察位，从 ${start} 起只有 ${Math.max(0, ids.length - at)} 个，不会重复填充`);
  }
  const next = structuredClone(config);
  let cursor = at;
  next.pixels = next.pixels.map(() => {
    const channels = {};
    let shared;
    if (gray) {
      shared = ids.slice(cursor, cursor + width);
      cursor += width;
    }
    for (const key of CHANNELS) {
      const bits = gray ? [...shared] : ids.slice(cursor, cursor += width);
      channels[key] = { kind: 'bits', bits, order: bitOrder, mapping: map };
    }
    return { mode: 'channels', channels };
  });
  return validateDisplay(next);
}

export function displayConnections(config) {
  return config.pixels.flatMap((pixel, index) => CHANNELS.flatMap(key => {
    const channel = channelsOf(pixel)[key];
    return channel.kind === 'bits'
      ? [...new Set(channel.bits)].map(source => ({ source, index, channel: key }))
      : [];
  }));
}

export class DisplayState {
  constructor(config, outputs = []) {
    this.configure(config, outputs);
  }

  configure(config, outputs = []) {
    const validated = validateDisplay(config);
    this.config = validated;
    this.errors = new Map(outputs.filter(output => output.error).map(output => [output.id, output.error]));
    this.dependents = new Map();
    for (const edge of displayConnections(validated)) {
      if (!this.dependents.has(edge.source)) this.dependents.set(edge.source, new Set());
      this.dependents.get(edge.source).add(edge.index);
    }
    this.values = new Map();
    this.results = [];
    this.initial = true;
  }

  update(values) {
    const dirty = new Set();
    if (this.initial) {
      this.config.pixels.forEach((pixel, index) => dirty.add(index));
      this.initial = false;
    }
    for (const [id, indices] of this.dependents) {
      if (this.values.has(id) !== values.has(id) || this.values.get(id) !== values.get(id)) {
        for (const index of indices) dirty.add(index);
      }
    }
    this.values = new Map(values);
    for (const index of dirty) this.results[index] = evaluatePixel(this.config.pixels[index], values, this.errors);
    return [...dirty];
  }
}
