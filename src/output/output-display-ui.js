import { APP_CONFIG } from '../config.js';
import {
  CHANNELS,
  defaultDisplay,
  validateDisplay,
  resizeDisplay,
  batchDisplay,
  convertPixel,
  parseBrightness,
  channelsOf,
  evaluatePixel,
} from './output-display.js';

const DEFAULTS = APP_CONFIG.outputBoard;

function parseBits(text) {
  return text.trim() ? text.trim().split(/[\s,，]+/) : [];
}

export function lampDetails(pixel, result) {
  const channels = channelsOf(pixel);
  return CHANNELS.map(key => {
    const channel = channels[key];
    const reading = result?.[key];
    const source = channel.kind === 'fixed' ? '固定值' : channel.bits.join(' → ');
    let details = '未就绪';
    if (reading) {
      details = `位串（列表顺序）：${reading.bits ?? '固定'} · 十进制：${reading.value ?? '未就绪'} · 亮度：${reading.brightness}`;
      if (reading.missing.length) details += '\n' + reading.missing.join('、');
    }
    return `${key.toUpperCase()} · ${source}\n${details}`;
  }).join('\n\n');
}

export class OutputDisplayUI {
  constructor(root, onApply, onExport) {
    this.dialog = root;
    this.onApply = onApply;
    this.onExport = onExport;
    this.config = defaultDisplay();
    this.outputs = [];
    this.values = new Map();
    this.errors = new Map();
    this.selected = 0;
    this.draftSelected = null;
    this.draftMode = null;
    this.modeDrafts = new Map();
    this.disposed = false;
    this.listeners = [];

    this.enabled = this.field('enabled');
    this.rows = this.field('rows');
    this.cols = this.field('cols');
    this.scale = this.field('scale');
    this.start = this.field('start');
    this.width = this.field('width');
    this.order = this.field('order');
    this.mapping = this.field('mapping');
    this.gray = this.field('gray');
    this.mode = this.field('mode');
    this.exportText = this.field('export-text');
    this.error = this.info('error');
    this.required = this.info('required');
    this.previewSize = this.info('preview-size');
    this.preview = this.info('preview');
    this.editorTitle = this.info('editor-title');
    this.readout = this.info('readout');
    this.exportPanel = this.info('export-panel');
    this.convertButton = root.querySelector('[data-display-action="convert"]');
    this.channelRegion = root.querySelector('[data-display-region="channels"]');
    this.packedRegion = root.querySelector('[data-display-region="packed"]');
    this.lampTemplate = root.querySelector('[data-display-template="lamp"]');
    this.optionTemplate = root.querySelector('[data-display-template="output-option"]');
    this.bitTemplate = root.querySelector('[data-display-template="bit-order"]');
    this.channelControls = new Map(CHANNELS.map(key => {
      const box = root.querySelector(`[data-display-channel="${key}"]`);
      return [key, {
        kind: box.querySelector('[data-channel-field="kind"]'),
        radix: box.querySelector('[data-channel-field="radix"]'),
        value: box.querySelector('[data-channel-field="value"]'),
        order: box.querySelector('[data-channel-field="order"]'),
        mapping: box.querySelector('[data-channel-field="mapping"]'),
        fixedRegion: box.querySelector('[data-channel-region="fixed"]'),
        bitsRegion: box.querySelector('[data-channel-region="bits"]'),
        previousRadix: DEFAULTS.channel.radix,
      }];
    }));
    this.bitEditors = new Map([...root.querySelectorAll('[data-bit-editor]')].map(box => [box.dataset.bitEditor, {
      box,
      area: box.querySelector('[data-bits-field="area"]'),
      add: box.querySelector('[data-bits-field="add"]'),
      list: box.querySelector('[data-bits-field="list"]'),
    }]));
    this.packedWidths = Object.fromEntries(CHANNELS.map(key => [key, this.field(`packed-${key}-width`)]));
    this.packedOrder = this.field('packed-order');
    this.packedMapping = this.field('packed-mapping');

    this.initializeDefaults();
    this.bind('click', event => this.handleClick(event));
    this.bind('input', event => this.handleInput(event));
    this.bind('change', event => this.handleChange(event));
    this.render();
  }

  field(name) {
    return this.dialog.querySelector(`[data-display-field="${name}"]`);
  }

  info(name) {
    return this.dialog.querySelector(`[data-display-info="${name}"]`);
  }

  initializeDefaults() {
    for (const control of [this.rows, this.cols]) {
      control.min = DEFAULTS.limits.dimension.min;
      control.max = DEFAULTS.limits.dimension.max;
    }
    this.scale.min = DEFAULTS.limits.scale.min;
    this.scale.max = DEFAULTS.limits.scale.max;
    this.scale.step = DEFAULTS.limits.scale.step;
    for (const control of [this.width, ...Object.values(this.packedWidths)]) {
      control.min = DEFAULTS.limits.channelBits.min;
      control.max = DEFAULTS.limits.channelBits.max;
    }
    this.width.value = DEFAULTS.batch.width;
    this.order.value = DEFAULTS.batch.order;
    this.mapping.value = DEFAULTS.batch.mapping;
    this.gray.checked = DEFAULTS.batch.gray;
  }

  bind(type, handler) {
    this.dialog.addEventListener(type, handler);
    this.listeners.push([type, handler]);
  }

  attempt(action) {
    if (this.disposed) return;
    try {
      action();
      this.error.textContent = '';
      return true;
    } catch (error) {
      this.error.textContent = error.message;
      return false;
    }
  }

  handleClick(event) {
    const bitButton = event.target.closest('[data-bit-action]');
    if (bitButton && this.dialog.contains(bitButton)) {
      const key = bitButton.closest('[data-bit-editor]').dataset.bitEditor;
      const index = Number(bitButton.closest('[data-bit-index]')?.dataset.bitIndex);
      this.editBits(key, bitButton.dataset.bitAction, index);
      return;
    }
    const button = event.target.closest('[data-display-action]');
    if (!button || !this.dialog.contains(button)) return;
    switch (button.dataset.displayAction) {
      case 'close':
        this.close();
        break;
      case 'resize':
        this.attempt(() => {
          this.commit(resizeDisplay(this.config, Number(this.rows.value), Number(this.cols.value)));
          this.resetDraft();
          this.render();
        });
        break;
      case 'batch':
        this.attempt(() => {
          this.commit(batchDisplay(this.config, {
            start: this.start.value,
            width: Number(this.width.value),
            order: this.order.value,
            mapping: this.mapping.value,
            gray: this.gray.checked,
          }, this.outputs));
          this.resetDraft();
          this.render();
        });
        break;
      case 'select-lamp':
        this.selectLamp(Number(button.dataset.lampIndex));
        break;
      case 'convert':
        this.convertDraft();
        break;
      case 'apply-lamp':
        this.applyLamp();
        break;
      case 'export':
        this.attempt(() => {
          this.exportText.value = this.onExport();
          this.exportPanel.open = true;
        });
        break;
    }
  }

  handleInput(event) {
    const control = event.target;
    if (control === this.scale) {
      this.attempt(() => this.commit({ ...this.config, scale: Number(this.scale.value) }));
    }
    if ([this.start, this.width, this.gray].includes(control)) this.requirement();
    if (control.matches('[data-bits-field="area"]')) {
      this.renderBitOrder(control.closest('[data-bit-editor]').dataset.bitEditor);
    }
  }

  handleChange(event) {
    const control = event.target;
    if (control === this.enabled) {
      this.attempt(() => this.commit({ ...this.config, enabled: this.enabled.checked }));
    } else if (control === this.mode) {
      this.changeMode(this.mode.value);
    } else if (control.matches('[data-channel-field="kind"]')) {
      this.showChannelSource(control.closest('[data-display-channel]').dataset.displayChannel);
    } else if (control.matches('[data-channel-field="radix"]')) {
      const key = control.closest('[data-display-channel]').dataset.displayChannel;
      const channel = this.channelControls.get(key);
      const changed = this.attempt(() => {
        const value = parseBrightness(channel.value.value, channel.previousRadix);
        channel.previousRadix = Number(channel.radix.value);
        channel.value.value = value.toString(channel.previousRadix);
      });
      if (!changed) channel.radix.value = channel.previousRadix;
    }
  }

  load(config, outputs, error) {
    this.config = structuredClone(config);
    this.outputs = outputs;
    this.errors = new Map(outputs.filter(output => output.error).map(output => [output.id, output.error]));
    this.selected = 0;
    this.resetDraft();
    this.exportText.value = '';
    this.exportPanel.open = false;
    this.error.textContent = error ?? '';
    this.render();
  }

  commit(config) {
    const next = validateDisplay(config);
    this.config = next;
    this.selected = Math.min(this.selected, next.pixels.length - 1);
    this.onApply(next);
    this.enabled.checked = next.enabled;
    this.renderPreview();
    this.requirement();
  }

  open(index) {
    if (this.disposed) return;
    if (Number.isInteger(index) && index >= 0 && index < this.config.pixels.length) {
      this.selected = index;
    }
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  update(values) {
    this.values = values;
    if (this.dialog.open) this.refreshValues();
  }

  requirement() {
    const width = Number(this.width.value);
    const start = this.outputs.findIndex(output => output.id === this.start.value);
    const available = start < 0 ? 0 : this.outputs.length - start;
    const limits = DEFAULTS.limits.channelBits;
    const valid = Number.isInteger(width) && width >= limits.min && width <= limits.max;
    const count = this.config.rows * this.config.cols;
    const needed = count * width * (this.gray.checked ? 1 : CHANNELS.length);
    this.required.textContent = valid
      ? `${count} 盏灯 · 需要 ${needed} 个 Yi · 可用 ${available} 个${needed > available ? `（缺少 ${needed - available} 个）` : ''}`
      : `每通道位数请输入 ${limits.min}～${limits.max} 的整数。`;
    this.required.classList.toggle('insufficient', !valid || needed > available);
  }

  render() {
    this.enabled.checked = this.config.enabled;
    this.scale.value = this.config.scale ?? DEFAULTS.compatibility.scale;
    this.rows.value = this.config.rows;
    this.cols.value = this.config.cols;
    this.renderOutputOptions();
    this.requirement();
    this.renderPreview();
    this.renderEditor();
  }

  renderOutputOptions() {
    const selects = [this.start, ...[...this.bitEditors.values()].map(editor => editor.add)];
    for (const select of selects) {
      const previous = select.value;
      const options = this.outputs.map(output => {
        const option = this.optionTemplate.content.firstElementChild.cloneNode(true);
        option.value = output.id;
        option.textContent = output.id + (output.error ? '（异常）' : '');
        return option;
      });
      select.replaceChildren(...options);
      if (this.outputs.some(output => output.id === previous)) select.value = previous;
    }
  }

  renderPreview() {
    this.previewSize.textContent = `${this.config.rows} × ${this.config.cols} · ${this.config.pixels.length} 盏灯`;
    this.preview.style.setProperty('--lamp-columns', this.config.cols);
    this.previewButtons = this.config.pixels.map((pixel, index) => {
      const button = this.lampTemplate.content.firstElementChild.cloneNode(true);
      button.textContent = String(index + 1);
      button.dataset.lampIndex = index;
      button.setAttribute('aria-label', `灯 ${index + 1}`);
      return button;
    });
    this.preview.replaceChildren(...this.previewButtons);
    this.refreshValues();
  }

  refreshValues() {
    this.config.pixels.forEach((pixel, index) => {
      const result = evaluatePixel(pixel, this.values, this.errors);
      const button = this.previewButtons?.[index];
      if (!button) return;
      const rgb = CHANNELS.map(key => result[key].brightness);
      button.style.setProperty('--lamp-rgb', rgb.join(','));
      button.classList.toggle('dark-label', rgb.reduce((total, value) => total + value, 0) > 350);
      button.classList.toggle('not-ready', CHANNELS.some(key => !result[key].ready));
      button.classList.toggle('chosen', index === this.selected);
      button.setAttribute('aria-pressed', String(index === this.selected));
      button.title = `灯 ${index + 1}\n` + lampDetails(pixel, result);
    });
    const pixel = this.config.pixels[this.selected];
    this.readout.textContent = lampDetails(pixel, evaluatePixel(pixel, this.values, this.errors));
  }

  selectLamp(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.config.pixels.length) return;
    this.selected = index;
    this.renderEditor();
    this.refreshValues();
  }

  resetDraft() {
    this.draftSelected = null;
    this.draftMode = null;
    this.modeDrafts.clear();
  }

  renderEditor(pixel) {
    if (pixel || this.draftSelected !== this.selected) {
      if (this.draftSelected !== this.selected) this.modeDrafts.clear();
      const draft = structuredClone(pixel ?? this.config.pixels[this.selected]);
      this.draftSelected = this.selected;
      this.draftMode = draft.mode;
      this.modeDrafts.set(draft.mode, draft);
      this.populateDraft(draft);
    }
    this.editorTitle.textContent = `灯 ${this.selected + 1} · 第 ${Math.floor(this.selected / this.config.cols) + 1} 行，第 ${this.selected % this.config.cols + 1} 列`;
    this.mode.value = this.draftMode;
    this.channelRegion.hidden = this.draftMode !== 'channels';
    this.packedRegion.hidden = this.draftMode !== 'packed';
    this.convertButton.textContent = this.draftMode === 'packed' ? '无损转为独立配置' : '无损转为 RGB 打包';
    this.refreshValues();
  }

  populateDraft(pixel) {
    if (pixel.mode === 'packed') {
      this.bitEditors.get('packed').area.value = pixel.bits.join(', ');
      this.renderBitOrder('packed');
      for (const key of CHANNELS) this.packedWidths[key].value = pixel.widths[key];
      this.packedOrder.value = pixel.order;
      this.packedMapping.value = pixel.mapping;
      return;
    }
    for (const key of CHANNELS) {
      const channel = pixel.channels[key];
      const controls = this.channelControls.get(key);
      controls.kind.value = channel.kind;
      controls.previousRadix = DEFAULTS.channel.radix;
      controls.radix.value = DEFAULTS.channel.radix;
      controls.value.value = channel.kind === 'fixed' ? channel.value : DEFAULTS.channel.value;
      controls.order.value = channel.order ?? DEFAULTS.batch.order;
      controls.mapping.value = channel.mapping ?? DEFAULTS.batch.mapping;
      this.bitEditors.get(key).area.value = channel.kind === 'bits' ? channel.bits.join(', ') : '';
      this.renderBitOrder(key);
      this.showChannelSource(key);
    }
  }

  showChannelSource(key) {
    const controls = this.channelControls.get(key);
    controls.fixedRegion.hidden = controls.kind.value !== 'fixed';
    controls.bitsRegion.hidden = controls.kind.value !== 'bits';
  }

  readDraft() {
    if (this.draftMode === 'packed') {
      return {
        mode: 'packed',
        bits: parseBits(this.bitEditors.get('packed').area.value),
        widths: Object.fromEntries(CHANNELS.map(key => [key, Number(this.packedWidths[key].value)])),
        order: this.packedOrder.value,
        mapping: this.packedMapping.value,
      };
    }
    return {
      mode: 'channels',
      channels: Object.fromEntries(CHANNELS.map(key => {
        const controls = this.channelControls.get(key);
        const channel = controls.kind.value === 'fixed'
          ? { kind: 'fixed', value: parseBrightness(controls.value.value, Number(controls.radix.value)) }
          : {
            kind: 'bits',
            bits: parseBits(this.bitEditors.get(key).area.value),
            order: controls.order.value,
            mapping: controls.mapping.value,
          };
        return [key, channel];
      })),
    };
  }

  changeMode(mode) {
    if (mode === this.draftMode) return;
    const changed = this.attempt(() => {
      const draft = this.readDraft();
      this.modeDrafts.set(this.draftMode, structuredClone(draft));
      let next;
      try {
        next = convertPixel(draft, mode);
      } catch (error) {
        if (mode !== 'packed') throw error;
        next = this.modeDrafts.get(mode) ?? {
          mode: 'packed',
          bits: [],
          ...structuredClone(DEFAULTS.packed),
        };
      }
      this.renderEditor(next);
    });
    if (!changed) this.mode.value = this.draftMode;
  }

  convertDraft() {
    this.attempt(() => {
      const draft = this.readDraft();
      const mode = this.draftMode === 'packed' ? 'channels' : 'packed';
      const converted = convertPixel(draft, mode);
      const next = structuredClone(this.config);
      next.pixels[this.selected] = converted;
      // Conversion is checked against the complete display contract, but only
      // the editor receives it. Applied configuration changes in applyLamp().
      const validated = validateDisplay(next);
      this.modeDrafts.set(this.draftMode, structuredClone(draft));
      this.renderEditor(validated.pixels[this.selected]);
    });
  }

  applyLamp() {
    this.attempt(() => {
      const next = structuredClone(this.config);
      next.pixels[this.selected] = this.readDraft();
      this.commit(next);
      this.renderEditor(this.config.pixels[this.selected]);
    });
  }

  editBits(key, action, index) {
    const editor = this.bitEditors.get(key);
    const bits = parseBits(editor.area.value);
    if (action === 'append') {
      if (!editor.add.value) return;
      bits.push(editor.add.value);
    } else {
      if (!Number.isInteger(index) || index < 0 || index >= bits.length) return;
      if (action === 'remove') {
        bits.splice(index, 1);
      } else {
        const target = index + (action === 'up' ? -1 : 1);
        if (target < 0 || target >= bits.length) return;
        [bits[index], bits[target]] = [bits[target], bits[index]];
      }
    }
    editor.area.value = bits.join(', ');
    this.renderBitOrder(key);
  }

  renderBitOrder(key) {
    const editor = this.bitEditors.get(key);
    const title = key === 'packed' ? '打包 Yi 列表（依次分为 R、G、B）' : `${key.toUpperCase()} Yi 列表`;
    const bits = parseBits(editor.area.value);
    const rows = bits.map((id, index) => {
      const row = this.bitTemplate.content.firstElementChild.cloneNode(true);
      row.dataset.bitIndex = index;
      row.querySelector('[data-bit-label]').textContent = `${index + 1}. ${id}`;
      const up = row.querySelector('[data-bit-action="up"]');
      const down = row.querySelector('[data-bit-action="down"]');
      up.setAttribute('aria-label', `${title} 第 ${index + 1} 位上移`);
      down.setAttribute('aria-label', `${title} 第 ${index + 1} 位下移`);
      up.disabled = index === 0;
      down.disabled = index === bits.length - 1;
      return row;
    });
    editor.list.replaceChildren(...rows);
  }

  dispose() {
    if (this.disposed) return;
    this.close();
    for (const [type, handler] of this.listeners) this.dialog.removeEventListener(type, handler);
    this.listeners = [];
    this.disposed = true;
  }
}
