import { JKEngine } from '../../src/jk/engine.js';
import { GPUCompute } from '../../src/jk/gpu-compute.js';
import { APP_CONFIG } from '../../html/config.js';
import fixture from './browser-cases.json';

// Diagnostic limits are host budgets; they do not change JK queue semantics.
const CONFIG = Object.freeze({
  maxCallsPerCase: APP_CONFIG.engine.maxUnits,
  maxTasks: APP_CONFIG.engine.gpuBatch,
  maxEventUnits: APP_CONFIG.engine.frameUnits,
});
const start = document.getElementById('start');
const stop = document.getElementById('stop');
const status = document.getElementById('status');
const summary = document.getElementById('summary');
let active = false;
let stopRequested = false;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

const encoded = value => JSON.stringify(canonical(value));
function compare(fixtureCase, engine) {
  const actual = engine.record();
  const differences = [];
  for (let index = 0; index < Math.max(fixtureCase.record.length, actual.length); index++) {
    if (encoded(fixtureCase.record[index]) !== encoded(actual[index])) {
      differences.push({ kind: 'record', index,
        expected: fixtureCase.record[index] ?? null, actual: actual[index] ?? null });
    }
  }
  const snapshot = engine.snapshot('final');
  if (encoded(snapshot) !== encoded(fixtureCase.snapshot)) {
    differences.push({ kind: 'snapshot', expected: fixtureCase.snapshot, actual: snapshot });
  }
  return { differences, records: actual.length };
}

function display(report) {
  summary.textContent = JSON.stringify(report, null, 2);
}

stop.addEventListener('click', () => {
  stopRequested = true;
  stop.disabled = true;
  status.textContent = '已请求中止；当前场景完成后停止。';
});

start.addEventListener('click', async () => {
  if (active) return;
  active = true;
  stopRequested = false;
  start.disabled = true;
  stop.disabled = false;
  const report = {
    status: 'RUNNING', totalCases: fixture.cases.length, completedCases: 0,
    passedCases: 0, recordsCompared: 0, stats: { dispatches: 0, tasks: 0, fallbacks: 0 },
    provenance: fixture.provenance, cases: [], differences: [], errors: [],
  };
  const gpu = new GPUCompute(message => { report.backendMessage = message; });
  status.textContent = '正在初始化 WebGPU…';
  display(report);
  try {
    if (!await gpu.init() || !gpu.device) {
      report.status = 'SKIP';
      report.reason = gpu.reason || '没有可用的 WebGPU 设备';
      status.textContent = `SKIP · ${report.reason}`;
      return;
    }
    for (const fixtureCase of fixture.cases) {
      if (stopRequested) break;
      status.textContent = `正在验证 ${report.completedCases + 1}/${report.totalCases} · ${fixtureCase.name}`;
      const before = { ...gpu.stats };
      const engine = new JKEngine(fixtureCase.model, fixtureCase.observe);
      let result;
      try {
        let calls = 0;
        for (const batch of fixtureCase.batches) {
          engine.injectBatch(batch);
          while (!engine.idle) {
            if (++calls > CONFIG.maxCallsPerCase) throw new Error('超过专项验证处理预算');
            await engine.runBatchAsync(inputs => gpu.computeBatch(inputs), CONFIG);
          }
        }
        result = compare(fixtureCase, engine);
      } catch (error) {
        result = { differences: [], records: engine.record().length, error: error.message };
        report.errors.push({ case: fixtureCase.name, error: error.message });
      }
      const delta = Object.fromEntries(Object.keys(gpu.stats).map(key => [key, gpu.stats[key] - before[key]]));
      const passed = !result.error && result.differences.length === 0 && delta.fallbacks === 0;
      report.cases.push({ name: fixtureCase.name, passed, records: result.records, stats: delta,
        ...(result.error ? { error: result.error } : {}) });
      report.differences.push(...result.differences.map(difference => ({ case: fixtureCase.name, ...difference })));
      report.completedCases++;
      report.passedCases += Number(passed);
      report.recordsCompared += result.records;
      report.stats = { ...gpu.stats };
      display(report);
      // Release the browser event loop so the native stop button remains usable.
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    report.stats = { ...gpu.stats };
    if (stopRequested && report.completedCases < report.totalCases) {
      report.status = 'STOPPED';
    } else if (report.completedCases === report.totalCases && report.passedCases === report.totalCases
      && report.stats.dispatches > 0 && report.stats.tasks > 0 && report.stats.fallbacks === 0) {
      report.status = 'PASS';
    } else {
      report.status = 'FAIL';
    }
    status.textContent = `${report.status} · ${report.passedCases}/${report.totalCases} 场景通过 · `
      + `${report.stats.dispatches} 次 GPU dispatch · ${report.stats.tasks} 个 EX · ${report.stats.fallbacks} 次回退`;
  } catch (error) {
    report.status = 'FAIL';
    report.errors.push({ error: error.message });
    status.textContent = `FAIL · ${error.message}`;
  } finally {
    report.stats = { ...gpu.stats };
    display(report);
    gpu.dispose();
    active = false;
    start.disabled = false;
    stop.disabled = true;
  }
});
