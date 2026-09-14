import { APP_CONFIG } from '../config.js';

/** Pure pixel-to-Xi conversion. This module never sends signals or touches the scene. */
export const IMAGE_INPUT_LIMITS = APP_CONFIG.imageInput.limits;

function fail(message) {
  throw new Error(message);
}

function integer(value, label) {
  return Number.isSafeInteger(value) ? value : fail(`${label} 必须为安全整数`);
}

function positive(value, label) {
  return integer(value, label) > 0 ? value : fail(`${label} 必须大于 0`);
}

function choice(value, choices, label) {
  return choices.includes(value) ? value : fail(`${label} 无效`);
}

function product(a, b, label) {
  return Number.isSafeInteger(a * b) ? a * b : fail(`${label} 超过安全整数范围`);
}

function channels(encoding) {
  return choice(encoding, ['rgb', 'gray'], '颜色编码') === 'rgb' ? 3 : 1;
}

export function defaultImageInputConfig() {
  const { encoding, arrangement, bitOrder, background } = APP_CONFIG.imageInput;
  return { encoding, arrangement, bitOrder, background };
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('缺少像素转换配置');
  return {
    encoding: choice(config.encoding, ['rgb', 'gray'], '颜色编码'),
    arrangement: choice(config.arrangement, ['pixel', 'channel'], '像素排列'),
    bitOrder: choice(config.bitOrder, ['lsb-first', 'msb-first'], '字节位序'),
    background: choice(config.background, ['white', 'black'], '透明底色'),
  };
}

function dimensions(width, height) {
  positive(width, '图片宽度');
  positive(height, '图片高度');
  product(width, height, '图片像素数量');
}

function selectionFields(selection) {
  if (!selection || typeof selection !== 'object') fail('缺少像素选区');
  return Object.fromEntries(
    ['x', 'y', 'width', 'height'].map(key => [key, integer(selection[key], `选区 ${key}`)]),
  );
}

export function validateSelection(selection, imageWidth, imageHeight) {
  dimensions(imageWidth, imageHeight);
  const result = selectionFields(selection);
  positive(result.width, '选区宽度');
  positive(result.height, '选区高度');
  if (
    result.x < 0 || result.y < 0 || result.width > imageWidth || result.height > imageHeight ||
    result.x > imageWidth - result.width || result.y > imageHeight - result.height
  ) {
    fail('选区必须完整位于原图内部');
  }
  return result;
}

export function clampSelection(selection, imageWidth, imageHeight) {
  dimensions(imageWidth, imageHeight);
  const result = selectionFields(selection);
  result.width = Math.max(1, Math.min(imageWidth, result.width));
  result.height = Math.max(1, Math.min(imageHeight, result.height));
  result.x = Math.max(0, Math.min(imageWidth - result.width, result.x));
  result.y = Math.max(0, Math.min(imageHeight - result.height, result.y));
  return result;
}

export function selectionBitCount(selection, encoding) {
  const count = product(
    positive(selection?.width, '选区宽度'),
    positive(selection?.height, '选区高度'),
    '选区像素数量',
  );
  return product(count, channels(encoding) * 8, '提取位数');
}

function checkLimit(bitCount) {
  if (bitCount > IMAGE_INPUT_LIMITS.outputBits) {
    fail(`单次提取最多 ${IMAGE_INPUT_LIMITS.outputBits.toLocaleString('en-US')} 位，当前需要 ${bitCount.toLocaleString('en-US')} 位`);
  }
}

function byteArray(data, length, label) {
  if (!(data instanceof Uint8ClampedArray || data instanceof Uint8Array) || data.length !== length) {
    fail(`${label} 必须为长度 ${length} 的 8 位像素数组`);
  }
}

export function extractPixelData(imageData, selection, rawConfig) {
  const config = validateConfig(rawConfig);
  const width = imageData?.width;
  const height = imageData?.height;
  dimensions(width, height);
  if (width * height > IMAGE_INPUT_LIMITS.imagePixels) {
    fail(`图片最多允许 ${IMAGE_INPUT_LIMITS.imagePixels.toLocaleString('en-US')} 个像素`);
  }
  const area = validateSelection(selection, width, height);
  const bitCount = selectionBitCount(area, config.encoding);
  checkLimit(bitCount);
  byteArray(imageData.data, width * height * 4, '原图 RGBA 数据');

  const count = area.width * area.height;
  const channelCount = channels(config.encoding);
  const rgba = new Uint8ClampedArray(count * 4);
  const bytes = new Uint8Array(bitCount / 8);
  const background = config.background === 'white' ? 255 : 0;
  for (let row = 0; row < area.height; row++) {
    for (let col = 0; col < area.width; col++) {
      const pixel = row * area.width + col;
      const source = ((area.y + row) * width + area.x + col) * 4;
      const target = pixel * 4;
      const alpha = imageData.data[source + 3];
      for (let channel = 0; channel < 3; channel++) {
        rgba[target + channel] = Math.round((imageData.data[source + channel] * alpha + background * (255 - alpha)) / 255);
      }
      if (config.encoding === 'gray') {
        const gray = Math.round((299 * rgba[target] + 587 * rgba[target + 1] + 114 * rgba[target + 2]) / 1000);
        rgba[target] = rgba[target + 1] = rgba[target + 2] = gray;
        bytes[pixel] = gray;
      } else {
        for (let channel = 0; channel < channelCount; channel++) {
          const byteIndex = config.arrangement === 'channel' ? channel * count + pixel : pixel * channelCount + channel;
          bytes[byteIndex] = rgba[target + channel];
        }
      }
      rgba[target + 3] = 255;
    }
  }
  return { width: area.width, height: area.height, rgba, bytes, bitCount };
}

export function mapPixelData(pixels, rawConfig, inputIds) {
  const config = validateConfig(rawConfig);
  const bitCount = selectionBitCount(pixels, config.encoding);
  checkLimit(bitCount);
  if (pixels.bitCount !== bitCount) fail('像素数据位数与当前配置不一致，请重新提取');
  byteArray(pixels.bytes, bitCount / 8, '已提取像素数据');
  if (!Array.isArray(inputIds)) fail('当前模型 Xi 列表无效');
  if (inputIds.length !== bitCount) {
    const difference = bitCount - inputIds.length;
    fail(`需要 ${bitCount} 位，当前模型有 ${inputIds.length} 个 Xi，${difference > 0 ? '超出' : '不足'} ${Math.abs(difference)} 位；必须恰好匹配`);
  }

  const seen = new Set();
  const ids = inputIds.map(id => {
    if (typeof id !== 'string' || !/^X(0|[1-9]\d*)$/.test(id)) fail(`无效 Xi：${String(id)}`);
    if (seen.has(id)) fail(`Xi 重复：${id}`);
    seen.add(id);
    return { id, index: BigInt(id.slice(1)) };
  }).sort((a, b) => a.index < b.index ? -1 : a.index > b.index ? 1 : 0);
  const values = {};
  for (let i = 0; i < ids.length; i++) {
    const shift = config.bitOrder === 'lsb-first' ? i % 8 : 7 - i % 8;
    values[ids[i].id] = (pixels.bytes[Math.floor(i / 8)] >> shift) & 1;
  }
  const preview = Object.fromEntries(Object.entries(values).slice(0, IMAGE_INPUT_LIMITS.previewEntries));
  return {
    values,
    json: JSON.stringify(values, null, 2),
    previewJson: JSON.stringify(preview, null, 2),
    omittedCount: Math.max(0, ids.length - IMAGE_INPUT_LIMITS.previewEntries),
    bitCount,
  };
}
