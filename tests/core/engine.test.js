import test from 'node:test';
import assert from 'node:assert/strict';
import {parseExpression} from '../../src/jk/model-schema.js';
import {engineFor,drain} from '../helpers/v4-model.js';

test('strict EX token parsing rejects whitespace, nesting, aliases and constants-only at validation',()=>{
 assert.equal(parseExpression('J0K1J(Q0)K(Q0)').length,4);
 for(const ex of ['',null,' J0','J0 K(X0)','J(K(Q0))','K(Q01)','K(Q0tag)'])assert.throws(()=>parseExpression(ex));
});
test('send immediately updates Xi in numeric order, never q; a step executes exactly one copy',()=>{
 const e=engineFor(['J0K(X0)','J0K(X1)','J0K(Q0)K(Q1)'],{0:['Q0','Q1'],1:[]});
 assert.equal(e.latest.has('X0'),false);assert.equal(e.outputs.get('Y0'),null);
 const sent=e.send({X1:1,X0:0});assert.deepEqual(sent.accepted,['X0','X1']);
 assert.deepEqual([...e.latest],[['X0',0],['X1',1]]);assert.equal(e.q.get('Q1'),0);
 assert.deepEqual(e.capture().fifos,{'Xi.FIFO':[{Q0:{}},{Q1:{}}],'Qi.FIFO':[]});
 assert.equal(e.step().node,'Q0');assert.equal(e.total,1);assert.equal(e.outputs.get('Y0'),null);
 assert.equal(e.step().node,'Q1');assert.equal(e.q.get('Q1'),1);
 assert.deepEqual(drain(e).map(t=>t.executions[0].value),[1,1]);
});
test('send rejects empty, unknown and invalid bits atomically',()=>{
 const e=engineFor(['J0K(X0)','J0K(X1)','J0K(Q0)K(Q1)'],{0:['Q0','Q1'],1:[]});
 for(const data of [{},{X2:1},{X0:1,X1:2},{X0:true},{X0:'1'},null]){assert.throws(()=>e.send(data));assert.equal(e.length,0);assert.equal(e.latest.size,0);}
});
test('duplicate pending copies read the latest Xi; equal tasks and zero outputs stay distinct',()=>{
 const e=engineFor();e.send({X0:1});e.send({X0:0});const trace=drain(e);
 assert.equal(trace.length,2);assert.deepEqual(trace.flatMap(t=>t.outputChanges.map(c=>c.value)),[0,0]);
 assert.equal(e.total,2);assert.equal(e.exTotal,4);
});
test('Xi.FIFO preempts older ordinary tasks, without interleaving a complete EX',()=>{
 const e=engineFor(['J0K(X0)','K(Q0)'],{0:['Q0','Q1'],1:[]});
 e.send({X0:1});e.step();assert.equal(e.itemAt(0).node,'Q1');
 e.send({X0:0});assert.equal(e.itemAt(0).node,'Q0');
 const trace=drain(e);assert.deepEqual(trace.map(t=>t.node),['Q0','Q1','Q1']);
 assert.deepEqual(trace.flatMap(t=>t.outputChanges.map(c=>c.value)),[0,0]);
});

test('fanout queues all targets in numeric order; never recursively executes them',()=>{
 const e=engineFor(['J0K(X0)','J0K(Q0)','J0K(Q0)','J0K(Q1)K(Q2)']);
 e.send({X0:1});const first=e.step();assert.equal(first.executions.length,1);
 assert.deepEqual(e.capture().fifos['Qi.FIFO'],[{Q1:{}},{Q2:{}}]);
 assert.deepEqual(drain(e).map(t=>t.node),['Q1','Q2','Q3']);
 assert.equal(e.outputs.get('Y0'),0);
});
test('input remains accepted while paused or with more than 10000 waiting tasks',()=>{
 const e=engineFor();for(let i=0;i<10005;i++)e.send({X0:i%2});
 assert.equal(e.length,10005);assert.equal(e.total,0);assert.equal(e.latest.get('X0'),0);
 e.step();assert.equal(e.length,10004);
});
