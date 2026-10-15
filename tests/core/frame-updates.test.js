import test from 'node:test';
import assert from 'node:assert/strict';
import {FrameUpdates} from '../../src/ui/frame-updates.js';
import {JKEngine,compileModel} from '../../src/jk/engine.js';
import {Playback} from '../../src/ui/playback.js';

const inputModel=()=>compileModel({nodes:[{id:'Q0',ex:'J0K(X0)'}],initial_q:{0:['Q0'],1:[]},q_y:[{Y0:'Q0'}]});
const queued=()=>{const e=new JKEngine(inputModel());for(let i=0;i<10;i++)e.send({X0:i%2});return e;};

test('each execution is observed immediately while callbacks and status changes share one frame refresh',()=>{
  const engine=queued(),observed=[],draws=[];
  const frames=new FrameUpdates(()=>draws.push(engine.total),event=>{if(event?.executions?.length)observed.push([event.ticket,engine.total]);});
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
  const engine=queued(),draws=[];
  const frames=new FrameUpdates(()=>draws.push(engine.total),event=>{if(event?.total===3)throw new Error('observer failed');});
  const playback=new Playback(engine,{onChange:event=>frames.request(event),now:()=>0});
  playback.skip=true;
  assert.throws(()=>playback.tick(1/60),/observer failed/);
  assert.equal(engine.total,3);
  assert.equal(engine.itemAt(0).node,'Q0');
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
