import test from 'node:test';
import assert from 'node:assert/strict';
import {compileModel,JKEngine} from '../src/engine.js';
import {Playback} from '../src/playback.js';

const model=(nodes,initial={0:[],1:[]},outputs=[])=>compileModel({nodes:nodes.map(([id,ex])=>({id,ex})),initial_q:initial,q_y:outputs});
const copyModel=()=>model([['Q0','J0K(X0)']],undefined,[{Y0:'Q0'}]);
function timedQueue({steps=100,stepMs=1,changeMs=0,speed=1,...options}={}){
 let clock=0;
 const engine=new JKEngine(copyModel(),{queueLimit:Math.max(steps+1,10000),historyLimit:steps+10});
 for(let i=0;i<steps;i++)engine.send({X0:i%2});
 const original=engine.step.bind(engine);engine.step=()=>{clock+=stepMs;return original();};
 const changed=[],playback=new Playback(engine,{now:()=>clock,onChange:event=>{clock+=changeMs;if(event)changed.push(event);},...options});
 playback.speed=speed;playback.skip=true;
 return {engine,playback,changed,time:()=>clock};
}
const snapshot=engine=>({total:engine.total,q:[...engine.q],latest:[...engine.latest],outputs:[...engine.outputs],counts:[...engine.counts],cache:[...engine.cache].map(([k,v])=>[k,[...v]]),queue:Array.from({length:engine.length},(_,i)=>{const v=engine.itemAt(i);return {ticket:v.ticket,node:v.node.id,values:v.values};}),history:engine.history});

test('skip uses the speed-scaled 1 / 4 / 16 ms frame budget and preserves remaining FIFO work',()=>{
 for(const [speed,budget] of [[.25,1],[1,4],[4,16]]){
  const {engine,playback,changed,time}=timedQueue({speed});
  assert.equal(playback.skipFrameBudgetMs,budget);playback.tick(1/60);
  assert.equal(engine.total,budget);assert.equal(engine.length,100-budget);assert.equal(time(),budget);
  assert.deepEqual(changed.map(e=>e.value),Array.from({length:budget},(_,i)=>i%2));
  assert.equal(playback.active,null);assert.equal(playback.visuals.length,0);assert.equal(playback.running,true);
 }
});

test('change callbacks are included in the budget and an expensive first atomic step completes once',()=>{
 const callbacks=timedQueue({stepMs:1,changeMs:2});callbacks.playback.tick(.016);
 assert.equal(callbacks.engine.total,2);assert.equal(callbacks.time(),6);assert.equal(callbacks.changed.length,2);
 const expensive=timedQueue({stepMs:9,speed:.25});expensive.playback.tick(.016);
 assert.equal(expensive.engine.total,1);assert.equal(expensive.time(),9);assert.equal(expensive.engine.itemAt(0).values.X0,1);
 const callbackOnly=timedQueue({stepMs:0,changeMs:5});callbackOnly.playback.tick(.016);
 assert.equal(callbackOnly.engine.total,1);assert.equal(callbackOnly.changed.length,1);
});

test('zero-resolution clocks stop after 10,000 real steps and custom batch caps are honored',()=>{
 const large=timedQueue({steps:10005,stepMs:0});large.playback.tick(.016);
 assert.equal(large.engine.total,10000);assert.equal(large.engine.length,5);
 large.playback.tick(.016);assert.equal(large.engine.total,10005);assert.equal(large.engine.length,0);
 const custom=timedQueue({steps:10,stepMs:0,maxSkipSteps:3,skipBudgetMs:2,speed:4});custom.playback.tick(.016);
 assert.equal(custom.engine.total,3);assert.equal(custom.playback.skipFrameBudgetMs,8);
});

test('switching to skip clears old animations immediately and computes in the very next tick',()=>{
 const engine=new JKEngine(copyModel()),visuals=[],playback=new Playback(engine,{now:()=>0,onVisual:event=>visuals.push(event)});
 playback.speed=4;playback.send({X0:1});playback.tick(.016);assert.ok(playback.active);
 playback.send({X0:0});assert.equal(playback.visuals.length,1);const before=snapshot(engine);
 playback.skip=true;
 assert.equal(playback.active,null);assert.equal(playback.visuals.length,0);assert.equal(visuals.at(-1),null);assert.deepEqual(snapshot(engine),before);assert.equal(playback.speed,4);
 playback.tick(.016);assert.equal(engine.total,2);assert.equal(engine.outputs.get('Y0'),0);assert.equal(playback.active,null);
 const visualCount=visuals.length;playback.skip=false;assert.equal(playback.speed,4);assert.equal(visuals.length,visualCount);
});

test('skip sends retain immediate logic delivery without adding records or applying the 400-record display limit',()=>{
 const engine=new JKEngine(copyModel()),playback=new Playback(engine,{now:()=>0});
 playback.pause();for(let i=0;i<400;i++)playback.send({X0:i%2});
 assert.equal(playback.visuals.length,400);assert.throws(()=>playback.send({X0:1}),/待播放输入记录已满/);assert.equal(engine.length,400);
 playback.skip=true;assert.equal(playback.running,false);assert.equal(playback.visuals.length,0);
 for(let i=0;i<405;i++)playback.send({X0:1});
 assert.equal(engine.length,805);assert.equal(engine.total,0);assert.equal(playback.visuals.length,0);
 playback.tick(1);assert.equal(engine.total,0);playback.step();assert.equal(engine.total,1);assert.equal(playback.running,false);
});

test('resuming skip clears a single-step endpoint display once even when the queue is empty',()=>{
 for(const pending of [0,1]){
  const engine=new JKEngine(copyModel()),shown=[],progress=[],changed=[];
  const playback=new Playback(engine,{now:()=>0,onVisual:event=>shown.push(event),onProgress:value=>progress.push(value),onChange:event=>{if(event?.type==='execution')changed.push(event);}});
  playback.skip=true;playback.pause();playback.send({X0:1});if(pending)playback.send({X0:0});
  const first=playback.step();assert.equal(shown.at(-1),first);assert.equal(progress.at(-1),1);assert.equal(playback.active,null);assert.equal(playback.running,false);
  const visualCount=shown.length;playback.tick(.016);assert.equal(shown.length,visualCount,'paused ticks preserve the endpoint values');
  playback.resume();playback.tick(.016);
  assert.equal(shown.length,visualCount+1);assert.equal(shown.at(-1),null);assert.equal(engine.total,1+pending);assert.equal(engine.length,0);
  assert.deepEqual(changed.map(e=>e.value),pending?[1,0]:[1],'display clearing must not repeat the completed step');
  playback.tick(.016);playback.tick(.016);assert.equal(shown.length,visualCount+1,'empty frames must not repeatedly clear the scene');
 }
});

test('batch processing consumes dynamically appended branch events in the exact direct-step FIFO order',()=>{
 const graph=model([['Q0','J0K(X0)'],['Q1','J0K(Q0)'],['Q2','J0K(Q0)'],['Q3','J0K(Q1)K(Q2)']],undefined,[{Y0:'Q3'},{Y1:'Q1'}]);
 const direct=new JKEngine(graph),batch=new JKEngine(graph),changes=[];
 for(const engine of [direct,batch]){engine.send({X0:1});engine.send({X0:1});engine.send({X0:0});}
 const playback=new Playback(batch,{now:()=>0,onChange:event=>{if(event)changes.push(event);}});playback.skip=true;playback.tick(.016);
 const expected=[];while(direct.length)expected.push(direct.step());
 assert.deepEqual(changes,expected);assert.deepEqual(snapshot(batch),snapshot(direct));
 assert.deepEqual(changes.slice(0,7).map(e=>e.node),['Q0','Q0','Q0','Q1','Q2','Q1','Q2']);
});

test('stateful feedback, repeated values and cross-send state match a step-by-step oracle',()=>{
 const graph=model([['Q0','J(Q0)K1K(Q1)'],['Q1','J0K(X0)'],['Q2','J0K(Q0)']],{0:['Q0','Q1'],1:[]},[{Y0:'Q0'},{Y1:'Q2'}]);
 const direct=new JKEngine(graph,{historyLimit:1000}),batch=new JKEngine(graph,{historyLimit:1000}),changes=[];
 const playback=new Playback(batch,{now:()=>0,maxSkipSteps:120,onChange:event=>{if(event?.type==='execution')changes.push(event);}});playback.skip=true;
 for(const input of [{X0:0},{X0:0},{X0:1}]){
  direct.send(input);playback.send(input);const expected=[];
  for(let i=0;i<120;i++)expected.push(direct.step());
  const start=changes.length;playback.tick(.016);
  assert.deepEqual(changes.slice(start),expected);assert.deepEqual(snapshot(batch),snapshot(direct));
 }
 assert.equal(batch.total,360);assert.ok(batch.length>0,'feedback remains pending without being dropped');
});

test('each completed event calls onChange before the next step and a callback pause ends the current batch',()=>{
 const {engine,playback}=timedQueue({stepMs:0});const observed=[];
 playback.onChange=event=>{if(event){observed.push([event.total,engine.total,engine.outputs.get('Y0')]);if(event.total===3)playback.pause();}};
 playback.tick(.016);
 assert.deepEqual(observed,[[1,1,0],[2,2,1],[3,3,0]]);assert.equal(engine.total,3);assert.equal(engine.length,97);assert.equal(playback.running,false);
 playback.tick(10);assert.equal(engine.total,3);playback.step();assert.equal(engine.total,4);assert.equal(playback.running,false);
});

test('reset or mode round-trips inside onChange invalidate the old batch even if running is restored',()=>{
 for(const action of ['reset','mode','pause']){
  const {engine,playback}=timedQueue({steps:4,stepMs:0});let called=false;
  playback.onChange=event=>{
   if(!event||called)return;called=true;
   if(action==='reset'){playback.reset();playback.send({X0:1});playback.resume();}
   if(action==='mode'){playback.skip=false;playback.skip=true;}
   if(action==='pause'){playback.pause();playback.resume();}
  };
  playback.tick(.016);
  assert.equal(engine.total,action==='reset'?0:1);assert.equal(engine.length,action==='reset'?1:3);
  assert.equal(playback.running,true);playback.tick(.016);assert.equal(engine.length,0);
 }
});

test('switching from skip to animation during a callback stops the batch without replaying its completed event',()=>{
 const {engine,playback}=timedQueue({steps:3,stepMs:0});
 playback.onChange=event=>{if(event&&event.total===1)playback.skip=false;};playback.tick(.016);
 assert.equal(engine.total,1);assert.equal(playback.active,null);assert.equal(engine.length,2);
 playback.tick(.016);assert.equal(engine.total,2);assert.equal(playback.active.event.total,2);
 playback.tick(.425);assert.equal(playback.active.progress,.5);assert.equal(engine.total,2);
 playback.tick(.425);assert.equal(playback.active,null);assert.equal(engine.total,2);
 playback.tick(.016);assert.equal(engine.total,3);
});

test('queue protection is checked before and after each atomic step; single-step may drain a protected queue',()=>{
 const before=timedQueue({steps:4,stepMs:0});before.engine.queueLimit=4;before.playback.tick(.016);
 assert.equal(before.engine.total,0);assert.equal(before.playback.running,false);assert.throws(()=>before.playback.resume(),/保护阈值/);
 before.playback.step();assert.equal(before.engine.total,1);assert.equal(before.engine.length,3);
 const graph=model([['Q0','J0K(X0)'],['Q1','J0K(Q0)'],['Q2','J0K(Q0)']]),engine=new JKEngine(graph,{queueLimit:2});
 const changed=[],playback=new Playback(engine,{now:()=>0,onChange:event=>{if(event)changed.push(event);}});playback.skip=true;playback.send({X0:1});playback.tick(.016);
 assert.equal(engine.total,1);assert.equal(engine.length,2);assert.equal(playback.running,false);assert.equal(changed.filter(e=>e.type==='execution').length,1);
 assert.deepEqual(Array.from({length:engine.length},(_,i)=>engine.itemAt(i).node.id),['Q1','Q2']);
});

test('a failing engine step or change callback pauses and rethrows without retrying completed work',()=>{
 for(const location of ['step','change']){
  const {engine,playback}=timedQueue({steps:4,stepMs:0});const original=engine.step.bind(engine),error=new Error('test failure');let calls=0;
  if(location==='step')engine.step=()=>{calls++;if(calls===2)throw error;return original();};
  else playback.onChange=event=>{if(event&&++calls===2)throw error;};
  assert.throws(()=>playback.tick(.016),e=>e===error);assert.equal(playback.running,false);assert.equal(calls,2);
  const completed=engine.total;playback.tick(.016);assert.equal(calls,2);assert.equal(engine.total,completed);
  if(location==='step')engine.step=original;else playback.onChange=()=>{};
  playback.resume();playback.tick(.016);assert.equal(engine.total,4);assert.equal(engine.length,0);
 }
 const actual=new JKEngine(copyModel());actual.send({X0:1});actual.queue[0]={...actual.queue[0],values:{X0:2}};
 const playback=new Playback(actual,{now:()=>0});playback.skip=true;
 assert.throws(()=>playback.tick(.016),/内部参数错误/);assert.equal(playback.running,false);assert.equal(actual.total,0);assert.equal(actual.length,0);
});

test('reentrant ticks cannot multiply a frame batch, while empty queues do not publish changes',()=>{
 const {engine,playback}=timedQueue({steps:5,stepMs:0,maxSkipSteps:2});let notified=0;
 playback.onChange=event=>{if(event){notified++;playback.tick(.016);}};playback.tick(.016);
 assert.equal(engine.total,2);assert.equal(notified,2);
 playback.tick(.016);playback.tick(.016);assert.equal(engine.total,5);assert.equal(notified,5);
 playback.tick(.016);assert.equal(notified,5);assert.equal(playback.running,true);
});

test('constructor rejects invalid clock, budget and cap options',()=>{
 for(const value of [0,-1,NaN,Infinity,'4'])assert.throws(()=>new Playback(new JKEngine(copyModel()),{skipBudgetMs:value}));
 for(const value of [0,-1,1.5,NaN,Infinity])assert.throws(()=>new Playback(new JKEngine(copyModel()),{maxSkipSteps:value}));
 assert.throws(()=>new Playback(new JKEngine(copyModel()),{now:0}),/时钟函数/);
});
