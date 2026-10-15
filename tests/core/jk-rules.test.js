import test from 'node:test';
import assert from 'node:assert/strict';
import {engineFor,drain} from '../helpers/v4-model.js';

test('two stateful arrivals form two ordinary tasks with execution-time state reads',()=>{
 const e=engineFor(['J0K(X0)','J0K(X1)','K(Q0)K(Q1)'],{0:['Q0','Q1','Q2'],1:[]});
 e.send({X0:1,X1:1});const trace=drain(e);
 assert.deepEqual(trace.map(t=>t.node),['Q0','Q1','Q2','Q2']);
 assert.deepEqual(trace.flatMap(t=>t.outputChanges.map(c=>c.value)),[0,0]);
});
test('barrier locks each complete group and clears immediately; older tasks cannot clear next group',()=>{
 const e=engineFor(['J0K(X0)','J0K(X1)','J0K(Q0)','J0K(Q1)','J0K(Q2)K(Q3)'],{0:['Q0','Q1'],1:[]});
 e.send({X0:1,X1:0});for(let i=0;i<4;i++)e.step();
 assert.deepEqual(e.itemAt(0).arrivals,{Q2:1,Q3:0});assert.equal(e.cache.get('node-4').size,0);
 e.send({X0:0});e.step(); // leaves Q4 before Q2
 assert.equal(e.step().executions[0].value,1);
 e.step();assert.deepEqual([...e.cache.get('node-4')],[['Q2',0]]);
 e.send({X0:1});drain(e);assert.deepEqual([...e.cache.get('node-4')],[['Q2',1]]);
 e.send({X1:1});assert.equal(drain(e).at(-1).executions[0].value,0);
});
test('each fanout target owns its barrier; stateful notifications do not trigger a mixed target',()=>{
 const e=engineFor(['J0K(X0)','J0K(X1)','J0K(Q0)','J0K(Q1)','J0K(Q2)K(Q3)K(Q0)','J0K(Q2)K(Q3)'],{0:['Q0','Q1'],1:[]},[{Y0:'Q4'},{Y1:'Q5'}]);
 e.send({X0:1});drain(e);assert.equal(e.counts.get('node-4'),0);
 assert.deepEqual([...e.cache.get('node-4')],[['Q2',1]]);assert.deepEqual([...e.cache.get('node-5')],[['Q2',1]]);
 e.send({X1:0});drain(e);assert.equal(e.outputs.get('Y0'),0);assert.equal(e.outputs.get('Y1'),1);
});
test('four pro conditions commit state and publish solely from final q, including repeated values',()=>{
 for(const [pro,expected] of [['q=0/1',[1,0,0]],['q=0',[0,0]],['q=1',[1]],['q=',[]]]){
  const e=engineFor(['J0K(X0)',{ex:'K(Q0)',pro},'J0K(Q1)'],{0:['Q0','Q1'],1:[]});
  const events=[];for(const value of [1,1,0]){e.send({X0:value});events.push(...drain(e).flatMap(t=>t.outputChanges.map(c=>c.value)));}
  assert.deepEqual(events,expected,pro);assert.equal(e.q.get('Q1'),0);assert.equal(e.counts.get('node-1'),3);
 }
});
test('silent state is readable through another trigger and never directly bound to Yi',()=>{
 const e=engineFor(['J0K(X0)',{ex:'K(Q0)',pro:'q='},'J0K(Q0)K(Q1)'],{0:['Q0','Q1'],1:[]});
 const outputs=[];for(const v of [1,1,0]){e.send({X0:v});outputs.push(...drain(e).flatMap(t=>t.outputChanges.map(c=>c.value)));}
 assert.deepEqual(outputs,[0,1,0]);
});
test('filtered stateless events do not fill barriers or repeat previous Yi output',()=>{
 const e=engineFor(['J0K(X0)','J0K(X1)',{ex:'J0K(Q0)',pro:'q=1'},'J0K(Q1)','J0K1J(Q2)J(Q3)'],{0:['Q0','Q1'],1:[]});
 e.send({X0:1,X1:1});assert.deepEqual(drain(e).flatMap(t=>t.outputChanges.map(c=>c.value)),[1]);
 e.send({X0:0,X1:0});assert.deepEqual(drain(e).flatMap(t=>t.outputChanges),[]);
 assert.equal(e.outputs.get('Y0'),1);assert.deepEqual([...e.cache.get('node-4')],[['Q3',0]]);
});
test('stateful self reads are fixed at task start and do not trigger the same node',()=>{
 const e=engineFor(['J0K(X0)','J0K(Q1)K1K(Q1)K(Q0)'],{0:['Q0'],1:['Q1']});
 e.send({X0:0});const trace=drain(e);assert.equal(trace.length,2);
 assert.equal(e.q.get('Q1'),1);assert.deepEqual(trace[1].executions[0].reads,{Q1:1,Q0:0});
});
