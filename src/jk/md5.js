/** UTF-8 MD5 for snapshot identity; this is not a security primitive. */
export function md5(text) {
  const input = new TextEncoder().encode(text);
  const bytes = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  bytes.set(input); bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer), bits = BigInt(input.length) * 8n;
  view.setUint32(bytes.length - 8, Number(bits & 0xffffffffn), true);
  view.setUint32(bytes.length - 4, Number(bits >> 32n), true);
  const shifts = [[7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21]];
  const constants = Array.from({length: 64}, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let offset = 0; offset < bytes.length; offset += 64) {
    let [a, b, c, d] = state;
    for (let i = 0; i < 64; i++) {
      const round = i >> 4;
      const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const g = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
      const sum = (a + f + constants[i] + view.getUint32(offset + g * 4, true)) | 0;
      const shift = shifts[round][i % 4], next = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
      [a, b, c, d] = [d, next, b, c];
    }
    [a, b, c, d].forEach((value, i) => { state[i] = (state[i] + value) | 0; });
  }
  return state.map(word => [0, 8, 16, 24].map(shift => ((word >>> shift) & 255).toString(16).padStart(2, '0')).join('')).join('');
}
