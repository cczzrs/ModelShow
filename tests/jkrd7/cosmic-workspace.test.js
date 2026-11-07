import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_CONFIG } from '../../html/config.js';
import {
  defaultWorkspaceState, normalizeWorkspaceState, normalizeAppearance, normalizeGlobalAppearance, defaultAppearance,
  fitWindowGeometry, changeWindowGeometry, placeWindowGeometry, windowPointFromPointer,
  changeDisplayMode, resetCurrentLayout, fitRailWidth,
} from '../../src/ui/cosmic-state.js';
import { CosmicWorkspace } from '../../src/ui/cosmic-workspace.js';

const config = APP_CONFIG.desktop;
const clone = value => structuredClone(value);

test('saved desktop restores geometry, visibility and appearance without retaining model state', () => {
  const originalConfig = clone(config);
  const saved = defaultWorkspaceState(config);
  Object.assign(saved.layouts.dual.windows.input, { x: 55, y: 320, width: 380, height: 310, visible: false, collapsed: true });
  saved.appearance.input = { background: '#224466', foreground: '#ddeeff', opacity: 0.61, radius: 9 };
  saved.layouts.dual.windows.input.q = 1;
  saved.layouts.dual.windows.input.tasks = [{ node: 'G1.Q1' }];
  saved.model = { q: 1 };
  const result = normalizeWorkspaceState(JSON.parse(JSON.stringify(saved)), config);
  assert.deepEqual(result.layouts.dual.windows.input, {
    zone: 'tools', x: 55, y: 320, width: 380, height: 310, visible: false, collapsed: true, fill: false,
  });
  assert.deepEqual(Object.keys(result), ['version', 'displayMode', 'split', 'rail', 'layouts', 'appearance']);
  assert.deepEqual(result.appearance.input, { background: '#224466', foreground: '#ddeeff', opacity: 0.61, radius: 9, fontScale: defaultAppearance(config, 'input').fontScale });
  assert.deepEqual(config, originalConfig);
});

test('corrupt stored settings cannot create unknown windows or invalid dimensions', () => {
  const saved = defaultWorkspaceState(config);
  saved.split = Infinity;
  saved.layouts.dual.windows.input.x = NaN;
  saved.layouts.dual.windows.input.y = -200;
  saved.layouts.dual.windows.input.width = '1200';
  saved.layouts.dual.windows.input.height = 1e10;
  saved.layouts.dual.windows.input.visible = 'false';
  saved.layouts.dual.windows.input.collapsed = null;
  saved.layouts.dual.windows.input.fill = true;
  saved.layouts.dual.windows.bad = { x: 0, visible: true };
  saved.layouts.dual.order = ['bad', 'input', 'input', 'scene', null];
  const result = normalizeWorkspaceState(saved, config);
  assert.equal(result.split, config.split.value);
  assert.equal(result.layouts.dual.windows.input.x, config.windows.input.x);
  assert.equal(result.layouts.dual.windows.input.y, 0);
  assert.equal(result.layouts.dual.windows.input.width, config.windows.input.width);
  assert.equal(result.layouts.dual.windows.input.height, config.geometry.maxCanvasHeight);
  assert.equal(result.layouts.dual.windows.input.visible, config.windows.input.visible);
  assert.equal(result.layouts.dual.windows.input.collapsed, config.windows.input.collapsed);
  assert.equal(result.layouts.dual.windows.input.fill, false);
  assert.equal(Object.hasOwn(result.layouts.dual.windows, 'bad'), false);
  assert.equal(new Set(result.layouts.dual.order).size, Object.keys(config.windows).length);
  assert.deepEqual(result.layouts.dual.order.slice(-2), ['input', 'scene']);
});

test('unsupported storage versions and non-object storage reset to current defaults', () => {
  const defaults = defaultWorkspaceState(config);
  for (const raw of [null, [], 'state', 3, { version: config.storage.version + 1, windows: { input: { visible: false } } }]) {
    assert.deepEqual(normalizeWorkspaceState(raw, config), defaults);
  }
});

test('each display mode uses its configured default order and completes missing windows once', () => {
  const custom = clone(config), keys = Object.keys(custom.windows);
  custom.display.modes.single.order = ['tasks', 'scene', 'tasks', 'unknown', null, 'input'];
  custom.display.modes.dual.order = ['models', 'output'];
  const defaults = defaultWorkspaceState(custom);
  assert.deepEqual(defaults.layouts.single.order, [...keys.filter(key => !['tasks', 'scene', 'input'].includes(key)), 'tasks', 'scene', 'input']);
  assert.deepEqual(defaults.layouts.dual.order, [...keys.filter(key => !['models', 'output'].includes(key)), 'models', 'output']);
  for (const order of [undefined, null, 'invalid', []]) {
    const saved = clone(defaults);
    saved.layouts.single.order = order;
    assert.deepEqual(normalizeWorkspaceState(saved, custom).layouts.single.order, defaults.layouts.single.order);
  }
});

test('saved window order stays above configured defaults and layout reset restores the configured order', () => {
  const custom = clone(config);
  custom.display.modes.single.order = [...Object.keys(custom.windows)].reverse();
  const defaults = defaultWorkspaceState(custom), saved = clone(defaults);
  saved.displayMode = 'single';
  saved.layouts.single.order = ['input', 'scene', 'input', 'unknown'];
  const restored = normalizeWorkspaceState(saved, custom);
  assert.deepEqual(restored.layouts.single.order, [...defaults.layouts.single.order.filter(key => !['input', 'scene'].includes(key)), 'input', 'scene']);
  assert.deepEqual(normalizeWorkspaceState(restored, custom), restored);
  assert.deepEqual(resetCurrentLayout(restored, custom).layouts.single.order, defaults.layouts.single.order);
  assert.deepEqual(restored.layouts.dual, defaults.layouts.dual);
});

test('startup appearance target uses valid configuration without replacing the restored active window', () => {
  // Exercise constructor initialization while stubbing only DOM event/rendering ports.
  class StartupWorkspace extends CosmicWorkspace {
    configureAppearanceFields() {}
    listen() {}
    render() {}
  }
  const saved = defaultWorkspaceState(config);
  saved.displayMode = 'single';
  saved.layouts.single.windows.input.visible = true;
  saved.layouts.single.order = saved.layouts.single.order.filter(key => key !== 'input').concat('input');
  const serialized = JSON.stringify(saved);
  const root = {
    ownerDocument: { defaultView: {
      localStorage: { getItem: () => serialized, setItem() { assert.fail('startup must not overwrite saved settings'); } },
      ResizeObserver: class { observe() {} },
    } },
    querySelector: () => ({}), querySelectorAll: () => [],
  };
  for (const target of ['appearance', 'scene', 'menu', 'dock', 'global', 'network-edges', 'network-nodes', undefined, null, 3, {}, 'unknown', '__proto__']) {
    const custom = clone(config); custom.appearance.target = target;
    const workspace = new StartupWorkspace({ root, config: custom });
    assert.equal(workspace.focused, 'input');
    assert.equal(workspace.styleTarget, ['appearance', 'scene', 'menu', 'dock', 'global', 'network-edges', 'network-nodes'].includes(target) ? target : 'input');
    assert.deepEqual(workspace.state, saved);
  }
});

test('appearance admits only hex colors and finite bounded opacity and corner radius', () => {
  const defaults = defaultWorkspaceState(config).appearance.input;
  assert.deepEqual(normalizeAppearance({ background: 'url(https://example.test)', foreground: '#AABBCC', opacity: -1, radius: Infinity }, defaults, config.appearance.limits), {
    ...defaults, foreground: '#aabbcc', opacity: config.appearance.limits.opacity.min,
  });
  assert.deepEqual(normalizeAppearance({ opacity: 20, radius: 500 }, defaults, config.appearance.limits), {
    ...defaults, opacity: config.appearance.limits.opacity.max, radius: config.appearance.limits.radius.max,
  });
});

test('global appearance separates seven colors from glass controls without creating a global window', () => {
  const defaults = defaultAppearance(config, 'global');
  assert.deepEqual(Object.keys(defaults), [
    'background', 'accent', 'hover', 'focus', 'border', 'selectionBackground', 'selectionForeground',
    'glassEnabled', 'glassBlur',
  ]);
  assert.deepEqual(normalizeGlobalAppearance({
    background: '#AABBCC', accent: 'red', hover: '#123', focus: null, border: 42,
    selectionBackground: 'url(example)', selectionForeground: '#12345678', opacity: 0, fontScale: 2,
  }, defaults, config.theme.glass.limits), { ...defaults, background: '#aabbcc' });
  for (const value of [undefined, null, [], 'colors']) assert.deepEqual(normalizeGlobalAppearance(value, defaults, config.theme.glass.limits), defaults);
  const state = defaultWorkspaceState(config);
  for (const layout of Object.values(state.layouts)) {
    assert.equal(Object.hasOwn(layout.windows, 'global'), false);
    assert.equal(layout.order.includes('global'), false);
  }
  defaults.background = '#000000';
  assert.equal(config.theme.background, state.appearance.global.background);
});

test('global glass settings validate boolean and finite blur independently from colors', () => {
  const defaults = defaultAppearance(config, 'global'), limits = config.theme.glass.limits;
  assert.equal(defaults.glassEnabled, true);
  assert.equal(defaults.glassBlur, 14);
  assert.deepEqual(normalizeGlobalAppearance({ background: '#ABCDEF', glassEnabled: false, glassBlur: 0 }, defaults, limits), {
    ...defaults, background: '#abcdef', glassEnabled: false, glassBlur: 0,
  });
  for (const invalid of [null, '14', '#ffffff', NaN, Infinity, {}, []]) {
    assert.deepEqual(normalizeGlobalAppearance({ glassEnabled: invalid, glassBlur: invalid }, defaults, limits), defaults);
  }
  assert.equal(normalizeGlobalAppearance({ glassBlur: -10 }, defaults, limits).glassBlur, limits.min);
  assert.equal(normalizeGlobalAppearance({ glassBlur: 1000 }, defaults, limits).glassBlur, limits.max);
  assert.equal(normalizeGlobalAppearance({ glassBlur: 25 }, defaults, { min: 2, max: 20 }).glassBlur, 20);
});

test('existing v2 colors gain glass defaults without resetting layouts or other appearances', () => {
  const saved = defaultWorkspaceState(config);
  saved.appearance.global.background = '#123456';
  saved.appearance.input.opacity = 0.37;
  delete saved.appearance.global.glassEnabled;
  delete saved.appearance.global.glassBlur;
  const restored = normalizeWorkspaceState(saved, config);
  assert.deepEqual(restored, {
    ...saved,
    appearance: { ...saved.appearance, global: { ...saved.appearance.global, glassEnabled: true, glassBlur: 14 } },
  });
  restored.appearance.global.glassEnabled = false;
  restored.appearance.global.glassBlur = 0;
  assert.deepEqual(normalizeWorkspaceState(JSON.parse(JSON.stringify(restored)), config), restored);
  delete restored.appearance.global.glassBlur;
  assert.equal(normalizeWorkspaceState(restored, config).appearance.global.glassEnabled, false);
  assert.equal(normalizeWorkspaceState(restored, config).appearance.global.glassBlur, config.theme.glass.blur);
});

test('captured module and rail appearances become defaults while scene opacity stays independent', () => {
  const saved = defaultWorkspaceState(config);
  const common = { background: '#172432', foreground: '#e5edf6', opacity: 0.84, radius: 14, fontScale: 1 };
  const dark = { background: '#000000', foreground: '#ffffff', opacity: 0.15, radius: 18, fontScale: 1.1 };
  const overrides = {
    scene: { background: '#122630', foreground: '#ffffff', opacity: 1, radius: 0, fontScale: 1.1 },
    controls: dark, inspector: dark, appearance: dark,
    overview: { background: '#000000', foreground: '#e5edf6', opacity: 0.15, radius: 18, fontScale: 1 },
  };
  for (const key of Object.keys(config.windows)) {
    assert.deepEqual(saved.appearance[key], overrides[key] ?? common, key);
  }
  for (const key of ['menu', 'dock']) {
    assert.deepEqual(saved.appearance[key], {
      background: '#000000', foreground: '#e5edf6', opacity: 1, radius: 18,
      iconColor: '#e5edf6', iconSize: 30, iconOpacity: 1, fontSize: 15, fontOpacity: 1,
    }, key);
  }
  saved.appearance.scene.opacity = 0;
  saved.appearance.input.opacity = 0;
  const restored = normalizeWorkspaceState(JSON.parse(JSON.stringify(saved)), config);
  assert.equal(restored.appearance.scene.opacity, 0);
  assert.equal(restored.appearance.input.opacity, config.appearance.limits.opacity.min);
  assert.equal(restored.appearance.scene.foreground, overrides.scene.foreground);
  assert.equal(restored.appearance.scene.fontScale, overrides.scene.fontScale);
});

test('global appearance restores independently and remains shared across display mode and layout reset', () => {
  const saved = defaultWorkspaceState(config);
  saved.appearance.input.foreground = '#123456';
  saved.appearance.scene.opacity = 0;
  saved.rail.width = 240;
  delete saved.appearance.global;
  const restored = normalizeWorkspaceState(saved, config);
  assert.deepEqual(restored.appearance.global, defaultAppearance(config, 'global'));
  assert.equal(restored.appearance.input.foreground, '#123456');
  assert.equal(restored.appearance.scene.opacity, 0);
  assert.deepEqual(restored.layouts, saved.layouts);
  assert.deepEqual(restored.rail, saved.rail);
  Object.assign(restored.appearance.global, { accent: '#abcdef', selectionBackground: '#445566' });
  const single = changeDisplayMode(restored, 'single');
  assert.equal(single.appearance.global, restored.appearance.global);
  const reset = resetCurrentLayout(single, config);
  assert.deepEqual(reset.appearance.global, restored.appearance.global);
  assert.deepEqual(normalizeWorkspaceState(JSON.parse(JSON.stringify(reset)), config).appearance, reset.appearance);
});

test('temporary narrow viewport fit preserves preferred geometry for restored desktop width', () => {
  const preferred = { ...defaultWorkspaceState(config).layouts.dual.windows.models, x: 100, width: 580 };
  const before = clone(preferred);
  const narrow = fitWindowGeometry(preferred, { width: 190, height: 800 }, config, 'models');
  assert.equal(narrow.x, config.geometry.padding);
  assert.equal(narrow.width, 190 - config.geometry.padding * 2);
  assert.deepEqual(preferred, before);
  const wide = fitWindowGeometry(preferred, { width: 900, height: 800 }, config, 'models');
  assert.equal(wide.x, 100);
  assert.equal(wide.width, 580);
});

test('scene fills its own side and becomes a movable manual rectangle after interaction', () => {
  const scene = defaultWorkspaceState(config).layouts.dual.windows.scene;
  const bounds = { width: 800, height: 600 };
  const rect = fitWindowGeometry(scene, bounds, config, 'scene');
  assert.deepEqual(rect, { x: 12, y: 12, width: 776, height: 576 });
  const resized = changeWindowGeometry(scene, rect, { x: -200, y: -180 }, 'resize', bounds, config, 'scene');
  assert.equal(resized.fill, false);
  assert.equal(resized.width, 576);
  assert.equal(resized.height, 396);
  const moved = changeWindowGeometry(resized, resized, { x: 80, y: 80 }, 'move', bounds, config, 'scene');
  assert.equal(moved.x, 92);
  assert.equal(moved.y, 92);
  assert.equal(scene.fill, true);
});

test('large drag deltas keep windows recoverable and cannot place a title beyond the canvas', () => {
  const state = defaultWorkspaceState(config).layouts.dual.windows.input;
  const bounds = { width: 700, height: config.geometry.maxCanvasHeight };
  const rect = fitWindowGeometry(state, bounds, config, 'input');
  const moved = changeWindowGeometry(state, rect, { x: 100000, y: 100000 }, 'move', bounds, config, 'input');
  assert.equal(moved.x + moved.width, bounds.width - config.geometry.padding);
  assert.equal(moved.y + moved.height, bounds.height - config.geometry.padding);
  const corner = changeWindowGeometry(state, rect, { x: -100000, y: -100000 }, 'move', bounds, config, 'input');
  assert.equal(corner.x, config.geometry.padding);
  assert.equal(corner.y, config.geometry.padding);
});

test('collapsed windows retain expanded height while only their title occupies canvas height', () => {
  const state = { ...defaultWorkspaceState(config).layouts.dual.windows.input, height: 400, y: 780, collapsed: true };
  const rect = fitWindowGeometry(state, { width: 700, height: 800 }, config, 'input');
  assert.equal(rect.height, 400);
  assert.equal(rect.y, 800 - config.geometry.padding - config.geometry.titleHeight);
  const expanded = fitWindowGeometry({ ...state, collapsed: false }, { width: 700, height: 800 }, config, 'input');
  assert.equal(expanded.height, 400);
  assert.equal(expanded.y, 800 - config.geometry.padding - 400);
});

test('resize uses gesture starting rectangle and enforces the remaining right and lower space', () => {
  const state = { ...defaultWorkspaceState(config).layouts.dual.windows.input, x: 250, y: 150, width: 300, height: 200 };
  const bounds = { width: 700, height: 800 };
  const grown = changeWindowGeometry(state, state, { x: 2000, y: 2000 }, 'resize', bounds, config, 'input');
  assert.equal(grown.x, 250); assert.equal(grown.y, 150);
  assert.equal(grown.width, 438); assert.equal(grown.height, 638);
  const shrunk = changeWindowGeometry(state, state, { x: -2000, y: -2000 }, 'resize', bounds, config, 'input');
  assert.equal(shrunk.width, config.geometry.minWidth);
  assert.equal(shrunk.height, config.geometry.minHeight);
});

test('cross-area placement persists while invalid area names reset and 3D remains on the left', () => {
  const saved = defaultWorkspaceState(config);
  saved.layouts.dual.windows.input.zone = 'scene';
  saved.layouts.dual.windows.input.x = 80; saved.layouts.dual.windows.input.y = 120;
  saved.layouts.dual.windows.scene.zone = 'tools';
  saved.layouts.dual.windows.tasks.zone = 'outside';
  delete saved.layouts.dual.windows.events.zone;
  const result = normalizeWorkspaceState(JSON.parse(JSON.stringify(saved)), config);
  assert.equal(result.layouts.dual.windows.input.zone, 'scene');
  assert.equal(result.layouts.dual.windows.input.x, 80);
  assert.equal(result.layouts.dual.windows.input.y, 120);
  assert.equal(result.layouts.dual.windows.scene.zone, 'scene');
  assert.equal(result.layouts.dual.windows.tasks.zone, config.geometry.defaultZone);
  assert.equal(result.layouts.dual.windows.events.zone, config.geometry.defaultZone);
});

test('crossing a scrolled work area converts viewport and title grab coordinates exactly once', () => {
  const grab = { x: 30, y: 12 };
  const toolsPoint = windowPointFromPointer({ x: 900, y: 120 }, grab, { left: 800, top: 40, scrollLeft: 0, scrollTop: 500 });
  assert.deepEqual(toolsPoint, { x: 70, y: 568 });
  const scenePoint = windowPointFromPointer({ x: 340, y: 120 }, grab, { left: 0, top: 40, scrollLeft: 0, scrollTop: 0 });
  assert.deepEqual(scenePoint, { x: 310, y: 68 });
  const state = { ...defaultWorkspaceState(config).layouts.dual.windows.input, width: 300, height: 200 };
  const inScene = placeWindowGeometry(state, scenePoint, { width: 800, height: 700 }, config, 'input', 'scene');
  assert.equal(inScene.zone, 'scene');
  assert.equal(inScene.x, 310); assert.equal(inScene.y, 68);
  const returned = placeWindowGeometry(inScene, toolsPoint, { width: 500, height: 6000 }, config, 'input', 'tools');
  assert.equal(returned.zone, 'tools');
  assert.equal(returned.x, 70); assert.equal(returned.y, 568);
});

test('moving across narrow and wide areas preserves preferred size without cumulative shrink', () => {
  const preferred = { ...defaultWorkspaceState(config).layouts.dual.windows.models, width: 580, height: 540 };
  const narrowBounds = { width: 320, height: 6000 };
  const narrow = placeWindowGeometry(preferred, { x: 100, y: 80 }, narrowBounds, config, 'models', 'tools');
  assert.equal(narrow.width, 580); assert.equal(narrow.height, 540);
  assert.equal(fitWindowGeometry(narrow, narrowBounds, config, 'models').width, 296);
  const wideBounds = { width: 800, height: 700 };
  const wide = placeWindowGeometry(narrow, { x: 100, y: 80 }, wideBounds, config, 'models', 'scene');
  assert.equal(wide.width, 580); assert.equal(wide.height, 540);
  assert.equal(fitWindowGeometry(wide, wideBounds, config, 'models').width, 580);
  const dragged = changeWindowGeometry(narrow, fitWindowGeometry(narrow, narrowBounds, config, 'models'), { x: 0, y: 20 }, 'move', narrowBounds, config, 'models');
  assert.equal(dragged.width, 580);
  assert.equal(dragged.y, 100);
});

test('single mode has independent configured defaults with every tool over the scene', () => {
  const state = defaultWorkspaceState(config);
  assert.equal(state.displayMode, 'single');
  const dual = state.layouts.dual.windows, single = state.layouts.single.windows;
  assert.notEqual(dual, single);
  assert.notEqual(dual.input, single.input);
  assert.equal(single.input.x, config.display.modes.single.windows.input.x);
  assert.equal(dual.input.x, config.windows.input.x);
  assert.ok(Object.values(single).every(window => window.zone === 'scene'));
  assert.equal(single.scene.fill, true);
  assert.equal(single.scene.visible, true);
  assert.equal(single.scene.collapsed, false);
  assert.ok(Object.values(single).every(window => !Object.hasOwn(window, 'appearance')));
});

test('reload restores both layouts and their separate window visibility, collapse state and order', () => {
  const saved = defaultWorkspaceState(config);
  saved.displayMode = 'single'; saved.split = 0.73;
  Object.assign(saved.layouts.dual.windows.input, { x: 31, y: 123, width: 370, height: 270, visible: false, collapsed: true });
  Object.assign(saved.layouts.single.windows.input, { x: 430, y: 66, width: 330, height: 350, visible: true, collapsed: false });
  saved.layouts.dual.order = saved.layouts.dual.order.filter(key => key !== 'input').concat('input');
  saved.layouts.single.order = saved.layouts.single.order.filter(key => key !== 'models').concat('models');
  const restored = normalizeWorkspaceState(JSON.parse(JSON.stringify(saved)), config);
  assert.deepEqual(restored, saved);
  assert.equal(restored.layouts.dual.order.at(-1), 'input');
  assert.equal(restored.layouts.single.order.at(-1), 'models');
});

test('switching display mode changes only the selected layout and shares one appearance map', () => {
  const dual = changeDisplayMode(defaultWorkspaceState(config), 'dual');
  const before = clone(dual);
  const single = changeDisplayMode(dual, 'single');
  assert.equal(single.displayMode, 'single');
  assert.equal(single.layouts.dual, dual.layouts.dual);
  assert.equal(single.layouts.single, dual.layouts.single);
  assert.equal(single.appearance, dual.appearance);
  assert.deepEqual(dual, before);
  single.appearance.input.radius = 23;
  const returned = changeDisplayMode(single, 'dual');
  assert.equal(returned.appearance.input.radius, 23);
  assert.deepEqual(returned.layouts, before.layouts);
  assert.equal(changeDisplayMode(returned, 'unknown'), returned);
});

test('resetting single mode keeps the dual layout, split ratio and shared appearance', () => {
  let state = changeDisplayMode(defaultWorkspaceState(config), 'single');
  state.split = 0.71;
  state.layouts.dual.windows.input.x = 89;
  state.layouts.single.windows.input.x = 50;
  state.layouts.single.windows.events.collapsed = false;
  state.appearance.input.background = '#123456';
  const dual = clone(state.layouts.dual), appearance = clone(state.appearance);
  state = resetCurrentLayout(state, config);
  assert.equal(state.displayMode, 'single');
  assert.equal(state.split, 0.71);
  assert.deepEqual(state.layouts.dual, dual);
  assert.deepEqual(state.appearance, appearance);
  assert.deepEqual(state.layouts.single, defaultWorkspaceState(config).layouts.single);
});

test('resetting dual mode restores its split and geometry without touching single mode', () => {
  let state = changeDisplayMode(defaultWorkspaceState(config), 'dual');
  state.split = 0.71;
  state.layouts.dual.windows.input.x = 89;
  state.layouts.single.windows.input.x = 50;
  state.layouts.single.windows.models.visible = true;
  state.appearance.models.opacity = 0.55;
  const single = clone(state.layouts.single), appearance = clone(state.appearance);
  state = resetCurrentLayout(state, config);
  assert.equal(state.split, config.split.value);
  assert.deepEqual(state.layouts.dual, defaultWorkspaceState(config).layouts.dual);
  assert.deepEqual(state.layouts.single, single);
  assert.deepEqual(state.appearance, appearance);
});

test('malformed mode data cannot put a single-mode window in the hidden tools area', () => {
  const state = defaultWorkspaceState(config);
  const dual = clone(state.layouts.dual);
  state.displayMode = 'invalid';
  state.layouts.single.windows.input.zone = 'tools';
  state.layouts.single.windows.scene.fill = false;
  state.layouts.single.windows.tasks.width = NaN;
  state.layouts.single.windows.unknown = { visible: true };
  state.layouts.single.order = ['unknown', 'input', 'input'];
  state.appearance.unknown = { background: '#123456' };
  const restored = normalizeWorkspaceState(state, config);
  assert.equal(restored.displayMode, config.display.mode);
  assert.equal(restored.layouts.single.windows.input.zone, 'scene');
  assert.equal(restored.layouts.single.windows.scene.fill, true);
  assert.equal(Number.isFinite(restored.layouts.single.windows.tasks.width), true);
  assert.equal(Object.hasOwn(restored.layouts.single.windows, 'unknown'), false);
  assert.equal(Object.hasOwn(restored.appearance, 'unknown'), false);
  assert.deepEqual(restored.layouts.dual, dual);
});

test('v1 desktop storage is not migrated into the v2 mode layouts', () => {
  const previous = { version: 1, split: 0.8, windows: { input: { x: 900, visible: false } }, order: ['input'] };
  assert.equal(config.storage.version, 2);
  assert.deepEqual(normalizeWorkspaceState(previous, config), defaultWorkspaceState(config));
});

test('existing v2 layouts gain controls and status defaults without resetting other windows', () => {
  const saved = defaultWorkspaceState(config);
  saved.displayMode = 'single'; saved.split = 0.72;
  saved.layouts.dual.windows.input.x = 73;
  saved.layouts.single.windows.input.y = 140;
  saved.appearance.input.foreground = '#abcdef';
  for (const key of ['controls', 'status']) {
    for (const layout of Object.values(saved.layouts)) {
      delete layout.windows[key]; layout.order = layout.order.filter(item => item !== key);
    }
    delete saved.appearance[key];
  }
  const restored = normalizeWorkspaceState(saved, config), defaults = defaultWorkspaceState(config);
  assert.equal(restored.displayMode, 'single'); assert.equal(restored.split, 0.72);
  assert.equal(restored.layouts.dual.windows.input.x, 73);
  assert.equal(restored.layouts.single.windows.input.y, 140);
  assert.equal(restored.appearance.input.foreground, '#abcdef');
  for (const key of ['controls', 'status']) {
    for (const mode of ['dual', 'single']) {
      assert.deepEqual(restored.layouts[mode].windows[key], defaults.layouts[mode].windows[key]);
      assert.equal(restored.layouts[mode].order.filter(item => item === key).length, 1);
    }
    assert.deepEqual(restored.appearance[key], defaults.appearance[key]);
  }
});

test('existing v2 saves gain shared rail defaults while retaining both layouts and appearance', () => {
  const saved = defaultWorkspaceState(config);
  delete saved.rail;
  saved.layouts.dual.windows.input.x = 94;
  saved.layouts.single.windows.input.y = 81;
  saved.appearance.input.radius = 24;
  const restored = normalizeWorkspaceState(saved, config);
  assert.deepEqual(restored.rail, { width: config.rail.width.value, menuRatio: config.rail.menuRatio.value });
  assert.deepEqual(restored.layouts, saved.layouts);
  assert.deepEqual(restored.appearance, saved.appearance);
  assert.equal(restored.version, 2);
});

test('rail restoration rejects non-numeric fields and clamps each field independently', () => {
  const saved = defaultWorkspaceState(config);
  for (const invalid of [undefined, null, [], 'rail', { width: NaN, menuRatio: Infinity }, { width: '260', menuRatio: '0.4' }]) {
    assert.deepEqual(normalizeWorkspaceState({ ...saved, rail: invalid }, config).rail, saved.rail);
  }
  assert.deepEqual(normalizeWorkspaceState({ ...saved, rail: { width: 1e8, menuRatio: -1, model: {} } }, config).rail, {
    width: config.rail.width.max, menuRatio: config.rail.menuRatio.min,
  });
  assert.deepEqual(normalizeWorkspaceState({ ...saved, rail: { width: 0, menuRatio: 4 } }, config).rail, {
    width: config.rail.width.min, menuRatio: config.rail.menuRatio.max,
  });
});

test('narrow rail fit preserves the preferred width and keeps an operable minimum', () => {
  const state = defaultWorkspaceState(config);
  state.rail.width = 320;
  assert.equal(fitRailWidth(state.rail.width, 480, config), 200);
  assert.equal(state.rail.width, 320);
  assert.equal(fitRailWidth(state.rail.width, 1200, config), 320);
  assert.equal(fitRailWidth(state.rail.width, 320, config), config.rail.width.min);
  assert.equal(fitRailWidth(state.rail.width, 0, config), config.rail.width.min);
});

test('rail preferences are shared across modes and survive window layout resets and refresh', () => {
  const state = defaultWorkspaceState(config);
  state.rail = { width: 264, menuRatio: 0.34 };
  state.layouts.dual.windows.input.x = 63;
  state.layouts.single.windows.input.y = 96;
  const single = changeDisplayMode(state, 'single');
  const reset = resetCurrentLayout(single, config);
  assert.deepEqual(reset.rail, state.rail);
  assert.deepEqual(reset.layouts.dual, state.layouts.dual);
  const dual = resetCurrentLayout(changeDisplayMode(reset, 'dual'), config);
  assert.deepEqual(dual.rail, state.rail);
  assert.deepEqual(normalizeWorkspaceState(JSON.parse(JSON.stringify(dual)), config).rail, state.rail);
});

// Exercise the real gesture handlers without a renderer or a synthetic document.
function railWorkspace(shellWidth = 1200) {
  const workspace = Object.create(CosmicWorkspace.prototype);
  Object.assign(workspace, {
    config, state: defaultWorkspaceState(config), active: true, gesture: null,
    root: { dataset: {} }, shell: { clientWidth: shellWidth, style: { setProperty() {} } },
    desktop: { scrollTop: 0, clientWidth: 300 }, sceneArea: { clientWidth: 500 },
    render() {}, save() { this.saved = clone(this.state); },
  });
  const target = id => {
    const captures = new Set(), attributes = new Map();
    const element = {
      closest: selector => selector === `#${id}` ? element : null,
      focus() {}, setPointerCapture: pointer => captures.add(pointer),
      hasPointerCapture: pointer => captures.has(pointer), releasePointerCapture: pointer => captures.delete(pointer),
      setAttribute: (name, value) => attributes.set(name, value), getAttribute: name => attributes.get(name),
    };
    return element;
  };
  workspace.railResize = target('cosmic-rail-resize');
  workspace.railSplitter = target('cosmic-rail-splitter');
  workspace.splitter = target('cosmic-splitter');
  workspace.rail = { getBoundingClientRect: () => ({ width: fitRailWidth(workspace.state.rail.width, shellWidth, config) }) };
  workspace.railMenu = { style: { setProperty() {} }, getBoundingClientRect: () => ({ height: 400 }) };
  workspace.railDock = { style: { setProperty() {} }, getBoundingClientRect: () => ({ height: 400 }) };
  return workspace;
}

const pointerEvent = (target, x = 600, y = 400, pointerId = 1) => ({ target, button: 0, pointerId, clientX: x, clientY: y, preventDefault() {} });
const keyEvent = (target, key, altKey = false) => ({ target, key, altKey, preventDefault() {} });

test('rail width drag starts at fitted width, ignores off-axis motion and cancels to saved preference', () => {
  const workspace = railWorkspace(480);
  workspace.state.rail.width = 320;
  const before = clone(workspace.state.rail);
  workspace.pointerDown(pointerEvent(workspace.railResize));
  workspace.pointerMove(pointerEvent(workspace.railResize, 600, 450));
  workspace.pointerMove(pointerEvent(workspace.railResize, 603));
  assert.deepEqual(workspace.state.rail, before);
  workspace.pointerMove(pointerEvent(workspace.railResize, 620));
  assert.equal(workspace.state.rail.width, 180);
  assert.equal(workspace.root.dataset.windowGesture, 'rail-width');
  workspace.pointerEnd(pointerEvent(workspace.railResize, 620), true);
  assert.deepEqual(workspace.state.rail, before);
  assert.equal(workspace.gesture, null);
  assert.equal(workspace.railResize.hasPointerCapture(1), false);
  assert.equal(workspace.root.dataset.windowGesture, undefined);
  workspace.pointerDown(pointerEvent(workspace.railResize));
  workspace.pointerMove(pointerEvent(workspace.railResize, 580));
  workspace.pointerEnd(pointerEvent(workspace.railResize, 580));
  assert.equal(workspace.saved.rail.width, 200);
});

test('rail menu drag uses only available row height and persists or cancels independently of scene split', () => {
  const workspace = railWorkspace();
  workspace.state.displayMode = 'dual';
  workspace.state.split = 0.6;
  workspace.state.rail.menuRatio = 0.5;
  const split = workspace.state.split;
  workspace.pointerDown(pointerEvent(workspace.railSplitter));
  workspace.pointerMove(pointerEvent(workspace.railSplitter, 600, 480));
  assert.equal(workspace.state.rail.menuRatio, 0.6);
  assert.equal(workspace.state.split, split);
  workspace.pointerEnd(pointerEvent(workspace.railSplitter, 600, 480));
  assert.equal(workspace.saved.rail.menuRatio, 0.6);
  workspace.pointerDown(pointerEvent(workspace.railSplitter));
  workspace.pointerMove(pointerEvent(workspace.railSplitter, 600, -10000));
  assert.equal(workspace.state.rail.menuRatio, config.rail.menuRatio.min);
  workspace.cancelGesture();
  assert.equal(workspace.state.rail.menuRatio, 0.6);
  workspace.pointerDown(pointerEvent(workspace.splitter));
  workspace.pointerMove(pointerEvent(workspace.splitter, 680));
  assert.equal(workspace.state.split, split + 0.1);
  workspace.cancelGesture();
  assert.equal(workspace.state.split, split);
  assert.equal(workspace.state.rail.menuRatio, 0.6);
});

test('keyboard input during a drag cannot persist a gesture that is later cancelled', () => {
  const workspace = railWorkspace();
  workspace.save();
  const before = clone(workspace.saved);
  workspace.pointerDown(pointerEvent(workspace.railResize));
  workspace.pointerMove(pointerEvent(workspace.railResize, 500));
  assert.equal(workspace.state.rail.width, 180);
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) workspace.keydown(keyEvent(workspace.railResize, key));
  assert.equal(workspace.state.rail.width, 180);
  assert.deepEqual(workspace.saved, before);
  workspace.cancelGesture();
  assert.deepEqual(workspace.state, before);
  assert.deepEqual(workspace.saved, before);
});

test('rail keyboard controls work in single mode with directional steps, limits and default restoration', () => {
  const workspace = railWorkspace();
  workspace.state.displayMode = 'single';
  workspace.keydown(keyEvent(workspace.railResize, 'ArrowLeft'));
  assert.equal(workspace.state.rail.width, config.rail.width.value + config.rail.width.step);
  workspace.keydown(keyEvent(workspace.railResize, 'ArrowRight'));
  assert.equal(workspace.state.rail.width, config.rail.width.value);
  workspace.keydown(keyEvent(workspace.railResize, 'End'));
  assert.equal(workspace.state.rail.width, config.rail.width.max);
  workspace.keydown(keyEvent(workspace.railResize, 'Home', true));
  assert.equal(workspace.state.rail.width, config.rail.width.value);
  workspace.keydown(keyEvent(workspace.railSplitter, 'ArrowDown'));
  assert.equal(workspace.state.rail.menuRatio, config.rail.menuRatio.value + config.rail.menuRatio.step);
  workspace.keydown(keyEvent(workspace.railSplitter, 'ArrowUp'));
  assert.equal(workspace.state.rail.menuRatio, config.rail.menuRatio.value);
  workspace.keydown(keyEvent(workspace.railSplitter, 'End'));
  assert.equal(workspace.state.rail.menuRatio, config.rail.menuRatio.max);
  workspace.keydown(keyEvent(workspace.railSplitter, 'Home'));
  assert.equal(workspace.state.rail.menuRatio, config.rail.menuRatio.min);
  workspace.keydown(keyEvent(workspace.railSplitter, 'Home', true));
  assert.equal(workspace.state.rail.menuRatio, config.rail.menuRatio.value);
});

test('rail handles remain draggable when they are companions inside a fullscreen scene', () => {
  for (const mode of ['dual', 'single']) {
    const workspace = railWorkspace();
    workspace.state.displayMode = mode;
    workspace.raise = () => {};
    workspace.fullscreenGeometry = () => true;
    workspace.areaMetrics = () => ({ left: 0, top: 0, scrollLeft: 0, scrollTop: 0 });
    workspace.sceneArea.clientHeight = 800;
    const scene = { dataset: { cosmicWindow: 'scene' }, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
    for (const [handle, selector, kind] of [
      [workspace.railResize, '#cosmic-rail-resize', 'rail-width'],
      [workspace.railSplitter, '#cosmic-rail-splitter', 'rail-menu'],
    ]) {
      handle.closest = value => value === '[data-cosmic-window]' ? scene : value === selector ? handle : null;
      const before = clone(workspace.windows.scene);
      workspace.pointerDown(pointerEvent(handle));
      assert.equal(workspace.gesture?.kind, kind, `${mode}: ${kind}`);
      workspace.pointerMove(pointerEvent(handle, 560, 440));
      assert.deepEqual(workspace.windows.scene, before);
      workspace.cancelGesture();
      assert.deepEqual(workspace.state.rail, { width: config.rail.width.value, menuRatio: config.rail.menuRatio.value });
    }
  }
});

test('rail accessible dimensions describe the rendered fit while keeping preferred width untouched', () => {
  const workspace = railWorkspace(480), variables = new Map();
  workspace.shell.style.setProperty = (name, value) => variables.set(name, value);
  workspace.state.rail = { width: 320, menuRatio: 0.34 };
  workspace.renderRail();
  assert.equal(variables.get('--cosmic-rail-width'), '200px');
  assert.equal(variables.get('--cosmic-rail-menu-ratio'), '0.34');
  assert.equal(variables.get('--cosmic-rail-splitter-size'), `${config.rail.geometry.splitterSize}px`);
  assert.equal(variables.get('--cosmic-rail-item-min-width'), `${config.rail.geometry.itemMinWidth}px`);
  assert.equal(workspace.railResize.getAttribute('aria-valuenow'), '200');
  assert.equal(workspace.railResize.getAttribute('aria-valuemax'), '200');
  assert.equal(workspace.railSplitter.getAttribute('aria-valuenow'), '34');
  assert.equal(workspace.state.rail.width, 320);
});

test('v2 saves gain menu and dock appearance without changing either mode or existing appearances', () => {
  const saved = defaultWorkspaceState(config);
  saved.layouts.single.windows.input.x = 54;
  saved.layouts.dual.windows.input.y = 81;
  saved.appearance.input.background = '#abcdef';
  delete saved.appearance.menu; delete saved.appearance.dock;
  const restored = normalizeWorkspaceState(saved, config);
  assert.deepEqual(restored.layouts, saved.layouts);
  assert.deepEqual(restored.rail, saved.rail);
  assert.deepEqual(restored.appearance.input, saved.appearance.input);
  for (const key of ['menu', 'dock']) assert.deepEqual(restored.appearance[key], defaultAppearance(config, key));
});

test('rail appearance validates six fields independently and keeps window appearance limits unchanged', () => {
  const saved = defaultWorkspaceState(config);
  saved.appearance.menu = { background: 'url(test)', foreground: '#AABBCC', opacity: 0, radius: 1000, iconSize: Infinity, fontSize: '18', extra: 99 };
  saved.appearance.dock = { background: '#334455', foreground: '#112233', opacity: 0.42, radius: 7, iconSize: 1000, fontSize: -1 };
  saved.appearance.input.opacity = 0;
  saved.appearance.input.iconSize = 28;
  saved.appearance.input.fontSize = 18;
  const restored = normalizeWorkspaceState(saved, config);
  const limits = config.rail.appearance.limits;
  assert.deepEqual(restored.appearance.menu, {
    ...defaultAppearance(config, 'menu'), foreground: '#aabbcc', opacity: 0, radius: limits.radius.max,
  });
  assert.deepEqual(restored.appearance.dock, {
    ...defaultAppearance(config, 'dock'), background: '#334455', foreground: '#112233', opacity: 0.42, radius: 7, iconSize: limits.iconSize.max, fontSize: limits.fontSize.min,
  });
  assert.equal(restored.appearance.input.opacity, config.appearance.limits.opacity.min);
  assert.equal(Object.hasOwn(restored.appearance.input, 'iconSize'), false);
  assert.equal(Object.hasOwn(restored.appearance.input, 'fontSize'), false);
  assert.deepEqual(normalizeWorkspaceState(JSON.parse(JSON.stringify(restored)), config).appearance, restored.appearance);
});

function appearanceWorkspace() {
  const workspace = railWorkspace();
  workspace.appearancePanels = new Map(Object.keys(config.appearance.panels).map(key => [key, { hidden: true }]));
  workspace.fields = Object.fromEntries([
    'target', 'bg', 'fg', 'alpha', 'radius', 'alpha-value', 'radius-value', 'rail-fields',
    'icon-color', 'icon-alpha', 'icon-alpha-value', 'icon-size', 'icon-size-value',
    'font-alpha', 'font-alpha-value', 'font-alpha-field', 'font-size', 'font-size-value', 'font-size-field',
    'font-scale', 'font-scale-value', 'font-scale-field', 'reset',
    'surface-fields', 'text-fields', 'global-fields', 'scene-hint',
    'global-glass-enabled', 'global-glass-blur', 'global-glass-blur-value',
    'global-background', 'global-accent', 'global-hover', 'global-focus', 'global-border',
    'global-selection-bg', 'global-selection-text',
  ].map(name => [name, {}]));
  workspace.styleTarget = 'input';
  return workspace;
}

test('network appearance targets show one independent panel and preserve desktop settings when switching back', () => {
  const workspace = appearanceWorkspace(), before = clone(workspace.state);
  workspace.save = () => assert.fail('switching appearance targets must not save or reset settings');
  for (const target of Object.keys(config.appearance.panels)) {
    assert.equal(workspace.isAppearanceTarget(target), true);
    workspace.styleTarget = target; workspace.syncAppearance();
    assert.equal(workspace.fields.target.value, target);
    for (const [key, panel] of workspace.appearancePanels) assert.equal(panel.hidden, key !== target);
    for (const field of ['global-fields', 'surface-fields', 'text-fields', 'rail-fields', 'scene-hint', 'reset']) assert.equal(workspace.fields[field].hidden, true);
    workspace.resetAppearance(); workspace.updateAppearance();
    assert.deepEqual(workspace.state, before);
    assert.equal(Object.hasOwn(workspace.state.appearance, target), false);
  }
  for (const target of ['global', 'menu', 'scene', 'appearance']) {
    workspace.styleTarget = target; workspace.syncAppearance();
    assert.ok([...workspace.appearancePanels.values()].every(panel => panel.hidden));
    assert.equal(workspace.fields.reset.hidden, false);
    assert.equal(workspace.fields.reset.disabled, false);
    assert.equal(workspace.fields['global-fields'].hidden, target !== 'global');
    assert.equal(workspace.fields['surface-fields'].hidden, target === 'global');
    assert.equal(workspace.fields['rail-fields'].hidden, target !== 'menu');
    assert.deepEqual(workspace.state, before);
  }
});

test('all appearance edits and selected resets persist through browser storage and restoration', () => {
  const workspace = appearanceWorkspace(), storage = new Map();
  workspace.browser = { localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  } };
  workspace.save = CosmicWorkspace.prototype.save;
  workspace.renderAppearanceTarget = () => {};
  for (const key of [...Object.keys(config.windows), 'menu', 'dock']) {
    workspace.styleTarget = key; workspace.syncAppearance();
    const changes = {
      bg: '#123456', fg: '#fedcba', alpha: '0.36', radius: '25', 'font-scale': '1.4',
      'icon-color': '#789abc', 'icon-alpha': '0.45', 'icon-size': '29',
      'font-alpha': '0.65', 'font-size': '16.7',
    };
    for (const [field, value] of Object.entries(changes)) workspace.fields[field].value = value;
    workspace.updateAppearance();
    assert.deepEqual(workspace.restore().appearance[key], workspace.state.appearance[key], key);
  }
  workspace.styleTarget = 'global'; workspace.syncAppearance();
  for (const name of ['background', 'accent', 'hover', 'focus', 'border', 'selection-bg', 'selection-text']) {
    workspace.fields[`global-${name}`].value = '#2468ac';
  }
  workspace.updateAppearance();
  assert.deepEqual(workspace.restore(), workspace.state);
  const beforeReset = clone(workspace.state.appearance);
  workspace.styleTarget = 'scene'; workspace.resetAppearance();
  const restored = workspace.restore();
  assert.deepEqual(restored.appearance.scene, defaultAppearance(config, 'scene'));
  for (const key of Object.keys(beforeReset).filter(key => key !== 'scene')) {
    assert.deepEqual(restored.appearance[key], beforeReset[key], key);
  }
});

test('switching appearance targets restores slider ranges and hides rail-only controls for windows', () => {
  const workspace = appearanceWorkspace();
  workspace.state.appearance.menu.opacity = 0;
  workspace.syncAppearance();
  assert.equal(workspace.fields.alpha.min, config.appearance.limits.opacity.min);
  assert.equal(workspace.fields['rail-fields'].hidden, true);
  assert.equal(workspace.fields['icon-size'].disabled, true);
  assert.equal(workspace.fields['font-alpha-field'].hidden, true);
  assert.equal(workspace.fields['font-size-field'].hidden, true);
  assert.equal(workspace.fields['font-scale-field'].hidden, false);
  assert.equal(workspace.fields['font-scale'].value, defaultAppearance(config, 'input').fontScale);
  assert.equal(workspace.fields['font-scale-value'].textContent, `${Math.round(defaultAppearance(config, 'input').fontScale * 100)}%`);
  workspace.styleTarget = 'menu'; workspace.syncAppearance();
  assert.equal(workspace.fields.alpha.min, 0);
  assert.equal(workspace.fields.alpha.value, 0);
  assert.equal(workspace.fields['rail-fields'].hidden, false);
  assert.equal(workspace.fields['icon-size'].disabled, false);
  assert.equal(workspace.fields['font-scale-field'].hidden, true);
  assert.equal(workspace.fields['font-scale'].disabled, true);
  assert.equal(workspace.fields['icon-color'].disabled, false);
  assert.equal(workspace.fields['icon-size'].max, config.rail.appearance.limits.iconSize.max);
  assert.equal(workspace.fields['font-size-value'].textContent, `${config.rail.appearance.menu.fontSize}px`);
  workspace.styleTarget = 'input'; workspace.syncAppearance();
  assert.equal(workspace.fields.alpha.min, config.appearance.limits.opacity.min);
  assert.equal(workspace.fields['font-size'].disabled, true);
  assert.equal(workspace.fields['rail-fields'].hidden, true);
  assert.equal(workspace.fields['font-scale'].disabled, false);
  assert.equal(workspace.fields['icon-alpha'].disabled, true);
  assert.equal(workspace.fields['font-alpha'].disabled, true);
});

test('global, scene and module target switches restore their own fields and opacity ranges', () => {
  const workspace = appearanceWorkspace();
  workspace.state.appearance.scene.opacity = 0;
  workspace.styleTarget = 'menu'; workspace.syncAppearance();
  workspace.styleTarget = 'global'; workspace.syncAppearance();
  assert.equal(workspace.fields.target.value, 'global');
  assert.equal(workspace.fields['global-fields'].hidden, false);
  assert.equal(workspace.fields['surface-fields'].hidden, true);
  assert.equal(workspace.fields['text-fields'].hidden, true);
  assert.equal(workspace.fields['rail-fields'].hidden, true);
  assert.equal(workspace.fields['scene-hint'].hidden, true);
  assert.equal(workspace.fields['global-accent'].disabled, false);
  assert.equal(workspace.fields['global-accent'].value, config.theme.accent);
  workspace.styleTarget = 'scene'; workspace.syncAppearance();
  assert.equal(workspace.fields['global-fields'].hidden, true);
  assert.equal(workspace.fields['global-accent'].disabled, true);
  assert.equal(workspace.fields['surface-fields'].hidden, false);
  assert.equal(workspace.fields['text-fields'].hidden, false);
  assert.equal(workspace.fields['scene-hint'].hidden, false);
  assert.equal(workspace.fields['rail-fields'].hidden, true);
  assert.equal(workspace.fields['font-scale-field'].hidden, false);
  assert.equal(workspace.fields.alpha.min, 0);
  assert.equal(workspace.fields.alpha.value, 0);
  assert.equal(workspace.fields['alpha-value'].textContent, '0%');
  workspace.styleTarget = 'input'; workspace.syncAppearance();
  assert.equal(workspace.fields['scene-hint'].hidden, true);
  assert.equal(workspace.fields.alpha.min, config.appearance.limits.opacity.min);
  assert.equal(workspace.fields.alpha.value, config.appearance.opacity);
  workspace.styleTarget = 'global'; workspace.syncAppearance();
  workspace.styleTarget = 'dock'; workspace.syncAppearance();
  assert.equal(workspace.fields['global-fields'].hidden, true);
  assert.equal(workspace.fields['surface-fields'].hidden, false);
  assert.equal(workspace.fields['text-fields'].hidden, false);
  assert.equal(workspace.fields['rail-fields'].hidden, false);
  assert.equal(workspace.fields['font-scale-field'].hidden, true);
});

test('global colors update their CSS channels, persist, and reset without changing local appearances', () => {
  const workspace = appearanceWorkspace(), variables = new Map();
  workspace.root.style = { setProperty: (name, value) => variables.set(name, value) };
  const before = clone(workspace.state);
  const fields = [
    ['background', 'global-background', '--cosmic-desktop-bg', '#112233'],
    ['accent', 'global-accent', '--cosmic-accent', '#223344'],
    ['hover', 'global-hover', '--cosmic-hover', '#334455'],
    ['focus', 'global-focus', '--cosmic-focus', '#445566'],
    ['border', 'global-border', '--cosmic-border-color', '#556677'],
    ['selectionBackground', 'global-selection-bg', '--cosmic-selection-bg', '#667788'],
    ['selectionForeground', 'global-selection-text', '--cosmic-selection-text', '#778899'],
  ];
  workspace.styleTarget = 'global'; workspace.syncAppearance();
  for (const [, field, , value] of fields) workspace.fields[field].value = value;
  workspace.updateAppearance();
  for (const [key, , variable, value] of fields) {
    assert.equal(workspace.saved.appearance.global[key], value);
    assert.equal(variables.get(variable), value);
  }
  assert.deepEqual(normalizeWorkspaceState(JSON.parse(JSON.stringify(workspace.saved)), config), workspace.saved);
  workspace.fields['global-accent'].value = 'url(invalid)';
  workspace.updateAppearance();
  assert.equal(workspace.saved.appearance.global.accent, '#223344');
  for (const key of [...Object.keys(config.windows), 'menu', 'dock']) {
    assert.deepEqual(workspace.state.appearance[key], before.appearance[key]);
  }
  assert.deepEqual(workspace.state.layouts, before.layouts);
  assert.deepEqual(workspace.state.rail, before.rail);
  workspace.resetAppearance();
  assert.deepEqual(workspace.saved.appearance.global, defaultAppearance(config, 'global'));
  for (const [key, , variable] of fields) assert.equal(variables.get(variable), config.theme[key]);
  assert.deepEqual(workspace.saved, before);
});

test('global glass controls apply live, preserve disabled strength, persist, and reset only global appearance', () => {
  const workspace = appearanceWorkspace(), variables = new Map(), storage = new Map(), handlers = new Map();
  workspace.root.style = { setProperty: (name, value) => variables.set(name, value) };
  workspace.browser = { localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  } };
  workspace.save = CosmicWorkspace.prototype.save;
  workspace.listen = (element, event, callback) => {
    if (!handlers.has(element)) handlers.set(element, new Map());
    handlers.get(element).set(event, callback);
  };
  workspace.configureAppearanceFields();
  const before = clone(workspace.state), enabled = workspace.fields['global-glass-enabled'], blur = workspace.fields['global-glass-blur'];
  assert.equal(enabled.disabled, true); assert.equal(blur.disabled, true);
  workspace.styleTarget = 'global'; workspace.syncAppearance();
  assert.equal(enabled.disabled, false); assert.equal(enabled.checked, true);
  assert.equal(blur.min, config.theme.glass.limits.min);
  assert.equal(blur.max, config.theme.glass.limits.max);
  assert.equal(blur.step, config.theme.glass.limits.step);
  assert.equal(blur.value, 14);
  enabled.checked = false;
  handlers.get(enabled).get('change')();
  assert.equal(variables.get('--cosmic-glass-blur'), '0px');
  assert.equal(workspace.state.appearance.global.glassBlur, 14);
  blur.value = '23'; handlers.get(blur).get('input')();
  assert.equal(variables.get('--cosmic-glass-blur'), '0px');
  assert.equal(workspace.fields['global-glass-blur-value'].textContent, '23px');
  assert.deepEqual(workspace.restore(), workspace.state);
  enabled.checked = true; handlers.get(enabled).get('change')();
  assert.equal(variables.get('--cosmic-glass-blur'), '23px');
  assert.deepEqual(workspace.restore(), workspace.state);
  for (const key of [...Object.keys(config.windows), 'menu', 'dock']) assert.deepEqual(workspace.state.appearance[key], before.appearance[key]);
  assert.deepEqual(workspace.state.layouts, before.layouts);
  assert.deepEqual(workspace.state.rail, before.rail);
  workspace.resetAppearance();
  assert.equal(variables.get('--cosmic-glass-blur'), '14px');
  assert.deepEqual(workspace.restore(), before);
});

test('updating or restoring one rail appearance leaves the other panel and windows intact', () => {
  const workspace = appearanceWorkspace(), variables = new Map();
  workspace.railMenu.style.setProperty = (name, value) => variables.set(name, value);
  const dock = clone(workspace.state.appearance.dock), input = clone(workspace.state.appearance.input);
  const layouts = clone(workspace.state.layouts);
  workspace.styleTarget = 'menu'; workspace.syncAppearance();
  Object.assign(workspace.fields.bg, { value: '#123456' });
  workspace.fields.fg.value = '#abcdef';
  workspace.fields.alpha.value = '0'; workspace.fields.radius.value = '24';
  workspace.fields['icon-size'].value = '32'; workspace.fields['font-size'].value = '18';
  workspace.updateAppearance();
  assert.deepEqual(workspace.saved.appearance.menu, { ...defaultAppearance(config, 'menu'), background: '#123456', foreground: '#abcdef', opacity: 0, radius: 24, iconSize: 32, fontSize: 18 });
  assert.equal(variables.get('--rail-panel-alpha'), '0');
  assert.equal(variables.get('--rail-panel-icon-size'), '32px');
  assert.equal(variables.get('--rail-panel-font-size'), '18px');
  workspace.resetAppearance();
  assert.deepEqual(workspace.state.appearance.menu, defaultAppearance(config, 'menu'));
  assert.deepEqual(workspace.state.appearance.dock, dock);
  assert.deepEqual(workspace.state.appearance.input, input);
  assert.deepEqual(workspace.state.layouts, layouts);
});

test('opening rail appearance defers target changes until fullscreen has exited', () => {
  const workspace = appearanceWorkspace();
  const appearance = {}, scene = { contains: () => false };
  workspace.elements = new Map([['scene', scene], ['appearance', appearance]]);
  workspace.sceneFullscreen = () => true;
  let continueAfterExit, shown;
  workspace.exitFullscreenBefore = (key, action) => { assert.equal(key, 'scene'); continueAfterExit = action; return true; };
  workspace.show = key => { shown = key; };
  workspace.openAppearance('dock');
  assert.equal(workspace.styleTarget, 'input');
  assert.equal(shown, undefined);
  workspace.sceneFullscreen = () => false;
  continueAfterExit();
  assert.equal(workspace.styleTarget, 'dock');
  assert.equal(shown, 'appearance');
  assert.equal(workspace.windows.appearance.collapsed, false);
});

test('single-panel fullscreen keeps floating windows editable and opens appearance inside the panel', () => {
  const workspace = appearanceWorkspace();
  const appearance = {}, scene = { classList: { contains: () => false }, contains: element => element === scene };
  workspace.sceneArea.classList = { contains: name => name === 'cosmic-panel-fullscreen' };
  workspace.doc = { fullscreenElement: workspace.sceneArea };
  workspace.elements = new Map([['scene', scene], ['appearance', appearance]]);
  workspace.state.displayMode = 'single';
  let shown;
  workspace.show = key => { shown = key; };
  workspace.exitFullscreenBefore = () => { assert.fail('Opening a panel tool must not exit fullscreen'); };
  assert.equal(workspace.panelFullscreen(), true);
  assert.equal(workspace.sceneFullscreen(), false);
  assert.equal(workspace.fullscreenGeometry('scene'), false);
  assert.equal(workspace.fullscreenGeometry('appearance'), false);
  workspace.openAppearance('input');
  assert.equal(shown, 'appearance');
  assert.equal(workspace.styleTarget, 'input');
  assert.equal(workspace.windows.appearance.collapsed, false);
});

test('switching display mode waits for single-panel fullscreen to exit in native and fallback modes', async () => {
  for (const native of [true, false]) {
    const workspace = railWorkspace();
    workspace.state.displayMode = 'single';
    const originalLayouts = clone(workspace.state.layouts);
    let expanded = true, exitCount = 0;
    workspace.sceneArea.classList = { contains: name => expanded && name === 'cosmic-panel-fullscreen' };
    const scene = { classList: { contains: () => false }, contains: () => false };
    const exit = () => { exitCount++; expanded = false; workspace.doc.fullscreenElement = null; };
    workspace.elements = new Map([['scene', scene]]);
    workspace.doc = { fullscreenElement: native ? workspace.sceneArea : null, exitFullscreen: async () => exit() };
    workspace.root.querySelector = () => ({ click: exit });
    workspace.root.dispatchEvent = () => {};
    workspace.browser = { requestAnimationFrame: callback => queueMicrotask(callback), CustomEvent: class {} };
    workspace.scheduleLayout = () => {};
    workspace.setDisplayMode('dual');
    assert.equal(workspace.state.displayMode, 'single');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(exitCount, 1);
    assert.equal(workspace.state.displayMode, 'dual');
    assert.equal(workspace.panelFullscreen(), false);
    assert.deepEqual(workspace.state.layouts, originalLayouts);
  }
});

test('existing v2 appearances gain independent icon and font defaults without changing saved styles', () => {
  const saved = defaultWorkspaceState(config);
  saved.appearance.input.background = '#123456';
  saved.appearance.menu.foreground = '#abcdef';
  for (const key of Object.keys(config.windows)) delete saved.appearance[key].fontScale;
  for (const key of ['menu', 'dock']) {
    delete saved.appearance[key].iconColor;
    delete saved.appearance[key].iconOpacity;
    delete saved.appearance[key].fontOpacity;
  }
  const restored = normalizeWorkspaceState(saved, config);
  for (const key of Object.keys(config.windows)) assert.equal(restored.appearance[key].fontScale, defaultAppearance(config, key).fontScale);
  assert.equal(restored.appearance.input.background, '#123456');
  assert.equal(restored.appearance.menu.foreground, '#abcdef');
  assert.equal(restored.appearance.menu.iconColor, config.rail.appearance.menu.iconColor);
  assert.equal(restored.appearance.menu.iconOpacity, 1);
  assert.equal(restored.appearance.menu.fontOpacity, 1);
  assert.deepEqual(restored.layouts, saved.layouts);
});

test('font scale and independent rail channels reject corrupt values and remain target-specific', () => {
  const saved = defaultWorkspaceState(config), limits = config.appearance.limits.fontScale;
  Object.assign(saved.appearance.menu, { iconColor: 'transparent', iconOpacity: NaN, fontOpacity: -10, fontScale: 1.8 });
  Object.assign(saved.appearance.dock, { iconColor: '#ABCDEF', iconOpacity: 2, fontOpacity: 0.35 });
  Object.assign(saved.appearance.input, { fontScale: 100, iconColor: '#123456', iconOpacity: 0.5, fontOpacity: 0.7 });
  saved.appearance.models.fontScale = '1.5';
  saved.appearance.inspector.fontScale = -1;
  const result = normalizeWorkspaceState(saved, config);
  assert.equal(result.appearance.menu.iconColor, config.rail.appearance.menu.iconColor);
  assert.equal(result.appearance.menu.iconOpacity, config.rail.appearance.menu.iconOpacity);
  assert.equal(result.appearance.menu.fontOpacity, 0);
  assert.equal(Object.hasOwn(result.appearance.menu, 'fontScale'), false);
  assert.equal(result.appearance.dock.iconColor, '#abcdef');
  assert.equal(result.appearance.dock.iconOpacity, 1);
  assert.equal(result.appearance.dock.fontOpacity, 0.35);
  assert.equal(result.appearance.input.fontScale, limits.max);
  assert.equal(result.appearance.inspector.fontScale, limits.min);
  assert.equal(result.appearance.models.fontScale, defaultAppearance(config, 'models').fontScale);
  for (const key of ['iconColor', 'iconOpacity', 'fontOpacity']) assert.equal(Object.hasOwn(result.appearance.input, key), false);
  assert.deepEqual(normalizeWorkspaceState(JSON.parse(JSON.stringify(result)), config).appearance, result.appearance);
});

test('rail icon and text controls write separate CSS channels and reset only the selected panel', () => {
  const workspace = appearanceWorkspace(), variables = new Map();
  workspace.railMenu.style.setProperty = (name, value) => variables.set(name, value);
  const dock = clone(workspace.state.appearance.dock);
  workspace.styleTarget = 'menu'; workspace.syncAppearance();
  workspace.fields['icon-color'].value = '#123456';
  workspace.fields['icon-alpha'].value = '0.25';
  workspace.updateAppearance();
  assert.equal(workspace.state.appearance.menu.foreground, config.rail.appearance.menu.foreground);
  assert.equal(workspace.state.appearance.menu.fontOpacity, 1);
  workspace.fields.fg.value = '#abcdef';
  workspace.fields['font-alpha'].value = '0.75';
  workspace.updateAppearance();
  assert.equal(variables.get('--rail-panel-icon-fg'), '#123456');
  assert.equal(variables.get('--rail-panel-icon-alpha'), '0.25');
  assert.equal(variables.get('--rail-panel-fg'), '#abcdef');
  assert.equal(variables.get('--rail-panel-font-alpha'), '0.75');
  assert.equal(workspace.saved.appearance.menu.iconOpacity, 0.25);
  assert.equal(workspace.saved.appearance.menu.fontOpacity, 0.75);
  workspace.resetAppearance();
  assert.deepEqual(workspace.saved.appearance.menu, defaultAppearance(config, 'menu'));
  assert.deepEqual(workspace.saved.appearance.dock, dock);
});

test('window font scale applies once on the selected window root and preserves nested window scale', () => {
  const workspace = appearanceWorkspace(), sceneStyles = new Map(), inspectorStyles = new Map([['--window-font-scale', '1.25']]);
  workspace.root.querySelectorAll = () => [];
  workspace.fullscreenGeometry = () => false;
  const inspector = { style: { setProperty: (name, value) => inspectorStyles.set(name, value) } };
  const scene = {
    parentElement: workspace.sceneArea, dataset: {}, classList: { toggle() {} },
    style: { setProperty: (name, value) => sceneStyles.set(name, value) },
    querySelector: () => null, querySelectorAll: selector => selector === '*' ? [inspector] : [],
  };
  workspace.elements = new Map([['scene', scene], ['inspector', inspector]]);
  workspace.state.appearance.inspector.fontScale = 1.25;
  workspace.styleTarget = 'scene'; workspace.syncAppearance();
  workspace.fields['font-scale'].value = '1.5';
  workspace.updateAppearance();
  assert.equal(sceneStyles.get('--window-font-scale'), '1.5');
  assert.equal(inspectorStyles.get('--window-font-scale'), '1.25');
  assert.equal(workspace.saved.appearance.scene.fontScale, 1.5);
  assert.equal(workspace.saved.appearance.inspector.fontScale, 1.25);
  workspace.resetAppearance();
  assert.equal(sceneStyles.get('--window-font-scale'), String(defaultAppearance(config, 'scene').fontScale));
  assert.equal(workspace.saved.appearance.inspector.fontScale, 1.25);
});

test('scene rendering notifies its renderer with the current appearance while other windows stay local', () => {
  const workspace = appearanceWorkspace(), callbacks = [];
  workspace.state.displayMode = 'dual';
  workspace.root.querySelectorAll = () => [];
  workspace.fullscreenGeometry = () => false;
  const element = parentElement => ({
    parentElement, dataset: {}, classList: { toggle() {} }, style: { setProperty() {} },
    querySelector: () => null, querySelectorAll: () => [],
  });
  workspace.elements = new Map([
    ['scene', element(workspace.sceneArea)], ['input', element(workspace.canvas)],
  ]);
  workspace.onAppearanceChange = (key, appearance) => callbacks.push([key, clone(appearance)]);
  workspace.renderWindow('input');
  assert.equal(callbacks.length, 0);
  workspace.styleTarget = 'scene'; workspace.syncAppearance();
  workspace.fields.bg.value = '#223344';
  workspace.fields.fg.value = '#aabbcc';
  workspace.fields.alpha.value = '0';
  workspace.fields['font-scale'].value = '1.5';
  workspace.updateAppearance();
  assert.deepEqual(callbacks, [['scene', workspace.saved.appearance.scene]]);
  assert.equal(callbacks[0][1].opacity, 0);
  assert.equal(callbacks[0][1].fontScale, 1.5);
  assert.deepEqual(workspace.saved.appearance.input, defaultAppearance(config, 'input'));
  workspace.resetAppearance();
  assert.deepEqual(callbacks.at(-1), ['scene', defaultAppearance(config, 'scene')]);
  assert.equal(callbacks.at(-1)[1].opacity, config.windows.scene.appearance.opacity);
});
