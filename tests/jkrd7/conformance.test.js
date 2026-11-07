import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JKEngine, computeEX } from '../../src/jk/engine.js';
import {
  compileModel,
  checkRunScript,
  checkSnapshot,
} from '../../src/jk/model-schema.js';

// The expected records are produced by the owning JK repository, never by
// the implementation under test. No CUDA component is imported or executed.
const oracleProcess = spawnSync('python3', [fileURLToPath(new URL('./reference-oracle.py', import.meta.url))], {
  encoding: 'utf8',
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  maxBuffer: 32 * 1024 * 1024,
});
assert.equal(oracleProcess.status, 0, oracleProcess.stderr || oracleProcess.error?.message);
const oracle = JSON.parse(oracleProcess.stdout);

function runBatches(engine, batches) {
  for (const batch of batches) {
    engine.injectBatch(batch);
    engine.run({ maxUnits: 100000 });
  }
}

test('JKRD7 oracle provenance is explicit', () => {
  assert.equal(Object.keys(oracle.provenance).length, 5);
  for (const [source, digest] of Object.entries(oracle.provenance)) {
    assert.match(digest, /^[a-f0-9]{64}$/, source);
  }
});

test('canonical JKRD7 positive static cases', async t => {
  for (const fixture of oracle.valid) {
    await t.test(fixture.name, () => assert.doesNotThrow(() => compileModel(fixture.model)));
  }
});

test('canonical JKRD7 negative static cases', async t => {
  for (const fixture of oracle.invalid) {
    await t.test(fixture.name, () => assert.throws(() => compileModel(fixture.model)));
  }
});

test('execution records and final state equal the canonical Python interpreter', async t => {
  for (const fixture of oracle.cases) {
    await t.test(fixture.name, () => {
      const engine = new JKEngine(fixture.model, fixture.observe);
      assert.deepEqual(engine.record(), [], 'initialization emits nothing');
      runBatches(engine, fixture.batches);
      assert.deepEqual(engine.record(), fixture.record, 'ordered inject/notify/q/output records');
      assert.deepEqual(engine.snapshot('final'), fixture.snapshot, 'all q, arrivals, rounds and FIFOs');
    });
  }
});

test('canonical Python snapshots resume in JavaScript with the exact remaining record', async t => {
  for (const fixture of oracle.cases) {
    await t.test(fixture.name, () => {
      const engine = new JKEngine(fixture.model, fixture.observe);
      const checkpoint = fixture.checkpoint;
      assert.deepEqual(checkSnapshot(checkpoint.snapshot, compileModel(fixture.model)), []);
      engine.restore(checkpoint.snapshot);
      assert.deepEqual(engine.snapshot('checkpoint'), checkpoint.snapshot);
      engine.run({ maxUnits: 100000 });
      runBatches(engine, fixture.batches.slice(1));
      assert.deepEqual(engine.record(), checkpoint.remainingRecord);
      assert.deepEqual(engine.snapshot('final'), fixture.snapshot);
    });
  }
});

test('§9.4 script and §9.5 snapshot examples pass their dedicated validators', () => {
  assert.deepEqual(checkRunScript(oracle.script, compileModel(oracle.scriptModel)), []);
  assert.deepEqual(checkSnapshot(oracle.snapshot, compileModel(oracle.snapshotModel)), []);
});

test('invalid input batches and snapshots fail atomically', () => {
  const engine = new JKEngine(oracle.scriptModel, oracle.script.observe);
  const before = engine.snapshot('unchanged');
  assert.throws(() => engine.injectBatch(['G1.Q1', 'G1.Q24']));
  assert.deepEqual(engine.snapshot('unchanged'), before);
  assert.deepEqual(engine.record(), []);
  const bad = structuredClone(before);
  bad.q['G1.Q1'] = true;
  assert.throws(() => engine.restore(bad));
  assert.deepEqual(engine.snapshot('unchanged'), before);
});

test('a legacy model is rejected instead of migrated', () => {
  assert.throws(() => compileModel({ format: 'jk-logic-structure-V4.0.0', nodes: [], initial_q: {} }));
  const oldVersion = structuredClone(oracle.scriptModel);
  oldVersion.version = '6.1.0';
  assert.throws(() => compileModel(oldVersion));
});

test('multi-queue scheduling stays explicitly unsupported', () => {
  const data = structuredClone(oracle.snapshotModel);
  data.queues = ['a', 'b'];
  data.roots[0].queue = 'a';
  data.roots[1].queue = 'b';
  assert.throws(() => new JKEngine(data), /queue|队列/);
});

test('manual single steps expose event-first scheduling and atomic transaction commit', () => {
  const engine = new JKEngine(oracle.snapshotModel, { watch: ['G2.Q101'], read: ['G2.Q102'] });
  engine.injectBatch(['G1.Q10', 'G1.Q10']);
  let found = false;
  for (let i = 0; i < 12; i++) {
    const state = engine.snapshot('S1');
    if (state.queues.work.events.some(event => Object.hasOwn(event, 'to'))) {
      assert.deepEqual(state, oracle.snapshot);
      found = true;
      break;
    }
    assert.ok(engine.step());
  }
  assert.equal(found, true, 'one step must finish the entire transaction before exposing a checkpoint');
});

test('async EX computation and §7.5 safe batches preserve Python records', async t => {
  for (const fixture of oracle.cases) {
    await t.test(fixture.name, async () => {
      for (const batched of [false, true]) {
        const engine = new JKEngine(fixture.model, fixture.observe);
        for (const batch of fixture.batches) {
          engine.injectBatch(batch);
          let calls = 0;
          while (!engine.idle) {
            if (batched) {
              await engine.runBatchAsync(async inputs => inputs.map(computeEX), { maxTasks: 4 });
            } else {
              await engine.stepAsync(async input => computeEX(input));
            }
            assert.ok(++calls < 100000, 'targeted case must terminate');
          }
        }
        assert.deepEqual(engine.record(), fixture.record, batched ? 'safe batches' : 'async EX');
        assert.deepEqual(engine.snapshot('final'), fixture.snapshot);
      }
    });
  }
});

test('an outstanding async processing unit excludes inputs and snapshots', async () => {
  const fixture = oracle.cases.find(item => item.name === 'M_FLOW');
  const engine = new JKEngine(fixture.model, fixture.observe);
  engine.injectBatch(fixture.batches[0]);
  while (engine.events.length) engine.step();
  let finish;
  const pending = engine.stepAsync(input => new Promise(resolve => { finish = () => resolve(computeEX(input)); }));
  assert.equal(engine.busy, true);
  assert.throws(() => engine.inject('G1.Q1'), /处理单元/);
  assert.throws(() => engine.snapshot('during'), /处理单元/);
  assert.throws(() => engine.step(), /处理单元/);
  finish();
  await pending;
  assert.equal(engine.busy, false);
  engine.run();
  assert.deepEqual(engine.record(), fixture.record);
});

test('a backend failure inside a transaction stops continuation and snapshot export without rollback', async t => {
  for (const batched of [false, true]) {
    await t.test(batched ? 'batch hook' : 'single EX hook', async () => {
      const engine = new JKEngine(oracle.snapshotModel);
      engine.inject('G1.Q10');
      while (engine.events.length) engine.step();
      const safe = engine.snapshot('before-transaction');
      let calls = 0;
      const compute = input => {
        if (++calls === 2) throw new Error('test backend unavailable');
        return computeEX(input);
      };
      await assert.rejects(
        batched ? engine.runBatchAsync(async inputs => inputs.map(compute)) : engine.stepAsync(compute),
        /backend unavailable/,
      );
      assert.equal(engine.busy, false);
      assert.equal(engine.idle, false);
      assert.equal(engine.q['G2.Q101'], 1, 'already-written q is not rolled back');
      assert.equal(engine.q['G2.Q102'], 0, 'later work has not been completed');
      assert.throws(() => engine.snapshot('invalid-boundary'), /完整处理单元边界/);
      assert.throws(() => engine.step(), /完整处理单元边界/);
      assert.throws(() => engine.inject('G1.Q10'), /完整处理单元边界/);
      const invalid = structuredClone(safe);
      invalid.version = '4.0.0';
      assert.throws(() => engine.restore(invalid));
      assert.throws(() => engine.snapshot(), /完整处理单元边界/, 'invalid restore must not clear the fault');
      engine.restore(safe);
      assert.equal(engine.fault, null);
      engine.run();
      assert.equal(engine.q['G2.Q102'], 1);
      engine.reset();
      assert.equal(engine.idle, true);
      assert.equal(engine.q['G2.Q101'], 0);
    });
  }
});

test('a backend failure before a standalone node commit retains its task for retry', async () => {
  const fixture = oracle.cases.find(item => item.name === 'M_FLOW');
  const engine = new JKEngine(fixture.model, fixture.observe);
  engine.injectBatch(fixture.batches[0]);
  while (engine.events.length) engine.step();
  const before = engine.snapshot('retry');
  await assert.rejects(engine.stepAsync(async () => { throw new Error('temporary backend failure'); }));
  assert.equal(engine.fault, null);
  assert.deepEqual(engine.snapshot('retry'), before);
  engine.run();
  assert.deepEqual(engine.record(), fixture.record);
});

test('GPU batch event draining yields for legal gated notification cycles without dropping tasks', async () => {
  // The Q3→Q4 edge passes through JKS.all, so §6.2 does not classify this
  // as the forbidden ungated pure notification cycle. Host budgets still apply.
  const model = { jkm: 'GATED_LOOP', version: '7.0.0', queues: ['work'], roots: [{
    id: 'G1', queue: 'work', pro: {}, runtime: {}, trigger: { any: ['Q1'], all: ['Q3'] },
    members: [
      { id: 'Q1', q: 1, trigger: { any: [] } },
      { id: 'Q2', q: 0, trigger: { any: ['Q1'] }, sources: { seed: 0, s: ['Q1'], ex: ['K'] } },
      { id: 'Q3', q: 1, trigger: { any: ['Q2', 'Q4'] } },
      { id: 'Q4', q: 1, trigger: { any: ['Q3'] } },
      { id: 'Q5', q: 0, trigger: { any: ['Q1'] }, sources: { seed: 0, s: ['Q1'], ex: ['K'] } },
    ],
  }] };
  const engine = new JKEngine(model);
  engine.inject('G1.Q1');
  engine.step();
  assert.deepEqual(engine.tasks, [{ node: 'G1.Q2' }, { node: 'G1.Q5' }]);
  const result = await engine.runBatchAsync(async inputs => inputs.map(computeEX), { maxEventUnits: 7 });
  assert.equal(result.yielded, true);
  assert.equal(result.size, 1);
  assert.equal(engine.q['G1.Q2'], 1);
  assert.equal(engine.q['G1.Q5'], 0);
  assert.deepEqual(engine.tasks, [{ node: 'G1.Q5' }]);
  assert.equal(engine.events.length, 1);
  assert.equal(engine.busy, false);
  assert.deepEqual(checkSnapshot(engine.snapshot(), compileModel(model)), []);
  const serial = new JKEngine(model);
  serial.inject('G1.Q1');
  serial.run({ maxUnits: engine.units });
  assert.deepEqual(engine.record(), serial.record());
  assert.deepEqual(engine.snapshot(), serial.snapshot());
});
