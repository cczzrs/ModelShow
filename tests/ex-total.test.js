import test from 'node:test';
import assert from 'node:assert/strict';
import {compileModel, JKEngine} from '../src/engine.js';
import {Playback} from '../src/playback.js';

const compile = (nodes, initial_q = {0: [], 1: []}, q_y = []) => compileModel({
  nodes: nodes.map(([id, ex]) => ({id, ex})), initial_q, q_y,
});

test('EX total counts every executed J/K token, including constants and repeated references', () => {
  const engine = new JKEngine(compile([
    ['Q0', 'J0K(X0)K(X0)J1'],
    ['Q1', 'J0K(Q0)K1'],
    ['Q2', 'K(X0)'], // Invalid stateless node: never executes.
    ['Q3', 'J0K1'],
  ], undefined, [{Y0: 'Q1'}, {Y1: 'Q1'}]));
  assert.equal(typeof engine.exTotal, 'number');
  assert.equal(engine.exTotal, 0);
  assert.equal(engine.length, 1, 'constant expressions are queued, not counted on load');
  engine.send({X0: 1});
  assert.equal(engine.exTotal, 0, 'input publication and queue insertion do not evaluate EX');
  const expected = [['Q3', 2], ['Q0', 6], ['Q1', 9]];
  for (const [node, total] of expected) {
    assert.equal(engine.step().node, node);
    assert.equal(engine.exTotal, total);
  }
  assert.equal(engine.total, 3);
  assert.equal(engine.outputs.get('Y0'), 1);
  assert.equal(engine.outputs.get('Y1'), 1, 'multiple output aliases add no EX operations');
  assert.equal(engine.step(), null);
  assert.equal(engine.exTotal, 9);
  engine.reset();
  assert.equal(engine.exTotal, 0);
  assert.equal(engine.length, 1, 'reset queues constants without counting them');
});

test('EX total accumulates across repeated sends independently of bounded event history', () => {
  const engine = new JKEngine(compile([
    ['Q0', 'J0K(X0)'],
    ['Q1', 'J0K(Q0)K1'],
  ]), {historyLimit: 2});
  for (let round = 1; round <= 5; round++) {
    engine.send({X0: 1});
    assert.equal(engine.exTotal, (round - 1) * 5);
    while (engine.length) engine.step();
    assert.equal(engine.exTotal, round * 5);
    assert.equal(engine.total, round * 2);
  }
  assert.equal(engine.history.length, 2);
  assert.equal(engine.exTotal, 25);
  engine.send({unrecognized: 1});
  assert.equal(engine.exTotal, 25);
});

test('normal animation, skip batches and single-step count the same stateful feedback executions', () => {
  const graph = compile([
    ['Q0', 'K(X0)'],
    ['Q1', 'J(Q0)K(Q1)K1'],
  ], {0: ['Q0', 'Q1'], 1: []}, [{Y0: 'Q1'}]);
  for (const mode of ['normal', 'skip', 'step']) {
    const engine = new JKEngine(graph), observed = [];
    const playback = new Playback(engine, {now: () => 0, onChange: event => {
      if (event?.type !== 'execution') return;
      observed.push([event.node, engine.exTotal]);
      if (engine.total === 12) playback.pause();
    }});
    playback.skip = mode === 'skip';
    playback.send({X0: 0});
    for (let frame = 0; engine.total < 12 && frame < 100; frame++) {
      if (mode === 'step') playback.step();
      else playback.tick(1);
    }
    assert.equal(engine.total, 12, mode);
    assert.equal(engine.exTotal, 34, mode); // Q0: 1 token; Q1: 11 executions × 3 tokens.
    assert.deepEqual(observed, Array.from({length: 12}, (_, i) => [i ? 'Q1' : 'Q0', 1 + i * 3]), mode);
    assert.equal(engine.outputs.get('Y0'), 1, mode);
    assert.equal(engine.length, 1, 'pending feedback is not counted');
    playback.tick(1);
    assert.equal(engine.exTotal, 34, 'paused playback adds no operations');
    playback.reset();
    assert.equal(engine.exTotal, 0, mode);
    assert.equal(engine.total, 0, mode);
  }
});

test('a failed expression evaluation adds no partial EX count', () => {
  const engine = new JKEngine(compile([['Q0', 'J0K(X0)K1']]));
  engine.send({X0: 1});
  engine.queue[0] = {...engine.queue[0], values: {X0: 2}};
  assert.throws(() => engine.step(), /内部参数错误/);
  assert.equal(engine.total, 0);
  assert.equal(engine.exTotal, 0, 'the first J0 token is not counted separately before a failed evaluation');
  engine.send({X0: 0});
  engine.step();
  assert.equal(engine.total, 1);
  assert.equal(engine.exTotal, 3);
});
