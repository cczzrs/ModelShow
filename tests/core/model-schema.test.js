import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {compileSnapshot,compileModel,serializeModel,modelFingerprints,canonicalJson} from '../../src/jk/model-schema.js';
import {JKEngine} from '../../src/jk/engine.js';
import {defaultDisplay} from '../../src/ui/output-display.js';
import {structure,snapshot,engineFor,drain,timestamp} from '../helpers/v4-model.js';
const official=()=>JSON.parse(readFileSync(new URL('../fixtures/jk-logic-structure-v4.json',import.meta.url)));
const digest = v=>createHash('md5').update(canonicalJson(v),'utf8').digest('hex');

test('central JKRD snapshot matches both published MD5 vectors without conversion',()=>{
 const raw=official();assert.deepEqual(compileSnapshot(raw).raw,raw);
 assert.deepEqual(modelFingerprints(raw),{format_md5:'57891bd07d782ead902e6109079627e0',md5:'5085a0e5acaea6806c007fd3421327f7'});
 const {format,nodes,initial_q,q_y,FIFOS,created_at}=raw;
 assert.equal(raw.format_md5,digest({format,nodes,initial_q,q_y}));assert.equal(raw.md5,digest({format,nodes,initial_q,q_y,FIFOS,created_at}));
});
test('old versions, old fields, missing queues, unknown fields and old task wrappers are rejected',()=>{
 const cases=[r=>r.format='jk-logic-structure-V3.1.0',r=>delete r.format,r=>delete r.FIFOS,r=>r.nodes[0].propagation='q=0/1',r=>r.nodes[0].tag='A',r=>r.outputDisplay={},r=>r.extra=1,r=>r.display.extra=1,r=>r.FIFOS['Xi.FIFO']=[{target:'Q0',data:{}}],r=>r.FIFOS.extra=[],r=>delete r.FIFOS['Qi.FIFO']];
 for(const change of cases){const raw=official();change(raw);assert.throws(()=>compileSnapshot(raw));}
 const incomplete=official();delete incomplete.format;assert.throws(()=>serializeModel(incomplete));
 const legacy=JSON.parse(readFileSync(new URL('../fixtures/jk-logic-structure-v262.json',import.meta.url)));
 assert.throws(()=>compileSnapshot(legacy));assert.throws(()=>serializeModel(legacy));
});
test('input copies, all-source DAG, stateless self-reference and references are enforced',()=>{
 const cases=[
 structure(['K(X0)']),structure(['J0K(X0)'],{0:[],1:[]}),
 structure(['J0K(X0)','J0K(X0)']),
 structure(['J0K(X0)','J0K(Q0)K(Q2)','K(Q1)'],{0:['Q0','Q2'],1:[]}),
 structure(['J0K(X0)','J0K(Q0)K(Q1)']),structure(['J0K(X0)','J0K1']),
 structure(['J0K(X0)','K(Q1)'],{0:['Q0','Q1'],1:[]}),
 structure(['J0K(X0)','J0K(Q0)'],{0:['Q0'],1:[]},[{Y0:'Q0'}]),
 structure([{ex:'J0K(X0)',pro:'q=1'}]),structure([{ex:'J0K(X0)',pro:'q='}]),
 structure(['J0K(X0)',{ex:'J0K(Q0)',pro:'q='}]),
 ];
 for(const raw of cases){assert.equal(compileModel(raw).canExecute,false);assert.throws(()=>serializeModel(raw));}
 const forward=structure(['J0K(X0)','J0K(Q2)','J0K(Q0)'],{0:['Q0','Q2'],1:[]},[{Y0:'Q1'}]);
 assert.equal(compileSnapshot(snapshot(forward)).canExecute,true,'acyclic forward state reads are legal');
});
test('statistics count unique external sources excluding self; every token is an operation',()=>{
 const raw=snapshot(structure(['J0K(X0)','J0K(Q0)K(Q0)K(Q1)'],{0:['Q0','Q1'],1:[]}));
 assert.equal(raw.ex_source_max,1);assert.equal(raw.ex_source_sum,2);assert.equal(raw.ex_operation_sum,6);
 for(const change of [r=>r.ex_source_sum++,r=>r.jk_bits_max=1,r=>r.input_bits=2,r=>r.inputs=[{X0:'X1'}],r=>r.initial_q[1].push('Q0'),r=>r.nodes[0].id='Q00']){const bad=structuredClone(raw);change(bad);assert.throws(()=>compileSnapshot(bad));}
});
test('queue membership, latch keys, bit types and task shape cannot bypass structural validation by hashing',()=>{
 const changes=[r=>r.FIFOS['Xi.FIFO']=[{Q2:{}}],r=>r.FIFOS['Qi.FIFO']=[{Q0:{}}],r=>r.FIFOS['Qi.FIFO']=[{Q4:{Q2:1}}],r=>r.FIFOS['Qi.FIFO']=[{Q4:{Q2:true,Q3:0}}],r=>r.FIFOS['Qi.FIFO']=[{Q4:{Q0:0,Q2:1,Q3:0}}],r=>r.FIFOS['Qi.FIFO']=[{Q99:{}}],r=>r.FIFOS['Qi.FIFO']=[{Q2:{},Q3:{}}]];
 for(const change of changes){const r=official();change(r);Object.assign(r,modelFingerprints(r));assert.throws(()=>compileSnapshot(r));}
});
test('fingerprints cover state values, queue order, repetitions and time with normalized default pro',()=>{
 const raw=official();
 for(const field of ['queue','time','state']){
 const r=structuredClone(raw);if(field==='queue')r.FIFOS['Qi.FIFO'].reverse();if(field==='time')r.created_at='2026-10-08T00:1791417600000000001';if(field==='state'){r.initial_q[0].push('Q4');r.initial_q[1]=[];}
 assert.notEqual(modelFingerprints(r).md5,raw.md5);assert.equal(modelFingerprints(r).format_md5===raw.format_md5,field!=='state');assert.throws(()=>compileSnapshot(r));
 }
 const explicit=official();explicit.nodes[0].pro='q=0/1';assert.deepEqual(compileSnapshot(explicit).raw,raw);
 for(const change of [r=>r.name='改名',r=>r.display.show='3D']){const r=official();change(r);assert.deepEqual(modelFingerprints(r),modelFingerprints(raw));assert.doesNotThrow(()=>compileSnapshot(r));}
});
test('display.outputBoard round trips without changing either JK fingerprint or requiring a board',()=>{
 const raw=official(),board=defaultDisplay(1,2);board.enabled=true;board.scale=2.5;
 board.pixels[0].channels.r={kind:'bits',bits:['Y0'],order:'lsb-first',mapping:'scale'};
 const saved=serializeModel(raw,{outputBoard:board});
 assert.deepEqual(saved.display,{show:raw.display.show,outputBoard:board});
 assert.deepEqual(modelFingerprints(saved),modelFingerprints(raw));
 assert.equal(saved.md5,raw.md5);assert.equal(saved.format_md5,raw.format_md5);
 assert.deepEqual(compileSnapshot(JSON.parse(JSON.stringify(saved))).raw,saved);
 assert.deepEqual(serializeModel(saved),saved,'existing snapshot board is preserved');
 assert.equal(Object.hasOwn(compileSnapshot(raw).raw.display,'outputBoard'),false,'standard snapshots may omit the ModelShow extension');
 const loaded=compileSnapshot(saved).raw;loaded.display.outputBoard.pixels[0].channels.r.bits.push('Y1');
 assert.deepEqual(saved.display.outputBoard.pixels[0].channels.r.bits,['Y0']);
 saved.display.outputBoard.pixels[0].channels.r.bits.push('Y2');
 assert.deepEqual(board.pixels[0].channels.r.bits,['Y0']);
});
test('invalid embedded output boards block loading and export even though display is outside fingerprints',()=>{
 const boards=[null,{}, {...defaultDisplay(),rows:0}, {...defaultDisplay(),scale:undefined}, {...defaultDisplay(),pixels:[]}];
 for(const board of boards){
  const raw=official();raw.display.outputBoard=board;
  assert.deepEqual(modelFingerprints(raw),modelFingerprints(official()));
  assert.equal(compileModel(raw).canExecute,false);
  assert.throws(()=>compileSnapshot(raw),/display\.outputBoard/);
  assert.throws(()=>serializeModel(raw),/display\.outputBoard/);
  assert.throws(()=>serializeModel(official(),{outputBoard:board}));
 }
});
test('board export copies validated configuration and never mutates the supplied snapshot or options',()=>{
 const raw=official(),before=structuredClone(raw),board=defaultDisplay(1,1);
 board.extra='not a display setting';board.pixels[0].channels.r.extra='discarded';
 const saved=serializeModel(raw,{outputBoard:board});
 assert.equal(Object.hasOwn(saved.display.outputBoard,'extra'),false);
 assert.equal(Object.hasOwn(saved.display.outputBoard.pixels[0].channels.r,'extra'),false);
 assert.deepEqual(raw,before);assert.equal(board.extra,'not a display setting');
 saved.display.outputBoard.pixels[0].channels.r.value=123;
 assert.equal(board.pixels[0].channels.r.value,0);
});
test('restore retains queues and q, skips missing Xi without even executing J0, then uses saved latches',()=>{
 const e=new JKEngine(compileSnapshot(official()));assert.equal(e.total,0);assert.equal(e.outputs.get('Y0'),null);assert.equal(e.latest.has('X0'),false);
 const trace=drain(e);assert.deepEqual(trace.map(t=>[t.node,t.skipped]),[['Q0',true],['Q0',true],['Q4',false],['Q2',false]]);
 assert.equal(e.total,2);assert.deepEqual(trace.flatMap(t=>t.outputChanges.map(c=>c.value)),[0]);
 assert.equal(e.q.get('Q0'),0);assert.deepEqual(trace[2].executions[0].reads,{Q0:0,Q2:1,Q3:0});
});
test('new zero input before restored copies run is readable and preserves all three tasks',()=>{
 const e=new JKEngine(compileSnapshot(official()));e.send({X0:0});const trace=drain(e);
 assert.deepEqual(trace.slice(0,3).map(t=>[t.node,t.skipped]),[['Q0',false],['Q0',false],['Q0',false]]);assert.equal(e.counts.get('node-0'),3);
});
test('capture saves current q and pending tasks at one boundary, never Xi or partial arrivals',()=>{
 const e=engineFor(['J0K(X0)','J0K(X1)','J0K(Q0)','J0K(Q1)','J0K(Q2)K(Q3)'],{0:['Q0','Q1'],1:[]});
 e.send({X0:1});drain(e);e.send({X1:0});
 const saved=e.snapshot({createdAt:timestamp}),restored=new JKEngine(compileSnapshot(saved));
 assert.deepEqual(saved.FIFOS,{'Xi.FIFO':[{Q1:{}}],'Qi.FIFO':[]});assert.equal(restored.q.get('Q0'),1);
 assert.equal(restored.cache.get('node-4').size,0);assert.equal(restored.latest.size,0);assert.equal(restored.outputs.get('Y0'),null);
 assert.equal(restored.step().skipped,true);assert.deepEqual([...e.cache.get('node-4')],[['Q2',1]]);
});
