/** Browser presentation preferences only; never includes JKM or execution state. */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : undefined;
const color = (value, fallback) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
const boolean = (value, fallback) => typeof value === 'boolean' ? value : fallback;
const bounded = (value, fallback, limits) => Math.min(limits.max, Math.max(limits.min,
  typeof value === 'number' && Number.isFinite(value) ? value : fallback));

function edgeStyle(raw, defaults, limits) {
  return {
    color: color(own(raw, 'color'), defaults.color),
    opacity: bounded(own(raw, 'opacity'), defaults.opacity, limits.opacity),
    length: bounded(own(raw, 'length'), defaults.length, limits.length),
    visible: boolean(own(raw, 'visible'), defaults.visible),
  };
}

function nodeStyle(raw, defaults, limits) {
  return {
    color: color(own(raw, 'color'), defaults.color),
    size: bounded(own(raw, 'size'), defaults.size, limits.size),
    visible: boolean(own(raw, 'visible'), defaults.visible),
    labels: boolean(own(raw, 'labels'), defaults.labels),
  };
}

function nodeOverrides(raw, defaults, base, limits) {
  const valid = (key, value) => key === 'color' ? typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)
    : key === 'size' ? typeof value === 'number' && Number.isFinite(value)
    : (key === 'visible' || key === 'labels') && typeof value === 'boolean';
  const overrides = Object.fromEntries([Object.entries(defaults), object(raw) ? Object.entries(raw) : []]
    .flat().filter(([key, value]) => valid(key, value)));
  const normalized = nodeStyle(overrides, base, limits);
  return Object.fromEntries(Object.keys(overrides).map(key => [key, normalized[key]]));
}

function markerStyle(raw, defaults) {
  return {
    visible: boolean(own(raw, 'visible'), defaults.visible),
    color: color(own(raw, 'color'), defaults.color),
  };
}

export function normalizeNetworkStyles(raw, config) {
  const source = object(raw) && own(raw, 'version') === config.storage.version ? raw : {};
  const edges = own(source, 'edges'), nodes = own(source, 'nodes'), tags = own(source, 'tags');
  const computation = own(source, 'computation');
  return {
    version: config.storage.version,
    edges: Object.fromEntries(Object.entries(config.edges.types).map(([key, defaults]) => [key,
      edgeStyle(own(edges, key), defaults, config.edges.limits),
    ])),
    nodes: Object.fromEntries(Object.entries(config.nodes.types).map(([key, defaults]) => [key,
      nodeStyle(own(nodes, key), defaults, config.nodes.limits),
    ])),
    computation: Object.fromEntries(Object.entries(config.nodes.computationTypes).map(([key, defaults]) => {
      const raw = own(computation, key);
      const overrides = nodeOverrides(raw, defaults.overrides, config.nodes.types.node, config.nodes.limits);
      return [key, { ...overrides, ...(defaults.marker ? { marker: markerStyle(own(raw, 'marker'), defaults.marker) } : {}) }];
    })),
    // A tag is model-authored text, even when it is named "__proto__".
    // fromEntries creates own data properties without invoking prototype setters.
    tags: Object.fromEntries((object(tags) ? Object.entries(tags) : [])
      .filter(([, value]) => object(value))
      .map(([tag, value]) => [tag, nodeStyle(value, config.nodes.types.node, config.nodes.limits)])),
  };
}

export function defaultNetworkStyles(config) {
  return normalizeNetworkStyles(null, config);
}
