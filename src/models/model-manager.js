import { compileModel } from '../core/engine.js';
import { parseModelPool, defaultPoolEntry } from './model-pool.js';

const emptyModel = () => ({
  name: '模型池为空',
  nodes: [],
  initial_q: { 0: [], 1: [] },
  q_y: [],
});
const emptyPool = () => ({
  version: 1,
  revision: 0,
  temporary: [],
  permanent: [],
});
const apiUrl = import.meta.env?.VITE_MODEL_POOL_API_URL || './api/model-pool';

function newest(entries, field) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => Date.parse(b.entry[field]) - Date.parse(a.entry[field]) || b.index - a.index)
    .map(item => item.entry);
}

/** Shared records stay authoritative; disconnected imports live only in this page session. */
export class ModelManager {
  constructor(onLoad, onMessage, prepareDownload = raw => raw) {
    this.onLoad = onLoad;
    this.onMessage = onMessage;
    this.prepareDownload = prepareDownload;
    this.busy = false;
    this.remote = false;
    this.writable = false;
    this.generation = 0;
    this.destroyed = false;
    this.localEntries = new Map();
    this.sharedPool = null;
    this.listeners = [];
    this.downloadUrls = new Map();
    this.abortController = new AbortController();
    this.$ = id => document.getElementById(id);
    this.dialog = this.$('import-dialog');
    this.editor = this.$('model-json');
    this.picker = this.$('model-pool-select');
    this.authDialog = this.$('model-auth-dialog');
    this.downloadLink = this.$('model-download-link');
    this.optionTemplate = this.$('model-option-template');
    this.pendingCommand = null;
    this.bindEvents();
    this.controls();
  }

  listen(element, type, callback) {
    element.addEventListener(type, callback);
    this.listeners.push(() => element.removeEventListener(type, callback));
  }

  bindEvents() {
    this.listen(this.$('import-btn'), 'click', () => this.open());
    this.listen(this.$('import-close'), 'click', () => this.close());
    this.listen(this.$('import-cancel'), 'click', () => this.close());
    this.listen(this.dialog, 'cancel', event => {
      if (this.busy || this.authDialog.open) {
        event.preventDefault();
      } else {
        ++this.generation;
      }
    });
    this.listen(this.$('import-file'), 'click', () => this.$('file').click());
    this.listen(this.$('file'), 'change', async () => {
      const input = this.$('file');
      const file = input.files[0];
      if (!file) return;
      const generation = ++this.generation;
      try {
        const text = await file.text();
        if (generation === this.generation && this.dialog.open) {
          await this.importText(text);
        }
      } catch (error) {
        if (generation === this.generation) this.error(error.message);
      } finally {
        input.value = '';
      }
    });
    this.listen(this.$('import-json'), 'click', () => this.importText(this.editor.value));
    this.listen(this.$('model-download'), 'click', () => this.download());
    this.listen(this.picker, 'change', () => {
      ++this.generation;
      this.select(this.picker.value, true);
      this.error('');
    });
    this.listen(this.editor, 'input', () => this.controls());
    this.listen(this.$('model-pool-add'), 'click', () => this.mutate({
      action: 'promote',
      id: this.selectedId,
    }));
    this.listen(this.$('model-pool-delete'), 'click', () => {
      const entry = this.entry();
      if (entry) return this.mutate({ action: 'delete', id: entry.id });
    });
    this.listen(this.$('model-auth-confirm'), 'click', () => this.submitAuthorization());
    this.listen(this.$('model-auth-cancel'), 'click', () => this.cancelAuthorization());
    this.listen(this.$('model-auth-password'), 'keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.submitAuthorization();
      }
    });
    this.listen(this.authDialog, 'cancel', event => {
      event.preventDefault();
      this.cancelAuthorization();
    });
  }

  entry(id = this.selectedId) {
    return this.pool && [...this.pool.permanent, ...this.pool.temporary].find(entry => entry.id === id);
  }

  error(text) {
    this.$('import-error').textContent = text;
    this.$('import-error').hidden = !text;
    if (text) this.onMessage(text, true);
  }

  status(text) {
    const counts = this.pool
      ? `永久 ${this.pool.permanent.length} 个 · 临时 ${this.pool.temporary.length} 个。`
      : '模型池未加载。';
    let access = '后端未连接：可导入、切换和下载模型；入池、删除暂不可用。';
    if (this.remote) {
      access = this.authRequired
        ? '共享模型池 · 临时模型可直接导入、删除；入池或删除永久模型时需要口令。'
        : '共享模型池 · 临时模型可直接导入、删除；永久模型管理尚未配置口令。';
    }
    const local = this.localEntries.size
      ? ` ${this.localEntries.size} 个本页临时模型尚未确认共享保存，刷新页面会丢失，请下载或连接后入池。`
      : '';
    this.$('model-pool-status').textContent = `${text ? text + ' ' : ''}${counts} ${access}${local}`;
  }

  controls() {
    const blocked = this.busy || this.authDialog.open;
    const allowed = this.remote && this.writable && !blocked;
    const entry = this.entry();
    this.$('import-file').disabled = blocked;
    this.$('import-json').disabled = blocked;
    this.$('model-download').disabled = blocked || !this.editor.value.trim();
    this.$('model-pool-add').disabled = !allowed
      || !entry
      || !this.pool.temporary.some(item => item.id === entry.id)
      || this.editor.value !== this.editorValue;
    this.$('model-pool-delete').disabled = !allowed || !entry;
    this.picker.disabled = blocked || !this.pool || !this.picker.options.length || !this.entry();
    this.editor.disabled = blocked;
    this.$('import-close').disabled = blocked;
    this.$('import-cancel').disabled = blocked;
    this.$('model-auth-confirm').disabled = this.busy;
    this.$('model-auth-cancel').disabled = this.busy;
    this.$('model-auth-password').disabled = this.busy;
  }

  select(id, load = false) {
    const entry = this.entry(id) ?? defaultPoolEntry(this.pool ?? emptyPool());
    this.selectedId = entry?.id ?? null;
    this.picker.value = this.selectedId ?? '';
    this.editorValue = entry ? JSON.stringify(entry.model, null, 2) : '';
    this.editor.value = this.editorValue;
    this.controls();
    if (load) this.onLoad(entry?.model ?? emptyModel());
  }

  render(preferredId = this.selectedId) {
    const groups = [
      { element: this.$('model-pool-permanent'), entries: this.pool.permanent, field: 'promotedAt' },
      { element: this.$('model-pool-temporary'), entries: this.pool.temporary, field: 'createdAt' },
    ];
    for (const { element, entries, field } of groups) {
      element.replaceChildren();
      element.hidden = !entries.length;
      for (const entry of newest(entries, field)) {
        const option = this.optionTemplate.content.firstElementChild.cloneNode(true);
        option.value = entry.id;
        const time = Date.parse(entry[field]) === 0
          ? '初始示例'
          : new Date(entry[field]).toLocaleString();
        const localLabel = this.localEntries.has(entry.id) ? '本页临时 · ' : '';
        option.textContent = `${entry.model.name ?? '未命名模型'} · ${localLabel}${time} · ${entry.id.slice(0, 8)}`;
        element.append(option);
      }
    }
    const placeholder = this.$('model-pool-placeholder');
    placeholder.textContent = '模型池为空';
    placeholder.hidden = !!(this.pool.permanent.length || this.pool.temporary.length);
    this.select(preferredId);
    this.status();
  }

  applyPool(pool, preferredId = this.selectedId) {
    this.sharedPool = pool;
    this.pool = { ...pool, temporary: [...pool.temporary, ...this.localEntries.values()] };
    this.render(preferredId);
  }

  importLocal(model, notice = '已导入本页临时模型，可继续查看和下载。') {
    const id = `local-${crypto.randomUUID()}`;
    this.localEntries.set(id, {
      id,
      createdAt: new Date().toISOString(),
      promotedAt: null,
      model,
    });
    this.applyPool(this.sharedPool ?? emptyPool(), id);
    this.select(id, true);
    this.status(notice);
    this.onMessage(notice);
  }

  releaseDownload(url) {
    URL.revokeObjectURL(url);
    this.downloadUrls.delete(url);
    if (this.downloadLink.href === url) {
      this.downloadLink.removeAttribute('href');
      this.downloadLink.removeAttribute('download');
    }
  }

  download() {
    if (this.destroyed || this.busy || this.authDialog.open) return;
    try {
      const draft = JSON.parse(this.editor.value);
      compileModel(draft);
      const raw = this.prepareDownload(draft);
      const text = JSON.stringify(raw, null, 2) + '\n';
      const name = (typeof raw.name === 'string' ? raw.name : 'jk-model')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .trim()
        .replace(/[. ]+$/g, '')
        .slice(0, 100) || 'jk-model';
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
      this.downloadLink.href = url;
      this.downloadLink.download = `${name}.json`;
      try {
        this.downloadLink.click();
      } finally {
        const timer = setTimeout(() => this.releaseDownload(url), 1000);
        this.downloadUrls.set(url, timer);
      }
      this.error('');
      return text;
    } catch (error) {
      this.error(`下载失败：${error.message}`);
    }
  }

  disconnect() {
    this.remote = false;
    this.writable = false;
    this.authRequired = false;
    this.pendingCommand = null;
    this.$('model-auth-password').value = '';
    this.authDialog.close();
    this.status();
  }

  async read() {
    try {
      const response = await fetch(apiUrl, {
        cache: 'no-store',
        signal: AbortSignal.any([AbortSignal.timeout(5000), this.abortController.signal]),
      });
      if (!response.ok) throw new Error(`共享模型池读取失败（HTTP ${response.status}）`);
      const data = await response.json();
      const pool = parseModelPool(data.pool);
      return { pool, remote: true, writable: data.writable === true, authRequired: data.authRequired === true };
    } catch {
      let pool = this.sharedPool;
      if (this.destroyed) return { pool: pool ?? emptyPool() };
      if (!pool) {
        try {
          const response = await fetch('./example.json', {
            cache: 'no-store',
            signal: AbortSignal.any([AbortSignal.timeout(5000), this.abortController.signal]),
          });
          if (!response.ok) throw new Error('示例模型池不可用');
          pool = parseModelPool(await response.json());
        } catch {
          pool = emptyPool();
        }
      }
      return { pool, remote: false, writable: false, authRequired: false };
    }
  }

  async refresh() {
    const previousId = this.selectedId;
    const hadPool = !!this.pool;
    const draft = this.editor.value !== this.editorValue ? this.editor.value : null;
    const { pool, ...connection } = await this.read();
    if (this.destroyed) return;
    Object.assign(this, connection);
    this.applyPool(pool);
    if (hadPool && previousId === this.selectedId && draft !== null) {
      this.editor.value = draft;
      this.controls();
    }
    if (!this.remote && hadPool) this.error('模型池连接失败，仍可导入和下载。');
    if (hadPool && previousId !== this.selectedId) this.onLoad(this.entry()?.model ?? emptyModel());
  }

  async loadInitial() {
    if (this.destroyed) return;
    this.busy = true;
    this.controls();
    try {
      await this.refresh();
      if (!this.destroyed) this.select(defaultPoolEntry(this.pool)?.id, true);
    } finally {
      this.busy = false;
      if (!this.destroyed) this.controls();
    }
  }

  async open() {
    if (this.destroyed) return;
    if (!this.dialog.open) this.dialog.showModal();
    if (this.busy) return;
    this.error('');
    this.busy = true;
    this.controls();
    try {
      await this.refresh();
    } catch (error) {
      if (!this.destroyed) {
        this.writable = false;
        this.error(error.message);
      }
    } finally {
      this.busy = false;
      if (!this.destroyed) {
        this.controls();
        this.status();
      }
    }
  }

  close() {
    if (!this.busy && !this.authDialog.open) {
      ++this.generation;
      this.dialog.close();
    }
  }

  authError(text) {
    this.$('model-auth-error').textContent = text;
    this.$('model-auth-error').hidden = !text;
  }

  cancelAuthorization() {
    if (this.busy) return;
    this.pendingCommand = null;
    this.$('model-auth-password').value = '';
    this.authError('');
    this.authDialog.close();
    this.controls();
  }

  requestAuthorization(command) {
    if (!this.authRequired) {
      this.error('服务器尚未配置管理员口令，暂不能修改永久模型。');
      return;
    }
    ++this.generation;
    this.pendingCommand = { ...command };
    this.$('model-auth-password').value = '';
    this.authError('');
    const name = this.entry(command.id)?.model.name ?? command.id;
    this.$('model-auth-description').textContent = command.action === 'promote'
      ? `将“${name}”移入永久模型组。`
      : `删除永久模型“${name}”，其他设备刷新后也将不再显示此模型。`;
    this.authDialog.showModal();
    this.controls();
    this.$('model-auth-password').focus();
  }

  async submitAuthorization() {
    if (this.destroyed || this.busy || !this.pendingCommand) return;
    const token = this.$('model-auth-password').value.trim();
    if (!token) {
      this.authError('请输入管理员口令。');
      return;
    }
    this.$('model-auth-password').value = '';
    this.authError('');
    await this.mutate(this.pendingCommand, token);
  }

  async importText(text) {
    if (this.destroyed || this.busy || this.authDialog.open) return;
    ++this.generation;
    try {
      const model = JSON.parse(text);
      compileModel(model);
      this.error('');
      if (!this.remote || !this.writable) {
        this.importLocal(model);
      } else {
        await this.mutate({ action: 'import', model });
      }
    } catch (error) {
      this.error(`导入失败：${error.message}`);
    }
  }

  async mutate(command, authorization) {
    if (this.destroyed || this.busy || !this.remote || !this.writable || (this.authDialog.open && !authorization)) return;
    const permanent = command.action === 'promote'
      || (command.action === 'delete' && this.pool.permanent.some(entry => entry.id === command.id));
    if (permanent && !authorization) {
      this.requestAuthorization(command);
      return;
    }
    this.busy = true;
    this.controls();
    this.error('');
    try {
      const local = this.localEntries.get(command.id);
      if (local && command.action === 'delete') {
        this.localEntries.delete(local.id);
        this.applyPool(this.sharedPool, defaultPoolEntry(this.sharedPool)?.id);
        this.select(this.selectedId, true);
        this.status('已删除本页临时模型。');
        return;
      }
      if (local && command.action === 'promote') {
        const uploaded = await this.post({ action: 'import', model: local.model });
        if (this.destroyed) return;
        this.localEntries.delete(local.id);
        this.applyPool(uploaded.pool, uploaded.selectedId);
        command = { action: 'promote', id: uploaded.selectedId };
        this.pendingCommand = command;
      }
      const data = await this.post(command, authorization);
      if (this.destroyed) return;
      const previousId = this.selectedId;
      this.pendingCommand = null;
      this.authDialog.close();
      this.applyPool(data.pool, data.selectedId);
      if (command.action !== 'promote' || previousId !== this.selectedId) {
        this.select(data.selectedId, true);
      }
      const notice = command.action === 'import'
        ? '已导入临时模型，可点击“入池”保存为永久模型。'
        : command.action === 'promote' ? '已保存为永久模型。' : '已从共享模型池删除。';
      this.status(notice);
      this.onMessage(notice);
    } catch (error) {
      if (this.destroyed) return;
      if (error.disconnected) {
        this.disconnect();
        if (command.action === 'import') {
          this.importLocal(command.model, '共享保存未确认，已保留为本页临时模型；连接恢复后请核对。');
        } else {
          this.error('后端连接失败，共享操作结果未确认。当前模型已保留，可下载后重新打开模型管理核对。');
        }
      } else if (error.status === 409) {
        this.pendingCommand = null;
        this.authDialog.close();
        await this.refresh();
        if (!this.destroyed) this.error('模型池已被其他设备更新，已刷新列表；请核对后重试。');
      } else if (this.authDialog.open) {
        this.authError(error.message);
      } else {
        this.error(error.message);
      }
    } finally {
      this.busy = false;
      if (!this.destroyed) this.controls();
    }
  }

  async post(command, authorization) {
    let response;
    let data;
    try {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...command, revision: this.pool.revision }),
        signal: AbortSignal.any([AbortSignal.timeout(10000), this.abortController.signal]),
      });
      data = await response.json();
    } catch (error) {
      throw Object.assign(error, { disconnected: true });
    }
    if (!response.ok) {
      throw Object.assign(new Error(data.error ?? `保存失败（HTTP ${response.status}）`), {
        status: response.status,
        disconnected: response.status >= 500,
      });
    }
    try {
      return { pool: parseModelPool(data.pool), selectedId: data.selectedId };
    } catch (error) {
      throw Object.assign(error, { disconnected: true });
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abortController.abort();
    ++this.generation;
    for (const removeListener of this.listeners) removeListener();
    this.listeners = [];
    for (const [url, timer] of this.downloadUrls) {
      clearTimeout(timer);
      this.releaseDownload(url);
    }
    this.pendingCommand = null;
    this.$('model-auth-password').value = '';
    this.authDialog.close();
    this.dialog.close();
  }
}
