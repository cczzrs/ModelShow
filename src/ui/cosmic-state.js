/** UI geometry only. No model, scheduler or rendering state belongs in this file. */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
export const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
const color = (value, fallback) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
export const isRailAppearanceTarget = key => key === 'menu' || key === 'dock';
export const GLOBAL_APPEARANCE_KEYS = ['background', 'accent', 'hover', 'focus', 'border', 'selectionBackground', 'selectionForeground'];
export const appearanceLimits = (config, key) => key === 'global' ? {}
  : isRailAppearanceTarget(key) ? config.rail.appearance.limits
    : { ...config.appearance.limits, ...config.windows[key]?.appearanceLimits };
export const windowZone = (value, key, config) => key === 'scene' ? 'scene'
  : ['scene', 'tools'].includes(value) ? value : config.windows[key].zone ?? config.geometry.defaultZone;

export function defaultAppearance(config, key) {
  if (key === 'global') return {
    ...Object.fromEntries(GLOBAL_APPEARANCE_KEYS.map(name => [name, config.theme[name]])),
    glassEnabled: config.theme.glass.enabled,
    glassBlur: config.theme.glass.blur,
  };
  if (isRailAppearanceTarget(key)) return { ...config.rail.appearance[key] };
  const appearance = config.appearance;
  return {
    background: appearance.background,
    foreground: appearance.foreground,
    opacity: appearance.opacity,
    radius: appearance.radius,
    fontScale: appearance.fontScale,
    ...config.windows[key].appearance,
  };
}

export function normalizeGlobalAppearance(raw, defaults, glassLimits) {
  const value = object(raw) ? raw : {};
  return {
    ...Object.fromEntries(GLOBAL_APPEARANCE_KEYS.map(key => [key, color(value[key], defaults[key])])),
    glassEnabled: typeof value.glassEnabled === 'boolean' ? value.glassEnabled : defaults.glassEnabled,
    glassBlur: clamp(finite(value.glassBlur, defaults.glassBlur), glassLimits.min, glassLimits.max),
  };
}

export function normalizeAppearance(raw, defaults, limits) {
  const value = object(raw) ? raw : {};
  const normalized = {
    background: color(value.background, defaults.background),
    foreground: color(value.foreground, defaults.foreground),
    opacity: clamp(finite(value.opacity, defaults.opacity), limits.opacity.min, limits.opacity.max),
    radius: clamp(finite(value.radius, defaults.radius), limits.radius.min, limits.radius.max),
  };
  if (Object.hasOwn(defaults, 'iconColor')) normalized.iconColor = color(value.iconColor, defaults.iconColor);
  for (const key of ['iconSize', 'fontSize', 'iconOpacity', 'fontOpacity', 'fontScale']) {
    if (Object.hasOwn(defaults, key) && Object.hasOwn(limits, key)) {
      normalized[key] = clamp(finite(value[key], defaults[key]), limits[key].min, limits[key].max);
    }
  }
  return normalized;
}

export function defaultWorkspaceState(config) {
  return normalizeWorkspaceState(null, config);
}

/** The rail is shared by both layouts; legacy v2 saves simply receive defaults. */
export function normalizeRail(raw, config) {
  const value = object(raw) ? raw : {};
  return Object.fromEntries(['width', 'menuRatio'].map(key => {
    const limits = config.rail[key];
    return [key, clamp(finite(value[key], limits.value), limits.min, limits.max)];
  }));
}

/** Fit the rail without changing its saved width, retaining an operable minimum. */
export function fitRailWidth(width, shellWidth, config) {
  const limits = config.rail.width;
  const available = finite(shellWidth, limits.max + config.rail.geometry.minWorkspaceWidth) - config.rail.geometry.minWorkspaceWidth;
  return clamp(finite(width, limits.value), limits.min, Math.min(limits.max, available));
}

/** Each display mode owns its geometry and visibility; appearance is shared separately. */
export function normalizeWorkspaceLayout(raw, config, mode) {
  const value = object(raw) ? raw : {};
  const supplied = object(value.windows) ? value.windows : {};
  const windows = {};
  for (const [key, base] of Object.entries(config.windows)) {
    const defaults = { ...base, ...config.display.modes[mode].windows[key] };
    const entry = Object.hasOwn(supplied, key) && object(supplied[key]) ? supplied[key] : {};
    const minWidth = defaults.minWidth ?? config.geometry.minWidth;
    const minHeight = defaults.minHeight ?? config.geometry.minHeight;
    const maximum = config.geometry.maxCanvasHeight;
    windows[key] = {
      zone: mode === 'single' ? 'scene' : windowZone(entry.zone ?? defaults.zone, key, config),
      x: clamp(finite(entry.x, defaults.x), 0, maximum),
      y: clamp(finite(entry.y, defaults.y), 0, maximum - config.geometry.titleHeight),
      width: clamp(finite(entry.width, defaults.width), minWidth, maximum),
      height: clamp(finite(entry.height, defaults.height), minHeight, maximum),
      visible: typeof entry.visible === 'boolean' ? entry.visible : defaults.visible,
      collapsed: typeof entry.collapsed === 'boolean' ? entry.collapsed : defaults.collapsed,
      fill: mode === 'single' && key === 'scene' || defaults.fill === true && (typeof entry.fill === 'boolean' ? entry.fill : true),
    };
  }
  const keys = Object.keys(windows);
  const knownOrder = order => Array.isArray(order) ? [...new Set(order.filter(key => typeof key === 'string' && Object.hasOwn(windows, key)))] : [];
  const configured = knownOrder(config.display.modes[mode].order);
  const defaults = [...keys.filter(key => !configured.includes(key)), ...configured];
  const order = Array.isArray(value.order) ? knownOrder(value.order) : defaults;
  return { windows, order: [...defaults.filter(key => !order.includes(key)), ...order] };
}

/** Invalid fields fall back independently; unknown windows and runtime fields are discarded. */
export function normalizeWorkspaceState(raw, config) {
  const value = object(raw) && raw.version === config.storage.version ? raw : {};
  const layouts = object(value.layouts) ? value.layouts : {};
  const appearance = object(value.appearance) ? value.appearance : {};
  return {
    version: config.storage.version,
    displayMode: ['dual', 'single'].includes(value.displayMode) ? value.displayMode : config.display.mode,
    split: clamp(finite(value.split, config.split.value), config.split.min, config.split.max),
    rail: normalizeRail(value.rail, config),
    layouts: {
      dual: normalizeWorkspaceLayout(layouts.dual, config, 'dual'),
      single: normalizeWorkspaceLayout(layouts.single, config, 'single'),
    },
    appearance: Object.fromEntries([...Object.keys(config.windows), 'menu', 'dock', 'global'].map(key => [key,
      key === 'global' ? normalizeGlobalAppearance(appearance.global, defaultAppearance(config, key), config.theme.glass.limits)
        : normalizeAppearance(Object.hasOwn(appearance, key) ? appearance[key] : null, defaultAppearance(config, key), appearanceLimits(config, key)),
    ])),
  };
}

export function changeDisplayMode(state, mode) {
  if (!['dual', 'single'].includes(mode)) return state;
  return { ...state, displayMode: mode };
}

export function resetCurrentLayout(state, config) {
  return {
    ...state,
    split: state.displayMode === 'dual' ? config.split.value : state.split,
    layouts: { ...state.layouts, [state.displayMode]: normalizeWorkspaceLayout(null, config, state.displayMode) },
  };
}

/** Return a temporary fit, preserving preferred geometry for a later larger viewport. */
export function fitWindowGeometry(window, bounds, config, key) {
  const { padding, titleHeight } = config.geometry;
  const spec = config.windows[key];
  const availableWidth = Math.max(1, bounds.width - padding * 2);
  const availableHeight = Math.max(titleHeight, bounds.height - padding * 2);
  if (window.fill) return { x: padding, y: padding, width: availableWidth, height: availableHeight };
  const width = clamp(window.width, Math.min(spec.minWidth ?? config.geometry.minWidth, availableWidth), availableWidth);
  const height = clamp(window.height, Math.min(spec.minHeight ?? config.geometry.minHeight, availableHeight), availableHeight);
  const occupiedHeight = window.collapsed ? titleHeight : height;
  return {
    x: clamp(window.x, padding, bounds.width - width - padding),
    y: clamp(window.y, padding, bounds.height - occupiedHeight - padding),
    width,
    height,
  };
}

/** Apply a gesture to its starting rectangle; no cumulative pointer rounding drift. */
export function changeWindowGeometry(window, start, delta, kind, bounds, config, key) {
  const next = { ...window, ...start, fill: false };
  if (kind === 'move') {
    return placeWindowGeometry(window.fill ? next : window, { x: start.x + delta.x, y: start.y + delta.y }, bounds, config, key);
  } else {
    next.width += delta.x;
    next.height += delta.y;
    const padding = config.geometry.padding;
    next.width = Math.min(next.width, bounds.width - start.x - padding);
    next.height = Math.min(next.height, bounds.height - start.y - padding);
  }
  return { ...next, ...fitWindowGeometry(next, bounds, config, key) };
}

/** Moving between work areas changes local position, never the preferred window size. */
export function placeWindowGeometry(window, point, bounds, config, key, zone = window.zone) {
  const next = { ...window, x: point.x, y: point.y, zone: windowZone(zone, key, config), fill: false };
  const fitted = fitWindowGeometry(next, bounds, config, key);
  return { ...next, x: fitted.x, y: fitted.y };
}

/** Convert a viewport pointer to a local title position, accounting for scroll once. */
export function windowPointFromPointer(pointer, grab, area) {
  return {
    x: pointer.x - grab.x - area.left + area.scrollLeft,
    y: pointer.y - grab.y - area.top + area.scrollTop,
  };
}
