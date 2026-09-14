import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export const mainSource = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
export const htmlSource = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

/** Extract a real function, allowing formatting changes but preserving its body. */
export function sourceFunction(source, name) {
  const match = new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} must remain available for the integration harness`);
  const end = source.indexOf(`\n${match[1]}}`, match.index);
  assert.ok(end > match.index, `${name} must have a matching outer closing brace`);
  return source.slice(match.index, end + match[1].length + 2);
}

const decode = value => value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
})[entity]);
const dataName = key => key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

/** A small DOM boundary for the actual static HTML and its cloned templates. */
export class UIElement {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName;
    this.attributes = { ...attributes };
    this.children = [];
    this.dataset = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (key.startsWith('data-')) this.dataset[dataName(key)] = value;
    }
    this.hidden = Object.hasOwn(attributes, 'hidden');
    this.open = Object.hasOwn(attributes, 'open');
    this.value = attributes.value ?? '';
    this._text = '';
    const classes = new Set((attributes.class ?? '').split(/\s+/).filter(Boolean));
    this.classList = {
      contains: name => classes.has(name),
      toggle(name, force = !classes.has(name)) {
        if (force) classes.add(name);
        else classes.delete(name);
        return force;
      },
    };
    this.style = new Map();
    this.style.setProperty = (key, value) => this.style.set(key, value);
    this.clientHeight = 0;
    this.scrollTop = 0;
    if (tagName === 'template') this.content = new UIElement('#fragment');
  }

  get textContent() {
    return this._text + this.children.map(child => child.textContent).join('');
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get firstElementChild() {
    return this.children.find(child => child.tagName !== '#text');
  }

  append(...nodes) {
    if (this.content) return this.content.append(...nodes);
    for (const node of nodes) {
      if (node.tagName === '#fragment') this.children.push(...node.children);
      else this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }

  matches(selector) {
    if (selector.startsWith('#')) return this.attributes.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const attribute = /^\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(selector);
    if (attribute) {
      return Object.hasOwn(this.attributes, attribute[1])
        && (attribute[2] === undefined || this.attributes[attribute[1]] === attribute[2]);
    }
    return this.tagName === selector;
  }

  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  cloneNode(deep) {
    const clone = new UIElement(this.tagName, this.attributes);
    clone._text = this._text;
    if (deep) clone.append(...this.children.map(child => child.cloneNode(true)));
    return clone;
  }
}

export function staticDocument() {
  const root = new UIElement('#document');
  const stack = [root];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const tokens = htmlSource.match(/<(?:!--[\s\S]*?--|!DOCTYPE[^>]*|\/?[a-zA-Z][\w:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*)>|[^<]+/gi);
  for (const token of tokens) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      const tagName = /^<\/([\w-]+)/.exec(token)[1].toLowerCase();
      const index = stack.findLastIndex(node => node.tagName === tagName);
      if (index > 0) stack.length = index;
    } else if (token.startsWith('<')) {
      const [, name, source] = /^<([\w-]+)([\s\S]*)>$/.exec(token);
      const tagName = name.toLowerCase();
      const attributes = {};
      for (const match of source.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attributes[match[1]] = decode(match[2] ?? match[3] ?? match[4] ?? '');
      }
      const element = new UIElement(tagName, attributes);
      stack.at(-1).append(element);
      if (!voidTags.has(tagName) && !token.endsWith('/>')) stack.push(element);
    } else {
      const node = new UIElement('#text');
      node._text = decode(token);
      stack.at(-1).append(node);
    }
  }
  root.getElementById = id => root.querySelector(`#${id}`);
  root.createDocumentFragment = () => new UIElement('#fragment');
  return root;
}

export function inspectorHarness(model, engine, selected, displayNodeId, extra = {}) {
  const document = staticDocument();
  const $ = id => {
    const element = document.getElementById(id);
    assert.ok(element, `static element #${id} must exist`);
    return element;
  };
  const cloneTemplate = id => $(id).content.firstElementChild.cloneNode(true);
  const state = { model, engine, selected, ...extra };
  const render = new Function('$', 'cloneTemplate', 'document', 'state', 'displayNodeId', `
    with (state) {
      ${sourceFunction(mainSource, 'renderInspector')}
      return renderInspector;
    }
  `)($, cloneTemplate, document, state, displayNodeId);
  return { document, $, state, render };
}
