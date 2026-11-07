import { APP_CONFIG } from '../../html/config.js';
import { compileModel } from './model-schema.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = message => { throw new Error(message); };

/** RGB input/output bindings are workspace data, never extra JKM fields. */
export function validateRGBBindings(raw, model) {
  const compiled = model?.jki instanceof Map ? model : compileModel(model);
  if (!keysAre(raw, ['inputs', 'observe']) || !keysAre(raw.observe, ['watch', 'read'])) {
    fail('RGB 绑定必须包含 inputs 与 observe（watch、read）');
  }
  if (!Array.isArray(raw.inputs) || raw.inputs.length > APP_CONFIG.rgb.imageInput.limits.outputBits) {
    fail('RGB inputs 必须是允许容量内的输入对数组');
  }
  const entrances = new Set(compiled.inputs), used = new Set();
  const inputs = Array.from(raw.inputs, (pair, index) => {
    if (!Array.isArray(pair) || pair.length !== 2 || !entrances.has(pair[0]) || !entrances.has(pair[1])) {
      fail(`inputs[${index}] 必须按 [置0入口, 置1入口] 填写两个合法绝对路径`);
    }
    if (pair[0] === pair[1] || pair.some(path => used.has(path))) fail(`inputs[${index}] 的独热入口与其他位重复`);
    pair.forEach(path => used.add(path));
    return [...pair];
  });
  const observe = Object.fromEntries(['watch', 'read'].map(key => {
    if (!Array.isArray(raw.observe[key])) fail(`observe.${key} 必须是路径数组`);
    return [key, Array.from(raw.observe[key], path => {
      if (typeof path !== 'string' || !compiled.jki.has(path)) fail(`observe.${key} 包含无效 JKI 绝对路径：${String(path)}`);
      return path;
    })];
  }));
  return { inputs, observe };
}

/** Validate the whole frame before the caller injects any notification. */
export function bitBatchToPaths(bits, bindings, model) {
  const checked = validateRGBBindings(bindings, model);
  if (!Array.isArray(bits) || bits.length !== checked.inputs.length) {
    fail(`输入必须是恰好 ${checked.inputs.length} 位的完整数组`);
  }
  return Array.from(bits, (bit, index) => {
    if (bit !== 0 && bit !== 1) fail(`输入第 ${index} 位必须为整数 0 或 1`);
    return checked.inputs[index][bit];
  });
}

/** Compose the approved M_REG pattern; a normal all-node observes complete frames. */
export function createRGBWorkspace() {
  const { rows, cols } = APP_CONFIG.rgb.outputBoard;
  const bitCount = rows * cols * 3 * 8;
  const inputs = [], read = [], groups = [];
  for (let index = 0; index < bitCount; index += 1) {
    const id = `G${index + 1}`, path = `G1.${id}`;
    const pro = tag => ({ jksid: path, tag: [tag] });
    groups.push({
      id,
      members: [
        { id: 'Q1', q: 1, trigger: { any: [] }, pro: pro('set0') },
        { id: 'Q2', q: 1, trigger: { any: [] }, pro: pro('set1') },
        { id: 'Q3', q: 0, trigger: { any: ['Q1'] }, sources: { seed: 0, s: ['Q4'], ex: ['K'] }, pro: pro(`b${index}.equal`) },
        { id: 'Q4', q: 0, trigger: { any: ['Q2'] }, sources: { seed: 1, s: ['Q3'], ex: ['K'] }, pro: pro(`b${index}.opposite`) },
        { id: 'Q5', q: 0, trigger: { any: ['Q3', 'Q4'] }, sources: { seed: 0, s: ['Q3', 'Q4'], ex: ['K', 'K'] }, pro: pro(`b${index}`) },
      ],
      trigger: { transaction_any: ['Q1', 'Q2'] }, queue: 'work',
      pro: { tag: [`RGB.bit.${index}`] }, runtime: {},
    });
    inputs.push([`${path}.Q1`, `${path}.Q2`]);
    read.push(`${path}.Q5`);
  }
  const model = {
    jkm: APP_CONFIG.rgb.modelName, version: APP_CONFIG.model.version, queues: ['work'],
    roots: [{
      id: 'G1', members: [
        { id: 'Q1', q: 1, trigger: { all: [...read] }, pro: { jksid: 'G1', tag: ['frame', 'done'] }, runtime: { trigger_all: Array(bitCount).fill(null) } },
        ...groups,
      ], trigger: {}, queue: 'work', pro: { tag: ['RGB'] }, runtime: {},
    }],
  };
  const bindings = { inputs, observe: { watch: ['G1.Q1'], read } };
  return { model, bindings };
}
