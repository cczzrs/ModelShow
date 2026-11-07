import { compileModel, validateRunScript, validateSnapshot } from './model-schema.js';
import { comparePaths } from './node-id.js';

const GATED = new Set(['all', 'transaction', 'transaction_any']);
const clone = (value) => structuredClone(value);
const hasEX = (node) => Boolean(node.sources?.ex?.length);

/** Evaluate one complete EX using values captured at its execution entrance. */
export function computeEX({ qBefore, seed, ops, values }) {
  let result = seed === undefined ? qBefore : seed;
  for (let index = 0; index < ops.length; index += 1) {
    result = ops[index] === 'J' ? result & values[index] : result ^ values[index];
  }
  return result;
}

/**
 * JKRD7 single-queue executor. Definitions never store live state.
 * A step is one event, node task, or complete transaction (§7.1).
 * Async computation holds the same processing boundary across GPU awaits.
 */
export class JKEngine {
  constructor(model, options = {}) {
    this.model = model?.jki instanceof Map ? model : compileModel(model);
    const usedQueues = new Set([...this.model.jks.values()].map((group) => group.queue));
    if (usedQueues.size > 1) throw new Error('多个 queue 之间的调度尚未定义（JKRD7 §9.3）');
    this.queue = [...usedQueues][0] ?? this.model.queues[0];
    this.historyLimit = options.historyLimit ?? Infinity;
    if (!(this.historyLimit === Infinity || Number.isInteger(this.historyLimit) && this.historyLimit >= 0)) {
      throw new Error('historyLimit 必须是非负整数或 Infinity');
    }
    this.busy = false;
    this.fault = null;
    this.watch = new Set();
    this.read = [];
    this.reset();
    this.setObservation(options.observe ?? { watch: options.watch ?? [], read: options.read ?? [] });
  }

  get idle() { return !this.busy && !this.fault && this.events.length === 0 && this.tasks.length === 0; }
  get pending() { return this.events.length + this.tasks.length; }

  _boundary({ allowFault = false } = {}) {
    if (this.busy) throw new Error('当前处理单元尚未完成，请在处理单元之间操作（JKRD7 §7.1、§9.5）');
    if (this.fault && !allowFault) throw new Error('计算后端在事务中失败，当前状态不是完整处理单元边界；请重置或恢复有效快照后继续。');
  }

  _absolute(path) {
    if (typeof path !== 'string' || !this.model.jki.has(path)) {
      throw new Error(`${String(path)} 不是模型中的 JKI 绝对路径`);
    }
    return path;
  }

  setObservation({ watch, read }) {
    this._boundary();
    if (!Array.isArray(watch) || !Array.isArray(read)) throw new Error('watch 和 read 必须是 JKI 绝对路径数组');
    const nextWatch = watch.map((path) => this._absolute(path));
    const nextRead = read.map((path) => this._absolute(path));
    this.watch = new Set(nextWatch);
    this.read = nextRead;
  }

  reset() {
    this._boundary({ allowFault: true });
    this.fault = null;
    this.q = Object.fromEntries([...this.model.jki].map(([path, node]) => [path, node.q]));
    this.triggerAll = Object.fromEntries([...this.model.jki]
      .filter(([, node]) => 'all' in node.trigger)
      .map(([path, node]) => [path, [...node.runtime.trigger_all]]));
    this.rounds = Object.fromEntries([...this.model.regTypes].map(([group, types]) => [group,
      Object.fromEntries(Object.keys(types).filter((type) => type === 'all' || type === 'transaction')
        .map((type) => [type, []]))]));
    this.events = [];
    this.tasks = [];
    this.trace = [];
    this.history = [];
    this.outputs = [];
    this.units = 0;
    this.batchSizes = [];
    this.stats = { events: 0, nodeTasks: 0, transactions: 0, notifications: 0, operations: 0 };
    return this;
  }

  inject(path) { return this.injectBatch([path]); }

  /** Atomic input validation; injection records facts and does not write q (§9.1). */
  injectBatch(paths) {
    this._boundary();
    if (!Array.isArray(paths)) throw new Error('输入批必须是路径数组');
    const next = paths.map((path) => {
      this._absolute(path);
      const node = this.model.jki.get(path);
      if (!Array.isArray(node.trigger.any) || node.trigger.any.length || !this.model.regOf.has(path)) {
        throw new Error(`${path} 不是输入入口（JKRD7 §3.2、§9.1）`);
      }
      return path;
    });
    for (const source of next) {
      this.trace.push({ inject: source });
      this.events.push({ source });
    }
    return next.length;
  }

  _publish(node, before, value) {
    const mode = Object.keys(node.publish ?? {})[0] ?? 'always';
    if (mode === 'never') return false;
    if (mode.startsWith('zero') && value !== 0 || mode.startsWith('one') && value !== 1) return false;
    return !mode.endsWith('_changed') || before !== null && before !== value;
  }

  _emit(path, tx) {
    this.trace.push({ notify: path });
    this.stats.notifications += 1;
    (tx ? tx.events : this.events).push({ source: path });
  }

  _receive(path, source, tx) {
    const node = this.model.jki.get(path);
    if ('all' in node.trigger) {
      const record = this.triggerAll[path];
      const index = this.model.triggerRefs.get(path).indexOf(source);
      record[index] = record[index] === null ? 0 : 1;
      if (record.some((value) => value === null)) return;
      record.fill(null);
    }
    if (hasEX(node)) (tx ? tx.tasks : this.tasks).push({ node: path });
    else if (this._publish(node, null, this.q[path])) this._emit(path, tx);
  }

  _offer(subscriber, source, tx, deferred) {
    if (tx && !tx.scope.has(subscriber)) deferred.push(subscriber);
    else this._receive(subscriber, source, tx);
  }

  _gated(group, subscriber) {
    return this.model.members.get(group).has(subscriber) && !this.model.prereqs.get(group).has(subscriber);
  }

  _release(group, order, tx) {
    for (const source of order) {
      const deferred = [];
      for (const subscriber of this.model.subscribers.get(source) ?? []) {
        if (this._gated(group, subscriber)) this._offer(subscriber, source, tx, deferred);
      }
      if (tx && deferred.length) tx.committed.push({ source, to: deferred, out: false });
    }
  }

  _feed(group, type, source, tx) {
    const inline = tx && group.startsWith(`${tx.target}.`);
    let order;
    if (type === 'transaction_any') order = [source];
    else {
      const record = this.rounds[group][type];
      if (!record.includes(source)) record.push(source);
      if (record.length < this.model.regTypes.get(group)[type].length) return;
      order = [...record];
      record.length = 0;
    }
    if (type === 'all' || inline) this._release(group, order, tx);
    else this.tasks.push({ tx: group, prereqs: order });
  }

  _deliver(event, tx) {
    const { source } = event;
    if (!tx && event.out !== false && this.watch.has(source)) {
      const values = this.read.map((path) => this.q[path]);
      this.outputs.push({ source, values: [...values] });
      this.trace.push({ output: source, values });
    }
    // Committed events have exact recipients and never repeat integration (§7.3).
    if ('to' in event) {
      for (const subscriber of event.to) this._receive(subscriber, source, null);
      return;
    }
    const registration = this.model.regOf.get(source);
    const gate = registration && GATED.has(registration.type) ? registration : null;
    if (gate) this._feed(gate.group, gate.type, source, tx);
    const deferred = [];
    for (const subscriber of this.model.subscribers.get(source) ?? []) {
      if (gate && this._gated(gate.group, subscriber)) continue;
      this._offer(subscriber, source, tx, deferred);
    }
    if (tx && (deferred.length || this.watch.has(source))) {
      tx.committed.push({ source, to: deferred, out: true });
    }
  }

  _input(path) {
    const node = this.model.jki.get(path);
    return {
      path,
      qBefore: this.q[path],
      seed: node.sources.seed,
      ops: [...node.sources.ex],
      values: this.model.sourceRefs.get(path).map((source) => this.q[source]),
    };
  }

  _history(entry) {
    const item = { unit: ++this.units, ...entry };
    if (this.historyLimit > 0) {
      this.history.push(item);
      if (this.history.length > this.historyLimit) this.history.shift();
    }
    return item;
  }

  _eventUnit() {
    const event = this.events.shift();
    this.stats.events += 1;
    const entry = this._history({ kind: 'event', target: event.source, event: clone(event) });
    this._deliver(event, null);
    return entry;
  }

  _commitNode(input, result, tx) {
    if (result !== 0 && result !== 1) throw new Error('计算后端必须返回整数 bit 0 或 1');
    const published = this._publish(this.model.jki.get(input.path), input.qBefore, result);
    const entry = { kind: 'node', target: input.path, qBefore: input.qBefore, result, published,
      seed: input.seed, ops: [...input.ops], values: [...input.values] };
    // Publication is logged before q is written; delivery follows the write (§4.3).
    if (published) this._emit(input.path, tx);
    this.q[input.path] = result;
    this.trace.push({ q: input.path, from: input.qBefore, to: result });
    this.stats.nodeTasks += 1;
    this.stats.operations += input.ops.length;
    return tx ? entry : this._history(entry);
  }

  _newTransaction(task) {
    return { target: task.tx, scope: this.model.ranges.get(task.tx), events: [], tasks: [], committed: [] };
  }

  _runTransaction(task) {
    const tx = this._newTransaction(task);
    const entry = this._history({ kind: 'transaction', target: task.tx, prereqs: [...task.prereqs], nodes: [] });
    this.stats.transactions += 1;
    this._release(task.tx, task.prereqs, tx);
    while (tx.events.length || tx.tasks.length) {
      if (tx.events.length) this._deliver(tx.events.shift(), tx);
      else {
        const input = this._input(tx.tasks.shift().node);
        entry.nodes.push(this._commitNode(input, computeEX(input), tx));
      }
    }
    this.events.push(...tx.committed);
    entry.committed = tx.committed.length;
    return entry;
  }

  /** One processing unit; false means quiescent. */
  step() {
    this._boundary();
    if (!this.pending) return false;
    this.busy = true;
    try {
      if (this.events.length) return this._eventUnit();
      const task = this.tasks.shift();
      if ('tx' in task) return this._runTransaction(task);
      const input = this._input(task.node);
      return this._commitNode(input, computeEX(input), null);
    } finally { this.busy = false; }
  }

  async _runTransactionAsync(task, compute, computeBatch, maxTasks) {
    const tx = this._newTransaction(task);
    const entry = this._history({ kind: 'transaction', target: task.tx, prereqs: [...task.prereqs], nodes: [] });
    this.stats.transactions += 1;
    this._release(task.tx, task.prereqs, tx);
    while (tx.events.length || tx.tasks.length) {
      if (tx.events.length) this._deliver(tx.events.shift(), tx);
      else if (computeBatch) {
        const paths = this._batchPaths(tx.tasks, maxTasks);
        const inputs = paths.map((path) => this._input(path));
        const results = await computeBatch(inputs);
        this._validateResults(results, inputs.length);
        tx.tasks.splice(0, inputs.length);
        this.batchSizes.push(inputs.length);
        for (let index = 0; index < inputs.length; index += 1) {
          entry.nodes.push(this._commitNode(inputs[index], results[index], tx));
          while (tx.events.length) this._deliver(tx.events.shift(), tx);
        }
      } else {
        const input = this._input(tx.tasks[0].node);
        const result = await compute(input);
        this._validateResults([result], 1);
        tx.tasks.shift();
        entry.nodes.push(this._commitNode(input, result, tx));
      }
    }
    this.events.push(...tx.committed);
    entry.committed = tx.committed.length;
    return entry;
  }

  /** Same unit boundary as step; compute(input) may dispatch a WebGPU kernel. */
  async stepAsync(compute = computeEX) {
    this._boundary();
    if (!this.pending) return false;
    if (typeof compute !== 'function') throw new Error('compute 必须是计算函数');
    this.busy = true;
    try {
      if (this.events.length) return this._eventUnit();
      const task = this.tasks[0];
      if ('tx' in task) {
        this.tasks.shift();
        try { return await this._runTransactionAsync(task, compute, null, 1); }
        catch (error) {
          // §6.3 has no transaction rollback. A failed external compute hook may
          // have left partial live state, which must never look like a boundary.
          this.fault = error instanceof Error ? error : new Error(String(error));
          throw this.fault;
        }
      }
      const input = this._input(task.node);
      const result = await compute(input);
      this._validateResults([result], 1);
      this.tasks.shift();
      return this._commitNode(input, result, null);
    } finally { this.busy = false; }
  }

  _batchPaths(queue, maxTasks) {
    const paths = [];
    const written = new Set();
    for (const task of queue) {
      if (!('node' in task) || paths.length >= maxTasks) break;
      if (written.has(task.node) || this.model.sourceRefs.get(task.node).some((source) => written.has(source))) break;
      paths.push(task.node);
      written.add(task.node);
    }
    return paths;
  }

  _validateResults(results, count) {
    if (!Array.isArray(results) || results.length !== count || results.some((bit) => bit !== 0 && bit !== 1)) {
      throw new Error('计算后端必须按输入顺序返回等长的整数 bit 数组');
    }
  }

  /**
   * One §7.5 batch (or one event/transaction). Results share entrance q;
   * commits and event draining remain serial, including inside transactions.
   */
  async runBatchAsync(computeBatch, { maxTasks = Infinity, maxEventUnits = 10000 } = {}) {
    this._boundary();
    if (typeof computeBatch !== 'function') throw new Error('computeBatch 必须是计算函数');
    if (!(maxTasks === Infinity || Number.isInteger(maxTasks) && maxTasks > 0)) throw new Error('maxTasks 必须是正整数');
    if (!Number.isInteger(maxEventUnits) || maxEventUnits < 1) throw new Error('maxEventUnits 必须是正整数');
    if (!this.pending) return false;
    this.busy = true;
    try {
      if (this.events.length) return this._eventUnit();
      const first = this.tasks[0];
      if ('tx' in first) {
        this.tasks.shift();
        try { return await this._runTransactionAsync(first, null, computeBatch, maxTasks); }
        catch (error) {
          this.fault = error instanceof Error ? error : new Error(String(error));
          throw this.fault;
        }
      }
      const paths = this._batchPaths(this.tasks, maxTasks);
      const inputs = paths.map((path) => this._input(path));
      const results = await computeBatch(inputs);
      this._validateResults(results, inputs.length);
      this.tasks.splice(0, inputs.length);
      this.batchSizes.push(inputs.length);
      const entries = [];
      let eventsDrained = 0;
      for (let index = 0; index < inputs.length; index += 1) {
        entries.push(this._commitNode(inputs[index], results[index], null));
        while (this.events.length && eventsDrained < maxEventUnits) {
          entries.push(this._eventUnit());
          eventsDrained += 1;
        }
        if (this.events.length) {
          // Legal gated notification cycles may never quiesce. Yield at an
          // event boundary and put uncommitted tasks back ahead of appended
          // work. Their precomputed results are discarded; no work is lost.
          this.tasks.unshift(...inputs.slice(index + 1).map(input => ({ node: input.path })));
          return { kind: 'batch', size: index + 1, entries, yielded: true };
        }
      }
      return { kind: 'batch', size: inputs.length, entries };
    } finally { this.busy = false; }
  }

  /** Budget is a host execution limit, never a queue capacity or task discard. */
  run({ maxUnits = 100000 } = {}) {
    this._boundary();
    if (!Number.isInteger(maxUnits) || maxUnits < 0) throw new Error('maxUnits 必须是非负整数');
    const start = this.units;
    while (this.units - start < maxUnits && this.step()) { /* one complete unit */ }
    return { units: this.units - start, idle: this.idle };
  }

  async runAsync(compute = computeEX, { maxUnits = 100000 } = {}) {
    this._boundary();
    if (!Number.isInteger(maxUnits) || maxUnits < 0) throw new Error('maxUnits 必须是非负整数');
    const start = this.units;
    while (this.units - start < maxUnits && await this.stepAsync(compute)) { /* one complete unit */ }
    return { units: this.units - start, idle: this.idle };
  }

  runScript(script, { maxUnits = 100000 } = {}) {
    const validated = validateRunScript(script, this.model);
    this.reset();
    this.setObservation(validated.observe);
    for (const batch of validated.batches) {
      this.injectBatch(batch);
      if (!this.run({ maxUnits }).idle) throw new Error('运行脚本尚未静止，已保留全部待处理队列；未注入下一批');
    }
    return this.record();
  }

  record() { return clone(this.trace); }

  snapshot(name = 'S1') {
    this._boundary();
    if (typeof name !== 'string' || !name.length) throw new Error('snapshot 必须是非空字符串');
    const sorted = [...this.model.jki.keys()].sort(comparePaths);
    const rounds = {};
    for (const group of [...this.model.jks.keys()].sort(comparePaths)) {
      const active = Object.fromEntries(Object.entries(this.rounds[group]).filter(([, record]) => record.length)
        .map(([type, record]) => [type, [...record]]));
      if (Object.keys(active).length) rounds[group] = active;
    }
    return {
      snapshot: name,
      jkm: this.model.name,
      version: '7.0.0',
      q: Object.fromEntries(sorted.map((path) => [path, this.q[path]])),
      trigger_all: Object.fromEntries(sorted.filter((path) => this.triggerAll[path]?.some((value) => value !== null))
        .map((path) => [path, [...this.triggerAll[path]]])),
      rounds,
      queues: { [this.queue]: { events: clone(this.events), tasks: clone(this.tasks) } },
    };
  }

  capture(name = 'S1') { return this.snapshot(name); }

  /** Validate before replacing live state; output history is not a saved field. */
  restore(snapshot) {
    this._boundary({ allowFault: true });
    const validated = validateSnapshot(snapshot, this.model);
    this.reset();
    this.q = { ...validated.q };
    for (const [path, record] of Object.entries(this.triggerAll)) {
      this.triggerAll[path] = [...(validated.trigger_all[path] ?? record)];
    }
    for (const [group, types] of Object.entries(this.rounds)) {
      for (const type of Object.keys(types)) types[type] = [...(validated.rounds[group]?.[type] ?? [])];
    }
    const fifo = validated.queues[this.queue] ?? { events: [], tasks: [] };
    this.events = clone(fifo.events);
    this.tasks = clone(fifo.tasks);
    return this;
  }
}
