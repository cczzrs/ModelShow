import {
  clamp, defaultAppearance, defaultWorkspaceState, normalizeAppearance, normalizeGlobalAppearance,
  normalizeWorkspaceState, fitWindowGeometry, changeWindowGeometry, placeWindowGeometry, windowPointFromPointer,
  changeDisplayMode, resetCurrentLayout, fitRailWidth, isRailAppearanceTarget, appearanceLimits,
} from './cosmic-state.js';

const globalFields = {
  background: ['global-background', 'desktop-bg'], accent: ['global-accent', 'accent'],
  hover: ['global-hover', 'hover'], focus: ['global-focus', 'focus'], border: ['global-border', 'border-color'],
  selectionBackground: ['global-selection-bg', 'selection-bg'], selectionForeground: ['global-selection-text', 'selection-text'],
};

/** Bind static COSMIC markup to local window state. Never constructs HTML or CSS rules. */
export class CosmicWorkspace {
  constructor({ root, config, onCommand = () => {}, onAppearanceChange = () => {} }) {
    this.root = root; this.config = config; this.onCommand = onCommand; this.onAppearanceChange = onAppearanceChange;
    this.doc = root.ownerDocument; this.browser = this.doc.defaultView;
    this.desktop = root.querySelector('.cosmic-desktop');
    this.canvas = root.querySelector('.cosmic-canvas');
    this.sceneArea = root.querySelector('.cosmic-scene-area');
    this.splitter = root.querySelector('#cosmic-splitter');
    this.shell = root.querySelector('.cosmic-shell');
    this.rail = root.querySelector('.cosmic-rail');
    this.railResize = root.querySelector('#cosmic-rail-resize');
    this.railSplitter = root.querySelector('#cosmic-rail-splitter');
    this.railMenu = root.querySelector('#cosmic-menu');
    this.railDock = root.querySelector('#cosmic-dock');
    this.elements = new Map([...root.querySelectorAll('[data-cosmic-window]')].map(element => [element.dataset.cosmicWindow, element]));
    this.listeners = []; this.active = true; this.gesture = null; this.disposed = false;
    this.state = this.restore(); this.focused = this.layout.order.findLast(key => this.windows[key].visible) ?? 'scene';
    this.styleTarget = this.isAppearanceTarget(config.appearance.target)
      ? config.appearance.target : this.focused;
    this.appearancePanels = new Map(Object.entries(config.appearance.panels).map(([key, id]) => [key, root.querySelector(`#${id}`)]));
    this.fields = Object.fromEntries([
      'target', 'bg', 'fg', 'alpha', 'radius', 'alpha-value', 'radius-value', 'rail-fields',
      'icon-color', 'icon-alpha', 'icon-alpha-value', 'icon-size', 'icon-size-value',
      'font-alpha', 'font-alpha-value', 'font-alpha-field', 'font-size', 'font-size-value', 'font-size-field',
      'font-scale', 'font-scale-value', 'font-scale-field', 'reset',
      'surface-fields', 'text-fields', 'global-fields', 'scene-hint',
      'global-glass-enabled', 'global-glass-blur', 'global-glass-blur-value',
      ...Object.values(globalFields).map(([field]) => field),
    ].map(name => [name, root.querySelector(`#cosmic-style-${name}`)]));
    this.configureAppearanceFields();
    this.listen(root, 'click', event => this.click(event));
    this.listen(root, 'pointerdown', event => this.pointerDown(event));
    this.listen(root, 'keydown', event => this.keydown(event));
    this.listen(root, 'focusin', event => {
      const element = event.target.closest('[data-cosmic-window]');
      if (element && this.elements.has(element.dataset.cosmicWindow)) this.raise(element.dataset.cosmicWindow);
    });
    this.listen(this.doc, 'pointermove', event => this.pointerMove(event));
    this.listen(this.doc, 'pointerup', event => this.pointerEnd(event));
    this.listen(this.doc, 'pointercancel', event => this.pointerEnd(event, true));
    this.listen(this.doc, 'keydown', event => {
      if (event.key === 'Escape' && this.gesture) { event.preventDefault(); this.cancelGesture(); }
    });
    this.listen(this.doc, 'fullscreenchange', () => { this.cancelGesture(); this.scheduleLayout(); });
    this.observer = new this.browser.ResizeObserver(() => this.scheduleLayout());
    for (const element of [this.desktop, this.sceneArea, this.shell, this.rail]) this.observer.observe(element);
    this.render();
  }

  listen(element, type, handler) {
    element.addEventListener(type, handler);
    this.listeners.push(() => element.removeEventListener(type, handler));
  }

  get layout() { return this.state.layouts[this.state.displayMode]; }
  get windows() { return this.layout.windows; }
  get single() { return this.state.displayMode === 'single'; }

  isAppearanceTarget(key) {
    return typeof key === 'string' && (Object.hasOwn(this.state.appearance, key) || Object.hasOwn(this.config.appearance.panels, key));
  }

  restore() {
    try { return normalizeWorkspaceState(JSON.parse(this.browser.localStorage.getItem(this.config.storage.key)), this.config); }
    catch { return defaultWorkspaceState(this.config); }
  }

  save() {
    try { this.browser.localStorage.setItem(this.config.storage.key, JSON.stringify(this.state)); }
    catch { /* Private browsing and unavailable storage still allow a working desktop. */ }
  }

  resolve(value) {
    if (this.elements.has(value)) return value;
    const element = this.doc.getElementById(value)?.closest('[data-cosmic-window]');
    return element && this.root.contains(element) ? element.dataset.cosmicWindow : null;
  }

  bounds(key, zone = this.windows[key].zone) {
    return this.single || key === 'scene' || zone === 'scene'
      ? { width: this.sceneArea.clientWidth, height: this.sceneArea.clientHeight }
      : { width: this.desktop.clientWidth, height: this.config.geometry.maxCanvasHeight };
  }

  areaMetrics(zone) {
    const element = this.single || zone === 'scene' ? this.sceneArea : this.desktop;
    const rect = element.getBoundingClientRect();
    return { left: rect.left + element.clientLeft, top: rect.top + element.clientTop, scrollLeft: element.scrollLeft, scrollTop: element.scrollTop };
  }

  pointerZone(clientX, previous) {
    if (this.single) return 'scene';
    const divider = this.splitter.getBoundingClientRect();
    return clientX < divider.left ? 'scene' : clientX > divider.right ? 'tools' : previous;
  }

  sceneFullscreen() {
    const scene = this.elements.get('scene');
    return Boolean(scene?.classList.contains('scene-fullscreen') || this.doc.fullscreenElement === scene);
  }

  panelFullscreen() {
    return Boolean(this.sceneArea.classList.contains('cosmic-panel-fullscreen') || this.doc.fullscreenElement === this.sceneArea);
  }

  fullscreenGeometry(key) {
    return this.sceneFullscreen() && this.elements.get('scene').contains(this.elements.get(key));
  }

  /** A hidden/collapsed native fullscreen element would leave no way back to its controls. */
  exitFullscreenBefore(key, action) {
    if (this.completingExitAction) return false;
    const exitControl = this.root.querySelector('#scene-fullscreen');
    const ownsExitControl = exitControl && this.elements.get(key)?.contains(exitControl);
    if ((key !== 'scene' && !ownsExitControl) || !(this.sceneFullscreen() || this.panelFullscreen())) return false;
    if (this.exitPending) return true;
    this.exitPending = true;
    const leave = async () => {
      try {
        if (this.doc.fullscreenElement) await this.doc.exitFullscreen();
        else this.root.querySelector('#scene-fullscreen')?.click();
        // exitFullscreen() can resolve before the helper's fullscreenchange handler
        // clears its fullscreen class. Finish that rendering cycle first.
        await new Promise(resolve => this.browser.requestAnimationFrame(resolve));
        if (!this.disposed && !this.doc.fullscreenElement) {
          this.completingExitAction = true;
          try { action(); } finally { this.completingExitAction = false; }
        }
      } catch (error) {
        this.root.dispatchEvent(new this.browser.CustomEvent('cosmic-workspace-error', { detail: { message: `退出全屏失败：${error.message}` } }));
      } finally { this.exitPending = false; this.scheduleLayout(); }
    };
    leave(); return true;
  }

  scheduleLayout() {
    if (this.frame || !this.active || this.disposed) return;
    this.frame = this.browser.requestAnimationFrame(() => { this.frame = null; this.render(); });
  }

  renderWindow(key) {
    const element = this.elements.get(key), state = this.windows[key];
    if (!element || !state) return;
    const parent = this.single || state.zone === 'scene' ? this.sceneArea : this.canvas;
    if (!this.fullscreenGeometry(key) && element.parentElement !== parent) {
      const focus = element.contains(this.doc.activeElement) ? this.doc.activeElement : null;
      parent.append(element);
      if (focus && this.doc.activeElement !== focus) focus.focus({ preventScroll: true });
      if (this.gesture?.key === key) this.gesture.handle.setPointerCapture(this.gesture.pointerId);
    }
    element.hidden = !state.visible;
    element.dataset.windowZone = state.zone;
    element.dataset.collapsed = String(state.collapsed);
    element.classList.toggle('is-active', this.focused === key);
    const bounds = this.bounds(key);
    if (bounds.width > 0 && bounds.height > 0) {
      const geometry = fitWindowGeometry(state, bounds, this.config, key);
      for (const name of ['x', 'y', 'width', 'height']) element.style.setProperty(`--window-${name}`, `${geometry[name]}px`);
    }
    const appearance = this.state.appearance[key];
    element.style.setProperty('--window-bg', appearance.background);
    element.style.setProperty('--window-fg', appearance.foreground);
    element.style.setProperty('--window-alpha', String(appearance.opacity));
    element.style.setProperty('--window-radius', `${appearance.radius}px`);
    element.style.setProperty('--window-font-scale', String(appearance.fontScale));
    if (key === 'scene') this.onAppearanceChange?.(key, appearance);
    element.style.setProperty('--window-z', String(this.layout.order.indexOf(key) + 1));
    const hints = this.config.display.modes[this.state.displayMode].hints;
    for (const handle of element.querySelectorAll(':scope > .cosmic-window-header [data-window-drag], :scope > [data-window-resize]')) {
      handle.disabled = this.fullscreenGeometry(key) || this.single && key === 'scene';
      handle.title = hints[`${key === 'scene' ? 'scene' : 'window'}${handle.hasAttribute('data-window-drag') ? 'Move' : 'Resize'}`];
    }
    const collapse = element.querySelector('[data-window-action="collapse"]');
    if (collapse) {
      collapse.setAttribute('aria-expanded', String(!state.collapsed));
      collapse.setAttribute('aria-label', `${state.collapsed ? '展开' : '收起'}${this.title(key)}`);
      collapse.title = state.collapsed ? '展开模块' : '收起模块';
    }
    for (const toggle of this.root.querySelectorAll('[data-cosmic-toggle]')) {
      if (toggle.dataset.cosmicToggle === key) toggle.setAttribute('aria-pressed', String(state.visible));
    }
  }

  renderRail() {
    const { width, menuRatio, geometry } = this.config.rail;
    const fitted = fitRailWidth(this.state.rail.width, this.shell.clientWidth, this.config);
    const maximum = fitRailWidth(width.max, this.shell.clientWidth, this.config);
    this.shell.style.setProperty('--cosmic-rail-width', `${fitted}px`);
    this.shell.style.setProperty('--cosmic-rail-menu-ratio', String(this.state.rail.menuRatio));
    this.shell.style.setProperty('--cosmic-rail-splitter-size', `${geometry.splitterSize}px`);
    this.shell.style.setProperty('--cosmic-rail-item-min-width', `${geometry.itemMinWidth}px`);
    this.railResize.setAttribute('aria-valuemin', String(width.min));
    this.railResize.setAttribute('aria-valuemax', String(Math.round(maximum)));
    this.railResize.setAttribute('aria-valuenow', String(Math.round(fitted)));
    this.railResize.setAttribute('aria-valuetext', `右侧栏 ${Math.round(fitted)} 像素`);
    this.railSplitter.setAttribute('aria-valuemin', String(Math.round(menuRatio.min * 100)));
    this.railSplitter.setAttribute('aria-valuemax', String(Math.round(menuRatio.max * 100)));
    this.railSplitter.setAttribute('aria-valuenow', String(Math.round(this.state.rail.menuRatio * 100)));
    this.railSplitter.setAttribute('aria-valuetext', `菜单栏 ${Math.round(this.state.rail.menuRatio * 100)}%，程序坞 ${Math.round((1 - this.state.rail.menuRatio) * 100)}%`);
    this.renderAppearanceTarget('menu');
    this.renderAppearanceTarget('dock');
  }

  renderAppearanceTarget(key) {
    if (key === 'global') {
      const appearance = this.state.appearance.global;
      for (const [name, [, variable]] of Object.entries(globalFields)) {
        this.root.style.setProperty(`--cosmic-${variable}`, appearance[name]);
      }
      this.root.style.setProperty('--cosmic-glass-blur', `${appearance.glassEnabled ? appearance.glassBlur : 0}px`);
      return;
    }
    if (!isRailAppearanceTarget(key)) { this.renderWindow(key); return; }
    const element = key === 'menu' ? this.railMenu : this.railDock;
    const appearance = this.state.appearance[key];
    element.style.setProperty('--rail-panel-bg', appearance.background);
    element.style.setProperty('--rail-panel-fg', appearance.foreground);
    element.style.setProperty('--rail-panel-icon-fg', appearance.iconColor);
    element.style.setProperty('--rail-panel-icon-alpha', String(appearance.iconOpacity));
    element.style.setProperty('--rail-panel-font-alpha', String(appearance.fontOpacity));
    element.style.setProperty('--rail-panel-alpha', String(appearance.opacity));
    element.style.setProperty('--rail-panel-radius', `${appearance.radius}px`);
    element.style.setProperty('--rail-panel-icon-size', `${appearance.iconSize}px`);
    element.style.setProperty('--rail-panel-font-size', `${appearance.fontSize}px`);
  }

  render() {
    if (!this.active || this.disposed) return;
    if (this.rendering) { this.scheduleLayout(); return; }
    this.rendering = true;
    try {
      // Switch the CSS layout before measuring either area, so geometry fits the
      // destination mode rather than the old split columns.
      this.root.dataset.displayMode = this.state.displayMode;
      this.renderAppearanceTarget('global');
      this.renderRail();
      this.shell.style.setProperty('--cosmic-split', String(this.state.split));
      this.splitter.hidden = this.single;
      this.splitter.disabled = this.single;
      this.splitter.tabIndex = this.single ? -1 : 0;
      this.splitter.setAttribute('aria-disabled', String(this.single));
      this.splitter.setAttribute('aria-valuemin', String(Math.round(this.config.split.min * 100)));
      this.splitter.setAttribute('aria-valuemax', String(Math.round(this.config.split.max * 100)));
      this.splitter.setAttribute('aria-valuenow', String(Math.round(this.state.split * 100)));
      this.splitter.setAttribute('aria-valuetext', `3D 场景 ${Math.round(this.state.split * 100)}%，工具区 ${Math.round((1 - this.state.split) * 100)}%`);
      const currentLabel = this.config.display.modes[this.state.displayMode].label;
      const nextLabel = this.config.display.modes[this.single ? 'dual' : 'single'].label;
      for (const button of this.root.querySelectorAll('[data-cosmic-command="display-mode"]')) {
        const description = `显示类型：${currentLabel}，切换为${nextLabel}`;
        button.setAttribute('aria-label', description);
        button.setAttribute('aria-pressed', String(!this.single));
        button.title = description;
        const label = button.querySelector('[data-display-mode-label]');
        if (label) label.textContent = currentLabel;
      }
      let height = this.desktop.clientHeight;
      for (const key of this.elements.keys()) {
        this.renderWindow(key);
        const window = this.windows[key];
        if (this.single || !window || !window.visible || window.zone !== 'tools' || !this.desktop.clientWidth) continue;
        const geometry = fitWindowGeometry(window, this.bounds(key), this.config, key);
        height = Math.max(height, geometry.y + (window.collapsed ? this.config.geometry.titleHeight : geometry.height) + this.config.geometry.padding);
      }
      this.canvas.style.setProperty('--canvas-height', `${height}px`);
    } finally {
      this.rendering = false;
    }
  }

  title(key) {
    return this.elements.get(key)?.querySelector('[data-window-drag]')?.textContent.trim() || key;
  }

  raise(key) {
    if (this.focused === key && this.layout.order.at(-1) === key) return;
    this.focused = key;
    this.layout.order = this.layout.order.filter(item => item !== key).concat(key);
    this.render(); this.save();
  }

  reveal(key) {
    if (this.single || this.windows[key].zone === 'scene' || !this.active) return;
    const window = this.windows[key];
    const geometry = fitWindowGeometry(window, this.bounds(key), this.config, key);
    const top = this.desktop.scrollTop, bottom = top + this.desktop.clientHeight;
    const headerBottom = geometry.y + this.config.geometry.titleHeight;
    if (geometry.y < top || headerBottom > bottom) this.desktop.scrollTop = Math.max(0, geometry.y - this.config.geometry.padding);
  }

  show(value) {
    const key = this.resolve(value); if (!key) return false;
    // Native fullscreen only paints descendants of its fullscreen element.
    // Opening a desktop tool must first restore the desktop containing it.
    if (this.sceneFullscreen() && !this.elements.get('scene').contains(this.elements.get(key))
      && this.exitFullscreenBefore('scene', () => this.show(value))) return true;
    const wasVisible = this.windows[key].visible;
    this.windows[key].visible = true;
    this.raise(key); this.render(); this.reveal(key); this.save();
    if (!wasVisible) this.root.dispatchEvent(new this.browser.CustomEvent('cosmic-window-show', { detail: { key } }));
    return true;
  }

  hide(value) {
    const key = this.resolve(value); if (!key) return false;
    if (this.exitFullscreenBefore(key, () => this.hide(key))) return true;
    if (this.gesture?.key === key) this.cancelGesture();
    const ownedFocus = this.elements.get(key).contains(this.doc.activeElement);
    this.windows[key].visible = false;
    this.render(); this.save();
    const toggle = [...this.root.querySelectorAll('[data-cosmic-toggle]')].find(element => element.dataset.cosmicToggle === key);
    if (ownedFocus) toggle?.focus({ preventScroll: true });
    return true;
  }

  toggle(value) {
    const key = this.resolve(value); if (!key) return false;
    return this.windows[key].visible ? this.hide(key) : this.show(key);
  }

  collapse(key) {
    if (this.exitFullscreenBefore(key, () => this.collapse(key))) return;
    const state = this.windows[key];
    state.collapsed = !state.collapsed;
    this.raise(key); this.render(); this.save();
    if (!state.collapsed) this.root.dispatchEvent(new this.browser.CustomEvent('cosmic-window-show', { detail: { key } }));
  }

  click(event) {
    if (!this.active) return;
    if (event.target.closest('#scene-fullscreen')) this.scheduleLayout();
    const appearance = event.target.closest('[data-cosmic-appearance]');
    if (appearance) { this.openAppearance(appearance.dataset.cosmicAppearance); return; }
    const toggle = event.target.closest('[data-cosmic-toggle]');
    if (toggle) { this.toggle(toggle.dataset.cosmicToggle); return; }
    const command = event.target.closest('[data-cosmic-command]')?.dataset.cosmicCommand;
    if (command) {
      if (command === 'reset-layout') this.resetLayout();
      else if (command === 'display-mode') this.setDisplayMode(this.single ? 'dual' : 'single');
      else if (command === 'appearance') this.openAppearance(this.focused);
      else this.onCommand(command);
      return;
    }
    const action = event.target.closest('[data-window-action]');
    const key = action?.closest('[data-cosmic-window]')?.dataset.cosmicWindow;
    if (!key) return;
    if (action.dataset.windowAction === 'hide') this.hide(key);
    if (action.dataset.windowAction === 'collapse') this.collapse(key);
    if (action.dataset.windowAction === 'appearance') this.openAppearance(key);
  }

  pointerDown(event) {
    if (!this.active || event.button !== 0 || this.gesture) return;
    const element = event.target.closest('[data-cosmic-window]');
    const key = element?.dataset.cosmicWindow;
    if (key) this.raise(key);
    const splitter = event.target.closest('#cosmic-splitter');
    const railResize = event.target.closest('#cosmic-rail-resize');
    const railSplitter = event.target.closest('#cosmic-rail-splitter');
    const drag = event.target.closest('[data-window-drag]');
    const resize = event.target.closest('[data-window-resize]');
    if (!splitter && !railResize && !railSplitter && !drag && !resize) return;
    if (this.single && (splitter || key === 'scene') && !railResize && !railSplitter) return;
    if (key && this.fullscreenGeometry(key) && !railResize && !railSplitter) return;
    const handle = railResize || railSplitter || splitter || drag || resize;
    if (resize && this.windows[key].collapsed) return;
    const kind = railResize ? 'rail-width' : railSplitter ? 'rail-menu' : splitter ? 'split' : resize ? 'resize' : 'move';
    const state = key && this.windows[key];
    const rect = element?.getBoundingClientRect();
    this.gesture = {
      kind, key, handle, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
      scrollTop: this.desktop.scrollTop, start: state && fitWindowGeometry(state, this.bounds(key), this.config, key),
      before: state && structuredClone(state), split: this.state.split, moved: false,
      rail: (railResize || railSplitter) && { ...this.state.rail },
      railWidth: railResize && this.rail.getBoundingClientRect().width,
      railHeight: railSplitter && this.railMenu.getBoundingClientRect().height + this.railDock.getBoundingClientRect().height,
      grab: rect && { x: event.clientX - rect.left, y: event.clientY - rect.top },
      area: state && this.areaMetrics(state.zone),
    };
    event.preventDefault(); handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
  }

  pointerMove(event) {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const x = event.clientX - gesture.clientX;
    const y = event.clientY - gesture.clientY + (gesture.before?.zone === 'tools' ? this.desktop.scrollTop - gesture.scrollTop : 0);
    const distance = gesture.kind === 'rail-width' ? Math.abs(x) : gesture.kind === 'rail-menu' ? Math.abs(y) : Math.hypot(x, y);
    if (!gesture.moved && distance < this.config.geometry.dragThreshold) return;
    gesture.moved = true;
    this.root.dataset.windowGesture = gesture.kind;
    if (gesture.kind === 'rail-width') {
      this.state.rail.width = fitRailWidth(gesture.railWidth - x, this.shell.clientWidth, this.config);
    } else if (gesture.kind === 'rail-menu') {
      const { min, max } = this.config.rail.menuRatio;
      if (gesture.railHeight > 0) this.state.rail.menuRatio = clamp(gesture.rail.menuRatio + y / gesture.railHeight, min, max);
    } else if (gesture.kind === 'split') {
      const width = this.sceneArea.clientWidth + this.desktop.clientWidth;
      if (width > 0) this.state.split = clamp(gesture.split + x / width, this.config.split.min, this.config.split.max);
    } else if (gesture.kind === 'move' && gesture.key !== 'scene') {
      const zone = this.pointerZone(event.clientX, this.windows[gesture.key].zone);
      const point = windowPointFromPointer({ x: event.clientX, y: event.clientY }, gesture.grab, this.areaMetrics(zone));
      this.windows[gesture.key] = placeWindowGeometry(gesture.before, point, this.bounds(gesture.key, zone), this.config, gesture.key, zone);
    } else {
      this.windows[gesture.key] = changeWindowGeometry(gesture.before, gesture.start, { x, y }, gesture.kind, this.bounds(gesture.key), this.config, gesture.key);
    }
    this.render();
  }

  pointerEnd(event, cancelled = false) {
    if (!this.gesture || event.pointerId !== this.gesture.pointerId) return;
    if (cancelled) { this.cancelGesture(); return; }
    this.releaseGesture(); this.save();
  }

  releaseGesture() {
    const gesture = this.gesture; this.gesture = null;
    delete this.root.dataset.windowGesture;
    if (gesture?.handle.hasPointerCapture(gesture.pointerId)) gesture.handle.releasePointerCapture(gesture.pointerId);
  }

  cancelGesture() {
    if (!this.gesture) return;
    if (this.gesture.rail) this.state.rail = this.gesture.rail;
    else if (this.gesture.kind === 'split') this.state.split = this.gesture.split;
    else this.windows[this.gesture.key] = this.gesture.before;
    this.releaseGesture(); this.render();
  }

  keydown(event) {
    if (!this.active || this.gesture || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const railResize = event.target.closest('#cosmic-rail-resize');
    const railSplitter = event.target.closest('#cosmic-rail-splitter');
    if (railResize || railSplitter) {
      const directionKeys = railResize ? ['ArrowRight', 'ArrowLeft'] : ['ArrowUp', 'ArrowDown'];
      if (!['Home', 'End', ...directionKeys].includes(event.key)) return;
      event.preventDefault();
      const property = railResize ? 'width' : 'menuRatio';
      const { min, max, value, step } = this.config.rail[property];
      const start = railResize ? fitRailWidth(this.state.rail.width, this.shell.clientWidth, this.config) : this.state.rail.menuRatio;
      const next = event.key === 'Home' ? event.altKey ? value : min : event.key === 'End' ? max
        : start + (event.key === directionKeys[0] ? -step : step);
      this.state.rail[property] = railResize ? fitRailWidth(next, this.shell.clientWidth, this.config) : clamp(next, min, max);
      this.render(); this.save(); return;
    }
    if (event.target.closest('#cosmic-splitter')) {
      event.preventDefault();
      if (this.single) return;
      const { min, max, value, step } = this.config.split;
      this.state.split = event.key === 'Home' ? min : event.key === 'End' ? max
        : clamp(this.state.split + (['ArrowLeft', 'ArrowDown'].includes(event.key) ? -step : step), min, max);
      if (event.altKey && event.key === 'Home') this.state.split = value;
      this.render(); this.save(); return;
    }
    const drag = event.target.closest('[data-window-drag]'), resize = event.target.closest('[data-window-resize]');
    if (!drag && !resize) return;
    const key = (drag || resize).closest('[data-cosmic-window]').dataset.cosmicWindow;
    if (this.fullscreenGeometry(key) || this.single && key === 'scene') return;
    const window = this.windows[key];
    if (drag && key !== 'scene' && (event.ctrlKey && ['ArrowLeft', 'ArrowRight'].includes(event.key) || event.altKey && event.key === 'Home')) {
      event.preventDefault();
      if (this.single) return;
      const zone = event.key === 'Home' ? window.zone === 'scene' ? 'tools' : 'scene' : event.key === 'ArrowLeft' ? 'scene' : 'tools';
      const rect = this.elements.get(key).getBoundingClientRect();
      const point = windowPointFromPointer({ x: rect.left, y: rect.top }, { x: 0, y: 0 }, this.areaMetrics(zone));
      this.windows[key] = placeWindowGeometry(window, point, this.bounds(key, zone), this.config, key, zone);
      this.raise(key); this.render(); this.reveal(key); this.save(); return;
    }
    if (['Home', 'End'].includes(event.key)) return;
    if (resize && window.collapsed) return;
    event.preventDefault();
    const step = this.config.geometry.keyboardStep * (event.shiftKey ? 2 : 1);
    const delta = { x: event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, y: event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0 };
    this.windows[key] = changeWindowGeometry(window, fitWindowGeometry(window, this.bounds(key), this.config, key), delta, resize ? 'resize' : 'move', this.bounds(key), this.config, key);
    this.raise(key); this.render(); this.reveal(key); this.save();
  }

  configureAppearanceFields() {
    this.listen(this.fields.target, 'change', () => {
      if (this.isAppearanceTarget(this.fields.target.value)) this.styleTarget = this.fields.target.value;
      this.syncAppearance();
    });
    for (const name of ['bg', 'fg', 'alpha', 'radius', 'icon-color', 'icon-alpha', 'icon-size', 'font-alpha', 'font-size', 'font-scale']) this.listen(this.fields[name], 'input', () => this.updateAppearance());
    for (const [name] of Object.values(globalFields)) this.listen(this.fields[name], 'input', () => this.updateAppearance());
    this.listen(this.fields['global-glass-enabled'], 'change', () => this.updateAppearance());
    this.listen(this.fields['global-glass-blur'], 'input', () => this.updateAppearance());
    this.listen(this.fields.reset, 'click', () => this.resetAppearance());
    this.syncAppearance();
  }

  openAppearance(key) {
    if (!this.isAppearanceTarget(key)) key = 'scene';
    if (this.sceneFullscreen() && !this.elements.get('scene').contains(this.elements.get('appearance'))
      && this.exitFullscreenBefore('scene', () => this.openAppearance(key))) return;
    this.styleTarget = key; this.syncAppearance();
    this.windows.appearance.collapsed = false;
    this.show('appearance');
  }

  syncAppearance() {
    const external = this.appearancePanels.has(this.styleTarget);
    for (const [key, panel] of this.appearancePanels) panel.hidden = key !== this.styleTarget;
    this.fields.target.value = this.styleTarget;
    this.fields.reset.hidden = external;
    this.fields.reset.disabled = external;
    if (external) {
      for (const name of ['global-fields', 'surface-fields', 'text-fields', 'rail-fields', 'scene-hint']) this.fields[name].hidden = true;
      return;
    }
    const appearance = this.state.appearance[this.styleTarget]; if (!appearance) return;
    const global = this.styleTarget === 'global';
    this.fields['global-fields'].hidden = !global;
    this.fields['surface-fields'].hidden = global;
    this.fields['text-fields'].hidden = global;
    this.fields['scene-hint'].hidden = this.styleTarget !== 'scene';
    this.fields.target.value = this.styleTarget;
    for (const [key, [name]] of Object.entries(globalFields)) {
      this.fields[name].disabled = !global;
      if (global) this.fields[name].value = appearance[key];
    }
    this.fields['global-glass-enabled'].disabled = !global;
    this.fields['global-glass-blur'].disabled = !global;
    if (global) {
      this.fields['rail-fields'].hidden = true;
      this.fields['global-glass-enabled'].checked = appearance.glassEnabled;
      const blur = this.fields['global-glass-blur'];
      for (const property of ['min', 'max', 'step']) blur[property] = this.config.theme.glass.limits[property];
      blur.value = appearance.glassBlur;
      this.fields['global-glass-blur-value'].textContent = `${appearance.glassBlur}px`;
      return;
    }
    const rail = isRailAppearanceTarget(this.styleTarget);
    const limits = appearanceLimits(this.config, this.styleTarget);
    this.fields['rail-fields'].hidden = !rail;
    this.fields['font-alpha-field'].hidden = !rail;
    this.fields['font-size-field'].hidden = !rail;
    this.fields['font-scale-field'].hidden = rail;
    this.fields['icon-color'].disabled = !rail;
    for (const [name, field] of [
      ['alpha', 'opacity'], ['radius', 'radius'], ['icon-size', 'iconSize'], ['icon-alpha', 'iconOpacity'],
      ['font-size', 'fontSize'], ['font-alpha', 'fontOpacity'], ['font-scale', 'fontScale'],
    ]) {
      const input = this.fields[name], limit = limits[field];
      input.disabled = !limit;
      if (!limit) continue;
      for (const property of ['min', 'max', 'step']) input[property] = limit[property];
      input.value = appearance[field];
    }
    const { background, foreground, opacity, radius } = appearance;
    this.fields.target.value = this.styleTarget;
    this.fields.bg.value = background; this.fields.fg.value = foreground;
    this.fields.alpha.value = opacity; this.fields.radius.value = radius;
    this.fields['alpha-value'].textContent = `${Math.round(opacity * 100)}%`;
    this.fields['radius-value'].textContent = `${radius}px`;
    if (rail) {
      this.fields['icon-color'].value = appearance.iconColor;
      this.fields['icon-alpha-value'].textContent = `${Math.round(appearance.iconOpacity * 100)}%`;
      this.fields['icon-size-value'].textContent = `${appearance.iconSize}px`;
      this.fields['font-alpha-value'].textContent = `${Math.round(appearance.fontOpacity * 100)}%`;
      this.fields['font-size-value'].textContent = `${appearance.fontSize}px`;
    } else {
      this.fields['font-scale-value'].textContent = `${Math.round(appearance.fontScale * 100)}%`;
    }
  }

  updateAppearance() {
    const appearance = this.state.appearance[this.styleTarget]; if (!appearance) return;
    if (this.styleTarget === 'global') {
      this.state.appearance.global = normalizeGlobalAppearance({
        ...Object.fromEntries(Object.entries(globalFields).map(([key, [name]]) => [key, this.fields[name].value])),
        glassEnabled: this.fields['global-glass-enabled'].checked,
        glassBlur: Number(this.fields['global-glass-blur'].value),
      }, appearance, this.config.theme.glass.limits);
      this.renderAppearanceTarget('global'); this.syncAppearance(); this.save(); return;
    }
    this.state.appearance[this.styleTarget] = normalizeAppearance({
      background: this.fields.bg.value, foreground: this.fields.fg.value,
      opacity: Number(this.fields.alpha.value), radius: Number(this.fields.radius.value),
      iconColor: this.fields['icon-color'].value,
      iconOpacity: Number(this.fields['icon-alpha'].value), fontOpacity: Number(this.fields['font-alpha'].value),
      iconSize: Number(this.fields['icon-size'].value), fontSize: Number(this.fields['font-size'].value),
      fontScale: Number(this.fields['font-scale'].value),
    }, appearance, appearanceLimits(this.config, this.styleTarget));
    this.renderAppearanceTarget(this.styleTarget); this.syncAppearance(); this.save();
  }

  resetAppearance() {
    if (!Object.hasOwn(this.state.appearance, this.styleTarget)) return;
    this.state.appearance[this.styleTarget] = defaultAppearance(this.config, this.styleTarget);
    this.renderAppearanceTarget(this.styleTarget); this.syncAppearance(); this.save();
  }

  resetLayout() {
    this.cancelGesture();
    this.state = resetCurrentLayout(this.state, this.config);
    this.focused = this.layout.order.findLast(key => this.windows[key].visible) ?? 'scene';
    this.desktop.scrollTop = 0; this.render(); this.save();
  }

  setDisplayMode(mode) {
    if (!['dual', 'single'].includes(mode) || mode === this.state.displayMode) return;
    if (this.exitFullscreenBefore('scene', () => this.setDisplayMode(mode))) return;
    this.cancelGesture();
    this.state = changeDisplayMode(this.state, mode);
    this.focused = this.layout.order.findLast(key => this.windows[key].visible) ?? 'scene';
    this.render(); this.save();
    // This is a layout change, not a window-open operation: business handlers
    // must not recapture snapshots or overwrite editors during a mode switch.
    this.root.dispatchEvent(new this.browser.CustomEvent('cosmic-display-mode-change', { detail: { mode } }));
  }

  setActive(active) {
    if (!active) this.cancelGesture();
    this.active = Boolean(active);
    if (this.active) this.scheduleLayout();
  }

  dispose() {
    this.cancelGesture(); this.disposed = true;
    this.observer.disconnect(); this.listeners.splice(0).forEach(remove => remove());
    if (this.frame) this.browser.cancelAnimationFrame(this.frame);
  }
}
