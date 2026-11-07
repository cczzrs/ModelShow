import { APP_CONFIG } from '../../html/config.js';

/** Drawing state only. Scene endpoint IDs may be prefixed; they are never JKM references. */
export const CHANNELS = Object.freeze(['r', 'g', 'b']);
const defaults = APP_CONFIG.scene.outputBoard;

export function defaultDisplay() {
  return {
    enabled: defaults.enabled, rows: defaults.rows, cols: defaults.cols, scale: defaults.scale,
    pixels: Array.from({ length: defaults.rows * defaults.cols }, () => ({
      channels: Object.fromEntries(CHANNELS.map(key => [key, { kind: 'fixed', value: 0 }])),
    })),
  };
}

function channelsOf(pixel) {
  if (pixel.mode !== 'packed') return pixel.channels;
  let offset = 0;
  return Object.fromEntries(CHANNELS.map(key => {
    const bits = pixel.bits.slice(offset, offset += pixel.widths[key]);
    return [key, { kind: 'bits', bits, order: pixel.order, mapping: pixel.mapping }];
  }));
}

export function displayConnections(config) {
  return config.pixels.flatMap((pixel, index) => CHANNELS.flatMap(key => {
    const channel = channelsOf(pixel)[key];
    return channel.kind === 'bits' ? [...new Set(channel.bits)].map(source => ({ source, index, channel: key })) : [];
  }));
}

function brightness(channel, values) {
  if (channel.kind === 'fixed') return { ready: true, bits: null, value: String(channel.value), brightness: channel.value, missing: [] };
  const bits = channel.bits.map(path => values.get(path));
  const missing = channel.bits.filter((_, index) => bits[index] !== 0 && bits[index] !== 1);
  if (!bits.length || missing.length) {
    return { ready: false, bits: bits.map(bit => bit === 0 || bit === 1 ? bit : '?').join(''), value: null, brightness: 0, missing };
  }
  const significant = channel.order === 'msb-first' ? bits : [...bits].reverse();
  const value = BigInt(`0b${significant.join('')}`), limit = BigInt(defaults.brightnessMax);
  const max = (1n << BigInt(bits.length)) - 1n;
  return { ready: true, bits: bits.join(''), value: String(value), brightness: Number(channel.mapping === 'direct' ? (value > limit ? limit : value) : (value * limit + max / 2n) / max), missing: [] };
}

export class DisplayState {
  constructor(config) { this.configure(config); }
  configure(config) {
    this.config = structuredClone(config); this.values = new Map(); this.results = []; this.initial = true;
    this.dependents = new Map();
    for (const edge of displayConnections(config)) {
      if (!this.dependents.has(edge.source)) this.dependents.set(edge.source, new Set());
      this.dependents.get(edge.source).add(edge.index);
    }
  }
  update(values) {
    const dirty = new Set(this.initial ? this.config.pixels.map((_, index) => index) : []);
    for (const [path, indices] of this.dependents) {
      if (this.values.get(path) !== values.get(path) || this.values.has(path) !== values.has(path)) {
        for (const index of indices) dirty.add(index);
      }
    }
    this.initial = false; this.values = new Map(values);
    for (const index of dirty) {
      const channels = channelsOf(this.config.pixels[index]);
      this.results[index] = Object.fromEntries(CHANNELS.map(key => [key, brightness(channels[key], values)]));
    }
    return [...dirty];
  }
}
