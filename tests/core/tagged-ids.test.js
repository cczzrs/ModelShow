import test from 'node:test';
import assert from 'node:assert/strict';
import {parseJKId,order} from '../../src/jk/node-id.js';
import {compileModel} from '../../src/jk/model-schema.js';
import {structure} from '../helpers/v4-model.js';
test('V4 has fixed numeric identities; old suffixes and metadata are rejected',()=>{
 assert.deepEqual(parseJKId('Q215'),{id:'Q215',number:'215'});
 for(const id of ['Q215L9B7','Q01','Q0\n','q0'])assert.throws(()=>parseJKId(id));
 for(const node of [{id:'Q0L1',ex:'J0K(X0)'},{ex:'J0K(X0)',tag:'L1'}])assert.equal(compileModel(structure([node])).canExecute,false);
 assert.deepEqual(['Q10','Q2','Q0'].sort(order),['Q0','Q2','Q10']);
});
