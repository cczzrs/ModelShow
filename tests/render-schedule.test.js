import test from 'node:test';
import assert from 'node:assert/strict';
import {RenderSchedule} from '../src/render-schedule.js';

function run(schedule,hz,seconds,options={}){
  const frames=[];
  for(let i=0;i<hz*seconds;i++){
    const now=i*1000/hz,frame=schedule.sample(now,options);
    if(frame)frames.push({now,...frame});
  }
  return frames;
}
function close(actual,expected){assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);}

test('slow wind submits 30 frames per second on 60, 120 and 144 Hz displays',()=>{
  for(const hz of [60,120,144]){
    const frames=run(new RenderSchedule(),hz,2);
    assert.equal(frames.length,60,`${hz} Hz display`);
    close(frames.reduce((sum,frame)=>sum+frame.deltaSeconds,0),frames.at(-1).now/1000);
  }
});

test('active propagation or camera motion submits up to 60 frames per second without changing wind time',()=>{
  for(const hz of [60,120,144]){
    const frames=run(new RenderSchedule(),hz,2,{active:true});
    assert.equal(frames.length,120);
    close(frames.reduce((sum,frame)=>sum+frame.deltaSeconds,0),frames.at(-1).now/1000);
  }
  const schedule=new RenderSchedule();
  assert.ok(schedule.sample(0));assert.equal(schedule.sample(16),null);
  assert.ok(schedule.sample(17,{active:true}),'interaction uses the shorter deadline immediately');
});

test('paused scenes draw once and then sleep; explicit changes still appear',()=>{
  const schedule=new RenderSchedule(),frames=run(schedule,120,1,{animate:false});
  assert.deepEqual(frames,[{now:0,deltaSeconds:0}]);
  schedule.invalidate();assert.deepEqual(schedule.sample(1000,{animate:false}),{deltaSeconds:0});
  assert.equal(schedule.sample(1010,{animate:false}),null);
  schedule.invalidate();assert.equal(schedule.sample(1010,{animate:false}),null);
  assert.deepEqual(schedule.sample(1017,{animate:false}),{deltaSeconds:0});
});

test('interaction wakes a paused scene for a bounded tail without advancing wind',()=>{
  const schedule=new RenderSchedule({interactionTailMs:100});
  schedule.sample(0,{animate:false});schedule.interact(1000);
  for(const now of [1000,1017,1034,1051,1068,1085])assert.deepEqual(schedule.sample(now,{animate:false}),{deltaSeconds:0});
  assert.equal(schedule.sample(1101,{animate:false}),null);
});

test('hidden pages draw nothing and do not accumulate wind elapsed time',()=>{
  const schedule=new RenderSchedule();schedule.sample(0);schedule.sample(20);
  assert.equal(schedule.sample(40,{hidden:true}),null);
  assert.equal(schedule.sample(60000,{hidden:true}),null);
  assert.deepEqual(schedule.sample(120000),{deltaSeconds:0});
  assert.equal(schedule.sample(120010),null);
  close(schedule.sample(120040).deltaSeconds,.04);
  schedule.resetClock();
  assert.deepEqual(schedule.sample(240000),{deltaSeconds:0},'visibility event resets time when no hidden RAF ran');
});

test('pause drops partial wind time and resuming advances only visible sampling intervals',()=>{
  const schedule=new RenderSchedule();schedule.sample(0);schedule.sample(10);
  schedule.invalidate();assert.deepEqual(schedule.sample(20,{animate:false}),{deltaSeconds:0});
  schedule.sample(1000,{animate:false});
  close(schedule.sample(1020).deltaSeconds,.02);
});

test('long main-thread stalls are bounded and never produce catch-up draws',()=>{
  const schedule=new RenderSchedule();schedule.sample(0);
  close(schedule.sample(10000).deltaSeconds,.1);
  for(let i=0;i<100;i++)assert.equal(schedule.sample(10000),null);
  assert.equal(schedule.sample(10010),null);
  close(schedule.sample(10040).deltaSeconds,.04);
  assert.deepEqual(schedule.sample(50),{deltaSeconds:0},'a replaced clock cannot rewind wind');
});

test('invalid frame rates or clock limits are rejected',()=>{
  for(const options of [{idleFps:0},{activeFps:NaN},{maxDeltaMs:-1},{interactionTailMs:-1}])assert.throws(()=>new RenderSchedule(options),RangeError);
});
