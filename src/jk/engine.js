/** JKRD V4: immediate events, two FIFO task queues, atomic complete EX. */
import { APP_CONFIG } from '../../html/config.js';
import { order } from './node-id.js';
import { emptyFifos, serializeModel } from './model-schema.js';
export { order } from './node-id.js';
export { parseExpression, compileModel } from './model-schema.js';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const queueNames = Object.keys(APP_CONFIG.engine.queues).sort((a, b) => APP_CONFIG.engine.queues[a].priority - APP_CONFIG.engine.queues[b].priority);

export class JKEngine {
  constructor(model, {historyLimit = APP_CONFIG.engine.historyLimit} = {}) {
    this.model = model;
    this.historyLimit = historyLimit;
    this.reset();
  }
  reset() {
    this.queues = Object.fromEntries(queueNames.map(name => [name, {items: [], head: 0}]));
    this.nextId = 1;
    this.total = 0;
    this.eventTotal = 0; // completed tasks, including unavailable-Xi skips
    this.exTotal = 0;
    this.q = new Map();
    this.cache = new Map();
    this.latest = new Map(); // Xi is unreadable until an external send.
    this.counts = new Map();
    this.last = new Map();
    this.history = [];
    for (const node of this.model.nodes) {
      if (!node.errors.length) this.q.set(node.id, node.initial);
      this.cache.set(node.key, new Map());
      this.counts.set(node.key, 0);
    }
    this.outputs = new Map(this.model.outputs.map(output => [output.id, null]));
    this.outputPublications = new Map(this.outputs);
    if (this.model.canExecute) for (const name of queueNames) for (const task of this.model.raw.FIFOS?.[name] ?? []) {
      const [id, arrivals] = Object.entries(task)[0];
      this.enqueue(name, id, arrivals);
    }
  }
  get length() { return queueNames.reduce((sum, name) => sum + this.queueLength(name), 0); }
  queueLength(name) { const queue = this.queues[name]; return queue.items.length - queue.head; }
  itemAt(index) {
    for (const name of queueNames) {
      const queue = this.queues[name], length = this.queueLength(name);
      if (index < length) return queue.items[queue.head + index];
      index -= length;
    }
  }
  enqueue(queue, node, arrivals = {}) {
    const item = Object.freeze({ticket: this.nextId++, queue, node, arrivals: Object.freeze({...arrivals})});
    this.queues[queue].items.push(item);
    return item;
  }
  /** Called synchronously between complete tasks; q and FIFOS share one boundary. */
  capture() {
    const fifos = emptyFifos();
    for (const name of queueNames) {
      const queue = this.queues[name];
      fifos[name] = queue.items.slice(queue.head).map(item => ({[item.node]: {...item.arrivals}}));
    }
    return {state: new Map(this.q), fifos};
  }
  snapshot(options = {}) { return serializeModel(this.model.raw, {...this.capture(), ...options}); }
  remember(event) {
    this.history.push(event);
    if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
    return event;
  }
  send(data) {
    if (!object(data)) throw new Error('输入必须是 JSON 对象，例如 {"X0":1}');
    if (!this.model.canExecute) throw new Error('模型结构或快照校验未通过，不能运行');
    const accepted = Object.keys(data);
    if (!accepted.length) throw new Error('send 必须至少提交一个 Xi');
    for (const id of accepted) {
      if (!this.model.inputs.includes(id)) throw new Error(`未知输入端口 ${id}；本次未发送任何输入`);
      if (data[id] !== 0 && data[id] !== 1) throw new Error(`${id} 的值必须为数字 0 或 1；本次未发送任何输入`);
    }
    accepted.sort(order);
    const queued = [], transfers = [];
    for (const id of accepted) {
      this.latest.set(id, data[id]);
      const target = `Q${id.slice(1)}`;
      queued.push(this.enqueue('Xi.FIFO', target));
      transfers.push({source: id, target, value: data[id], ready: true});
    }
    return this.remember({type: 'input', accepted, queued, transfers, outputChanges: []});
  }
  publish(node, value, event) {
    this.latest.set(node.id, value);
    for (const target of this.model.targets.get(node.id) ?? []) {
      const cache = this.cache.get(target.key);
      let ready = target.required.length === 0;
      if (target.required.includes(node.id)) {
        cache.set(node.id, value);
        ready = target.required.every(source => cache.has(source));
      }
      event.transfers.push({source: node.id, target: target.id, value, ready});
      if (ready) {
        event.queued.push(this.enqueue('Qi.FIFO', target.id, Object.fromEntries(cache)));
        cache.clear(); // The new task owns this group; collect the NEXT group now.
      }
    }
    for (const output of this.model.outputs) if (output.source === node.id) {
      const change = {id: output.id, source: node.id, value};
      this.outputs.set(output.id, value);
      this.outputPublications.set(output.id, value);
      event.outputChanges.push(change);
      event.transfers.push({source: node.id, target: output.id, value, ready: false});
    }
  }
  step() {
    if (!this.model.canExecute || !this.length) return null;
    const name = queueNames.find(name => this.queueLength(name)), queue = this.queues[name];
    const item = queue.items[queue.head++], node = this.model.byId.get(item.node)[0];
    if (queue.head > 2048 && queue.head * 2 > queue.items.length) {
      queue.items = queue.items.slice(queue.head); queue.head = 0;
    }
    this.eventTotal++;
    const event = {type: 'task', ...item, transfers: [], queued: [], executions: [], outputChanges: [], total: this.total, eventTotal: this.eventTotal, skipped: false};
    const reads = {};
    for (const source of node.sources) {
      reads[source] = source.startsWith('X') ? this.latest.get(source) : node.required.includes(source) ? item.arrivals[source] : this.q.get(source);
      if (reads[source] !== 0 && reads[source] !== 1) {
        event.skipped = true;
        event.reason = `参数 ${source} 尚不可读，任务结束，未执行 EX`;
        return this.remember(event);
      }
    }
    const before = node.initial === null ? null : this.q.get(node.id);
    let value = before ?? APP_CONFIG.engine.initialStateless;
    const operations = [];
    for (const token of node.tokens) {
      const input = token.source ? reads[token.source] : token.constant, previous = value;
      value = token.op === 'J' ? value & input : value ^ input;
      operations.push({token: token.text, before: previous, input, after: value});
    }
    this.q.set(node.id, value);
    this.total++;
    this.exTotal += operations.length;
    this.counts.set(node.key, this.counts.get(node.key) + 1);
    const published = node.pro === 'q=0/1' || node.pro === `q=${value}`;
    if (node.input) event.transfers.push({source: node.input, target: node.id, value: reads[node.input], ready: true});
    if (published) this.publish(node, value, event);
    const execution = {type: 'execution', ticket: item.ticket, node: node.id, before, value, reads, operations, total: this.total, published, pro: node.pro, outputChanges: event.outputChanges};
    this.last.set(node.key, execution);
    event.executions.push(execution);
    event.total = this.total;
    this.remember(execution);
    return this.remember(event);
  }
  waiting(node) { return node.required.filter(source => !this.cache.get(node.key).has(source)); }
}
