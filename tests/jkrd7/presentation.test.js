import test from 'node:test';
import assert from 'node:assert/strict';
import { compileModel } from '../../src/jk/model-schema.js';
import { JKEngine } from '../../src/jk/engine.js';
import { createDisplayModel, unitTransfers } from '../../src/scene/model-view.js';
import { createLayout, layoutEdges, LAYOUT_MODES } from '../../src/scene/layout.js';

// Nested IDs, repeated EX operands, separate trigger/source connections and an
// allowed feedback component exercise the boundary between JKRD7 and drawing.
const fixture = {
  jkm: 'presentation-boundaries', version: '7.0.0', queues: ['work'], roots: [{
    id: 'G1', queue: 'work', pro: {}, runtime: {}, trigger: { any: ['Q1'] },
    members: [
      { id: 'Q1', q: 1, trigger: { any: [] }, pro: { tag: ['入口'] } },
      { id: 'Q2', q: 0, trigger: { any: ['Q1'] },
        sources: { s: ['Q1', 'Q1', 'G1.G2.Q1'], ex: ['K', 'J', 'K'], seed: 0 } },
      { id: 'Q3', q: 0, trigger: { any: ['Q2'] }, sources: { s: ['Q4'], ex: ['K'], seed: 0 } },
      { id: 'Q4', q: 0, trigger: { any: ['Q3'] }, sources: { s: ['Q3'], ex: ['K'], seed: 0 }, publish: { never: [] } },
      { id: 'Q5', q: 0, trigger: { any: ['Q1'] }, sources: { s: ['Q1'], seed: 1 } },
      { id: 'G2', queue: 'work', pro: {}, runtime: {}, trigger: {}, members: [
        { id: 'Q1', q: 0, trigger: { any: ['G1.Q2'] }, sources: { s: ['G1.Q1'], ex: ['K'], seed: 0 } },
      ] },
    ],
  }],
};
const observe = { watch: ['G1.Q3'], read: ['G1.Q1', 'G1.Q3', 'G1.G2.Q1'] };

test('drawing keeps absolute identities and never copies input JKI into Xi nodes', () => {
  const compiled = compileModel(fixture);
  const drawing = createDisplayModel(compiled, observe);
  assert.deepEqual(drawing.nodes.map(node => node.key), compiled.paths);
  assert.equal(drawing.nodes.length, compiled.jki.size);
  assert.deepEqual(drawing.inputs, []);
  assert.notEqual(drawing.byId.get('G1.Q1'), drawing.byId.get('G1.G2.Q1'));
  assert.equal(drawing.byId.get('G1.Q1').initial, 1);
  assert.equal(drawing.byId.get('G1.G2.Q1').initial, 0);
  assert.match(drawing.byId.get('G1.Q1').displayName, /G1\.Q1.*入口/);
  assert.deepEqual(new Set(drawing.outputs.map(output => output.source)), new Set(observe.read));
  assert.equal(drawing.outputs.length, 3, 'watch/read overlap creates one observation endpoint');
  assert.ok(drawing.outputs.every(output => output.id.startsWith('observe:')));
});

test('drawing preserves repeated EX steps and keeps trigger-only links distinct', () => {
  const drawing = createDisplayModel(compileModel(fixture), observe);
  const repeated = drawing.byId.get('G1.Q2').tokens.filter(token => token.relation === 'source');
  assert.deepEqual(repeated.map(({ source, op, index }) => [source, op, index]), [
    ['G1.Q1', 'K', 0], ['G1.Q1', 'J', 1], ['G1.G2.Q1', 'K', 2],
  ]);
  assert.equal(drawing.byId.get('G1.Q2').tokens.filter(token => token.relation === 'trigger').length, 1);
  const separate = drawing.byId.get('G1.Q3').tokens;
  assert.ok(separate.some(token => token.source === 'G1.Q2' && token.relation === 'trigger'));
  assert.ok(separate.some(token => token.source === 'G1.Q4' && token.relation === 'source'));
  assert.ok(drawing.byId.get('G1.Q5').tokens.every(token => token.relation !== 'source'), 'empty EX does not read sources');
  assert.equal(layoutEdges(drawing).filter(edge => edge.source === 'G1.Q1' && edge.target === 'G1.Q2').length, 3);
});

test('drawing marks only nonempty EX regardless of q, sources references or seed', () => {
  for (const sources of [undefined, {}, { s: ['Q1'], seed: 1 }, { s: ['Q1'], ex: [], seed: 0 },
    { s: ['Q1'], ex: ['J'] }, { s: ['Q1'], ex: ['K'] }]) {
    for (const q of [0, 1]) {
      const raw = structuredClone(fixture), definition = raw.roots[0].members[4];
      definition.q = q;
      if (sources === undefined) delete definition.sources;
      else definition.sources = structuredClone(sources);
      const before = structuredClone(raw);
      const drawing = createDisplayModel(compileModel(raw), { read: ['G1.Q5'] });
      assert.equal(drawing.byId.get('G1.Q5').hasEX, !!sources?.ex?.length);
      assert.equal(drawing.byId.get('G1.Q5').initial, q);
      assert.ok(drawing.outputs.every(output => !output.hasEX));
      assert.deepEqual(raw, before, 'drawing eligibility must not rewrite the model');
    }
  }
});

test('all original layout modes keep nested nodes, feedback and observations finite and separate', async t => {
  const drawing = createDisplayModel(compileModel(fixture), observe);
  const expected = new Set([...drawing.nodes.map(node => node.key), ...drawing.outputs.map(output => output.id)]);
  for (const mode of LAYOUT_MODES) await t.test(mode, () => {
    const result = createLayout(drawing, mode);
    assert.deepEqual(new Set(result.positions.keys()), expected);
    for (const [key, point] of result.positions) {
      assert.ok(['x', 'y', 'z'].every(axis => Number.isFinite(point[axis])), key);
    }
    assert.equal(new Set([...result.positions.values()].map(point => JSON.stringify(point))).size, expected.size);
    assert.ok(Number.isFinite(result.metrics.score));
    assert.deepEqual(result.positions, createLayout(drawing, mode).positions, 'layout is deterministic');
  });
});

test('5D keeps the original two-sided boundary with input priority for observed inputs', () => {
  const result = createLayout(createDisplayModel(compileModel(fixture), observe), '5D');
  assert.deepEqual(result.inputKeys, ['G1.Q1']);
  assert.deepEqual(new Set(result.outputKeys), new Set(['G1.Q3', 'G1.G2.Q1']));
  assert.deepEqual(result.dualKeys, ['G1.Q1']);
  assert.equal(result.conflictPolicy, 'input-first');
  assert.equal(result.positions.get('G1.Q1').x, result.leftX);
  for (const path of result.outputKeys) assert.equal(result.positions.get(path).x, result.rightX);
  assert.ok(result.leftX < result.rightX);
});

test('drawing and layout leave the queued runtime and canonical definition unchanged', () => {
  const engine = new JKEngine(fixture, observe);
  engine.injectBatch(['G1.Q1']);
  const before = engine.snapshot('presentation');
  const record = engine.record();
  const definition = structuredClone(engine.model.raw);
  const refs = structuredClone(engine.model.sourceRefs);
  const drawing = createDisplayModel(engine.model, observe);
  for (const mode of LAYOUT_MODES) createLayout(drawing, mode);
  assert.deepEqual(engine.snapshot('presentation'), before);
  assert.deepEqual(engine.record(), record);
  assert.deepEqual(engine.model.raw, definition);
  assert.deepEqual(engine.model.sourceRefs, refs);
});

test('signal animation uses captured EX operands and no numeric notification payload', () => {
  const engine = new JKEngine(fixture, observe);
  engine.injectBatch(['G1.Q1']);
  engine.run({ maxUnits: 100 });
  const entry = engine.history.find(item => item.kind === 'node' && item.target === 'G1.Q2');
  assert.ok(entry);
  assert.equal(engine.q['G1.G2.Q1'], 1, 'source changed after the first EX entry');
  const transfers = unitTransfers(engine.model, entry);
  assert.deepEqual(transfers.map(({ source, value, index }) => [source, value, index]), [
    ['G1.Q1', 1, 0], ['G1.Q1', 1, 1], ['G1.G2.Q1', 0, 2],
  ]);
  const notification = unitTransfers(engine.model, { kind: 'event', target: 'G1.Q1', event: { source: 'G1.Q1' } });
  assert.ok(notification.length > 0);
  assert.ok(notification.every(item => item.relation === 'trigger' && item.value === '·'));
});

test('committed event animation follows exact recipients and never replays internal delivery', () => {
  const model = compileModel(fixture);
  const event = { kind: 'event', target: 'G1.Q1', event: { source: 'G1.Q1', to: ['G1.Q5'], out: false } };
  assert.deepEqual(unitTransfers(model, event).map(item => item.target), ['G1.Q5']);
  event.event.to = [];
  assert.deepEqual(unitTransfers(model, event), []);
});
