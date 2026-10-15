/** JKRD V4.0.0. Diagnostics retain rows; public loading requires a full snapshot. */
import { APP_CONFIG } from '../../html/config.js';
import { order } from './node-id.js';
import { md5 } from './md5.js';
import { validateDisplay } from '../ui/output-display.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const qId = /^Q(?:0|[1-9]\d*)$/;
const proValues = new Set(['q=0/1', 'q=0', 'q=1', 'q=']);
const statsFields = ['input_bits', 'output_bits', 'jk_bits', 'ex_source_max', 'ex_operation_max', 'ex_source_sum', 'ex_operation_sum'];
const completeFields = ['name', 'md5', 'format', 'format_md5', 'created_at', ...statsFields, 'jk_bits_max', 'nodes', 'initial_q', 'q_y', 'inputs', 'outputs', 'FIFOS', 'display'];
const queueNames = Object.keys(APP_CONFIG.engine.queues);
export const emptyFifos = () => Object.fromEntries(queueNames.map(name => [name, []]));

export function parseExpression(ex) {
  if (typeof ex !== 'string') throw new Error('ex 必须是字符串');
  if (!ex) throw new Error('ex 不能为空');
  if (/\s/.test(ex)) throw new Error('ex 不允许空白');
  const re = /([JK])(?:([01])|\(([XQ](?:0|[1-9]\d*))\))/y, tokens = [];
  let pos = 0;
  while (pos < ex.length) {
    re.lastIndex = pos;
    const match = re.exec(ex);
    if (!match) throw new Error(`ex 第 ${pos + 1} 个字符无法解析：${ex.slice(pos, pos + 12)}`);
    tokens.push({op: match[1], constant: match[2] === undefined ? null : Number(match[2]), source: match[3] ?? null, text: match[0], index: tokens.length});
    pos = re.lastIndex;
  }
  return tokens;
}

/** Recursive lexical key ordering; arrays and string contents retain their order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function normalizedNodes(nodes) {
  return nodes.map(node => {
    const data = structuredClone(node);
    if (object(data) && data.pro === APP_CONFIG.model.defaultPro) delete data.pro;
    return data;
  });
}
function validTimestamp(value) {
  const parts = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}):(\d{1,20})$/.exec(value);
  if (!parts || parts[0] !== value) return false;
  const instant = new Date(Number(BigInt(parts[2]) / 1000000n));
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 13) === parts[1];
}
function initialState(nodes) {
  return Object.fromEntries([0, 1].map(bit => [bit, nodes.filter(node => node.initial === bit).map(node => node.id).sort(order)]));
}
export function modelFingerprints({format, nodes, initial_q, q_y, FIFOS, created_at}) {
  const payload = {format, nodes: normalizedNodes(nodes), initial_q, q_y};
  return {
    format_md5: md5(canonicalJson(payload)),
    md5: md5(canonicalJson({...payload, FIFOS, created_at})),
  };
}

export function compileModel(raw, {verifyMetadata = true} = {}) {
  if (!object(raw) || !Array.isArray(raw.nodes) || !object(raw.initial_q) || !Array.isArray(raw.q_y)) throw new Error('模型必须包含 nodes 数组、initial_q 对象、q_y 数组');
  if (!Array.isArray(raw.initial_q['0']) || !Array.isArray(raw.initial_q['1'])) throw new Error('initial_q 的 0、1 必须都是数组');
  const issues = [], blockingIssues = [], byId = new Map(), inputReferences = new Set();
  const block = message => { issues.push(message); blockingIssues.push(message); };
  function fields(value, allowed, label, report = block) {
    if (!object(value)) { report(`${label} 必须是对象`); return false; }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) report(`${label} 不接受未定义字段 ${key}`);
    return true;
  }
  fields(raw, completeFields, '模型');
  if (own(raw, 'name') && (typeof raw.name !== 'string' || !raw.name.trim())) block('name 必须为非空字符串');
  if (['format', 'md5', 'format_md5'].some(field => own(raw, field)) && raw.format !== APP_CONFIG.model.format) block(`format 必须为 ${APP_CONFIG.model.format}，不兼容旧版`);
  if (own(raw, 'created_at') && !validTimestamp(raw.created_at)) block('created_at 必须为一致的 UTC 日期小时与 Unix 纳秒标记');
  fields(raw.initial_q, ['0', '1'], 'initial_q');
  if (own(raw, 'display') && fields(raw.display, ['show', 'outputBoard'], 'display')) {
    if (typeof raw.display.show !== 'string') block('display.show 必须是字符串');
    if (own(raw.display, 'outputBoard')) {
      try { validateDisplay(raw.display.outputBoard); }
      catch (error) { block(`display.outputBoard 无效：${error.message}`); }
    }
  }
  const nodes = raw.nodes.map((data, index) => {
    const id = typeof data?.id === 'string' ? data.id : `无编号-${index}`;
    const node = {key: `node-${index}`, originalId: id, id, displayName: id, ex: data?.ex, errors: [], tokens: [], initial: null, sources: [], eventSources: [], required: [], pro: data?.pro ?? APP_CONFIG.model.defaultPro};
    fields(data, ['id', 'ex', 'pro'], `nodes[${index}]`, message => node.errors.push(message));
    if (!qId.test(id) || id !== `Q${index}`) node.errors.push(`nodes[${index}].id 必须为 Q${index}；节点须从 Q0 连续按序排列`);
    if (object(data) && own(data, 'pro') && !proValues.has(data.pro)) node.errors.push('pro 必须为 q=0/1、q=0、q=1 或 q=');
    try { node.tokens = parseExpression(node.ex); } catch (error) { node.errors.push(error.message); }
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(node);
    return node;
  });
  for (const group of byId.values()) if (group.length > 1) group.forEach(node => node.errors.push(`节点 ID 重复：${node.id}`));
  function referenceError(reference) {
    if (typeof reference !== 'string' || !qId.test(reference)) return `引用格式错误：${String(reference)}；只接受固定 Q 编号`;
    if (!byId.has(reference)) return `引用不存在：${reference}`;
    if (byId.get(reference).length !== 1) return `依赖异常：${reference}（节点 ID 重复）`;
    return null;
  }
  const assigned = new Set();
  for (const bit of [0, 1]) {
    let previous = null;
    for (const reference of raw.initial_q[bit]) {
      const error = referenceError(reference);
      if (error) { block(`initial_q ${error}`); continue; }
      if (assigned.has(reference)) block(`initial_q 重复赋值或 0/1 冲突：${reference}`);
      if (previous !== null && order(previous, reference) >= 0) block(`initial_q[${bit}] 必须按 Q 编号严格递增`);
      previous = reference;
      assigned.add(reference); byId.get(reference).forEach(node => { node.initial = bit; });
    }
  }
  for (const node of nodes) {
    node.sources = [...new Set(node.tokens.flatMap(token => token.source ? [token.source] : []))];
    node.eventSources = node.sources.filter(source => source !== node.id);
    if (!node.eventSources.length && node.tokens.length) node.errors.push('ex_source 至少为 1；禁止纯常量或仅自引用节点');
    if (node.initial === null && node.tokens[0]?.text !== 'J0') node.errors.push('无状态 JK 节点必须以 J0 开头');
    if (node.initial === null && node.pro === 'q=') node.errors.push('无状态节点禁止使用 q=');
    if (node.initial === null && node.sources.includes(node.id)) node.errors.push('无状态节点不得显式引用自身');
    for (const source of node.sources) {
      if (source.startsWith('Q')) { const error = referenceError(source); if (error) node.errors.push(error); }
      else inputReferences.add(source);
    }
    node.required = node.eventSources.filter(source => source.startsWith('Q') && byId.get(source)?.length === 1 && byId.get(source)[0].initial === null);
  }
  function portCount(field, prefix) {
    if (!own(raw, field)) return null;
    if (!Array.isArray(raw[field])) { block(`${field} 必须是有序端口数组`); return null; }
    raw[field].forEach((entry, index) => {
      const id = `${prefix}${index}`;
      if (!object(entry) || Object.keys(entry).length !== 1 || entry[id] !== id) block(`${field}[${index}] 必须为 {${id}: ${id}} 身份映射`);
    });
    return raw[field].length;
  }
  const declaredInputs = portCount('inputs', 'X'), declaredOutputs = portCount('outputs', 'Y');
  const referencedWidth = [...inputReferences].reduce((width, id) => Math.max(width, Math.min(Number(id.slice(1)) + 1, APP_CONFIG.model.maxIoBits + 1)), 0);
  let inputWidth = declaredInputs ?? raw.input_bits ?? referencedWidth;
  if (!Number.isSafeInteger(inputWidth) || inputWidth < 0 || inputWidth > APP_CONFIG.model.maxIoBits) { block(`input_bits 必须为 0 到 ${APP_CONFIG.model.maxIoBits} 的整数`); inputWidth = Math.min(referencedWidth, APP_CONFIG.model.maxIoBits); }
  if (referencedWidth > inputWidth) block('Xi 引用超出已声明输入端口范围');
  const inputs = Array.from({length: inputWidth}, (_, index) => `X${index}`);
  for (const [index, node] of nodes.entries()) {
    node.input = index < inputWidth ? inputs[index] : null;
    if (node.input) {
      if (node.ex !== `J0K(${node.input})` || node.initial === null) node.errors.push(`${node.input} 必须由同编号有状态 ${node.id} 唯一复制，EX 固定为 J0K(${node.input})`);
    } else if (node.sources.some(source => source.startsWith('X'))) node.errors.push('非输入副本不得直接引用 Xi');
  }
  if (nodes.length < inputWidth) block('每个 Xi 必须有同编号输入副本');
  // ALL Q connections form a DAG, excluding only legal stateful self reads.
  const indegree = new Map(nodes.map(node => [node, node.eventSources.filter(source => source.startsWith('Q')).length]));
  const targets = new Map();
  for (const node of nodes) for (const source of node.eventSources) {
    if (!targets.has(source)) targets.set(source, []);
    targets.get(source).push(node);
  }
  const ready = nodes.filter(node => indegree.get(node) === 0);
  for (let head = 0; head < ready.length; head++) for (const target of targets.get(ready[head].id) ?? []) {
    indegree.set(target, indegree.get(target) - 1);
    if (indegree.get(target) === 0) ready.push(target);
  }
  for (const node of nodes) if (indegree.get(node) > 0) node.errors.push('全部 Q 来源连接必须为 DAG，不能包含多节点环');
  const outputs = raw.q_y.flatMap((entry, index) => {
    if (!object(entry) || Object.keys(entry).length !== 1) { block('q_y 每项必须为一个 {Yi: Qj} 映射'); return []; }
    const [id, source] = Object.entries(entry)[0];
    if (id !== `Y${index}`) block(`q_y[${index}] 必须为 Y${index}；输出须从 Y0 连续按序排列`);
    let error = referenceError(source);
    if (!error && byId.get(source)[0].pro !== APP_CONFIG.model.defaultPro) error = 'Yi 只能绑定 pro=q=0/1 的 Q';
    if (error) block(`${id} ${error}`);
    return [{id, source, originalSource: source, error}];
  });
  if (outputs.length > APP_CONFIG.model.maxIoBits) block(`output_bits 不得超过 ${APP_CONFIG.model.maxIoBits}`);
  if (declaredOutputs !== null && declaredOutputs !== outputs.length) block('outputs 与 q_y 输出位宽不一致');
  for (const node of nodes) {
    node.references = (targets.get(node.id)?.length ?? 0) + outputs.filter(output => output.source === node.id).length;
    if (!node.references) node.errors.push('每个 Q 的被引用数量至少为 1（其他 Q 或 Yi）');
  }
  const statistics = {
    input_bits: inputWidth, output_bits: outputs.length, jk_bits: nodes.length,
    ex_source_max: nodes.reduce((max, node) => Math.max(max, node.eventSources.length), 0),
    ex_operation_max: nodes.reduce((max, node) => Math.max(max, node.tokens.length), 0),
    ex_source_sum: nodes.reduce((sum, node) => sum + node.eventSources.length, 0),
    ex_operation_sum: nodes.reduce((sum, node) => sum + node.tokens.length, 0),
  };
  if (own(raw, 'jk_bits_max') && (!Number.isSafeInteger(raw.jk_bits_max) || raw.jk_bits_max < nodes.length)) block('jk_bits_max 必须为不小于实际节点数的整数');
  if (verifyMetadata) for (const field of statsFields) if (own(raw, field) && raw[field] !== statistics[field]) block(`${field} 与实际结构不一致：应为 ${statistics[field]}`);
  if (own(raw, 'FIFOS')) {
    if (fields(raw.FIFOS, queueNames, 'FIFOS')) for (const name of queueNames) {
      if (!Array.isArray(raw.FIFOS[name])) { block(`FIFOS 必须包含 ${name} 任务数组`); continue; }
      raw.FIFOS[name].forEach((task, index) => {
        const label = `${name}[${index}]`;
        if (!object(task) || Object.keys(task).length !== 1) { block(`${label} 必须为单目标 {Q: {锁存数据}}`); return; }
        const [id, data] = Object.entries(task)[0], error = referenceError(id);
        if (error) { block(`${label} ${error}`); return; }
        const node = byId.get(id)[0];
        if (Boolean(node.input) !== (name === 'Xi.FIFO')) block(`${label} 目标 ${id} 队列归属错误`);
        if (!object(data) || Object.keys(data).length !== node.required.length || !node.required.every(source => own(data, source)) || Object.values(data).some(value => value !== 0 && value !== 1)) block(`${label} 必须恰好锁存全部 Qi_J0 来源的 0/1 数据`);
      });
    }
  } else if (own(raw, 'format')) block('V4.0.0 快照必须包含 FIFOS，不补空队列');
  const missing = completeFields.filter(field => !own(raw, field));
  const fingerprints = !missing.includes('format') && !missing.includes('FIFOS') && !missing.includes('created_at') && nodes.every(node => typeof node.ex === 'string') ? modelFingerprints(raw) : null;
  if (verifyMetadata) for (const field of ['md5', 'format_md5']) if (own(raw, field) && (typeof raw[field] !== 'string' || !/^[a-f0-9]{32}$/.test(raw[field]) || raw[field] !== fingerprints?.[field])) block(`${field} 与 V4.0.0 规范 JSON 指纹不一致`);
  const invalid = issues.length > 0 || nodes.some(node => node.errors.length) || outputs.some(output => output.error);
  // The whole structure must be valid; no partial execution of invalid models.
  const integrity = {status: invalid ? 'invalid' : missing.length ? 'draft' : 'verified', missing, fingerprints};
  return {raw, nodes, byId, valid: nodes.filter(node => !node.errors.length), inputs, outputs, targets, issues, blockingIssues, canExecute: !invalid && nodes.length > 0, statistics, integrity};
}
function errorsOf(model) {
  return [...model.blockingIssues, ...model.nodes.flatMap(node => node.errors.map(error => `${node.id}: ${error}`))];
}
export function compileSnapshot(raw) {
  const model = compileModel(raw), errors = [...errorsOf(model), ...model.integrity.missing.map(field => `标准快照缺少 ${field}`)];
  if (!model.nodes.length) errors.push('标准快照必须包含节点');
  if (errors.length) throw new Error(`模型快照校验失败：${errors.join('；')}`);
  const snapshot = structuredClone(raw);
  snapshot.nodes = normalizedNodes(snapshot.nodes);
  return compileModel(snapshot);
}

/** Explicit V4 authoring, never an import/migration path. */
export function serializeModel(raw, {state, fifos, createdAt, show, outputBoard} = {}) {
  const model = compileModel(raw, {verifyMetadata: false}), errors = errorsOf(model);
  if (!model.nodes.length) errors.push('标准快照必须包含节点');
  if (errors.length) throw new Error(`模型结构无效，不能导出：${errors.join('；')}`);
  const nodes = normalizedNodes(raw.nodes), initial_q = initialState(model.nodes);
  if (state !== undefined) {
    initial_q['0'] = []; initial_q['1'] = [];
    for (const node of model.nodes) if (node.initial !== null) {
      const value = state instanceof Map ? state.get(node.id) : state?.[node.id];
      if (value !== 0 && value !== 1) throw new Error(`${node.id} 的快照状态必须为 0 或 1`);
      initial_q[value].push(node.id);
    }
  }
  const now = new Date();
  const timestamp = createdAt ?? ((state === undefined && fifos === undefined) ? raw.created_at : null) ?? `${now.toISOString().slice(0, 13)}:${BigInt(now.getTime()) * 1000000n}`;
  const FIFOS = structuredClone(fifos ?? raw.FIFOS ?? emptyFifos());
  const q_y = model.outputs.map(output => ({[output.id]: output.source}));
  const payload = {format: APP_CONFIG.model.format, nodes, initial_q, q_y, FIFOS, created_at: timestamp};
  const fingerprints = modelFingerprints(payload);
  const display = {show: show ?? raw.display?.show ?? APP_CONFIG.scene.layout};
  const board = outputBoard === undefined ? raw.display?.outputBoard : outputBoard;
  if (board !== undefined) display.outputBoard = validateDisplay(board);
  const snapshot = {
    name: raw.name ?? APP_CONFIG.model.defaultName, md5: fingerprints.md5,
    format: payload.format, format_md5: fingerprints.format_md5, created_at: timestamp,
    input_bits: model.statistics.input_bits, jk_bits_max: raw.jk_bits_max ?? nodes.length, jk_bits: nodes.length,
    output_bits: model.statistics.output_bits, ex_source_max: model.statistics.ex_source_max,
    ex_operation_max: model.statistics.ex_operation_max, ex_source_sum: model.statistics.ex_source_sum, ex_operation_sum: model.statistics.ex_operation_sum,
    nodes, initial_q, q_y,
    inputs: model.inputs.map(id => ({[id]: id})), outputs: model.outputs.map(output => ({[output.id]: output.id})),
    FIFOS, display,
  };
  return compileSnapshot(snapshot).raw;
}

/** Live exports capture state and queues together; edited drafts retain their own state. */
export function exportCurrentModel(raw, loadedRaw, engine, show, outputBoard) {
  const same = canonicalJson(raw) === canonicalJson(loadedRaw);
  // Applied board edits also appear in the manager's JSON, but do not make
  // the loaded model a separate draft with stale q or queues.
  const syncedBoard = outputBoard !== undefined && loadedRaw && canonicalJson(raw) === canonicalJson({
    ...loadedRaw, display: {...loadedRaw.display, outputBoard},
  });
  if ((same || syncedBoard) && engine) return engine.snapshot({show, outputBoard});
  const structure = value => canonicalJson({nodes: value?.nodes, initial_q: value?.initial_q, q_y: value?.q_y});
  if (!loadedRaw || structure(raw) === structure(loadedRaw)) compileSnapshot(raw);
  return serializeModel(raw);
}
