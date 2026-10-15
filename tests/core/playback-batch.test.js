import test from 'node:test';
import assert from 'node:assert/strict';
import {compileModel,JKEngine} from '../../src/jk/engine.js';
import {Playback} from '../../src/ui/playback.js';
const model=()=>compileModel({nodes:[{id:'Q0',ex:'J0K(X0)'}],initial_q:{0:['Q0'],1:[]},q_y:[{Y0:'Q0'}]});
function setup({steps=100,stepMs=1,changeMs=0,speed=1,...options}={}) {
 let clock=0;const engine=new JKEngine(model());
 for(let i=0;i<steps;i++)engine.send({X0:i%2});
 const original=engine.step.bind(engine);engine.step=()=>{clock+=stepMs;return original();};
 const changed=[],playback=new Playback(engine,{now:()=>clock,onChange:e=>{clock+=changeMs;if(e)changed.push(e);},...options});
 playback.speed=speed;playback.skip=true;return {engine,playback,changed,time:()=>clock};
}
const snapshot=e=>({total:e.total,eventTotal:e.eventTotal,exTotal:e.exTotal,q:[...e.q],latest:[...e.latest],outputs:[...e.outputs],cache:[...e.cache].map(([k,v])=>[k,[...v]]),queue:Array.from({length:e.length},(_,i)=>e.itemAt(i)),history:e.history});
test('speed-scaled budget includes callbacks and never interrupts atomic task execution',()=>{
 for(const [speed,budget] of [[.25,1],[1,4],[4,16]]) {
  const {engine,playback,changed,time}=setup({speed});playback.tick(.016);
  assert.equal(engine.total,budget);assert.equal(engine.eventTotal,budget);assert.equal(engine.length,100-budget);
  assert.equal(time(),budget);assert.equal(changed.length,budget);
  assert.deepEqual(changed.map(e=>e.executions[0].value),Array.from({length:budget},()=>1));
 }
 const slow=setup({stepMs:1,changeMs:2});slow.playback.tick(.016);assert.equal(slow.engine.eventTotal,2);assert.equal(slow.time(),6);
 const atomic=setup({stepMs:9,speed:.25});atomic.playback.tick(.016);assert.equal(atomic.engine.eventTotal,1);assert.equal(atomic.time(),9);
});
test('zero-resolution clock obeys task cap without a hidden source-event queue',()=>{
 const {engine,playback}=setup({steps:10005,stepMs:0});playback.tick(.016);assert.equal(engine.eventTotal,10000);
 playback.tick(.016);assert.equal(engine.eventTotal,10005);assert.equal(engine.total,10005);assert.equal(engine.length,0);
 const custom=setup({steps:10,stepMs:0,maxSkipSteps:3});custom.playback.tick(.016);assert.equal(custom.engine.eventTotal,3);
});
test('paused sends update Xi and retain every task without display-record limits',()=>{
 const engine=new JKEngine(model()),shown=[],p=new Playback(engine,{now:()=>0,onVisual:e=>shown.push(e)});p.pause();
 for(let i=0;i<805;i++)p.send({X0:i%2});
 assert.equal(engine.length,805);assert.equal(engine.total,0);assert.equal(engine.latest.get('X0'),0);assert.equal(p.visuals.length,0);
 p.step();assert.equal(engine.total,1);assert.equal(p.running,false);
 const before=snapshot(engine);p.skip=true;assert.deepEqual(snapshot(engine),before);
 p.resume();p.tick(.016);assert.equal(engine.length,0);assert.equal(engine.total,805);assert.equal(shown.at(-1),null);
});
test('animation, skip and single-step consume identical FIFO traces',()=>{
 const graph=compileModel({nodes:[{id:'Q0',ex:'J0K(X0)'},{id:'Q1',ex:'J0K(Q0)'},{id:'Q2',ex:'J0K(Q0)'},{id:'Q3',ex:'J0K(Q1)K(Q2)'}],initial_q:{0:['Q0'],1:[]},q_y:[{Y0:'Q3'}]});
 const direct=new JKEngine(graph);for(const v of [1,1,0])direct.send({X0:v});const expected=[];while(direct.length)expected.push(direct.step());
 for(const mode of ['skip','animation','step']) {
  const engine=new JKEngine(graph),observed=[],p=new Playback(engine,{now:()=>0,onChange:e=>{if(e?.type==='task')observed.push(e);}});
  for(const v of [1,1,0])p.send({X0:v});p.skip=mode==='skip';
  for(let i=0;engine.length&&i<200;i++)mode==='step'?p.step():p.tick(1);
  assert.deepEqual(observed,expected,mode);assert.deepEqual(snapshot(engine),snapshot(direct),mode);
 }
});
test('callbacks pause, reset or change modes only between tasks',()=>{
 for(const action of ['pause','reset','mode']) {
  const {engine,playback:p}=setup({steps:4,stepMs:0});let called=false;
  p.onChange=e=>{if(!e||called)return;called=true;if(action==='pause')p.pause();if(action==='reset'){p.reset();p.send({X0:1});p.resume();}if(action==='mode')p.skip=false;};
  p.tick(.016);assert.equal(engine.total,action==='reset'?0:1);assert.equal(engine.eventTotal,action==='reset'?0:1);
  if(action==='pause')assert.equal(p.running,false);p.skip=true;p.resume();p.tick(.016);assert.equal(engine.length,0);
 }
});
test('failing step or observer pauses without retry; reentrant ticks cannot multiply work',()=>{
 for(const where of ['step','observer']) {
  const {engine,playback:p}=setup({steps:4,stepMs:0});const original=engine.step.bind(engine);let calls=0;
  if(where==='step')engine.step=()=>{if(++calls===2)throw Error('failure');return original();};else p.onChange=()=>{if(++calls===2)throw Error('failure');};
  assert.throws(()=>p.tick(.016),/failure/);assert.equal(p.running,false);const done=engine.eventTotal;p.tick(.016);assert.equal(engine.eventTotal,done);
  engine.step=original;p.onChange=()=>{};p.resume();p.tick(.016);assert.equal(engine.total,4);assert.equal(engine.length,0);
 }
 const {engine,playback:p}=setup({steps:5,stepMs:0,maxSkipSteps:2});let n=0;p.onChange=()=>{n++;p.tick(.016);};p.tick(.016);assert.equal(engine.eventTotal,2);assert.equal(n,2);
});
test('idle frames and invalid scheduler options',()=>{
 const engine=new JKEngine(model());let n=0;const p=new Playback(engine,{onChange:()=>n++});p.skip=true;p.tick(1);assert.equal(n,0);
 for(const v of [0,-1,NaN,Infinity,'4'])assert.throws(()=>new Playback(engine,{skipBudgetMs:v}));
 for(const v of [0,-1,1.5,NaN,Infinity])assert.throws(()=>new Playback(engine,{maxSkipSteps:v}));assert.throws(()=>new Playback(engine,{now:0}),/时钟函数/);
});
