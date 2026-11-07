import { comparePaths } from '../jk/node-id.js';

/** JKS containment navigation; selection addresses always identify a real JKI. */
export class NodeTree {
  constructor({ element, groupTemplate, nodeTemplate, tagTemplate, onSelect, expandedDepth }) {
    Object.assign(this, { element, groupTemplate, nodeTemplate, tagTemplate, onSelect, expandedDepth });
    this.items = new Map(); this.roots = []; this.focused = null; this.selected = null;
    this.handleClick = event => {
      const row = event.target.closest?.('[data-tree-row]');
      if (!row || !this.element.contains(row)) return;
      const item = this.items.get(row.parentElement.dataset.path);
      if (!item) return;
      this.focus(item);
      if (item.group) this.expand(item, item.group.hidden);
      else { this.select(item.path); this.onSelect(item.path); }
    };
    this.handleFocus = event => {
      const item = this.fromTarget(event.target);
      if (item) this.rove(item);
    };
    this.handleKey = event => this.keydown(event);
    element.addEventListener('click', this.handleClick);
    element.addEventListener('focusin', this.handleFocus);
    element.addEventListener('keydown', this.handleKey);
  }

  fromTarget(target) {
    const element = target.closest?.('[role="treeitem"]');
    return element && this.element.contains(element) ? this.items.get(element.dataset.path) : null;
  }

  setModel(compiled, selected) {
    if (compiled === this.model) { this.select(selected); return; }
    this.model = compiled; this.items.clear(); this.focused = null; this.selected = null;
    const build = (nodes, parent = null, depth = 1) => [...nodes].sort((a, b) => comparePaths(a.id, b.id)).map((node, index, siblings) => {
      const branch = Array.isArray(node.members), path = parent ? `${parent.path}.${node.id}` : node.id;
      const element = (branch ? this.groupTemplate : this.nodeTemplate).content.firstElementChild.cloneNode(true);
      const row = element.querySelector('[data-tree-row]'), tags = node.pro?.tag || [];
      element.dataset.path = path;
      element.title = path;
      element.setAttribute('aria-label', `${path}${tags.length ? ` · ${tags.join(' · ')}` : ''}`);
      element.setAttribute('aria-level', String(depth));
      element.setAttribute('aria-posinset', String(index + 1));
      element.setAttribute('aria-setsize', String(siblings.length));
      element.querySelector('[data-tree-name]').textContent = node.id;
      const tagContainer = element.querySelector('[data-tree-tags]');
      for (const text of tags) {
        const tag = this.tagTemplate.content.firstElementChild.cloneNode(true);
        tag.textContent = text; tagContainer.append(tag);
      }
      tagContainer.hidden = tags.length === 0;
      const item = { path, element, row, parent, group: branch ? element.querySelector('[role="group"]') : null, children: [] };
      this.items.set(path, item);
      if (branch) {
        item.children = build(node.members, item, depth + 1);
        item.group.append(...item.children.map(child => child.element));
        this.expand(item, depth <= this.expandedDepth);
      }
      return item;
    });
    this.roots = build(compiled.raw.roots);
    this.element.replaceChildren(...this.roots.map(item => item.element));
    this.rove(this.roots[0] || null);
    this.select(selected);
  }

  visible() {
    const items = [];
    const visit = branches => branches.forEach(item => {
      items.push(item);
      if (item.group && !item.group.hidden) visit(item.children);
    });
    visit(this.roots); return items;
  }

  rove(item) {
    if (this.focused) this.focused.element.tabIndex = -1;
    this.focused = item;
    if (item) item.element.tabIndex = 0;
  }

  focus(item) {
    if (!item) return;
    this.rove(item); item.element.focus({ preventScroll: true }); this.scrollRow(item);
  }

  expand(item, open) {
    if (!item.group) return;
    item.group.hidden = !open; item.element.setAttribute('aria-expanded', String(open));
    if (!open && this.focused !== item && this.focused && item.element.contains(this.focused.element)) {
      const ownsFocus = item.group.contains(this.element.ownerDocument.activeElement);
      if (ownsFocus) this.focus(item); else this.rove(item);
    }
  }

  select(path) {
    const item = this.items.get(path), next = item && !item.group ? item : null;
    if (this.selected === next) return;
    if (this.selected !== next) {
      if (this.selected) {
        this.selected.element.setAttribute('aria-selected', 'false');
        this.selected.element.classList.remove('active');
      }
      this.selected = next;
      if (next) {
        next.element.setAttribute('aria-selected', 'true'); next.element.classList.add('active');
      }
    }
    if (!next) return;
    // Selecting a node leaves every branch in its manually chosen expansion state.
    // Preserve keyboard focus while live state updates or scene selections arrive.
    if (!this.element.contains(this.element.ownerDocument.activeElement) && this.visible().includes(next)) this.rove(next);
  }

  scrollRow(item) {
    if (!this.element.clientHeight) return false;
    const box = this.element.getBoundingClientRect(), row = item.row.getBoundingClientRect();
    const top = box.top + this.element.clientTop, bottom = top + this.element.clientHeight;
    if (row.top < top) this.element.scrollTop += row.top - top;
    else if (row.bottom > bottom) this.element.scrollTop += row.bottom - bottom;
    return true;
  }

  keydown(event) {
    const item = this.fromTarget(event.target);
    if (!item || !['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const visible = this.visible(), index = visible.indexOf(item);
    switch (event.key) {
      case 'ArrowDown': this.focus(visible[Math.min(visible.length - 1, index + 1)]); break;
      case 'ArrowUp': this.focus(visible[Math.max(0, index - 1)]); break;
      case 'Home': this.focus(visible[0]); break;
      case 'End': this.focus(visible.at(-1)); break;
      case 'ArrowRight':
        if (item.group?.hidden) this.expand(item, true);
        else if (item.group) this.focus(item.children[0]);
        break;
      case 'ArrowLeft':
        if (item.group && !item.group.hidden) this.expand(item, false);
        else this.focus(item.parent);
        break;
      default:
        if (item.group) this.expand(item, item.group.hidden);
        else { this.select(item.path); this.onSelect(item.path); }
    }
  }

  dispose() {
    this.element.removeEventListener('click', this.handleClick);
    this.element.removeEventListener('focusin', this.handleFocus);
    this.element.removeEventListener('keydown', this.handleKey);
  }
}
