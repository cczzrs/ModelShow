import { JKI_ID, JKS_ID, comparePaths, parentPath, isDescendant } from './node-id.js';

// This module implements JKRD7.md, not an independent schema or a version migrator.
export const VERSION = '7.0.0';
export const PUBLISH = Object.freeze({
  always: Object.freeze([0, 1]), zero: Object.freeze([0]), one: Object.freeze([1]),
  never: Object.freeze([]), always_changed: Object.freeze([0, 1]),
  zero_changed: Object.freeze([0]), one_changed: Object.freeze([1]),
});
export const REGISTRATION_TYPES = Object.freeze([
  'any', 'all', 'transaction', 'transaction_any', 'ack', 'pre', 'post', 'comp', 'frame',
]);
export const GATED_TYPES = Object.freeze(['all', 'transaction', 'transaction_any']);
export const TX_TYPES = Object.freeze(['transaction', 'transaction_any']);
const JKM_FIELDS = ['jkm', 'version', 'queues', 'roots'];
const JKS_FIELDS = ['id', 'members', 'trigger', 'queue', 'pro', 'runtime'];
const JKI_FIELDS = ['id', 'q', 'trigger', 'sources', 'publish', 'pro', 'runtime'];
const RUN_FIELDS = ['run', 'model', 'observe', 'batches'];
const SNAPSHOT_FIELDS = ['snapshot', 'jkm', 'version', 'q', 'trigger_all', 'rounds', 'queues'];
const own = (obj, key) => Object.hasOwn(obj, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const string = value => typeof value === 'string' && value.length > 0;
const list = (value, empty = true) => Array.isArray(value) && (empty || value.length > 0)
  && Array.from(value).every(string);
const unique = value => new Set(value).size === value.length;
const keysAre = (obj, fields) => object(obj) && Object.keys(obj).length === fields.length
  && fields.every(key => own(obj, key));
const subsetKeys = (obj, fields) => Object.keys(obj).every(key => fields.includes(key));
export const isBit = value => Number.isInteger(value) && (value === 0 || value === 1);
export const hasEx = node => Boolean(node.sources?.ex?.length);
export const isJKS = value => object(value) && own(value, 'members');

export class ModelValidationError extends Error {
  constructor(errors, title = 'JKRD7 校验失败') {
    super(`${title}\n${errors.join('\n')}`);
    this.name = 'ModelValidationError';
    this.errors = [...errors];
  }
}

function checkNode(node, path, errors) {
  const fail = message => errors.push(`${path}: ${message}`);
  if (!subsetKeys(node, JKI_FIELDS)) fail('JKI 含未批准字段（§2、§3）');
  if (!['id', 'q', 'trigger'].every(key => own(node, key))) fail('JKI 必须包含 id、q、trigger');
  if (!JKI_ID.test(node.id)) fail('id 必须是 Q＋正整数');
  if (!isBit(node.q)) fail('q 必须是整数 0 或 1');
  const trigger = node.trigger;
  let mode, refs;
  if (!object(trigger) || Object.keys(trigger).length !== 1 || !['any', 'all'].includes(Object.keys(trigger)[0])) {
    fail('trigger 必须恰好有 any 或 all 一个键');
  } else {
    [mode] = Object.keys(trigger);
    refs = trigger[mode];
    if (!list(refs) || !unique(refs)) fail(`trigger.${mode} 必须是无重复的引用数组`);
    if (mode === 'all' && Array.isArray(refs) && refs.length === 0) fail('trigger.all 不得为空');
  }
  if (own(node, 'sources')) {
    if (!object(node.sources)) fail('sources 必须是对象');
    else {
      const sources = node.sources;
      if (!subsetKeys(sources, ['s', 'ex', 'seed'])) fail('sources 含未批准字段');
      if (own(sources, 's') && !list(sources.s)) fail('sources.s 必须是引用数组');
      if (own(sources, 'ex') && (!Array.isArray(sources.ex) || !Array.from(sources.ex).every(op => op === 'J' || op === 'K'))) {
        fail('sources.ex 只能由 J、K 组成');
      } else if (sources.ex?.length && (!Array.isArray(sources.s) || sources.s.length !== sources.ex.length)) {
        fail('非空 sources.ex 必须与 sources.s 等长');
      }
      if (own(sources, 'seed') && !isBit(sources.seed)) fail('seed 必须是整数 0 或 1，null 非法');
    }
  }
  if (own(node, 'publish')) {
    const pub = node.publish;
    if (!object(pub)) fail('publish 必须是对象');
    else if (Object.keys(pub).length > 0) {
      const [modeName] = Object.keys(pub);
      const values = pub[modeName];
      if (Object.keys(pub).length !== 1 || !own(PUBLISH, modeName) || !Array.isArray(values)
          || values.length !== PUBLISH[modeName].length
          || !Array.from(values).every((v, i) => isBit(v) && v === PUBLISH[modeName][i])) {
        fail('publish 必须使用七种模式之一的固定集合（§4.4）');
      }
    }
  }
  if (own(node, 'pro')) {
    if (!object(node.pro)) fail('pro 必须是对象');
    else {
      if (!subsetKeys(node.pro, ['jksid', 'tag'])) fail('pro 含未批准字段');
      if (own(node.pro, 'jksid') && !string(node.pro.jksid)) fail('pro.jksid 必须是 JKS 绝对路径');
      if (own(node.pro, 'tag') && !list(node.pro.tag)) fail('pro.tag 必须是字符串数组');
    }
  }
  if (own(node, 'runtime') && (!object(node.runtime) || !subsetKeys(node.runtime, ['trigger_all']))) {
    fail('runtime 必须是只含 trigger_all 的对象');
  }
  if (mode === 'all' && Array.isArray(refs)) {
    const record = node.runtime?.trigger_all;
    if (!Array.isArray(record) || record.length !== refs.length || !Array.from(record).every(v => v === null)) {
      fail('all 定义必须保留等长且全为 null 的 runtime.trigger_all');
    }
  } else if (mode === 'any' && object(node.runtime) && own(node.runtime, 'trigger_all')) {
    fail('any 节点不保存 trigger_all');
  }
}

function cycleIn(edges) {
  const state = new Map();
  for (const start of [...edges.keys()].sort(comparePaths)) {
    if (state.has(start)) continue;
    const stack = [{ path: start, cursor: 0 }];
    state.set(start, 1);
    while (stack.length) {
      const current = stack.at(-1);
      const targets = edges.get(current.path) || [];
      if (current.cursor >= targets.length) {
        state.set(current.path, 2);
        stack.pop();
        continue;
      }
      const next = targets[current.cursor++];
      if (state.get(next) === 1) {
        return [...stack.slice(stack.findIndex(item => item.path === next)).map(item => item.path), next];
      }
      if (!state.has(next)) {
        state.set(next, 1);
        stack.push({ path: next, cursor: 0 });
      }
    }
  }
  return null;
}

export function compileModel(raw, { singleQueue = true } = {}) {
  const errors = [];
  const fail = message => errors.push(message);
  if (!keysAre(raw, JKM_FIELDS)) throw new ModelValidationError(['JKM 必须恰好包含 jkm、version、queues、roots（§8.1）；不接受旧版格式']);
  if (!string(raw.jkm)) fail('jkm 必须是非空字符串');
  if (raw.version !== VERSION) fail(`只接受 JKRD7 version="${VERSION}"`);
  if (!list(raw.queues, false) || !unique(raw.queues)) fail('queues 必须是非空、无重复的字符串数组');
  if (!Array.isArray(raw.roots)) fail('roots 必须是 JKS 数组');
  if (errors.length) throw new ModelValidationError(errors);
  const data = structuredClone(raw);
  const m = {
    raw: data, name: data.jkm, queues: [...data.queues], errors: [],
    jki: new Map(), jks: new Map(), triggerRefs: new Map(), sourceRefs: new Map(),
    regTypes: new Map(), regOf: new Map(), ranges: new Map(), members: new Map(),
    prereqs: new Map(), subscribers: new Map(), inputs: [], paths: [],
  };
  const addresses = new Set();
  function register(path, obj, table) {
    if (addresses.has(path)) fail(`绝对路径重复：${path}`);
    else { addresses.add(path); table.set(path, obj); }
  }
  function walk(group, prefix, label) {
    if (!isJKS(group)) { fail(`${label} 必须是 JKS 对象`); return; }
    if (!keysAre(group, JKS_FIELDS)) fail(`${label}: JKS 必须恰好有 id、members、trigger、queue、pro、runtime 六个字段`);
    if (typeof group.id !== 'string' || !JKS_ID.test(group.id)) { fail(`${label}: JKS id 必须是 G＋正整数`); return; }
    const path = prefix ? `${prefix}.${group.id}` : group.id;
    register(path, group, m.jks);
    if (!object(group.trigger)) fail(`${path}: trigger 必须是对象`);
    if (!m.queues.includes(group.queue)) fail(`${path}: queue 必须在 JKM.queues 中声明`);
    if (!object(group.pro) || !subsetKeys(group.pro, ['tag']) || (own(group.pro, 'tag') && !list(group.pro.tag))) {
      fail(`${path}: JKS.pro 只允许 tag 字符串数组`);
    }
    if (!keysAre(group.runtime, [])) fail(`${path}: JKS.runtime 必须是 {}`);
    if (!Array.isArray(group.members) || group.members.length === 0) { fail(`${path}: members 必须是非空数组`); return; }
    const ids = new Set();
    for (const [index, member] of group.members.entries()) {
      if (!object(member)) { fail(`${path}.members[${index}]: 成员必须是完整对象`); continue; }
      if (ids.has(member.id)) fail(`${path}: 同层 id 重复 ${member.id}`);
      ids.add(member.id);
      if (isJKS(member)) walk(member, path, `${path}.members[${index}]`);
      else {
        const size = errors.length;
        checkNode(member, `${path}.${member.id}`, errors);
        if (errors.length === size) register(`${path}.${member.id}`, member, m.jki);
      }
    }
  }
  data.roots.forEach((root, i) => walk(root, '', `roots[${i}]`));
  if (errors.length) throw new ModelValidationError(errors);
  m.resolve = (ref, layer) => {
    if (!string(ref)) throw new ModelValidationError(['引用必须是非空字符串']);
    const path = ref.includes('.') ? ref : `${layer}.${ref}`;
    if (!m.jki.has(path)) throw new ModelValidationError([`${ref} 不是 ${layer} 可引用的 JKI；短 ID 只在本层解析，跨层使用绝对路径`]);
    return path;
  };
  function resolveAll(refs, layer, where) {
    const result = [];
    for (const ref of refs) {
      try { result.push(m.resolve(ref, layer)); }
      catch (error) { fail(`${where}: ${error.errors[0]}`); }
    }
    return result;
  }
  for (const [path, node] of m.jki) {
    const refs = resolveAll(Object.values(node.trigger)[0], parentPath(path), `${path}.trigger`);
    if (!unique(refs)) fail(`${path}.trigger: 短 ID 与绝对路径不可重复指向同一 JKI`);
    m.triggerRefs.set(path, refs);
    m.sourceRefs.set(path, resolveAll(node.sources?.s || [], parentPath(path), `${path}.sources.s`));
  }
  for (const path of m.jks.keys()) {
    m.members.set(path, new Set([...m.jki.keys()].filter(p => isDescendant(p, path))));
    m.prereqs.set(path, new Set());
    m.regTypes.set(path, Object.create(null));
  }
  m.gated = (group, subscriber) => m.members.get(group).has(subscriber) && !m.prereqs.get(group).has(subscriber);
  for (const [path, group] of m.jks) {
    for (const [kind, refs] of Object.entries(group.trigger)) {
      if (!REGISTRATION_TYPES.includes(kind)) { fail(`${path}.trigger.${kind}: 未定义的登记类型`); continue; }
      if (!list(refs, false)) { fail(`${path}.trigger.${kind}: 必须是非空引用数组`); continue; }
      const paths = resolveAll(refs, path, `${path}.trigger.${kind}`);
      m.regTypes.get(path)[kind] = paths;
      for (const prereq of paths) {
        if (!m.members.get(path).has(prereq)) fail(`${path}: 前置 ${prereq} 必须属于本结构`);
        else if (m.prereqs.get(path).has(prereq)) fail(`${path}: 前置 ${prereq} 重复登记`);
        else if (m.regOf.has(prereq)) fail(`${prereq}: 不支持同一 JKI 被多个 JKS 登记（§9.3）`);
        else {
          m.prereqs.get(path).add(prereq);
          m.regOf.set(prereq, { group: path, type: kind });
        }
      }
    }
  }
  for (const [path, node] of m.jki) {
    if (node.trigger.any?.length === 0) {
      if (!m.regOf.has(path)) fail(`${path}: trigger.any=[] 只允许已登记的输入入口`);
      else m.inputs.push(path);
    }
    if (own(node.pro || {}, 'jksid') && !m.jks.has(node.pro.jksid)) fail(`${path}: pro.jksid 必须是实际 JKS 的绝对路径`);
  }
  for (const [group, kinds] of m.regTypes) {
    if (!TX_TYPES.some(type => own(kinds, type))) continue;
    const scope = new Set([...m.members.get(group)].filter(path => !m.prereqs.get(group).has(path)));
    m.ranges.set(group, scope);
    for (const path of scope) {
      for (const ref of m.triggerRefs.get(path)) {
        if (!m.members.get(group).has(ref)) fail(`${group}: 事务范围内 ${path} 被外部 ${ref} 触发，外部上游只能接到前置成员`);
      }
    }
    const cycle = cycleIn(new Map([...scope].map(path => [path, m.triggerRefs.get(path).filter(ref => scope.has(ref))])));
    if (cycle) fail(`${group}: 事务范围内触发连接成环 ${cycle.join(' → ')}`);
  }
  for (const [path, refs] of m.triggerRefs) {
    for (const ref of refs) {
      if (!m.subscribers.has(ref)) m.subscribers.set(ref, []);
      m.subscribers.get(ref).push(path);
    }
  }
  for (const subscribers of m.subscribers.values()) subscribers.sort(comparePaths);
  const loud = new Set([...m.jki].filter(([, node]) => {
    const mode = Object.keys(node.publish || {})[0] || 'always';
    return own(node.trigger, 'any') && !hasEx(node) && ['always', 'zero', 'one'].includes(mode) && PUBLISH[mode].includes(node.q);
  }).map(([path]) => path));
  const cycle = cycleIn(new Map([...loud].map(path => [path, m.triggerRefs.get(path).filter(ref => {
    const reg = m.regOf.get(ref);
    return loud.has(ref) && !(reg && GATED_TYPES.includes(reg.type) && m.gated(reg.group, path));
  })])));
  if (cycle) fail(`纯通知环 ${cycle.join(' → ')}：永不终止并阻止任务执行（§6.2）`);
  m.usedQueues = [...new Set([...m.jks.values()].map(group => group.queue))];
  if (singleQueue && m.usedQueues.length > 1) fail('当前执行器仅支持单 queue；多个 queue 之间的调度尚未定义（§9.3）');
  if (errors.length) throw new ModelValidationError(errors);
  m.paths = [...m.jki.keys()].sort(comparePaths);
  m.inputs.sort(comparePaths);
  return m;
}

export function checkRunScript(script, model) {
  if (!keysAre(script, RUN_FIELDS)) return ['运行脚本必须恰好包含 run、model、observe、batches（§9.4）'];
  const errors = [];
  if (!string(script.run)) errors.push('run 必须是非空字符串');
  if (!string(script.model)) errors.push('model 必须是非空 JKM 文件路径');
  if (!keysAre(script.observe, ['watch', 'read']) || !list(script.observe.watch) || !list(script.observe.read)) {
    errors.push('observe 必须包含 watch、read 两个路径数组');
  } else {
    for (const ref of [...script.observe.watch, ...script.observe.read]) {
      if (!model.jki.has(ref)) errors.push(`observe 中的 ${ref} 不是 JKI 绝对路径`);
    }
  }
  if (!Array.isArray(script.batches) || !Array.from(script.batches).every(batch => list(batch, false))) {
    errors.push('batches 必须是非空输入路径数组组成的数组');
  } else {
    for (const ref of script.batches.flat()) {
      if (!model.inputs.includes(ref)) errors.push(`batches 中的 ${ref} 不是输入入口`);
    }
  }
  return errors;
}

export function validateRunScript(script, model) {
  const errors = checkRunScript(script, model);
  if (errors.length) throw new ModelValidationError(errors, '运行脚本校验失败');
  return structuredClone(script);
}

export function checkSnapshot(snap, model) {
  if (!keysAre(snap, SNAPSHOT_FIELDS)) return ['快照必须恰好包含 snapshot、jkm、version、q、trigger_all、rounds、queues（§9.5）'];
  const errors = [];
  const fail = message => errors.push(message);
  if (!string(snap.snapshot)) fail('snapshot 必须是非空名称');
  if (snap.jkm !== model.name) fail('快照 jkm 与当前模型不对应');
  if (snap.version !== VERSION) fail(`快照 version 必须为 ${VERSION}`);
  if (!keysAre(snap.q, model.paths) || !Object.values(snap.q).every(isBit)) fail('q 必须准确覆盖全部 JKI，且值为整数 0 或 1');
  if (!object(snap.trigger_all)) fail('trigger_all 必须是对象');
  else for (const [path, record] of Object.entries(snap.trigger_all)) {
    const node = model.jki.get(path);
    if (!node?.trigger.all || !Array.isArray(record) || record.length !== node.trigger.all.length
        || !Array.from(record).every(v => v === null || isBit(v))
        || !record.some(v => v !== null) || !record.some(v => v === null)) {
      fail(`trigger_all.${path}: 必须是 all 节点未到齐、非空的到达记录`);
    }
  }
  if (!object(snap.rounds)) fail('rounds 必须是对象');
  else for (const [group, kinds] of Object.entries(snap.rounds)) {
    if (!model.jks.has(group) || !object(kinds) || Object.keys(kinds).length === 0) {
      fail(`rounds.${group}: 必须是实际 JKS 的非空轮记录`); continue;
    }
    for (const [kind, record] of Object.entries(kinds)) {
      const registered = model.regTypes.get(group)[kind] || [];
      if (!['all', 'transaction'].includes(kind) || !list(record, false) || !unique(record)
          || record.length >= registered.length || !record.every(ref => registered.includes(ref))) {
        fail(`rounds.${group}.${kind}: 只能保存尚未到齐的本轮前置，按首次到达顺序且无重复`);
      }
    }
  }
  if (!object(snap.queues) || !Object.keys(snap.queues).every(name => model.queues.includes(name))) {
    fail('queues 必须是由模型声明的 queue 名组成的对象'); return errors;
  }
  if (!(model.usedQueues || []).every(name => own(snap.queues, name))) fail('queues 必须包含模型实际使用的全部 queue');
  for (const [queue, fifo] of Object.entries(snap.queues)) {
    if (!keysAre(fifo, ['events', 'tasks']) || !Array.isArray(fifo.events) || !Array.isArray(fifo.tasks)) {
      fail(`queues.${queue}: 必须包含 events、tasks 两个数组`); continue;
    }
    for (const item of fifo.events) {
      let valid = object(item) && model.jki.has(item.source)
        && model.jks.get(parentPath(item.source)).queue === queue;
      if (valid && keysAre(item, ['source', 'to', 'out'])) {
        const subscribers = model.subscribers.get(item.source) || [];
        valid = list(item.to) && unique(item.to) && item.to.every(path => subscribers.includes(path)) && typeof item.out === 'boolean';
      } else if (valid) valid = keysAre(item, ['source']);
      if (!valid) fail(`queues.${queue}.events: 事件必须是合法来源，提交事件另有 to 与布尔 out；不得携带值`);
    }
    for (const item of fifo.tasks) {
      let valid = false;
      if (keysAre(item, ['node'])) {
        const node = model.jki.get(item.node);
        valid = Boolean(node && hasEx(node) && model.jks.get(parentPath(item.node)).queue === queue);
      } else if (keysAre(item, ['tx', 'prereqs']) && model.ranges.has(item.tx) && list(item.prereqs, false) && unique(item.prereqs)) {
        const kinds = model.regTypes.get(item.tx);
        const transaction = kinds.transaction || [];
        const any = kinds.transaction_any || [];
        valid = model.jks.get(item.tx).queue === queue && (
          (transaction.length > 0 && item.prereqs.length === transaction.length && item.prereqs.every(ref => transaction.includes(ref)))
          || (item.prereqs.length === 1 && any.includes(item.prereqs[0]))
        );
      }
      if (!valid) fail(`queues.${queue}.tasks: 节点任务必须有 EX；事务任务必须包含一次合法事务的前置`);
    }
  }
  return errors;
}

export function validateSnapshot(snapshot, model) {
  const errors = checkSnapshot(snapshot, model);
  if (errors.length) throw new ModelValidationError(errors, '运行现场快照校验失败');
  return structuredClone(snapshot);
}

// Export definitions only; runtime state belongs in a separate §9.5 snapshot.
export function serializeModel(raw) {
  return structuredClone(compileModel(raw).raw);
}
