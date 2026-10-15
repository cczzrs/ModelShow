/** V4 identity is a fixed numeric Q ID. Display never changes references. */
export function parseJKId(value) {
  const match = typeof value === 'string' && /^Q(0|[1-9]\d*)$/.exec(value);
  if (!match || match[0] !== value) throw new Error('JK 节点 ID 必须为固定 Q 编号，不接受标签或前导零');
  return {id: value, number: match[1]};
}
export function order(a, b) {
  const number = value => /^[XQY](0|[1-9]\d*)$/.exec(value)?.[1];
  const left = number(a), right = number(b);
  if (left === undefined || right === undefined) throw new Error('无法排序无效节点 ID');
  const x = BigInt(left), y = BigInt(right);
  return x < y ? -1 : x > y ? 1 : 0;
}
export function compareNodes(a, b) {
  try { return order(a.id, b.id) || a.key.localeCompare(b.key); }
  catch { return a.key.localeCompare(b.key); }
}
export function displayNodeId(model, id) {
  const nodes = model?.byId?.get(id);
  return nodes?.length === 1 ? nodes[0].displayName : id;
}
