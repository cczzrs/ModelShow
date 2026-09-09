import test from 'node:test';
import assert from 'node:assert/strict';
import {FrameUpdates} from '../src/frame-updates.js';
import {JKEngine,compileModel} from '../src/engine.js';
import {Playback} from '../src/playback.js';

const constantModel=()=>compileModel({nodes:Array.from({length:10},(_,i)=>({id:`Q${i}`,ex:'J0K1'})),initial_q:{0:[],1:[]},q_y:[]});

test('each execution is observed immediately while callbacks and status changes share one frame refresh',()=>{
  const engine=new JKEngine(constantModel()),observed=[],draws=[];
  const frames=new FrameUpdates(()=>draws.push(engine.total),event=>{if(event?.type==='execution')observed.push([event.ticket,engine.total]);});
  const playback=new Playback(engine,{onChange:event=>frames.request(event),now:()=>0});
  playback.skip=true;
  playback.tick(1/60);
  assert.equal(engine.total,10);
  assert.deepEqual(observed,Array.from({length:10},(_,i)=>[i+1,i+1]));
  assert.deepEqual(draws,[]);
  frames.invalidate(); // The frame's queue/run-state check must not trigger another refresh.
  assert.equal(frames.flush(),true);
  assert.equal(frames.flush(),false);
  assert.deepEqual(draws,[10]);
  playback.tick(1/60);
  assert.equal(frames.flush(),false,'idle frames do not rebuild the interface');
  playback.pause();frames.flush();
  playback.reset();frames.flush();
  assert.deepEqual(draws,[10,10,0]);
});

test('completed state is still flushed after a synchronous event observer fails',()=>{
  const engine=new JKEngine(constantModel()),draws=[];
  const frames=new FrameUpdates(()=>draws.push(engine.total),event=>{if(event?.total===3)throw new Error('observer failed');});
  const playback=new Playback(engine,{onChange:event=>frames.request(event),now:()=>0});
  playback.skip=true;
  assert.throws(()=>playback.tick(1/60),/observer failed/);
  assert.equal(engine.total,3);
  assert.equal(engine.itemAt(0).node.id,'Q3');
  playback.pause();
  assert.equal(frames.flush(),true);
  assert.deepEqual(draws,[3]);
});

test('refresh failure remains pending and newly invalidated work is not lost during a flush',()=>{
  let fails=true,calls=0;
  const frames=new FrameUpdates(()=>{calls++;if(fails)throw new Error('display failed');if(calls===2)frames.invalidate();});
  frames.invalidate();
  assert.throws(()=>frames.flush(),/display failed/);
  fails=false;
  assert.equal(frames.flush(),true);
  assert.equal(frames.flush(),true);
  assert.equal(frames.flush(),false);
  assert.equal(calls,3);
});
