import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FrameUpdates} from '../src/frame-updates.js';
import {Playback} from '../src/playback.js';
import {compileModel,JKEngine} from '../src/engine.js';

// Exercise the actual browser-loop functions without constructing its DOM or GPU.
const main=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
function sourceFunction(name,indent=''){
  const start=main.indexOf(`${indent}function ${name}(`),end=main.indexOf(`\n${indent}}`,start);
  assert.ok(start>=0&&end>start,`${name} must remain available for the integration harness`);
  return main.slice(start,end+indent.length+2);
}
const createFrame=new Function('playback','message','frameUpdates','view','engine','requestAnimationFrame',`
  let previous=0,lastStatus='';
  ${sourceFunction('pauseAfterError')}
  ${sourceFunction('frame','  ')}
  return frame;
`);
function setup({nodes=[],sync=()=>{},refresh=()=>{},render=()=>{},fail=()=>{}}={}){
  const engine=new JKEngine(compileModel({nodes,initial_q:{0:[],1:[]},q_y:[]}));
  const messages=[],scheduled=[],presented=[];
  const frames=new FrameUpdates(()=>{presented.push(engine.total);refresh();sync();},()=>sync());
  const playback=new Playback(engine,{onChange:event=>frames.request(event),now:()=>0});playback.skip=true;
  const frame=createFrame(playback,(text,error)=>messages.push({text,error}),frames,{render,fail},engine,callback=>scheduled.push(callback));
  return {engine,playback,frames,frame,messages,scheduled,presented};
}

test('persistent output observer failure pauses completed work, reports errors and retains the next animation frame',()=>{
  const state=setup({nodes:[{id:'Q0',ex:'J0K1'},{id:'Q1',ex:'J0K1'}],sync(){throw new Error('persistent observer failure');}});
  assert.doesNotThrow(()=>state.frame(16));
  assert.equal(state.engine.total,1);assert.equal(state.engine.length,1);assert.equal(state.playback.running,false);
  assert.equal(state.frames.pending,true);assert.equal(state.scheduled.length,1);assert.equal(state.scheduled[0],state.frame);
  assert.deepEqual(state.presented,[1]);assert.equal(state.messages.length,2);
  assert.match(state.messages[0].text,/执行错误：persistent observer failure/);
  assert.match(state.messages[0].text,/状态同步失败：persistent observer failure/);
  assert.match(state.messages[1].text,/界面更新错误：persistent observer failure/);
  assert.ok(state.messages.every(m=>m.error));
  state.frame(32);
  assert.equal(state.engine.total,1,'paused failures must not execute the remaining queue');
  assert.equal(state.frames.pending,true);assert.equal(state.scheduled.length,2);
});

test('an unchanged idle frame schedules exactly one successor without presenting the interface again',()=>{
  let renders=0;const state=setup({render(){renders++;}});
  state.frame(16); // Establish the initial run/queue status.
  assert.deepEqual(state.presented,[0]);assert.equal(state.frames.pending,false);
  state.presented.length=0;state.scheduled.length=0;
  state.frame(32);
  assert.equal(state.scheduled.length,1);assert.equal(state.scheduled[0],state.frame);
  assert.deepEqual(state.presented,[]);assert.deepEqual(state.messages,[]);assert.equal(renders,2);
  assert.equal(state.engine.total,0);assert.equal(state.frames.pending,false);
});

test('presentation failure remains pending and an unexpectedly failing GPU error handler cannot lose the next frame',()=>{
  const state=setup({refresh(){throw new Error('presentation failed');}});
  state.frame(16);
  assert.equal(state.playback.running,false);assert.equal(state.frames.pending,true);assert.equal(state.scheduled.length,1);
  assert.match(state.messages[0].text,/界面更新错误：presentation failed/);
  const gpu=setup({render(){throw new Error('device lost');},fail(){throw new Error('failure handler failed');}});
  assert.throws(()=>gpu.frame(16),/failure handler failed/);
  assert.equal(gpu.scheduled.length,1,'the outer finally still schedules recovery work');
});
