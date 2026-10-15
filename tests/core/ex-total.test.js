import test from 'node:test';
import assert from 'node:assert/strict';
import {engineFor,drain} from '../helpers/v4-model.js';
test('EX totals count complete operations including repeats and exclude sends, skips and outputs',()=>{
 const e=engineFor(['J0K(X0)','J0K(Q0)K(Q0)J1'],{0:['Q0'],1:[]},[{Y0:'Q1'},{Y1:'Q1'}]);
 e.send({X0:1});assert.equal(e.exTotal,0);const trace=drain(e);
 assert.equal(e.exTotal,6);assert.equal(e.total,2);assert.equal(e.eventTotal,2);assert.equal(trace.flatMap(t=>t.outputChanges).length,2);
 e.reset();assert.equal(e.exTotal,0);assert.equal(e.outputs.get('Y0'),null);
});
