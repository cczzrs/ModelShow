import { IMAGE_INPUT_LIMITS, defaultImageInputConfig, clampSelection, selectionBitCount, extractPixelData, mapPixelData } from './image-input.js';
import { decodeInputImage } from './image-input-loader.js';

// The source canvas always stays at decoded resolution; the viewport is display-only.
export class ImageInputUI {
  constructor(onApply, onApplied = () => {}) {
    this.onApply = onApply;
    this.onApplied = onApplied;
    this.config = defaultImageInputConfig();
    this.selection = { x: 0, y: 0, width: 8, height: 8 };
    this.inputIds = [];
    this.modelVersion = 0;
    this.generation = 0;
    this.view = { scale: 1, x: 0, y: 0, width: 0, height: 0 };
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'image-input-dialog';
    this.dialog.setAttribute('aria-label', '输入数据提取');
    this.dialog.innerHTML = `
      <div class="image-input-heading"><div><div class="eyebrow">IMAGE → Xi</div><h2>输入数据提取</h2></div><button class="button" data-action="close">关闭</button></div>
      <div class="image-input-import"><button class="button" data-action="choose">选择图片</button><span data-info="file">PNG / JPEG / WebP · 最大 32 MB、1600 万像素</span></div>
      <input type="file" accept=".png,.apng,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" hidden>
      <div class="image-input-fields">
        <label>选框宽（原图像素）<input name="width" type="number" min="1" step="1" value="8"></label>
        <label>选框高（原图像素）<input name="height" type="number" min="1" step="1" value="8"></label>
        <label>X 坐标<input name="x" type="number" min="0" step="1" value="0"></label>
        <label>Y 坐标<input name="y" type="number" min="0" step="1" value="0"></label>
        <label>像素格式<select name="encoding"><option value="rgb">RGB 8 位</option><option value="gray">灰度 8 位</option></select></label>
        <label>通道排列<select name="arrangement"><option value="pixel">逐像素 RGB</option><option value="channel">先全部 R，再 G，再 B</option></select></label>
        <label>每字节位序<select name="bitOrder"><option value="lsb-first">低位优先 b0 → b7</option><option value="msb-first">高位优先 b7 → b0</option></select></label>
        <label>透明底色<select name="background"><option value="white">白色</option><option value="black">黑色</option></select></label>
      </div>
      <div class="image-input-body">
        <div class="image-input-workspace">
          <div class="image-input-tools"><button class="button small" data-action="fit">适应窗口</button><button class="button small" data-action="original">原始比例</button><span data-info="zoom">100%</span></div>
          <div class="image-input-stage"><canvas tabindex="0" aria-label="图片选区"></canvas><span class="image-input-empty">选择一张本地图片开始提取</span></div>
          <p class="image-input-help">左键拖动选框 · 空格＋拖动 / 中键平移 · 滚轮围绕鼠标缩放</p>
          <div data-info="coords" class="image-input-coords">选区坐标以原图左上角为 (0, 0)</div>
        </div>
        <div class="image-input-results">
          <label>提取像素预览<canvas class="image-input-preview" width="280" height="150" aria-label="提取像素预览"></canvas></label>
          <div data-info="capacity" class="image-input-capacity" role="status"></div>
          <label>Xi JSON 预览<textarea class="image-input-json" readonly aria-label="Xi JSON 预览" spellcheck="false"></textarea></label>
          <span data-info="omitted" class="image-input-help"></span>
        </div>
      </div>
      <div class="errors" data-info="error" role="alert" hidden></div>
      <div class="image-input-footer"><span>仅填入文本，由“发送信号”执行。图片仅保留在本页面会话。</span><button class="button primary" data-action="apply" disabled>填入信号输入框</button></div>`;
    document.body.append(this.dialog);
    this.field = name => this.dialog.querySelector(`[name="${name}"]`);
    this.info = name => this.dialog.querySelector(`[data-info="${name}"]`);
    this.action = name => this.dialog.querySelector(`[data-action="${name}"]`);
    this.fileInput = this.dialog.querySelector('input[type=file]');
    this.stage = this.dialog.querySelector('.image-input-stage');
    this.canvas = this.stage.querySelector('canvas');
    this.context = this.canvas.getContext('2d');
    this.preview = this.dialog.querySelector('.image-input-preview');
    this.jsonPreview = this.dialog.querySelector('.image-input-json');
    this.action('close').onclick = () => this.close();
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.dialog.addEventListener('close', () => { if (!this.dialog.open) this.cancelPending(); });
    this.action('choose').onclick = () => this.fileInput.click();
    this.fileInput.onchange = () => {
      const file = this.fileInput.files[0];
      this.fileInput.value = '';
      if (file) this.loadFile(file);
    };
    this.action('fit').onclick = () => this.fit();
    this.action('original').onclick = () => this.zoom(1, this.view.width / 2, this.view.height / 2);
    this.action('apply').onclick = () => this.apply();
    for (const key of ['width', 'height', 'x', 'y']) {
      this.field(key).onchange = () => this.changeSelection(key);
      this.field(key).oninput = () => {
        if (Number.isSafeInteger(this.field(key).valueAsNumber)) this.changeSelection(key);
        else { this.result = null; this.action('apply').disabled = true; }
      };
    }
    for (const key of Object.keys(this.config)) this.field(key).onchange = () => {
      this.config[key] = this.field(key).value;
      this.field('arrangement').disabled = this.config.encoding === 'gray';
      this.refresh(); this.draw();
    };
    this.canvas.addEventListener('pointerdown', event => this.pointerDown(event));
    this.canvas.addEventListener('pointermove', event => this.pointerMove(event));
    this.canvas.addEventListener('pointerup', event => this.pointerEnd(event));
    this.canvas.addEventListener('pointercancel', event => this.pointerEnd(event));
    this.canvas.addEventListener('lostpointercapture', () => { if (this.drag) { this.drag = null; this.refresh(); } });
    this.canvas.addEventListener('contextmenu', event => event.preventDefault());
    this.canvas.addEventListener('wheel', event => {
      event.preventDefault();
      if (!this.source || this.drag) return;
      const point = this.localPoint(event);
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.view.height : 1);
      this.zoom(this.view.scale * Math.exp(-delta * .0015), point.x, point.y);
    }, { passive: false });
    this.dialog.addEventListener('keydown', event => {
      if (event.code === 'Space' && !event.target.closest('input,textarea,select,button')) {
        event.preventDefault(); this.space = true; this.canvas.classList.add('pan-ready');
      }
    });
    this.dialog.addEventListener('keyup', event => { if (event.code === 'Space') this.clearSpace(); });
    this.blurHandler = () => { this.clearSpace(); if (this.drag) { this.drag = null; this.refresh(); } };
    window.addEventListener('blur', this.blurHandler);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stage);
  }

  setModel(inputIds, version) {
    this.inputIds = [...inputIds];
    this.modelVersion = version;
    this.result = null;
    this.refresh();
  }

  open() {
    if (!this.dialog.open) this.dialog.showModal();
    this.resize();
    this.refresh();
    if (!this.source) this.fileInput.click();
  }

  clearSpace() { this.space = false; this.canvas.classList.remove('pan-ready'); }
  cancelPending() {
    ++this.generation;
    this.loading = false;
    if (this.drag && this.canvas.hasPointerCapture(this.drag.pointerId)) this.canvas.releasePointerCapture(this.drag.pointerId);
    this.drag = null;
    this.clearSpace();
    this.updateFileInfo();
  }
  close() { this.cancelPending(); this.dialog.close(); }

  async loadFile(file) {
    const generation = ++this.generation;
    this.loading = true;
    this.error('');
    this.updateFileInfo();
    this.refresh();
    let decoded, candidate;
    try {
      decoded = await decodeInputImage(file);
      if (generation !== this.generation || !this.dialog.open) return;
      candidate = document.createElement('canvas');
      candidate.width = decoded.width; candidate.height = decoded.height;
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
      candidate = null;
      this.selection = selection;
      this.fit();
    } catch (error) {
      if (generation === this.generation && this.dialog.open) this.error(`图片导入失败：${error.message}`);
    } finally {
      decoded?.bitmap.close();
      if (candidate) candidate.width = candidate.height = 0;
      if (generation === this.generation) {
        this.loading = false;
        this.updateFileInfo(); this.syncSelection(); this.refresh(); this.draw();
      }
    }
  }

  updateFileInfo() {
    this.action('choose').textContent = this.source ? '更换图片' : '选择图片';
    this.info('file').textContent = this.loading ? '正在解码图片…' : this.source
      ? `${this.sourceName} · ${this.source.width} × ${this.source.height} 像素`
      : 'PNG / JPEG / WebP · 最大 32 MB、1600 万像素';
    this.stage.querySelector('.image-input-empty').hidden = !!this.source;
  }

  error(text) { this.info('error').textContent = text; this.info('error').hidden = !text; }

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
    } catch (error) { this.error(error.message); }
    this.syncSelection(); this.refresh(); this.draw();
  }

  refresh() {
    this.result = null;
    this.action('apply').disabled = true;
    this.jsonPreview.value = '';
    this.info('omitted').textContent = '';
    this.syncSelection();
    this.preview.getContext('2d').clearRect(0, 0, this.preview.width, this.preview.height);
    if (!this.source) { this.info('capacity').textContent = `当前模型：${this.inputIds.length.toLocaleString()} 个 Xi · 请先选择图片`; return; }
    const count = selectionBitCount(this.selection, this.config.encoding), diff = count - this.inputIds.length;
    this.info('capacity').textContent = `所需 ${count.toLocaleString()} 位 / 模型 ${this.inputIds.length.toLocaleString()} 个 Xi`;
    this.info('capacity').classList.toggle('mismatch', diff !== 0 || count > IMAGE_INPUT_LIMITS.outputBits);
    if (count > IMAGE_INPUT_LIMITS.outputBits) {
      this.info('capacity').textContent += ` · 超过单次 ${IMAGE_INPUT_LIMITS.outputBits.toLocaleString()} 位上限，请缩小选框`; return;
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
      this.info('omitted').textContent = mapped.omittedCount ? `预览前 128 个 Xi，省略 ${mapped.omittedCount.toLocaleString()} 个；填入时使用完整数据。` : `全部 ${count.toLocaleString()} 个 Xi · 数字编号升序`;
      this.action('apply').disabled = false;
    } catch (error) { this.error(error.message); }
  }

  apply() {
    this.error('');
    this.refresh(); // Recompute against the latest model, image, selection and options.
    if (!this.result || this.loading || this.result.modelVersion !== this.modelVersion) return;
    try { this.onApply(this.result.json, this.result.modelVersion); }
    catch (error) { this.error(error.message); return; }
    this.close();
    this.onApplied();
  }

  drawPreview(pixels) {
    const buffer = document.createElement('canvas');
    buffer.width = pixels.width; buffer.height = pixels.height;
    buffer.getContext('2d').putImageData(new ImageData(pixels.rgba, pixels.width, pixels.height), 0, 0);
    const ctx = this.preview.getContext('2d'), { width, height } = this.preview;
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
    this.view.width = width; this.view.height = height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
    this.draw();
  }

  fit() {
    if (!this.source) return;
    this.view.scale = Math.min((this.view.width - 32) / this.source.width, (this.view.height - 32) / this.source.height, 64);
    this.view.x = (this.view.width - this.source.width * this.view.scale) / 2;
    this.view.y = (this.view.height - this.source.height * this.view.scale) / 2;
    this.draw();
  }

  zoom(scale, x, y) {
    if (!this.source) return;
    const minimum = Math.min(this.view.width / this.source.width, this.view.height / this.source.height, 1) / 16;
    scale = Math.max(minimum, Math.min(64, scale));
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
    const point = this.localPoint(event), v = this.view, s = this.selection;
    const x = (point.x - v.x) / v.scale, y = (point.y - v.y) / v.scale;
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
    const point = this.localPoint(event), dx = point.x - d.point.x, dy = point.y - d.point.y;
    if (d.kind === 'pan') { this.view.x = d.x + dx; this.view.y = d.y + dy; }
    else {
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
    const ctx = this.context, v = this.view;
    if (!v.width || !v.height) return;
    ctx.setTransform(this.canvas.width / v.width, 0, 0, this.canvas.height / v.height, 0, 0);
    ctx.clearRect(0, 0, v.width, v.height);
    this.info('zoom').textContent = `${Math.round(v.scale * 100)}%`;
    if (!this.source) return;
    const iw = this.source.width * v.scale, ih = this.source.height * v.scale;
    ctx.fillStyle = this.config.background === 'white' ? '#fff' : '#000';
    ctx.fillRect(v.x, v.y, iw, ih);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.source, v.x, v.y, iw, ih);
    const s = this.selection, x = v.x + s.x * v.scale, y = v.y + s.y * v.scale, w = s.width * v.scale, h = s.height * v.scale;
    ctx.save();
    ctx.beginPath(); ctx.rect(v.x, v.y, iw, ih); ctx.rect(x, y, w, h);
    ctx.fillStyle = '#06101a99'; ctx.fill('evenodd');
    if (v.scale >= 8) {
      ctx.beginPath();
      for (let i = Math.max(1, Math.ceil(-x / v.scale)); i < s.width && x + i * v.scale < v.width; i++) { ctx.moveTo(x + i * v.scale, Math.max(0, y)); ctx.lineTo(x + i * v.scale, Math.min(v.height, y + h)); }
      for (let i = Math.max(1, Math.ceil(-y / v.scale)); i < s.height && y + i * v.scale < v.height; i++) { ctx.moveTo(Math.max(0, x), y + i * v.scale); ctx.lineTo(Math.min(v.width, x + w), y + i * v.scale); }
      ctx.strokeStyle = '#7b8e9e66'; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.strokeStyle = '#07151f'; ctx.lineWidth = 4; ctx.strokeRect(x, y, w, h);
    ctx.strokeStyle = '#b0ffe8'; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  dispose() {
    this.close();
    this.resizeObserver.disconnect();
    window.removeEventListener('blur', this.blurHandler);
    if (this.source) this.source.width = this.source.height = 0;
    this.dialog.remove();
  }
}
