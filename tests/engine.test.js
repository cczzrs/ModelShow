import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseExpression, compileModel, JKEngine } from '../src/engine.js';
import { Playback } from '../src/playback.js';
const make=(nodes,initial={'0':[],'1':[]},outputs=[])=>new JKEngine(compileModel({nodes:nodes.map(([id,ex])=>({id,ex})),initial_q:initial,q_y:outputs}));
const drain=e=>{const trace=[];while(e.length){assert.ok(trace.length<200,'unexpected nontermination');trace.push(e.step());}return trace;};
const example=()=>new JKEngine(compileModel(JSON.parse(readFileSync(new URL('../public/example.json',import.meta.url),'utf8'))));
test('parser consumes full expressions; rejects nested, empty and trailing invalid text',()=>{
 assert.equal(parseExpression(' J0 K1 J( X0 ) ').length,3);
 for(const ex of ['', 'J0x', 'J0J(J(X0))','J0K(X01)','J0;alert(1)','J0K2',null])assert.throws(()=>parseExpression(ex));
});
test('NAND and NOR truth tables, both initial states',()=>{
 for(const initial of [0,1])for(const a of [0,1])for(const b of [0,1]){
  const e=make([['Q0','J0K1J(X0)J(X1)K1'],['Q1','J0K1K(X0)J(X1)K1K(X0)']],{'0':initial===0?['Q0','Q1']:[],'1':initial===1?['Q0','Q1']:[]});
  e.send({X0:a,X1:b});drain(e);assert.equal(e.latest.get('Q0'),1-(a&b));assert.equal(e.latest.get('Q1'),1-(a|b));
 }
});
test('README example exact FIFO and outputs',()=>{
 const e=example();e.send({X0:1,X1:0,X2:1,X3:0});const events=drain(e);
 assert.deepEqual(events.map(e=>e.node),['Q0','Q1','Q3','Q2','Q5','Q4']);
 assert.deepEqual(Object.fromEntries(e.outputs),{Y0:1,Y1:1,Y2:1,Y3:1});assert.ok([...e.cache.values()].every(m=>m.size===0));
});
test('repeated triggers have immutable independent snapshots',()=>{
 const e=make([['Q0','J0K(X0)']]);e.send({X0:0});e.send({X0:1});assert.equal(e.length,2);
 assert.throws(()=>{e.itemAt(0).values.X0=1;},TypeError);
 assert.deepEqual(drain(e).map(e=>e.value),[0,1]);
});
test('partial arrivals persist and overwrite before ready',()=>{
 const e=make([['Q0','J0K(X0)K(X1)']]);e.send({X0:0});e.send({X0:1});assert.equal(e.length,0);e.send({X1:0});assert.equal(e.step().value,1);
 e.send({X1:1});assert.equal(e.length,0);assert.deepEqual(e.waiting(e.model.nodes[0]),['X0']);
});
test('duplicate token references create a single source notification',()=>{
 const e=make([['Q0','J0K(X0)K(X0)']]);const input=e.send({X0:1});assert.equal(input.transfers.length,1);assert.equal(e.length,1);assert.equal(e.step().value,0);
});
test('state references read latest q at execution, not at enqueue',()=>{
 const e=make([['Q0','K(X0)'],['Q1','J0K(X1)K(Q0)']],{'0':['Q0'],'1':[]});
 e.send({X0:1,X1:0});assert.equal(e.itemAt(1).values.Q0,undefined);assert.equal(e.step().value,1);const event=e.step();assert.equal(event.reads.Q0,1);assert.equal(event.value,1);
});
test('unchanged state-source publications still trigger nodes without arrival requirements',()=>{
 const e=make([['Q0','J0J(X0)'],['Q1','K(Q0)'],['Q2','K(Q1)']],{'0':['Q1','Q2'],'1':[]});
 e.send({X0:1});drain(e);e.send({X0:1});drain(e);assert.equal(e.counts.get('node-2'),2);
});
test('constants initialize once, initial q does not publish',()=>{
 const e=make([['Q0','J0K1'],['Q1','K(Q0)'],['Q2','K(Q1)']],{'0':['Q1','Q2'],'1':[]},[{Y0:'Q1'}]);
 assert.equal(e.length,1);assert.equal(e.outputs.get('Y0'),null);drain(e);assert.equal(e.total,3);assert.equal(e.outputs.get('Y0'),1);
 e.send({X9:1});assert.equal(e.length,0);e.reset();assert.equal(e.total,0);assert.equal(e.length,1);assert.equal(e.outputs.get('Y0'),null);
});
test('self-reference reads pre-write state and loops are preserved',()=>{
 const e=make([['Q0','K(X0)'],['Q1','K(Q0)K(Q1)']],{'0':['Q0','Q1'],'1':[]});
 e.send({X0:1});e.step();const first=e.step();assert.deepEqual(first.reads,{Q0:1,Q1:0});assert.equal(first.value,1);assert.equal(e.length,1);assert.equal(e.step().value,1);
});
test('numeric node sorting and input sorting',()=>{
 const e=make([['Q10','J0K(X2)'],['Q2','J0K(X2)'],['Q1','J0K(X10)']]);
 e.send({X10:0,X2:1});assert.deepEqual(drain(e).map(e=>e.node),['Q2','Q10','Q1']);
});
test('all matched input fields are validated before any mutation',()=>{
 const e=make([['Q0','J0K(X0)'],['Q1','J0K(X1)']]);
 for(const value of [2,null,true,'1']){assert.throws(()=>e.send({X0:1,X1:value}));assert.equal(e.length,0);assert.equal(e.latest.size,0);}
 assert.equal(e.send({unknown:'ignored'}).accepted.length,0);
});
test('duplicate IDs, invalid expressions and dependencies are blocked; independent nodes run',()=>{
 const e=make([['Q0','J0'],['Q0','J0K1'],['Q1','J0K(Q0)'],['Q2','J0K(Q1)'],['Q3','J0K(X0)'],['Q4','K(X1)']]);
 assert.equal(e.model.nodes.length,6);assert.equal(e.model.valid.length,1);assert.ok(e.model.nodes[2].errors[0].includes('依赖异常'));
 e.send({X0:1,X1:1});assert.deepEqual(drain(e).map(e=>e.node),['Q3']);
});
test('state initialization conflicts block dependent nodes',()=>{
 const e=make([['Q0','K(X0)'],['Q1','J0K(Q0)']],{'0':['Q0'],'1':['Q0']});assert.equal(e.model.valid.length,0);
});
test('missing references and invalid output mappings do not publish fake values',()=>{
 const e=make([['Q0','J0K(Q9)'],['Q1','J0K1']],undefined,[{Y0:'Q0'},{Y1:'Q1'},{Y1:'Q1'},{Y2:'Q99'}]);drain(e);
 assert.deepEqual(Object.fromEntries(e.outputs),{Y0:null,Y1:null,Y2:null});assert.ok(e.model.outputs.every(o=>o.error));
});
test('output aliases all receive a publication without adding executions',()=>{
 const e=make([['Q0','J0K(X0)']],undefined,[{Y0:'Q0'},{Y1:'Q0'}]);e.send({X0:1});drain(e);assert.equal(e.total,1);assert.deepEqual(Object.fromEntries(e.outputs),{Y0:1,Y1:1});
});
test('playback pause freezes animation and execution; input does not resume; step remains paused',()=>{
 const e=make([['Q0','J0K(X0)']]);const p=new Playback(e);p.pause();p.send({X0:1});p.tick(1);assert.equal(e.total,0);p.step();assert.equal(e.total,1);assert.equal(p.running,false);
 p.send({X0:0});p.resume();p.tick(.1);assert.ok(p.active);p.tick(.1);const progress=p.active.progress;p.pause();p.tick(10);assert.equal(p.active.progress,progress);
});
test('speed and skip preserve execution order and results',()=>{
 const run=(speed,skip)=>{const e=example(),p=new Playback(e);p.speed=speed;p.skip=skip;p.send({X0:1,X1:0,X2:1,X3:0});for(let i=0;i<1000&&(e.length||p.active||p.visuals.length);i++)p.tick(.1);return {trace:e.history.filter(e=>e.type==='execution').map(e=>[e.node,e.value]),out:Object.fromEntries(e.outputs)};};
 assert.deepEqual(run(.25,false),run(4,false));assert.deepEqual(run(1,false),run(1,true));
});
test('reset clears queued snapshots, history, outputs, counts and animation',()=>{
 const e=example(),p=new Playback(e);p.send({X0:1,X1:0,X2:1,X3:0});p.step();p.reset();assert.equal(e.total,0);assert.equal(e.length,0);assert.equal(e.history.length,0);assert.equal(p.running,false);assert.ok([...e.outputs.values()].every(x=>x===null));
});
test('queue protection pauses without losing existing items; histories are bounded',()=>{
 const e=make([['Q0','J0K(X0)']]);e.queueLimit=2;e.historyLimit=2;const p=new Playback(e);p.send({X0:0});p.send({X0:1});p.tick(.1);assert.equal(p.running,false);assert.equal(e.length,2);assert.throws(()=>p.send({X0:0}));assert.equal(p.step().value,0);assert.equal(p.step().value,1);assert.equal(e.history.length,2);
});
