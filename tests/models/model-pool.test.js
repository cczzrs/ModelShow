import test from 'node:test';
import assert from 'node:assert/strict';
import {serializeModel,compileSnapshot} from '../../src/jk/model-schema.js';
import {compileModel} from '../../src/jk/engine.js';
import {parseModelPool, defaultPoolEntry, mutateModelPool} from '../../src/jk/model-pool.js';
import {defaultDisplay} from '../../src/ui/output-display.js';

const dates = ['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', '2026-09-03T00:00:00.000Z'];
const model = () => serializeModel({name: '原始模型', nodes: [{id: 'Q0', ex: 'J0K(X0)'}], initial_q: {0: ['Q0'], 1: []}, q_y: [{Y0: 'Q0'}]}, {createdAt:'2026-10-02T00:1790899200000000000'});
const entry = (id, time = dates[0], permanent = false) => ({id, createdAt: time, promotedAt: permanent ? time : null, model: model()});
const empty = () => ({version: 1, revision: 0, temporary: [], permanent: []});
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };
const status = expected => error => error.status === expected && typeof error.message === 'string';

test('single legacy seed and old snapshots are rejected without rewriting data', () => {
 const raw=freeze(model());assert.throws(()=>parseModelPool(raw),status(400));
 const old={...model(),format:'jk-logic-structure-V3.1.0'};
 assert.throws(()=>parseModelPool({...empty(),permanent:[{...entry('old',dates[0],true),model:old}]}),status(400));
 assert.throws(()=>mutateModelPool(empty(),{revision:0,action:'import',model:old}),status(400));
});

test('latest permanent promotion is preferred over newer temporary imports, with array-order tie breaks', () => {
  const pool = {...empty(), temporary: [entry('temp', dates[2])], permanent: [entry('p1', dates[0], true), entry('p2', dates[1], true), entry('p3', dates[1], true)]};
  pool.permanent[0].createdAt = dates[2];
  assert.equal(defaultPoolEntry(parseModelPool(pool)).id, 'p3');
  pool.permanent = [];
  pool.temporary.push(entry('older', dates[0]), entry('last', dates[2]));
  assert.equal(defaultPoolEntry(parseModelPool(pool)).id, 'last');
  assert.equal(defaultPoolEntry(empty()), null);
});

test('import, promote, idempotent promotion, and deletion maintain groups, timestamps, revisions and selection', () => {
  let result = mutateModelPool(empty(), {revision: 0, action: 'import', model: model()}, {id: 'temp', now: dates[0]});
  assert.equal(result.pool.revision, 1);
  assert.equal(result.selectedId, 'temp');
  assert.equal(result.pool.temporary[0].promotedAt, null);
  result = mutateModelPool(result.pool, {revision: 1, action: 'promote', id: 'temp'}, {now: dates[1]});
  assert.equal(result.pool.revision, 2);
  assert.equal(result.selectedId, 'temp');
  assert.equal(result.pool.temporary.length, 0);
  assert.equal(result.pool.permanent[0].createdAt, dates[0]);
  assert.equal(result.pool.permanent[0].promotedAt, dates[1]);
  const promoted = result.pool;
  result = mutateModelPool(promoted, {revision: 2, action: 'promote', id: 'temp'}, {now: dates[2]});
  assert.deepEqual(result.pool, promoted, 'repeated promotion must not reorder or bump revision');
  result = mutateModelPool(result.pool, {revision: 2, action: 'import', model: model()}, {id: 'next', now: dates[2]});
  assert.equal(defaultPoolEntry(result.pool).id, 'temp');
  result = mutateModelPool(result.pool, {revision: 3, action: 'delete', id: 'temp'});
  assert.equal(result.selectedId, 'next');
  result = mutateModelPool(result.pool, {revision: 4, action: 'delete', id: 'next'});
  assert.equal(result.selectedId, null);
  assert.deepEqual(result.pool, {...empty(), revision: 5});
});

test('deleting a temporary entry selects the latest remaining permanent entry', () => {
  const pool = {...empty(), permanent: [entry('p', dates[0], true)], temporary: [entry('t', dates[2])]};
  const result = mutateModelPool(pool, {revision: 0, action: 'delete', id: 't'});
  assert.equal(result.selectedId, 'p');
  assert.equal(result.pool.revision, 1);
});

test('pool parsing and every mutation clone nested models without altering input data', () => {
  const source = freeze({...empty(), permanent: [entry('p', dates[0], true)], temporary: [entry('t')]});
  const before = JSON.stringify(source);
  const raw = freeze(model());
  const command = freeze({action: 'import', revision: 0, model: raw});
  for (const result of [
    {pool: parseModelPool(source)},
    mutateModelPool(source, command, {id: 'new', now: dates[2]}),
    mutateModelPool(source, {action: 'promote', revision: 0, id: 't'}, {now: dates[2]}),
    mutateModelPool(source, {action: 'promote', revision: 0, id: 'p'}),
    mutateModelPool(source, {action: 'delete', revision: 0, id: 't'}),
  ]) {
    assert.notEqual(result.pool, source);
    result.pool.permanent[0].model.nodes[0].ex = "changed";
    assert.equal(JSON.stringify(source), before);
  }
  assert.deepEqual(raw, model());
});

test('model pool import, promotion and JSON reload preserve the embedded board independently',()=>{
 const raw=model();raw.display.outputBoard=defaultDisplay(1,2);raw.display.outputBoard.enabled=true;
 raw.display.outputBoard.pixels[1].channels.b={kind:'bits',bits:['Y0'],order:'lsb-first',mapping:'scale'};
 const imported=mutateModelPool(empty(),{revision:0,action:'import',model:raw},{id:'board',now:dates[0]});
 const promoted=mutateModelPool(imported.pool,{revision:1,action:'promote',id:'board'},{now:dates[1]});
 const restored=parseModelPool(JSON.parse(JSON.stringify(promoted.pool)));
 assert.deepEqual(defaultPoolEntry(restored).model,raw);
 restored.permanent[0].model.display.outputBoard.pixels[1].channels.b.bits.push('Y1');
 assert.deepEqual(promoted.pool.permanent[0].model,raw);
 assert.deepEqual(imported.pool.temporary[0].model,raw);
 const invalid=structuredClone(raw);invalid.display.outputBoard.rows=0;
 assert.throws(()=>mutateModelPool(empty(),{revision:0,action:'import',model:invalid}),status(400));
});

test('public pool rejects illegal nodes, incomplete snapshots and bad metadata without mutation',()=>{
 const anomalous={...model(),nodes:[{id:'Q0',ex:'J0'}]},emptyPool=empty();
 for(const invalid of [anomalous,null,[],{}, {...model(),nodes:{}}, {...model(),q_y:{}}, {...model(),initial_q:{0:[]}}, {...model(),md5:'0'.repeat(32)}]){
  assert.throws(()=>parseModelPool(invalid),status(400));assert.throws(()=>mutateModelPool(emptyPool,{revision:0,action:'import',model:invalid}),status(400));
 }
 assert.deepEqual(emptyPool,empty());
});
test('pool schema rejects unsupported versions, revisions, missing groups, duplicate IDs and invalid dates', () => {
  const invalid = [
    {...empty(), version: 2}, {...empty(), revision: -1}, {...empty(), revision: 0.5}, {...empty(), revision: Number.MAX_SAFE_INTEGER + 1},
    {version: 1, revision: 0, temporary: []}, {...empty(), permanent: {}},
    {...empty(), temporary: [entry('same')], permanent: [entry('same', dates[0], true)]},
    {...empty(), temporary: [entry('')]}, {...empty(), temporary: [entry('  ')]},
    {...empty(), temporary: [entry('bad', '2026-02-30T00:00:00.000Z')]},
    {...empty(), temporary: [entry('bad', '2026')]},
    {...empty(), temporary: [entry('bad', `${dates[0]}\n`)]},
    {...empty(), temporary: [entry('bad', '2026-09-01T24:00:00.000Z')]},
    {...empty(), temporary: [entry('bad', dates[0], true)]},
    {...empty(), permanent: [entry('bad')]},
    {...empty(), permanent: [{...entry('bad', dates[0], true), model: {}}]},
  ];
  for (const value of invalid) assert.throws(() => parseModelPool(value), status(400), JSON.stringify(value));
});

test('stale revisions never mutate and are checked even for an otherwise idempotent promotion', () => {
  const pool = freeze({...empty(), revision: 4, permanent: [entry('p', dates[0], true)]});
  for (const action of ['import', 'promote', 'delete']) assert.throws(() => mutateModelPool(pool, {revision: 3, action, id: 'p', model: model()}), status(409));
  assert.equal(pool.revision, 4);
  assert.equal(pool.permanent.length, 1);
});

test('malformed commands, missing entries, ID collisions, and revision overflow receive explicit status errors', () => {
  for (const command of [null, [], {}, {action: 'import'}, {revision: '0', action: 'import'}, {revision: 0, action: 'unknown'}, {revision: 0, action: 'delete'}, {revision: 0, action: 'promote', id: ''}]) {
    assert.throws(() => mutateModelPool(empty(), command), status(400));
  }
  for (const action of ['delete', 'promote']) assert.throws(() => mutateModelPool(empty(), {revision: 0, action, id: 'missing'}), status(404));
  const pool = {...empty(), temporary: [entry('existing')]};
  assert.throws(() => mutateModelPool(pool, {revision: 0, action: 'import', model: model()}, {id: 'existing'}), status(400));
  assert.throws(() => mutateModelPool(pool, {revision: 0, action: 'import', model: model()}, {id: 'new', now: 'yesterday'}), status(400));
  assert.throws(() => mutateModelPool({...pool, revision: Number.MAX_SAFE_INTEGER}, {revision: Number.MAX_SAFE_INTEGER, action: 'delete', id: 'existing'}), status(400));
  assert.equal(pool.temporary.length, 1);
});

test('timestamps compare real instants and injected times are normalized to UTC', () => {
  const pool = {...empty(), permanent: [entry('utc', '2026-09-01T10:00:00Z', true), entry('offset', '2026-09-01T09:00:00-02:00', true)]};
  assert.equal(defaultPoolEntry(parseModelPool(pool)).id, 'offset');
  const result = mutateModelPool(empty(), {revision: 0, action: 'import', model: model()}, {id: 't', now: '2026-09-01T09:00:00-02:00'});
  assert.equal(result.pool.temporary[0].createdAt, '2026-09-01T11:00:00.000Z');
});

test('non-JSON values are rejected rather than silently losing raw model fields', () => {
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), () => 1]) assert.throws(() => parseModelPool({...model(), custom: value}), status(400));
  const circular = model(); circular.self = circular;
  assert.throws(() => parseModelPool(circular), status(400));
  const shared = {deep: [1]};
  const pool=parseModelPool({...empty(),a:shared,b:shared});
  assert.deepEqual(pool.a,pool.b,'shared pool metadata references are not cycles');
  assert.notEqual(pool.a,shared);
});
