/** Convert already composited RGBA pixels to ordered one-hot input batches. */
export function pixelsToBatches(pixels, count, { zero, one, threshold }) {
  if (!Number.isInteger(count) || count < 1 || pixels.length < count * 4) throw new Error('像素数量无效');
  if (typeof zero !== 'string' || !zero || typeof one !== 'string' || !one || zero === one) throw new Error('需要两个不同的独热入口');
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) throw new Error('灰度阈值必须为 0–255 整数');
  return Array.from({ length: count }, (_, i) => [
    pixels[i * 4] * .2126 + pixels[i * 4 + 1] * .7152 + pixels[i * 4 + 2] * .0722 >= threshold ? one : zero,
  ]);
}
