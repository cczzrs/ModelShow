/** Stable JK identity and optional display metadata. Never infer layer/bit semantics. */
const numberSource = '(?:0|[1-9]\\d*)', tagSource = '[A-Za-z][A-Za-z0-9]*';
export const JK_ID_SOURCE = `Q${numberSource}(?:${tagSource})?`;
const jkId = new RegExp(`^Q(${numberSource})(${tagSource})?$`);
const tagPattern = new RegExp(`^${tagSource}$`);

export function parseJKId(value) {
  const match = typeof value === 'string' && jkId.exec(value);
  if (!match || match[0].length !== value.length) throw new Error('JK 节点 ID 必须为 Q + 非负整数（无前导零），可附加英文字母开头的字母数字标记');
  return {id: `Q${match[1]}`, number: match[1], tag: match[2] ?? null};
}

export function validateNodeTag(value) {
  if (typeof value !== 'string' || tagPattern.exec(value)?.[0] !== value) throw new Error('tag 必须为非空字符串，以英文字母开头且只包含英文字母和数字');
  return value;
}

export function order(a, b) {
  const number = value => value.startsWith('Q') ? parseJKId(value).number : /^(?:X|Y)(0|[1-9]\d*)$/.exec(value)?.[1];
  const left = number(a), right = number(b);
  if (left === undefined || right === undefined) throw new Error('无法排序无效节点 ID');
  const x = BigInt(left), y = BigInt(right);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function compareNodes(a, b) {
  // Invalid/duplicate definitions remain visible in the existing per-row order.
  try {
    const x = BigInt(parseJKId(a.id).number), y = BigInt(parseJKId(b.id).number);
    return (x < y ? -1 : x > y ? 1 : 0) || a.key.localeCompare(b.key);
  }
  catch { return a.key.localeCompare(b.key); }
}

export function displayNodeId(model, id) {
  const nodes = model?.byId?.get(id);
  return nodes?.length === 1 ? nodes[0].displayName : id;
}

/** Resolve a reference after all node identities and tags have been collected. */
export function resolveJKReference(value, byId) {
  let parsed;
  try { parsed = parseJKId(value); }
  catch { return {id: value, error: `引用格式错误：${String(value)}`}; }
  const {id, tag} = parsed, nodes = byId.get(id);
  if (!nodes) return {id, error: `引用不存在：${value}`};
  if (nodes.length !== 1) return {id, error: `依赖异常：${id}（节点 ID 重复）`};
  if (tag !== null && tag !== nodes[0].tag) return {id, error: `引用标记不一致：${value}；${id} 的标记为 ${nodes[0].tag ?? '无'}`};
  return {id, error: null};
}
