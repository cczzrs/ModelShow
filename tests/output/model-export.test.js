import test from 'node:test';
import assert from 'node:assert/strict';
import {exportCurrentModel,compileSnapshot} from '../../src/jk/model-schema.js';
import {engineFor,drain} from '../helpers/v4-model.js';
import {defaultDisplay} from '../../src/ui/output-display.js';
test('live export retains pending task duplicates and current states, layout lives in display.show',()=>{
 const e=engineFor(['J0K(X0)','K(Q0)'],{0:['Q0','Q1'],1:[]});e.send({X0:1});e.step();e.send({X0:0});
 const board=defaultDisplay(1,2);board.enabled=true;board.scale=2.5;
 const raw=e.model.raw,saved=exportCurrentModel(structuredClone(raw),raw,e,'3D',board);
 assert.deepEqual(saved.initial_q,{0:['Q1'],1:['Q0']});assert.deepEqual(saved.FIFOS,{'Xi.FIFO':[{Q0:{}}],'Qi.FIFO':[{Q1:{}}]});
 assert.equal(saved.display.show,'3D');assert.equal(Object.hasOwn(saved,'outputDisplay'),false);assert.doesNotThrow(()=>compileSnapshot(saved));
 assert.deepEqual(saved.display.outputBoard,board);saved.display.outputBoard.pixels[0].channels.r.value=100;
 assert.equal(board.pixels[0].channels.r.value,0);assert.equal(Object.hasOwn(raw.display,'outputBoard'),false);
 assert.notEqual(saved.format_md5,raw.format_md5);assert.equal(e.length,2);
});
test('unimported draft retains its own states and queues; metadata tampering is rejected',()=>{
 const e=engineFor();e.send({X0:1});drain(e);const raw=e.model.raw,draft=structuredClone(raw);draft.name='draft';
 assert.deepEqual(exportCurrentModel(draft,raw,e).initial_q,raw.initial_q);
 draft.md5='0'.repeat(32);assert.throws(()=>exportCurrentModel(draft,raw,e),/md5/);
 const old=structuredClone(raw);old.format='jk-logic-structure-V3.1.0';old.nodes[0].ex='K(X0)';assert.throws(()=>exportCurrentModel(old,raw,e));
});
test('unimported name or display edits keep the draft board, state and queues instead of the live model',()=>{
 const e=engineFor();e.model.raw.display.outputBoard=defaultDisplay(1,1);
 e.send({X0:1});drain(e);e.send({X0:0});
 const raw=e.model.raw,applied=defaultDisplay(2,2);applied.enabled=true;
 for(const edit of [draft=>draft.name='renamed draft',draft=>draft.display.show='2D',draft=>draft.display.outputBoard.scale=2]){
  const draft=structuredClone(raw);edit(draft);
  const saved=exportCurrentModel(draft,raw,e,'1D',applied);
  assert.deepEqual(saved.display,draft.display);assert.deepEqual(saved.initial_q,draft.initial_q);
  assert.deepEqual(saved.FIFOS,draft.FIFOS);assert.equal(saved.md5,draft.md5);
 }
 const draft=structuredClone(raw);delete draft.display.outputBoard;
 assert.equal(Object.hasOwn(exportCurrentModel(draft,raw,e,'1D',applied).display,'outputBoard'),false);
});
test('live export replaces stored board with the latest applied configuration',()=>{
 const e=engineFor(),stored=defaultDisplay(1,1),applied=defaultDisplay(1,2);
 e.model.raw.display.outputBoard=stored;applied.enabled=true;
 const raw=e.model.raw,saved=exportCurrentModel(structuredClone(raw),raw,e,'4D',applied);
 assert.deepEqual(saved.display,{show:'4D',outputBoard:applied});
 assert.deepEqual(raw.display.outputBoard,stored);assert.equal(stored.cols,1);
 assert.deepEqual(exportCurrentModel(structuredClone(raw),raw,e).display.outputBoard,stored);
});

test('the manager JSON with only a synced board still captures live state and tasks',()=>{
 const e=engineFor(),raw=e.model.raw,board=defaultDisplay(1,1);
 board.enabled=true;board.pixels[0].channels.r.value=173;
 e.send({X0:1});drain(e);e.send({X0:0});
 const displayed=structuredClone(raw);displayed.display.outputBoard=structuredClone(board);
 const saved=exportCurrentModel(displayed,raw,e,'2D',board);
 assert.deepEqual(saved.initial_q,{0:[],1:['Q0']});
 assert.deepEqual(saved.FIFOS,{'Xi.FIFO':[{Q0:{}}],'Qi.FIFO':[]});
 assert.deepEqual(saved.display,{show:'2D',outputBoard:board});
 displayed.name='unimported edit';
 const draft=exportCurrentModel(displayed,raw,e,'2D',board);
 assert.deepEqual(draft.initial_q,raw.initial_q);assert.deepEqual(draft.FIFOS,raw.FIFOS);
 assert.equal(draft.name,'unimported edit');
});
