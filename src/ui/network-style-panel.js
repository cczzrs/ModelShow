import { defaultNetworkStyles, normalizeNetworkStyles } from './network-style-state.js';
import { resolveNodeStyle } from '../scene/network-style.js';

/** Connect static controls to display preferences; model definitions remain untouched. */
export class NetworkStylePanel {
  constructor({ root, config, onChange = () => {} }) {
    this.root = root; this.config = config; this.onChange = onChange;
    this.browser = root.ownerDocument.defaultView;
    this.listeners = []; this.tagNodes = new Map();
    this.fields = Object.fromEntries([
      'edge-type', 'edge-color', 'edge-opacity', 'edge-opacity-value', 'edge-length', 'edge-length-value', 'edge-visible', 'edge-reset',
      'node-type', 'node-color', 'node-size', 'node-size-value', 'node-visible', 'node-labels', 'node-reset',
      'node-marker-visible', 'node-marker-color', 'node-marker-visible-field', 'node-marker-color-field',
    ].map(name => [name, root.querySelector(`#network-${name}`)]));
    this.edgeToggles = [...root.querySelectorAll('[data-network-edge-toggle]')];
    this.optionTemplate = root.ownerDocument.getElementById('network-style-option-template');
    this.state = this.restore();
    this.fields['edge-type'].value = config.edges.defaultType;
    this.fields['node-type'].value = config.nodes.defaultType;
    for (const [name, limits] of [
      ['edge-opacity', config.edges.limits.opacity], ['edge-length', config.edges.limits.length], ['node-size', config.nodes.limits.size],
    ]) for (const property of ['min', 'max', 'step']) this.fields[name][property] = limits[property];
    this.listen(this.fields['edge-type'], 'change', () => this.syncEdge());
    this.listen(this.fields['node-type'], 'change', () => this.syncNode());
    for (const name of ['edge-color', 'edge-opacity', 'edge-length']) this.listen(this.fields[name], 'input', () => this.updateEdge());
    this.listen(this.fields['edge-visible'], 'change', () => this.updateEdge());
    this.listen(this.fields['edge-reset'], 'click', () => this.resetEdge());
    for (const button of this.edgeToggles) this.listen(button, 'click', () => this.toggleEdge(button.dataset.networkEdgeToggle));
    for (const name of ['node-color', 'node-size']) this.listen(this.fields[name], 'input', () => this.updateNode(name.slice(5)));
    for (const name of ['node-visible', 'node-labels']) this.listen(this.fields[name], 'change', () => this.updateNode(name.slice(5)));
    this.listen(this.fields['node-marker-visible'], 'change', () => this.updateMarker('visible'));
    this.listen(this.fields['node-marker-color'], 'input', () => this.updateMarker('color'));
    this.listen(this.fields['node-reset'], 'click', () => this.resetNode());
    this.syncEdge(); this.syncNode(); this.syncLegend(); this.onChange(this.state);
  }

  listen(element, type, handler) {
    element.addEventListener(type, handler);
    this.listeners.push(() => element.removeEventListener(type, handler));
  }

  restore() {
    try { return normalizeNetworkStyles(JSON.parse(this.browser.localStorage.getItem(this.config.storage.key)), this.config); }
    catch { return defaultNetworkStyles(this.config); }
  }

  commit(next) {
    this.state = normalizeNetworkStyles(next, this.config);
    this.syncEdge(); this.syncNode(); this.syncLegend(); this.onChange(this.state);
    try { this.browser.localStorage.setItem(this.config.storage.key, JSON.stringify(this.state)); }
    catch {
      this.root.dispatchEvent(new this.browser.CustomEvent('network-style-error', {
        bubbles: true, detail: { message: '浏览器未能保存网络样式；本页设置仍然生效。' },
      }));
    }
  }

  setModel(compiled) {
    const selected = this.fields['node-type'].value;
    this.tagNodes = new Map();
    const inputs = new Set(compiled.inputs);
    for (const [path, definition] of compiled.jki) {
      const node = { isInput: inputs.has(path), hasEX: (definition.sources?.ex?.length ?? 0) > 0, tags: definition.pro?.tag ?? [] };
      for (const tag of node.tags) if (!this.tagNodes.has(tag)) this.tagNodes.set(tag, node);
    }
    for (const option of this.fields['node-type'].querySelectorAll('[data-network-style-tag]')) option.remove();
    for (const tag of this.tagNodes.keys()) {
      const option = this.optionTemplate.content.firstElementChild.cloneNode(true);
      option.value = `tag:${tag}`; option.textContent = `用途：${tag}`;
      option.dataset.networkStyleTag = '';
      this.fields['node-type'].append(option);
    }
    this.fields['node-type'].value = (selected.startsWith('tag:') && this.tagNodes.has(selected.slice(4))
      || Object.hasOwn(this.state.nodes, selected)
      || selected.startsWith('computation:') && Object.hasOwn(this.state.computation, selected.slice(12))) ? selected : this.config.nodes.defaultType;
    this.syncNode();
  }

  nodeSelection() {
    const key = this.fields['node-type'].value;
    if (Object.hasOwn(this.state.nodes, key)) return { key, style: this.state.nodes[key] };
    if (key.startsWith('computation:') && Object.hasOwn(this.state.computation, key.slice(12))) {
      const computation = key.slice(12);
      return { computation, style: { ...this.state.nodes.node, ...this.state.computation[computation] } };
    }
    if (key.startsWith('tag:')) {
      const tag = key.slice(4), node = this.tagNodes.get(tag);
      if (node) return { tag, style: Object.hasOwn(this.state.tags, tag)
        ? this.state.tags[tag] : resolveNodeStyle({ ...node, tags: [] }, this.state) };
    }
    return { key: this.config.nodes.defaultType, style: this.state.nodes[this.config.nodes.defaultType] };
  }

  syncLegend() {
    for (const [attribute, styles] of [['networkNodeColor', this.state.nodes], ['networkEdgeColor', this.state.edges]]) {
      const selector = attribute === 'networkNodeColor' ? '[data-network-node-color]' : '[data-network-edge-color]';
      for (const element of this.root.querySelectorAll(selector)) {
        const key = element.dataset[attribute];
        if (Object.hasOwn(styles, key)) element.style.backgroundColor = styles[key].color;
      }
    }
  }

  syncEdge() {
    for (const button of this.edgeToggles) {
      const key = button.dataset.networkEdgeToggle;
      if (!Object.hasOwn(this.state.edges, key)) continue;
      const { visible } = this.state.edges[key], { label } = this.config.edges.types[key];
      button.setAttribute('aria-pressed', String(visible));
      button.setAttribute('aria-label', `显示或隐藏${label}`);
      button.title = `${visible ? '隐藏' : '显示'}${label}`;
      button.querySelector('[data-network-edge-visibility]').textContent = visible ? '已显示' : '已隐藏';
    }
    const key = this.fields['edge-type'].value;
    const style = this.state.edges[key]; if (!Object.hasOwn(this.state.edges, key)) return;
    this.fields['edge-color'].value = style.color;
    this.fields['edge-opacity'].value = style.opacity;
    this.fields['edge-opacity-value'].textContent = `${Math.round(style.opacity * 100)}%`;
    this.fields['edge-length'].value = style.length;
    this.fields['edge-length-value'].textContent = `${Math.round(style.length * 100)}%`;
    this.fields['edge-visible'].checked = style.visible;
  }

  syncNode() {
    const { tag, computation, style } = this.nodeSelection();
    this.fields['node-color'].value = style.color;
    this.fields['node-size'].value = style.size;
    this.fields['node-size-value'].textContent = `${Math.round(style.size * 100)}%`;
    this.fields['node-visible'].checked = style.visible;
    this.fields['node-labels'].checked = style.labels;
    const isEX = computation === 'ex', marker = this.state.computation.ex.marker;
    this.fields['node-marker-visible-field'].hidden = !isEX;
    this.fields['node-marker-color-field'].hidden = !isEX;
    this.fields['node-marker-visible'].checked = marker.visible;
    this.fields['node-marker-color'].value = marker.color;
    this.fields['node-reset'].textContent = tag === undefined && computation !== 'q' ? '恢复该类默认样式' : '恢复继承样式';
  }

  updateEdge() {
    const key = this.fields['edge-type'].value;
    if (!Object.hasOwn(this.state.edges, key)) return;
    this.commit({ ...this.state, edges: { ...this.state.edges, [key]: {
      color: this.fields['edge-color'].value, opacity: Number(this.fields['edge-opacity'].value),
      length: Number(this.fields['edge-length'].value), visible: this.fields['edge-visible'].checked,
    } } });
  }

  resetEdge() {
    const key = this.fields['edge-type'].value;
    if (!Object.hasOwn(this.state.edges, key)) return;
    this.commit({ ...this.state, edges: { ...this.state.edges, [key]: defaultNetworkStyles(this.config).edges[key] } });
  }

  toggleEdge(key) {
    if (!Object.hasOwn(this.state.edges, key)) return;
    const style = this.state.edges[key];
    this.commit({ ...this.state, edges: { ...this.state.edges, [key]: { ...style, visible: !style.visible } } });
  }

  updateNode(property) {
    const { key, tag, computation } = this.nodeSelection();
    const style = {
      color: this.fields['node-color'].value, size: Number(this.fields['node-size'].value),
      visible: this.fields['node-visible'].checked, labels: this.fields['node-labels'].checked,
    };
    if (tag !== undefined) this.commit({ ...this.state, tags: { ...this.state.tags, [tag]: style } });
    else if (computation !== undefined) this.commit({ ...this.state, computation: { ...this.state.computation,
      [computation]: { ...this.state.computation[computation], [property]: style[property] },
    } });
    else this.commit({ ...this.state, nodes: { ...this.state.nodes, [key]: style } });
  }

  resetNode() {
    const { key, tag, computation } = this.nodeSelection();
    if (tag !== undefined) this.commit({ ...this.state, tags: Object.fromEntries(Object.entries(this.state.tags).filter(([name]) => name !== tag)) });
    else if (computation !== undefined) this.commit({ ...this.state, computation: { ...this.state.computation,
      [computation]: defaultNetworkStyles(this.config).computation[computation],
    } });
    else this.commit({ ...this.state, nodes: { ...this.state.nodes, [key]: defaultNetworkStyles(this.config).nodes[key] } });
  }

  updateMarker(property) {
    if (this.nodeSelection().computation !== 'ex') return;
    const ex = this.state.computation.ex;
    const value = property === 'visible' ? this.fields['node-marker-visible'].checked : this.fields['node-marker-color'].value;
    this.commit({ ...this.state, computation: { ...this.state.computation, ex: {
      ...ex, marker: { ...ex.marker, [property]: value },
    } } });
  }

  dispose() {
    this.listeners.forEach(remove => remove()); this.listeners.length = 0;
  }
}
