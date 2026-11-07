import { comparePaths } from '../jk/node-id.js';

/** This graph is a read-only drawing projection, never an accepted model format. */
export function compareDisplayNodes(a, b) {
  return comparePaths(a.id, b.id);
}

export function createDisplayModel(compiled, { watch = [], read = [] } = {}) {
  const nodes = compiled.paths.map(path => {
    const definition = compiled.jki.get(path);
    const ops = definition.sources?.ex ?? [];
    const tokens = (compiled.sourceRefs.get(path) ?? []).map((source, index) => ({
      source, index, op: ops[index] ?? 'K', relation: ops.length ? 'source' : 'source-definition',
    }));
    for (const [index, source] of (compiled.triggerRefs.get(path) ?? []).entries()) {
      tokens.push({ source, index, op: 'K', relation: 'trigger' });
    }
    return {
      id: path, key: path, initial: definition.q, hasEX: ops.length > 0, errors: [], tokens, isInput: compiled.inputs.includes(path),
      tags: [...(definition.pro?.tag ?? [])],
      displayName: definition.pro?.tag?.length ? `${path} · ${definition.pro.tag.join(' · ')}` : path,
    };
  });
  const observed = [...new Set([...watch, ...read])].filter(path => compiled.jki.has(path)).sort(comparePaths);
  const outputs = observed.map(path => ({
    id: `observe:${path}`, source: path, displayName: `观察 · ${path}`, error: null, category: 'observe', tags: [],
  }));
  return {
    name: compiled.name, nodes, inputs: [], outputs,
    byId: new Map(nodes.map(node => [node.id, node])),
  };
}

/** Read captured EX values from the completed unit; notifications carry no bit. */
export function unitTransfers(compiled, entry) {
  if (!entry) return [];
  if (entry.kind === 'batch') return entry.entries.flatMap(item => unitTransfers(compiled, item));
  if (entry.kind === 'transaction') return entry.nodes.flatMap(item => unitTransfers(compiled, item));
  if (entry.kind === 'event') {
    const registration = compiled.regOf.get(entry.target);
    const gated = registration && ['all', 'transaction', 'transaction_any'].includes(registration.type);
    // Exact committed recipients are authoritative. Gate releases require their
    // own runtime record; do not infer that a pending round delivered anything.
    const recipients = entry.event && Object.hasOwn(entry.event, 'to') ? entry.event.to
      : [...(compiled.subscribers.get(entry.target) ?? [])].filter(target => !gated
        || !compiled.members.get(registration.group).has(target)
        || compiled.prereqs.get(registration.group).has(target));
    return recipients.map(target => ({
      source: entry.target, target, value: '·', relation: 'trigger',
    }));
  }
  if (entry.kind !== 'node') return [];
  const sources = compiled.sourceRefs.get(entry.target) ?? [];
  return entry.ops.map((op, index) => ({
    source: sources[index], target: entry.target, value: entry.values[index], relation: 'source', index,
  }));
}
