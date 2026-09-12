import test from 'node:test';
import assert from 'node:assert/strict';
import {parseJKId} from '../src/node-id.js';
import {compileModel, parseExpression, order, JKEngine} from '../src/engine.js';
import {Playback} from '../src/playback.js';
import {defaultDisplay, exportDisplayModel} from '../src/output-display.js';

const rawModel = (nodes, initial_q = {0: [], 1: []}, q_y = []) => ({nodes, initial_q, q_y});
const drain = engine => {
  const events = [];
  while (engine.length) {
    assert.ok(events.length < 100, 'unexpected feedback in finite test');
    events.push(engine.step());
  }
  return events;
};

test('JK identity parser separates exact decimal identity from case-sensitive ASCII tags', () => {
  for (const [source, id, number, tag] of [
    ['Q0', 'Q0', '0', null], ['Q215L9B7', 'Q215', '215', 'L9B7'],
    ['Q215l9B7', 'Q215', '215', 'l9B7'], ['Q0Z', 'Q0', '0', 'Z'],
    ['Q900719925474099312345T001', 'Q900719925474099312345', '900719925474099312345', 'T001'],
  ]) assert.deepEqual(parseJKId(source), {id, number, tag});
  for (const value of ['Q00', 'Q01L9', 'Q-1T', 'Q+1', 'Q1.5T', 'Q1_A', 'Q1A-B', 'Q1中文', 'q1A', 'X1A', 'Y1A', ' Q1A', 'Q1A ', 'Q1A\n', '', 215, null, undefined]) {
    assert.throws(() => parseJKId(value), undefined, String(value));
  }
});

test('expression grammar accepts tagged Q references while Xi and Yi grammar stays unchanged', () => {
  assert.deepEqual(parseExpression(' J0 K( Q215L9B7 ) J(X0) ').map(t => t.text), ['J0', 'K(Q215L9B7)', 'J(X0)']);
  for (const ex of ['J0K(Q01L9)', 'J0K(Q1_a)', 'J0K(Q1A-B)', 'J0K(X1Tag)', 'J0K(X01)', 'J0K(Y0)', 'J0K(Q1T)garbage']) {
    assert.throws(() => parseExpression(ex), undefined, ex);
  }
  const model = compileModel(rawModel([{id: 'Q215L9B7', ex: 'J0K(X3)'}], undefined, [{Y0: 'Q215L9B7'}, {Y1Tag: 'Q215'}, {Y01: 'Q215'}]));
  assert.deepEqual(model.inputs, ['X3']);
  assert.deepEqual(model.outputs.map(o => [o.id, o.source, o.error]), [['Y0', 'Q215', null]]);
  assert.equal(model.issues.length, 2);
});

test('explicit tags and legacy suffixes compile to canonical IDs without changing source expressions', () => {
  const model = compileModel(rawModel([
    {id: 'Q215', tag: 'L9B7', ex: 'K(X0)'},
    {id: 'Q216Right', tag: 'Right', ex: 'J0 K(Q215L9B7) K(Q215)'},
    {id: 'Q217', ex: 'J0K(Q216Right)'},
  ], {0: ['Q215L9B7'], 1: []}, [{Y0: 'Q216Right'}, {Y1: 'Q217'}]));
  assert.equal(model.valid.length, 3);
  assert.deepEqual(model.nodes.map(n => [n.originalId, n.id, n.tag, n.displayName]), [
    ['Q215', 'Q215', 'L9B7', 'Q215L9B7'],
    ['Q216Right', 'Q216', 'Right', 'Q216Right'],
    ['Q217', 'Q217', null, 'Q217'],
  ]);
  assert.deepEqual([...model.byId.keys()], ['Q215', 'Q216', 'Q217']);
  assert.equal(model.nodes[1].ex, 'J0 K(Q215L9B7) K(Q215)');
  assert.deepEqual(model.nodes[1].tokens.map(t => [t.text, t.source]), [['J0', null], ['K(Q215L9B7)', 'Q215'], ['K(Q215)', 'Q215']]);
  assert.deepEqual(model.nodes[1].sources, ['Q215']);
  assert.deepEqual(model.nodes[1].required, [], 'stateful sources do not become stateless arrival requirements');
});

test('tags are optional but provided tags must be nonempty ASCII identifiers', () => {
  for (const tag of ['', null, 12, true, [], {}, '9L', '_L', 'L-9', ' L9', 'L9 ', 'L9\n', '中文']) {
    const model = compileModel(rawModel([{id: 'Q0', tag, ex: 'J0K(X0)'}, {id: 'Q1', ex: 'J0K1'}]));
    assert.ok(model.nodes[0].errors.length, String(tag));
    assert.deepEqual(model.valid.map(n => n.id), ['Q1']);
  }
  for (const tag of ['A', 'a', 'L9B7']) {
    const model = compileModel(rawModel([{id: 'Q0', tag, ex: 'J0K1'}]));
    assert.equal(model.valid.length, 1);
    assert.equal(model.nodes[0].displayName, `Q0${tag}`);
  }
});

test('conflicting suffix and tag block the node and its dependents only', () => {
  const model = compileModel(rawModel([
    {id: 'Q0Left', tag: 'left', ex: 'J0K(X0)'},
    {id: 'Q1', ex: 'J0K(Q0)'}, {id: 'Q2', ex: 'J0K(Q1)'},
    {id: 'Q3OK', ex: 'J0K(X0)'},
  ], undefined, [{Y0: 'Q2'}, {Y1: 'Q3OK'}]));
  assert.deepEqual(model.valid.map(n => n.id), ['Q3']);
  assert.ok(model.nodes.slice(0, 3).every(n => n.errors.length));
  const engine = new JKEngine(model);
  engine.send({X0: 1});
  assert.deepEqual(drain(engine).map(e => e.node), ['Q3']);
  assert.deepEqual([...engine.outputs], [['Y0', null], ['Y1', 1]]);
});

test('different tagged definitions of one numeric identity are duplicates and never merge', () => {
  const model = compileModel(rawModel([
    {id: 'Q215', tag: 'One', ex: 'J0K(X0)'},
    {id: 'Q215L9B7', ex: 'J0K(X0)'},
    {id: 'Q215L9B8', ex: 'J0K1'},
    {id: 'Q216', ex: 'J0K(Q215L9B7)'},
    {id: 'Q217', ex: 'J0K(Q216)'},
    {id: 'Q218Safe', ex: 'J0K(X0)'},
  ]));
  assert.equal(model.byId.get('Q215').length, 3);
  assert.ok(model.nodes.slice(0, 3).every(n => n.errors.some(e => /重复/.test(e))));
  assert.ok(model.nodes.slice(3, 5).every(n => n.errors.length));
  assert.deepEqual(model.valid.map(n => n.id), ['Q218']);
  const engine = new JKEngine(model); engine.send({X0: 1});
  assert.deepEqual(drain(engine).map(e => e.node), ['Q218']);
});

test('wrong or undeclared reference tags cannot silently alias existing node IDs', () => {
  const model = compileModel(rawModel([
    {id: 'Q0', tag: 'L9B7', ex: 'J0K1'}, {id: 'Q1', ex: 'J0K1'},
    {id: 'Q2', ex: 'J0K(Q0L9B8)'}, {id: 'Q3', ex: 'J0K(Q0l9B7)'},
    {id: 'Q4', ex: 'J0K(Q1Extra)'}, {id: 'Q5', ex: 'J0K(Q2)'},
    {id: 'Q6', ex: 'J0K(Q0L9B7)'},
  ], undefined, [{Y0: 'Q0L9B8'}, {Y1: 'Q1Extra'}, {Y2: 'Q0'}, {Y3: 'Q0L9B7'}]));
  assert.deepEqual(model.valid.map(n => n.id), ['Q0', 'Q1', 'Q6']);
  assert.ok(model.nodes.slice(2, 6).every(n => n.errors.length));
  assert.ok(model.outputs[0].error && model.outputs[1].error);
  const engine = new JKEngine(model); drain(engine);
  assert.deepEqual([...engine.outputs], [['Y0', null], ['Y1', null], ['Y2', 1], ['Y3', 1]]);
});

test('invalid initialization tags block the intended node rather than making it accidentally stateless', () => {
  for (const entry of ['Q0Wrong', 'Q0left']) {
    const model = compileModel(rawModel([
      {id: 'Q0Left', ex: 'J0K(X0)'}, {id: 'Q1', ex: 'J0K(Q0)'}, {id: 'Q2', ex: 'J0K(X0)'},
    ], {0: [entry], 1: []}));
    assert.deepEqual(model.valid.map(n => n.id), ['Q2'], entry);
    const engine = new JKEngine(model); engine.send({X0: 1});
    assert.deepEqual(drain(engine).map(e => e.node), ['Q2']);
  }
  const unknown = compileModel(rawModel([{id: 'Q0', ex: 'J0K1'}], {0: ['Q99Missing', 'malformed'], 1: []}));
  assert.equal(unknown.valid.length, 1);
  assert.equal(unknown.issues.length, 2);
});

test('initialization conflict detection uses numeric identity across both reference spellings', () => {
  for (const initial of [{0: ['Q0', 'Q0Left'], 1: []}, {0: ['Q0Left'], 1: ['Q0']}]) {
    const model = compileModel(rawModel([{id: 'Q0Left', ex: 'K(X0)'}, {id: 'Q1', ex: 'J0K(Q0)'}], initial));
    assert.equal(model.valid.length, 0);
    assert.ok(model.nodes[0].errors.some(e => /重复|冲突/.test(e)));
  }
});

test('source aliases deduplicate arrival notifications but retain both J/K operations and EX totals', () => {
  const model = compileModel(rawModel([
    {id: 'Q0Left', ex: 'J0K(X0)'},
    {id: 'Q1Right', ex: 'J0K(Q0)K(Q0Left)'},
  ], undefined, [{Y0: 'Q1Right'}, {Y1: 'Q1'}]));
  const engine = new JKEngine(model);
  assert.deepEqual(model.nodes[1].sources, ['Q0']);
  assert.deepEqual(model.nodes[1].required, ['Q0']);
  assert.equal(model.targets.get('Q0').length, 1);
  for (let round = 1; round <= 2; round++) {
    engine.send({X0: 1});
    const first = engine.step();
    assert.deepEqual(first.transfers, [{source: 'Q0', target: 'Q1', value: 1, ready: true}]);
    assert.equal(engine.length, 1);
    assert.deepEqual(engine.itemAt(0).values, {Q0: 1});
    const second = engine.step();
    assert.deepEqual(second.reads, {Q0: 1});
    assert.deepEqual(second.operations.map(o => o.token), ['J0', 'K(Q0)', 'K(Q0Left)']);
    assert.equal(second.value, 0);
    assert.equal(engine.length, 0);
    assert.equal(engine.total, round * 2);
    assert.equal(engine.exTotal, round * 5);
    assert.deepEqual([...engine.outputs], [['Y0', 0], ['Y1', 0]]);
  }
});

test('huge numeric IDs preserve constant and same-source FIFO sorting regardless of tag', () => {
  const high = '9007199254740993', low = '9007199254740992';
  const model = compileModel(rawModel([
    {id: `Q${high}A`, ex: 'J0K(X0)'}, {id: 'Q10A', ex: 'J0K1'},
    {id: `Q${low}Z`, ex: 'J0K(X0)'}, {id: 'Q2Z', ex: 'J0K1'},
    {id: 'Q1Last', ex: 'J0K(X0)'},
  ]));
  const engine = new JKEngine(model);
  assert.deepEqual([engine.itemAt(0).node.id, engine.itemAt(1).node.id], ['Q2', 'Q10']);
  engine.send({X0: 1});
  assert.deepEqual(drain(engine).map(e => e.node), ['Q2', 'Q10', 'Q1', `Q${low}`, `Q${high}`]);
  assert.ok(order(`Q${low}Z`, `Q${high}A`) < 0);
  assert.equal(order('Q215L9B8', 'Q215L9B7'), 0);
});

const feedbackModel = encoding => {
  const tags = {Q30: 'Read', Q10: 'Input', Q2: 'Loop'};
  const ref = id => encoding === 'legacy' ? id + tags[id] : id;
  return rawModel([
    {id: ref('Q30'), ...(encoding === 'field' ? {tag: tags.Q30} : {}), ex: `J0K(X1)K(${ref('Q10')})`},
    {id: ref('Q10'), ...(encoding === 'field' ? {tag: tags.Q10} : {}), ex: 'K(X0)'},
    {id: ref('Q2'), ...(encoding === 'field' ? {tag: tags.Q2} : {}), ex: `J(${ref('Q10')})K(${ref('Q2')})K1`},
  ], {0: [ref('Q10'), ref('Q2')], 1: []}, [{Y0: ref('Q2')}, {Y3: ref('Q30')}]);
};
const eventState = event => ({...event, operations: event.operations?.map(({before, input, after}) => ({before, input, after}))});
const engineState = engine => ({
  total: engine.total, exTotal: engine.exTotal, q: [...engine.q], latest: [...engine.latest],
  outputs: [...engine.outputs], counts: [...engine.counts],
  cache: [...engine.cache].map(([key, values]) => [key, [...values]]),
  queue: Array.from({length: engine.length}, (_, index) => {
    const item = engine.itemAt(index); return {ticket: item.ticket, node: item.node.id, values: item.values};
  }),
  history: engine.history.map(eventState),
});

test('all ID representations preserve stateful feedback, partial and repeated sends in every playback mode', () => {
  let reference;
  for (const encoding of ['bare', 'field', 'legacy']) for (const mode of ['normal', 'skip', 'step']) {
    const engine = new JKEngine(compileModel(feedbackModel(encoding)));
    assert.equal(engine.model.valid.length, 3);
    let stopAt = 6;
    const playback = new Playback(engine, {now: () => 0, onChange: event => {
      if (event?.type === 'execution' && engine.total === stopAt) playback.pause();
    }});
    playback.skip = mode === 'skip';
    const rounds = [];
    for (const inputs of [[{X0: 0}, {X1: 1}], [{X0: 1, X1: 0}], [{X0: 1, X1: 0}]]) {
      for (const input of inputs) playback.send(input);
      playback.resume();
      for (let tick = 0; tick < 100 && engine.total < stopAt; tick++) {
        if (mode === 'step') playback.step(); else playback.tick(1);
      }
      assert.equal(engine.total, stopAt, `${encoding}/${mode}`);
      assert.equal(playback.running, false);
      const paused = engineState(engine); playback.tick(100);
      assert.deepEqual(engineState(engine), paused);
      rounds.push(paused); stopAt += 6;
    }
    assert.deepEqual(rounds[0].history.filter(e => e.type === 'execution').map(e => [e.node, e.value]), [
      ['Q10', 0], ['Q30', 1], ['Q2', 1], ['Q2', 0], ['Q2', 1], ['Q2', 0],
    ], 'independently worked first-round FIFO and state sequence');
    assert.equal(rounds[0].exTotal, 16, 'one input operation plus five three-operation executions');
    assert.equal(rounds[1].exTotal, 32);
    if (!reference) reference = rounds; else assert.deepEqual(rounds, reference, `${encoding}/${mode}`);
    playback.reset();
    assert.equal(engine.total, 0); assert.equal(engine.exTotal, 0); assert.equal(engine.length, 0);
    assert.deepEqual([...engine.q], [['Q10', 0], ['Q2', 0]]);
    assert.deepEqual([...engine.outputs], [['Y0', null], ['Y3', null]]);
  }
});

test('compile and display export preserve original fields, suffix spelling, expressions and MD5', () => {
  const raw = feedbackModel('legacy');
  raw.name = 'tag compatibility'; raw.md5 = 'retain-exact-original-md5'; raw.custom = {nested: ['keep']};
  raw.nodes[0].customNodeField = 'keep this too';
  const saved = structuredClone(raw);
  const freeze = value => {if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);} return value;};
  freeze(raw);
  const model = compileModel(raw);
  assert.equal(model.raw, raw);
  const display = defaultDisplay(1, 1); display.enabled = true;
  const exported = exportDisplayModel(model.raw, display);
  const {outputDisplay, ...original} = exported;
  assert.deepEqual(original, saved);
  assert.deepEqual(raw, saved);
  assert.deepEqual(outputDisplay, display);
  assert.deepEqual(compileModel(exported).nodes.map(n => [n.id, n.tag]), [['Q30', 'Read'], ['Q10', 'Input'], ['Q2', 'Loop']]);
});
