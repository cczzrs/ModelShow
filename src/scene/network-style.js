/** Drawing categories only; these never change JKI identities or execution. */
export function edgeStyleType(edge) {
  if (edge.relation === 'trigger') return 'trigger';
  if (edge.relation === 'source-definition') return 'source';
  if (edge.relation === 'observe' || edge.op === 'Y') return 'observe';
  return edge.op === 'J' ? 'J' : edge.op === 'K' ? 'K' : 'source';
}

export function nodeStyleTarget(node, state) {
  const category = node.category === 'observe' || node.type === 'Y' ? 'observe'
    : node.category === 'input' || node.isInput || node.type === 'X' ? 'input' : 'node';
  const tag = (node.tags ?? node.pro?.tag ?? []).find(value => Object.hasOwn(state?.tags ?? {}, value)) ?? null;
  return { category, tag };
}

export function nodeComputationType(node) {
  if (node.category === 'observe' || node.type === 'Y') return null;
  const hasEX = node.hasEX ?? (node.sources?.ex?.length > 0);
  return hasEX ? 'ex' : 'q';
}

export function resolveNodeStyle(node, state) {
  if (!state) return null;
  const { category, tag } = nodeStyleTarget(node, state);
  if (tag !== null) return state.tags[tag];
  const base = state.nodes?.[category] ?? null;
  const computation = nodeComputationType(node);
  const overrides = computation === null ? null : state.computation?.[computation];
  const properties = Object.entries(overrides ?? {}).filter(([key]) => key !== 'marker');
  return properties.length ? { ...base, ...Object.fromEntries(properties) } : base;
}

/**
 * Fit endpoint distances from an immutable base layout. Repeated/competing edges
 * are independent constraints; Jacobi relaxation shares their correction between
 * endpoints. Self loops and isolated nodes never move. No curve is shortened.
 */
export function adjustNetworkLayout(layout, edges, styles, { iterations, relaxation }) {
  if (!styles || !edges.some(edge => (styles.edges?.[edgeStyleType(edge)]?.length ?? 1) !== 1)) return layout;
  const constraints = edges.filter(edge => edge.sourceKey !== edge.targetKey
    && layout.positions.has(edge.sourceKey) && layout.positions.has(edge.targetKey))
    .map(edge => {
      const a = layout.positions.get(edge.sourceKey), b = layout.positions.get(edge.targetKey);
      const delta = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const distance = Math.hypot(delta.x, delta.y, delta.z);
      const length = styles.edges?.[edgeStyleType(edge)]?.length ?? 1;
      return { a: edge.sourceKey, b: edge.targetKey, delta, distance, target: distance * length };
    }).filter(edge => edge.distance > 0 && Number.isFinite(edge.target) && edge.target > 0);
  if (!constraints.length) return layout;
  const positions = new Map([...layout.positions].map(([key, point]) => [key, { ...point }]));
  const neighbors = new Map();
  for (const { a, b } of constraints) {
    if (!neighbors.has(a)) neighbors.set(a, new Set());
    if (!neighbors.has(b)) neighbors.set(b, new Set());
    neighbors.get(a).add(b); neighbors.get(b).add(a);
  }
  const visited = new Set(), components = [];
  for (const key of neighbors.keys()) {
    if (visited.has(key)) continue;
    const component = [], pending = [key]; visited.add(key);
    while (pending.length) {
      const next = pending.pop(); component.push(next);
      for (const neighbor of neighbors.get(next)) if (!visited.has(neighbor)) { visited.add(neighbor); pending.push(neighbor); }
    }
    components.push(component);
  }
  for (let step = 0; step < iterations; step++) {
    const changes = new Map([...neighbors.keys()].map(key => [key, { x: 0, y: 0, z: 0, count: 0 }]));
    for (const edge of constraints) {
      const a = positions.get(edge.a), b = positions.get(edge.b);
      let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const distance = Math.hypot(dx, dy, dz);
      const scale = (distance - edge.target) / (distance || edge.distance) / 2;
      if (!distance) { dx = edge.delta.x; dy = edge.delta.y; dz = edge.delta.z; }
      const first = changes.get(edge.a), second = changes.get(edge.b);
      first.x += dx * scale; first.y += dy * scale; first.z += dz * scale; first.count++;
      second.x -= dx * scale; second.y -= dy * scale; second.z -= dz * scale; second.count++;
    }
    for (const [key, delta] of changes) {
      const point = positions.get(key), scale = relaxation / delta.count;
      point.x += delta.x * scale; point.y += delta.y * scale; point.z += delta.z * scale;
    }
  }
  // Preserve each component's original center, including unequal-degree graphs.
  for (const component of components) {
    const shift = { x: 0, y: 0, z: 0 };
    for (const key of component) for (const axis of ['x', 'y', 'z']) shift[axis] += positions.get(key)[axis] - layout.positions.get(key)[axis];
    for (const key of component) for (const axis of ['x', 'y', 'z']) positions.get(key)[axis] -= shift[axis] / component.length;
  }
  const bounds = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
  for (const point of positions.values()) for (const axis of ['x', 'y', 'z']) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]); bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
  return { ...layout, positions, bounds };
}
