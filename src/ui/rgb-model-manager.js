import { APP_CONFIG } from '../../html/config.js';
import { compileModel } from '../jk/model-schema.js';
import { parseModelPool } from '../jk/model-pool.js';

const copy = value => value == null ? value : structuredClone(value);
const pretty = value => JSON.stringify(value, null, 2);
const definition = value => compileModel(value?.raw ?? value).raw;

/** RGB keeps JKM definitions and its presentation bindings in separate records. */
export class RGBModelManager {
  constructor({ onLoad, getModel, getBindings, onBindings, onMessage = () => {} }) {
    this.onLoad = onLoad; this.getModel = getModel; this.getBindings = getBindings;
    this.onBindings = onBindings; this.onMessage = onMessage;
    this.$ = id => document.getElementById(`rgb-${id}`);
    this.dialog = this.$('import-dialog'); this.authDialog = this.$('model-auth-dialog');
    this.editor = this.$('model-json'); this.bindingsEditor = this.$('bindings-json');
    this.picker = this.$('model-pool-select'); this.local = new Map(); this.remoteBindings = new Map();
    this.listeners = []; this.urls = new Set(); this.sequence = 0; this.fileVersion = 0;
    this.pool = null; this.selectedId = null; this.loadedId = null; this.pendingCommand = null;
    this.busy = false; this.requestBusy = false; this.mutating = false; this.disposed = false;
    this.bind();
  }

  listen(element, type, listener) {
    element.addEventListener(type, listener);
    this.listeners.push(() => element.removeEventListener(type, listener));
  }
  action(id, callback) {
    this.listen(this.$(id), 'click', () => Promise.resolve().then(callback).catch(error => this.error(error.message)));
  }
  bind() {
    this.action('import-btn', () => this.open());
    this.action('import-close', () => this.close()); this.action('import-cancel', () => this.close());
    this.action('import-file', () => this.$('file').click());
    this.action('import-json', () => this.importText(this.editor.value));
    this.action('bindings-apply', () => this.applyBindings());
    this.action('model-download', () => this.download());
    this.action('model-pool-add', () => this.add()); this.action('model-pool-delete', () => this.remove());
    this.action('model-auth-confirm', () => this.confirmAuthorization());
    this.action('model-auth-cancel', () => this.cancelAuthorization());
    this.listen(this.authDialog, 'cancel', event => { event.preventDefault(); this.cancelAuthorization(); });
    this.listen(this.authDialog, 'close', () => this.clearAuthorization());
    this.listen(this.$('model-auth-password'), 'keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); this.confirmAuthorization().catch(error => this.authError(error.message)); }
    });
    this.listen(this.dialog, 'cancel', event => {
      if (this.busy || this.mutating) event.preventDefault(); else this.close();
    });
    this.listen(this.dialog, 'close', () => { this.fileVersion++; this.clearAuthorization(); });
    this.listen(this.picker, 'change', () => {
      this.loadEntry(this.picker.value).catch(error => { this.picker.value = this.selectedId || ''; this.error(error.message); });
    });
    this.listen(this.$('file'), 'change', async event => {
      const file = event.target.files[0]; event.target.value = '';
      if (!file) return;
      const version = ++this.fileVersion;
      try {
        if (file.size > APP_CONFIG.view.fileBytes) throw new Error('模型文件超过大小限制');
        const text = await file.text();
        if (this.disposed || version !== this.fileVersion || !this.dialog.open) return;
        await this.importText(text);
      } catch (error) { if (!this.disposed && version === this.fileVersion) this.error(error.message); }
    });
  }

  init(defaultModel, bindings) {
    const model = copy(definition(defaultModel));
    this.local.set('local:default', { id: 'local:default', model, bindings: copy(bindings), builtin: true });
    this.selectedId = this.loadedId = 'local:default';
    this.editor.value = pretty(model); this.bindingsEditor.value = pretty(bindings);
    this.renderPicker(); return this;
  }
  entry(id = this.selectedId) {
    if (this.local.has(id)) return { ...this.local.get(id), location: 'local' };
    for (const group of ['permanent', 'temporary']) {
      const item = this.pool?.[group].find(entry => entry.id === id);
      if (item) return { ...item, location: group, bindings: copy(this.remoteBindings.get(id) ?? null) };
    }
    return null;
  }
  error(text = '') {
    if (this.disposed) return;
    this.$('import-error').textContent = text; this.$('import-error').hidden = !text;
    if (text) this.onMessage(text, true);
  }
  authError(text = '') {
    this.$('model-auth-error').textContent = text; this.$('model-auth-error').hidden = !text;
  }
  status(text) { if (!this.disposed) this.$('model-pool-status').textContent = text; }
  controls() {
    if (this.disposed) return;
    const entry = this.entry(), locked = this.busy || this.mutating;
    for (const id of ['import-file', 'import-json', 'bindings-apply', 'model-download', 'import-close', 'import-cancel']) this.$(id).disabled = locked;
    this.picker.disabled = locked;
    this.$('model-pool-add').disabled = locked || this.requestBusy || !entry || entry.location === 'permanent';
    this.$('model-pool-delete').disabled = locked || this.requestBusy || !entry || entry.builtin === true;
    this.$('model-pool-add').textContent = entry?.location === 'temporary' ? '转永久' : '入池';
    this.$('model-pool-add').title = entry?.location === 'temporary' ? '将临时模型移入永久组' : '把定义保存到共享临时组';
    this.$('model-auth-confirm').disabled = this.mutating;
    this.$('model-auth-cancel').disabled = this.mutating;
  }
  renderPicker() {
    if (this.disposed) return;
    const permanent = this.$('model-pool-permanent'), temporary = this.$('model-pool-temporary');
    permanent.replaceChildren(); temporary.replaceChildren();
    const append = (group, entry, label) => {
      const option = this.$('model-option-template').content.firstElementChild.cloneNode(true);
      option.value = entry.id; option.textContent = `${label}${entry.model.jkm}`; group.append(option);
    };
    for (const entry of this.pool?.permanent || []) append(permanent, entry, '');
    for (const entry of this.pool?.temporary || []) append(temporary, entry, '共享 / ');
    for (const entry of this.local.values()) append(temporary, entry, entry.builtin ? '内置 / ' : '本地 / ');
    this.$('model-pool-placeholder').textContent = '选择模型';
    this.picker.value = this.entry() ? this.selectedId : '';
    this.controls();
  }
  open() {
    if (this.disposed) return;
    this.editor.value = pretty(definition(this.getModel()));
    this.bindingsEditor.value = pretty(this.getBindings()); this.error();
    if (!this.dialog.open) this.dialog.showModal();
    this.refresh().catch(() => {});
  }
  close() {
    if (this.busy || this.mutating) return false;
    this.fileVersion++; this.cancelAuthorization();
    if (this.dialog.open) this.dialog.close();
    return true;
  }
  async loadEntry(id) {
    if (this.busy || this.mutating) throw new Error('请等待当前操作完成');
    const entry = this.entry(id);
    if (!entry) throw new Error('请选择有效模型');
    const model = copy(definition(entry.model)), bindings = copy(entry.bindings);
    this.busy = true; this.controls();
    try {
      await this.onLoad(model, bindings);
      if (this.disposed) return;
      this.selectedId = this.loadedId = id; this.editor.value = pretty(model);
      this.bindingsEditor.value = pretty(this.getBindings()); this.error();
      this.onMessage(`已加载 ${model.jkm}`);
    } finally { this.busy = false; this.renderPicker(); }
  }
  async importText(text) {
    if (this.busy || this.mutating) throw new Error('请等待当前操作完成');
    const model = copy(definition(JSON.parse(text)));
    this.busy = true; this.controls();
    try {
      await this.onLoad(model, null);
      if (this.disposed) return;
      const id = `local:${++this.sequence}`;
      this.local.set(id, { id, model, bindings: copy(this.getBindings()) });
      this.selectedId = this.loadedId = id; this.editor.value = pretty(model);
      this.bindingsEditor.value = pretty(this.getBindings()); this.error();
      this.onMessage(`已导入 ${model.jkm}；当前保存在本页。`);
    } finally { this.busy = false; this.renderPicker(); }
  }
  syncBindings(bindings) {
    if (this.local.has(this.loadedId)) this.local.get(this.loadedId).bindings = copy(bindings);
    else if (this.loadedId) this.remoteBindings.set(this.loadedId, copy(bindings));
    this.bindingsEditor.value = pretty(bindings);
  }
  async applyBindings() {
    if (this.busy || this.mutating) throw new Error('请等待当前操作完成');
    const raw = JSON.parse(this.bindingsEditor.value);
    this.busy = true; this.controls();
    try {
      await this.onBindings(raw);
      if (this.disposed) return;
      const bindings = copy(this.getBindings());
      this.syncBindings(bindings); this.error();
      this.onMessage('输入与输出绑定已更新。');
    } finally { this.busy = false; this.controls(); }
  }

  async request(command, token) {
    if (this.disposed) throw new Error('模型管理已关闭');
    if (this.requestBusy) throw new Error('共享池请求正在进行，请稍后重试');
    this.requestBusy = true; this.mutating = Boolean(command); this.controls();
    const controller = new AbortController(); this.requestController = controller;
    const timeout = setTimeout(() => controller.abort(), APP_CONFIG.pool.timeoutMs);
    try {
      const headers = command ? { 'Content-Type': 'application/json' } : {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(import.meta.env?.VITE_MODEL_POOL_API_URL || APP_CONFIG.pool.endpoint, {
        method: command ? 'POST' : 'GET', headers, ...(command ? { body: JSON.stringify(command) } : {}),
        cache: 'no-store', signal: controller.signal,
      });
      let data;
      try { data = await response.json(); } catch { throw new Error('共享池返回内容无效'); }
      if (!response.ok) throw new Error(data.error || `模型池 HTTP ${response.status}`);
      const pool = parseModelPool(data.pool);
      if (this.disposed) return null;
      this.pool = pool; this.renderPicker();
      this.status(`共享池 revision ${pool.revision} · ${pool.permanent.length} 个永久 / ${pool.temporary.length} 个临时 · 本地绑定单独保留`);
      return data;
    } catch (error) {
      this.status(command ? '共享操作未确认；当前模型和本地记录已保留，重新打开模型管理核对。' : '共享池暂不可用，可继续本地导入和下载。');
      throw error;
    } finally {
      clearTimeout(timeout); if (this.requestController === controller) this.requestController = null;
      this.requestBusy = false; this.mutating = false; this.controls();
    }
  }
  async refresh() {
    if (this.requestBusy) return;
    this.status('正在连接共享模型池…');
    await this.request();
  }
  async add() {
    if (this.busy || this.mutating) throw new Error('请等待当前操作完成');
    const entry = this.entry();
    if (!entry) throw new Error('请选择模型');
    if (entry.location === 'permanent') return;
    if (!this.pool) await this.refresh();
    if (!this.pool) throw new Error('尚未连接共享模型池');
    if (entry.location === 'temporary') {
      this.authorize({ action: 'promote', revision: this.pool.revision, id: entry.id }); return;
    }
    const data = await this.request({ action: 'import', revision: this.pool.revision, model: copy(entry.model) });
    if (!data || this.disposed) return;
    this.remoteBindings.set(data.selectedId, copy(entry.bindings));
    if (this.selectedId === entry.id) this.selectedId = data.selectedId;
    if (this.loadedId === entry.id) this.loadedId = data.selectedId;
    this.renderPicker(); this.error(); this.onMessage('模型定义已保存到共享临时组；RGB 绑定保留在本页。');
  }
  async remove() {
    if (this.busy || this.mutating) throw new Error('请等待当前操作完成');
    const entry = this.entry();
    if (!entry) throw new Error('请选择模型');
    if (entry.builtin) throw new Error('内置示例保留在本页');
    if (entry.location === 'local') {
      this.local.delete(entry.id); this.selectedId = null;
      this.renderPicker(); this.onMessage('已移除本地条目，当前运行模型保持不变。'); return;
    }
    const command = { action: 'delete', revision: this.pool.revision, id: entry.id };
    if (entry.location === 'permanent') this.authorize(command);
    else await this.mutate(command);
  }
  async mutate(command, token) {
    const data = await this.request(command, token);
    if (!data || this.disposed) return;
    if (command.action === 'delete') {
      this.remoteBindings.delete(command.id);
      if (this.selectedId === command.id) this.selectedId = null;
    }
    this.renderPicker(); this.error();
    this.onMessage(command.action === 'delete' ? '已删除共享条目，当前运行模型保持不变。' : '已移入永久模型组。');
  }
  authorize(command) {
    this.pendingCommand = copy(command); this.$('model-auth-password').value = ''; this.authError();
    this.$('model-auth-title').textContent = command.action === 'delete' ? '删除永久模型' : '转为永久模型';
    this.$('model-auth-description').textContent = '管理员口令仅用于本次操作，不在页面保存。';
    if (!this.authDialog.open) this.authDialog.showModal();
  }
  clearAuthorization() {
    this.pendingCommand = null; this.$('model-auth-password').value = ''; this.authError();
  }
  cancelAuthorization() {
    if (this.mutating) return;
    this.clearAuthorization(); if (this.authDialog.open) this.authDialog.close();
  }
  async confirmAuthorization() {
    const command = copy(this.pendingCommand), password = this.$('model-auth-password').value;
    this.$('model-auth-password').value = '';
    if (!command) return;
    if (!password) { this.authError('请输入管理员口令'); return; }
    try { await this.mutate(command, password); this.cancelAuthorization(); }
    catch (error) { if (!this.disposed) this.authError(error.message); }
  }
  download() {
    const model = copy(definition(this.getModel()));
    const url = URL.createObjectURL(new Blob([pretty(model)], { type: 'application/json' })); this.urls.add(url);
    const link = this.$('model-download-link'); link.href = url;
    link.download = `${model.jkm}.jkm.json`.replace(/[\\/:*?"<>|]/g, '_'); link.click(); link.removeAttribute('href');
    setTimeout(() => { URL.revokeObjectURL(url); this.urls.delete(url); }, 1000);
  }
  dispose() {
    this.disposed = true; this.fileVersion++; this.requestController?.abort();
    this.listeners.splice(0).forEach(remove => remove()); this.clearAuthorization();
    if (this.authDialog.open) this.authDialog.close(); if (this.dialog.open) this.dialog.close();
    for (const url of this.urls) URL.revokeObjectURL(url); this.urls.clear();
  }
}
