/** Shared model-pool data rules. No storage, network, or browser dependencies. */
import {compileModel} from './engine.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const epoch = '1970-01-01T00:00:00.000Z';

function fail(message, status = 400) {
  throw Object.assign(new Error(message), {status});
}

function cloneJSON(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!object(value) && !Array.isArray(value)) fail('模型池只接受有效的 JSON 数据');
  if (ancestors.has(value)) fail('模型池数据不能包含循环引用');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('模型池只接受 JSON 对象');
  ancestors.add(value);
  const result = Array.isArray(value)
    ? Array.from(value, item => cloneJSON(item, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJSON(item, ancestors)]));
  ancestors.delete(value);
  return result;
}

function timestamp(value, label) {
  // Require an actual ISO date/time with a timezone; Date.parse alone accepts
  // misleading inputs such as a bare year or an overflowing February date.
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const time = match && match[0] === value ? Date.parse(value) : NaN;
  const date = match ? new Date(`${match[1]}T00:00:00.000Z`) : null;
  if (!Number.isFinite(time) || !Number.isFinite(date?.getTime()) || date.toISOString().slice(0, 10) !== match[1]
    || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) fail(`${label} 必须是有效的 ISO 日期时间字符串`);
  return time;
}

function validateModel(model) {
  try { compileModel(model); }
  catch (error) { fail(`模型格式错误：${error.message}`); }
  return model;
}

/** Validate and clone a pool, or wrap a legacy single model as a permanent seed. */
export function parseModelPool(raw) {
  const pool = cloneJSON(raw);
  if (!object(pool)) fail('模型池必须是 JSON 对象');
  if (!Object.hasOwn(pool, 'temporary') && !Object.hasOwn(pool, 'permanent')) {
    validateModel(pool);
    return {version: 1, revision: 0, temporary: [], permanent: [{id: 'example', createdAt: epoch, promotedAt: epoch, model: pool}]};
  }
  if (pool.version !== 1) fail('不支持的模型池版本，version 必须为 1');
  if (!Number.isSafeInteger(pool.revision) || pool.revision < 0) fail('模型池 revision 必须为非负安全整数');
  if (!Array.isArray(pool.temporary) || !Array.isArray(pool.permanent)) fail('模型池必须包含 temporary 和 permanent 数组');
  const ids = new Set();
  for (const group of ['temporary', 'permanent']) for (const entry of pool[group]) {
    if (!object(entry) || !nonempty(entry.id)) fail('模型池条目 id 必须为非空字符串');
    if (ids.has(entry.id)) fail(`模型池条目 ID 重复：${entry.id}`);
    ids.add(entry.id);
    timestamp(entry.createdAt, `${entry.id} 的 createdAt`);
    if (group === 'temporary') {
      if (entry.promotedAt !== null) fail(`临时模型 ${entry.id} 的 promotedAt 必须为 null`);
    } else timestamp(entry.promotedAt, `${entry.id} 的 promotedAt`);
    validateModel(entry.model);
  }
  return pool;
}

/** Latest promotion wins; use the latest temporary import only if no permanent model remains. */
export function defaultPoolEntry(pool) {
  const group = pool.permanent.length ? pool.permanent : pool.temporary;
  const field = pool.permanent.length ? 'promotedAt' : 'createdAt';
  return group.reduce((latest, entry) => !latest || Date.parse(entry[field]) >= Date.parse(latest[field]) ? entry : latest, null);
}

/** Apply one revision-checked mutation without changing the supplied pool or command. */
export function mutateModelPool(rawPool, command, options = {}) {
  const pool = parseModelPool(rawPool);
  if (!object(command) || !Number.isSafeInteger(command.revision) || command.revision < 0) fail('操作必须包含非负整数 revision');
  if (command.revision !== pool.revision) fail('模型池已被其他页面更新，请刷新后重试', 409);
  if (!['import', 'promote', 'delete'].includes(command.action)) fail('不支持的模型池操作');
  let selectedId;
  if (command.action === 'import') {
    const model = validateModel(cloneJSON(command.model));
    const id = options.id ?? globalThis.crypto.randomUUID();
    if (!nonempty(id)) fail('新模型条目 id 必须为非空字符串');
    if ([...pool.temporary, ...pool.permanent].some(entry => entry.id === id)) fail(`模型池条目 ID 重复：${id}`);
    const now = options.now ?? new Date().toISOString();
    timestamp(now, '入池时间');
    pool.temporary.push({id, createdAt: new Date(now).toISOString(), promotedAt: null, model});
    selectedId = id;
  } else {
    if (!nonempty(command.id)) fail('操作必须指定非空模型条目 id');
    const temporaryIndex = pool.temporary.findIndex(entry => entry.id === command.id);
    const permanentIndex = pool.permanent.findIndex(entry => entry.id === command.id);
    if (temporaryIndex < 0 && permanentIndex < 0) fail('指定的模型已不存在，请刷新模型池', 404);
    if (command.action === 'promote') {
      if (permanentIndex >= 0) return {pool, selectedId: command.id};
      const now = options.now ?? new Date().toISOString();
      timestamp(now, '入池时间');
      const [entry] = pool.temporary.splice(temporaryIndex, 1);
      entry.promotedAt = new Date(now).toISOString();
      pool.permanent.push(entry);
      selectedId = entry.id;
    } else {
      if (temporaryIndex >= 0) pool.temporary.splice(temporaryIndex, 1);
      else pool.permanent.splice(permanentIndex, 1);
      selectedId = defaultPoolEntry(pool)?.id ?? null;
    }
  }
  if (pool.revision === Number.MAX_SAFE_INTEGER) fail('模型池 revision 已达到上限');
  pool.revision++;
  return {pool, selectedId};
}
