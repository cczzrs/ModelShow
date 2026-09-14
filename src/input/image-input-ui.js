import { APP_CONFIG } from '../config.js';
import {
  IMAGE_INPUT_LIMITS,
  defaultImageInputConfig,
  clampSelection,
  selectionBitCount,
  extractPixelData,
  mapPixelData,
} from './image-input.js';
import { decodeInputImage } from './image-input-loader.js';

// HTML owns the dialog. The source canvas stays at decoded resolution;
// the viewport changes only how that image is displayed.
export class ImageInputUI {
  constructor(root, onApply, onApplied = () => {}) {
    this.dialog = root;
    this.onApply = onApply;
    this.onApplied = onApplied;
    this.config = defaultImageInputConfig();
    this.selection = { ...APP_CONFIG.imageInput.selection };
    this.inputIds = [];
    this.modelVersion = 0;
    this.generation = 0;
    this.view = { ...APP_CONFIG.imageInput.view };
    this.listeners = [];
    this.disposed = false;

    this.field = name => this.dialog.querySelector(`[name="${name}"]`);
    this.info = name => this.dialog.querySelector(`[data-info="${name}"]`);
    this.action = name => this.dialog.querySelector(`[data-action="${name}"]`);
    this.fileInput = this.dialog.querySelector('input[type=file]');
    this.stage = this.dialog.querySelector('.image-input-stage');
    this.canvas = this.stage.querySelector('canvas');
    this.context = this.canvas.getContext('2d');
    this.preview = this.dialog.querySelector('.image-input-preview');
    this.jsonPreview = this.dialog.querySelector('.image-input-json');
    this.presetButtons = [...this.dialog.querySelectorAll('[data-preset]')];
    this.canvasColors = getComputedStyle(this.stage);

    this.initializeFields();
    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stage);
    this.updateFileInfo();
    this.refresh();
  }

  initializeFields() {
    const fields = APP_CONFIG.imageInput.fields;
    for (const key of ['width', 'height', 'x', 'y']) {
      const field = this.field(key);
      const limits = key === 'width' || key === 'height' ? fields.size : fields.coordinate;
      field.min = limits.min;
      field.step = limits.step;
      field.value = this.selection[key];
    }
    for (const [key, value] of Object.entries(this.config)) {
      this.field(key).value = value;
    }
    this.field('arrangement').disabled = this.config.encoding === 'gray';
    this.info('zoom').textContent = `${Math.round(this.view.scale * 100)}%`;
  }

  listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this.listeners.push(() => target.removeEventListener(type, handler, options));
  }

  bindEvents() {
    this.listen(this.action('close'), 'click', () => this.close());
    this.listen(this.dialog, 'cancel', event => {
      event.preventDefault();
      this.close();
    });
    this.listen(this.dialog, 'close', () => {
      if (!this.dialog.open) this.cancelPending();
    });
    this.listen(this.action('choose'), 'click', () => this.fileInput.click());
    for (const button of this.presetButtons) {
      this.listen(button, 'click', () => this.loadBuiltin(button.dataset.preset));
    }
    this.listen(this.fileInput, 'change', () => {
      const file = this.fileInput.files[0];
      this.fileInput.value = '';
      if (file) this.loadFile(file);
    });
    this.listen(this.action('fit'), 'click', () => this.fit());
    this.listen(this.action('original'), 'click', () => {
      this.zoom(APP_CONFIG.imageInput.view.scale, this.view.width / 2, this.view.height / 2);
    });
    this.listen(this.action('apply'), 'click', () => this.apply());

    for (const key of ['width', 'height', 'x', 'y']) {
      this.listen(this.field(key), 'change', () => this.changeSelection(key));
      this.listen(this.field(key), 'input', () => {
        if (Number.isSafeInteger(this.field(key).valueAsNumber)) {
          this.changeSelection(key);
        } else {
          this.result = null;
          this.action('apply').disabled = true;
        }
      });
    }
    for (const key of Object.keys(this.config)) {
      this.listen(this.field(key), 'change', () => {
        this.config[key] = this.field(key).value;
        this.field('arrangement').disabled = this.config.encoding === 'gray';
        this.refresh();
        this.draw();
      });
    }

    this.listen(this.canvas, 'pointerdown', event => this.pointerDown(event));
    this.listen(this.canvas, 'pointermove', event => this.pointerMove(event));
    this.listen(this.canvas, 'pointerup', event => this.pointerEnd(event));
    this.listen(this.canvas, 'pointercancel', event => this.pointerEnd(event));
    this.listen(this.canvas, 'lostpointercapture', () => {
      if (this.drag) {
        this.drag = null;
        this.refresh();
      }
    });
    this.listen(this.canvas, 'contextmenu', event => event.preventDefault());
    this.listen(this.canvas, 'wheel', event => {
      event.preventDefault();
      if (!this.source || this.drag) return;
      const point = this.localPoint(event);
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.view.height : 1);
      this.zoom(this.view.scale * Math.exp(-delta * 0.0015), point.x, point.y);
    }, { passive: false });
    this.listen(this.dialog, 'keydown', event => {
      if (event.code === 'Space' && !event.target.closest('input,textarea,select,button')) {
        event.preventDefault();
        this.space = true;
        this.canvas.classList.add('pan-ready');
      }
    });
    this.listen(this.dialog, 'keyup', event => {
      if (event.code === 'Space') this.clearSpace();
    });
    this.listen(window, 'blur', () => {
      this.clearSpace();
      if (this.drag) {
        this.drag = null;
        this.refresh();
      }
    });
  }

  setModel(inputIds, version) {
    this.inputIds = [...inputIds];
    this.modelVersion = version;
    this.result = null;
    this.refresh();
  }

  open() {
    if (this.disposed) return;
    if (!this.dialog.open) this.dialog.showModal();
    this.resize();
    this.refresh();
    if (!this.source && !this.loading && this.presetButtons.length) {
      this.loadBuiltin(APP_CONFIG.imageInput.defaultPreset);
    }
  }

  clearSpace() {
    this.space = false;
    this.canvas.classList.remove('pan-ready');
  }

  cancelPending() {
    ++this.generation;
    this.importAbort?.abort();
    this.importAbort = null;
    this.loading = false;
    if (this.drag && this.canvas.hasPointerCapture(this.drag.pointerId)) {
      this.canvas.releasePointerCapture(this.drag.pointerId);
    }
    this.drag = null;
    this.clearSpace();
    this.updateFileInfo();
  }
  close() {
    this.cancelPending();
    if (this.dialog.open) this.dialog.close();
  }

  loadBuiltin(name) {
    const button = this.presetButtons.find(button => button.dataset.preset === name);
    const url = button?.querySelector('img')?.src;
    if (!url || this.disposed) return;
    return this.loadFile(async signal => {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`无法加载 ${name}（HTTP ${response.status}）`);
      const blob = await response.blob();
      return new File([blob], name, { type: 'image/png' });
    }, name);
  }

  async loadFile(file, presetName = null) {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.importAbort?.abort();
    const abort = this.importAbort = new AbortController();
    this.loading = true;
    this.error('');
    this.updateFileInfo();
    this.refresh();
    let decoded;
    let candidate;
    try {
      // Fetch and decode share one generation, so a late preset cannot replace a newer local image.
      if (typeof file === 'function') file = await file(abort.signal);
      if (generation !== this.generation || !this.dialog.open) return;
      decoded = await decodeInputImage(file);
      if (generation !== this.generation || !this.dialog.open) return;
      candidate = document.createElement('canvas');
      candidate.width = decoded.width;
      candidate.height = decoded.height;
      const context = candidate.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
      if (!context) throw new Error('无法创建图片数据画布');
      context.drawImage(decoded.bitmap, 0, 0);
      context.getImageData(0, 0, 1, 1); // Check allocation/readability before replacing a valid source.
      const selection = clampSelection(this.selection, decoded.width, decoded.height);
      selection.x = Math.floor((decoded.width - selection.width) / 2);
      selection.y = Math.floor((decoded.height - selection.height) / 2);
      if (this.source) this.source.width = this.source.height = 0;
      this.source = candidate;
      this.sourceContext = context;
      this.sourceName = decoded.name;
      this.sourcePreset = presetName;
      candidate = null;
      this.selection = selection;
      this.fit();
    } catch (error) {
      if (generation === this.generation && this.dialog.open) this.error(`图片导入失败：${error.message}`);
    } finally {
      decoded?.bitmap.close();
      if (candidate) candidate.width = candidate.height = 0;
      if (generation === this.generation) {
        this.importAbort = null;
        this.loading = false;
        this.updateFileInfo();
        this.syncSelection();
        this.refresh();
        this.draw();
      }
    }
  }

  updateFileInfo() {
    for (const button of this.presetButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.preset === this.sourcePreset));
    }
    this.action('choose').textContent = this.source ? '更换图片' : '选择图片';
    this.info('file').textContent = this.loading ? '正在解码图片…' : this.source
      ? `${this.sourceName} · ${this.source.width} × ${this.source.height} 像素`
      : `PNG / JPEG / WebP · 最大 ${IMAGE_INPUT_LIMITS.fileBytes / (1024 * 1024)} MB、${IMAGE_INPUT_LIMITS.imagePixels / 10000} 万像素`;
    this.stage.querySelector('.image-input-empty').hidden = !!this.source;
  }

  error(text) {
    this.info('error').textContent = text;
    this.info('error').hidden = !text;
  }

  syncSelection() {
    for (const key of ['width', 'height', 'x', 'y']) {
      const field = this.field(key);
      field.value = this.selection[key];
      field.disabled = !this.source;
      if (this.source) field.max = key === 'width' ? this.source.width : key === 'height' ? this.source.height
        : key === 'x' ? this.source.width - this.selection.width : this.source.height - this.selection.height;
    }
    const s = this.selection;
    this.info('coords').textContent = this.source ? `原图选区：(${s.x}, ${s.y}) → (${s.x + s.width - 1}, ${s.y + s.height - 1}) · ${s.width} × ${s.height} 像素`
      : '选区坐标以原图左上角为 (0, 0)';
  }

  changeSelection(key) {
    if (!this.source) return;
    try {
      const value = this.field(key).valueAsNumber;
      const next = { ...this.selection, [key]: value };
      if (key === 'width') next.x = Math.round(this.selection.x + (this.selection.width - value) / 2);
      if (key === 'height') next.y = Math.round(this.selection.y + (this.selection.height - value) / 2);
      this.selection = clampSelection(next, this.source.width, this.source.height);
      this.error('');
    } catch (error) {
      this.error(error.message);
    }
    this.syncSelection();
    this.refresh();
    this.draw();
  }

  refresh() {
    this.result = null;
    this.action('apply').disabled = true;
    this.jsonPreview.value = '';
    this.info('omitted').textContent = '';
    this.syncSelection();
    this.preview.getContext('2d').clearRect(0, 0, this.preview.width, this.preview.height);
    if (!this.source) {
      this.info('capacity').textContent = `当前模型：${this.inputIds.length.toLocaleString()} 个 Xi · 请先选择图片`;
      this.info('capacity').classList.remove('mismatch');
      return;
    }
    const count = selectionBitCount(this.selection, this.config.encoding);
    const diff = count - this.inputIds.length;
    this.info('capacity').textContent = `所需 ${count.toLocaleString()} 位 / 模型 ${this.inputIds.length.toLocaleString()} 个 Xi`;
    this.info('capacity').classList.toggle('mismatch', diff !== 0 || count > IMAGE_INPUT_LIMITS.outputBits);
    if (count > IMAGE_INPUT_LIMITS.outputBits) {
      this.info('capacity').textContent += ` · 超过单次 ${IMAGE_INPUT_LIMITS.outputBits.toLocaleString()} 位上限，请缩小选框`;
      return;
    }
    if (diff) this.info('capacity').textContent += diff > 0 ? ` · 多出 ${diff.toLocaleString()} 位` : ` · 还缺 ${(-diff).toLocaleString()} 位`;
    if (this.loading || this.drag?.kind === 'selection') return;
    try {
      const s = this.selection;
      const data = this.sourceContext.getImageData(s.x, s.y, s.width, s.height);
      const pixels = extractPixelData(data, { x: 0, y: 0, width: s.width, height: s.height }, this.config);
      this.drawPreview(pixels);
      if (diff) return;
      const mapped = mapPixelData(pixels, this.config, this.inputIds);
      this.result = { ...mapped, modelVersion: this.modelVersion };
      this.jsonPreview.value = mapped.previewJson;
      this.info('omitted').textContent = mapped.omittedCount ? `预览前 ${IMAGE_INPUT_LIMITS.previewEntries} 个 Xi，省略 ${mapped.omittedCount.toLocaleString()} 个；填入时使用完整数据。` : `全部 ${count.toLocaleString()} 个 Xi · 数字编号升序`;
      this.action('apply').disabled = false;
    } catch (error) {
      this.error(error.message);
    }
  }

  apply() {
    this.error('');
    this.refresh(); // Recompute against the latest model, image, selection and options.
    if (!this.result || this.loading || this.result.modelVersion !== this.modelVersion) return;
    try {
      this.onApply(this.result.json, this.result.modelVersion);
    } catch (error) {
      this.error(error.message);
      return;
    }
    this.close();
    this.onApplied();
  }

  drawPreview(pixels) {
    const buffer = document.createElement('canvas');
    buffer.width = pixels.width;
    buffer.height = pixels.height;
    buffer.getContext('2d').putImageData(new ImageData(pixels.rgba, pixels.width, pixels.height), 0, 0);
    const ctx = this.preview.getContext('2d');
    const { width, height } = this.preview;
    const scale = Math.min((width - 12) / pixels.width, (height - 12) / pixels.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buffer, (width - pixels.width * scale) / 2, (height - pixels.height * scale) / 2, pixels.width * scale, pixels.height * scale);
    buffer.width = buffer.height = 0;
  }

  resize() {
    if (!this.dialog.open) return;
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width || !height) return;
    this.view.x += (width - this.view.width) / 2;
    this.view.y += (height - this.view.height) / 2;
    this.view.width = width;
    this.view.height = height;
    const dpr = Math.min(window.devicePixelRatio || 1, APP_CONFIG.imageInput.view.pixelRatio);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.draw();
  }

  fit() {
    if (!this.source) return;
    this.view.scale = Math.min((this.view.width - 32) / this.source.width, (this.view.height - 32) / this.source.height, APP_CONFIG.imageInput.view.maxScale);
    this.view.x = (this.view.width - this.source.width * this.view.scale) / 2;
    this.view.y = (this.view.height - this.source.height * this.view.scale) / 2;
    this.draw();
  }

  zoom(scale, x, y) {
    if (!this.source) return;
    const minimum = Math.min(this.view.width / this.source.width, this.view.height / this.source.height, 1) / 16;
    scale = Math.max(minimum, Math.min(APP_CONFIG.imageInput.view.maxScale, scale));
    const ratio = scale / this.view.scale;
    this.view.x = x - (x - this.view.x) * ratio;
    this.view.y = y - (y - this.view.y) * ratio;
    this.view.scale = scale;
    this.draw();
  }

  localPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  pointerDown(event) {
    if (!this.source || this.loading || this.drag || ![0, 1].includes(event.button)) return;
    event.preventDefault();
    this.canvas.focus();
    const point = this.localPoint(event);
    const v = this.view;
    const s = this.selection;
    const x = (point.x - v.x) / v.scale;
    const y = (point.y - v.y) / v.scale;
    const kind = event.button === 1 || this.space ? 'pan' : 'selection';
    if (kind === 'selection' && !(x >= s.x && x < s.x + s.width && y >= s.y && y < s.y + s.height)) {
      this.selection = clampSelection({ ...s, x: Math.floor(x - s.width / 2), y: Math.floor(y - s.height / 2) }, this.source.width, this.source.height);
    }
    this.drag = { pointerId: event.pointerId, kind, point, x: v.x, y: v.y, selection: { ...this.selection } };
    this.canvas.setPointerCapture(event.pointerId);
    if (kind === 'selection') this.refresh();
    this.draw();
  }

  pointerMove(event) {
    const d = this.drag;
    if (!d || d.pointerId !== event.pointerId) return;
    const point = this.localPoint(event);
    const dx = point.x - d.point.x;
    const dy = point.y - d.point.y;
    if (d.kind === 'pan') {
      this.view.x = d.x + dx;
      this.view.y = d.y + dy;
    } else {
      this.selection = clampSelection({ ...d.selection, x: Math.round(d.selection.x + dx / this.view.scale), y: Math.round(d.selection.y + dy / this.view.scale) }, this.source.width, this.source.height);
      this.syncSelection();
    }
    this.draw();
  }

  pointerEnd(event) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    this.drag = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.refresh();
  }

  draw() {
    const ctx = this.context;
    const v = this.view;
    if (!v.width || !v.height) return;
    ctx.setTransform(this.canvas.width / v.width, 0, 0, this.canvas.height / v.height, 0, 0);
    ctx.clearRect(0, 0, v.width, v.height);
    this.info('zoom').textContent = `${Math.round(v.scale * 100)}%`;
    if (!this.source) return;

    const imageWidth = this.source.width * v.scale;
    const imageHeight = this.source.height * v.scale;
    const color = name => this.canvasColors.getPropertyValue(`--image-canvas-${name}`).trim();
    ctx.fillStyle = color(this.config.background);
    ctx.fillRect(v.x, v.y, imageWidth, imageHeight);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.source, v.x, v.y, imageWidth, imageHeight);

    const selection = this.selection;
    const x = v.x + selection.x * v.scale;
    const y = v.y + selection.y * v.scale;
    const width = selection.width * v.scale;
    const height = selection.height * v.scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.x, v.y, imageWidth, imageHeight);
    ctx.rect(x, y, width, height);
    ctx.fillStyle = color('mask');
    ctx.fill('evenodd');
    if (v.scale >= 8) {
      ctx.beginPath();
      for (let i = Math.max(1, Math.ceil(-x / v.scale)); i < selection.width && x + i * v.scale < v.width; i++) {
        ctx.moveTo(x + i * v.scale, Math.max(0, y));
        ctx.lineTo(x + i * v.scale, Math.min(v.height, y + height));
      }
      for (let i = Math.max(1, Math.ceil(-y / v.scale)); i < selection.height && y + i * v.scale < v.height; i++) {
        ctx.moveTo(Math.max(0, x), y + i * v.scale);
        ctx.lineTo(Math.min(v.width, x + width), y + i * v.scale);
      }
      ctx.strokeStyle = color('grid');
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.strokeStyle = color('outline');
    ctx.lineWidth = 4;
    ctx.strokeRect(x, y, width, height);
    ctx.strokeStyle = color('selection');
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, width, height);
    ctx.restore();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.close();
    this.resizeObserver.disconnect();
    for (const removeListener of this.listeners) removeListener();
    this.listeners = [];
    if (this.source) this.source.width = this.source.height = 0;
    this.source = null;
    this.sourceContext = null;
    this.result = null;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.preview.getContext('2d').clearRect(0, 0, this.preview.width, this.preview.height);
  }
}
