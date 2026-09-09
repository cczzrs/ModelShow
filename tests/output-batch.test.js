import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {NetworkView} from '../src/view.js';
import {defaultDisplay} from '../src/output-display.js';
import {compileModel,JKEngine} from '../src/engine.js';
import {Playback} from '../src/playback.js';

const bits=ids=>({kind:'bits',bits:ids,order:'lsb-first',mapping:'scale'});
const model=()=>compileModel({nodes:[{id:'Q0',ex:'J0K(X0)'},{id:'Q1',ex:'J0K(X1)'}],initial_q:{0:[],1:[]},q_y:[{Y0:'Q0'},{Y1:'Q1'}]});
const bounds={min:{x:-2,y:-1,z:-1},max:{x:2,y:1,z:1}};
function setup(t,config){
  const engine=new JKEngine(model()),view=new NetworkView({closest:()=>null});
  view.model=engine.model;view.engine=engine;view.layout={mode:'4D',bounds,positions:new Map()};
  const c=config??defaultDisplay(1,1);c.enabled=true;if(!config)c.pixels[0].channels.r=bits(['Y0','Y1']);
  view.setOutputDisplay(c);t.after(()=>view.outputBoard.clear());
  const paints=[],paint=view.outputBoard.paint.bind(view.outputBoard);
  view.outputBoard.paint=(results,indices)=>{paints.push({indices:[...indices],results:structuredClone(results)});paint(results,indices);};
  const trajectory=[];
  const playback=new Playback(engine,{now:()=>0,skipBudgetMs:4,maxSkipSteps:1000,onChange:event=>{
    view.syncOutputs(engine,event);
    if(event?.type==='execution')trajectory.push({ticket:event.ticket,...view.outputState.results[0].r});
  }});
  playback.skip=true;
  return {engine,view,playback,paints,trajectory};
}
function red(view,index=0){const color=new THREE.Color();view.outputBoard.lamps.getColorAt(index,color);return color.r;}
const linear=value=>new THREE.Color().setRGB(value/255,0,0,THREE.SRGBColorSpace).r;

test('one skip batch aggregates each Yi transition immediately and paints its accumulated changes only at frame end',t=>{
  const {engine,view,playback,paints,trajectory}=setup(t);
  assert.equal(view.outputState.results[0].r.ready,false);
  playback.send({X0:1});playback.send({X1:0});playback.send({X0:0});playback.send({X0:1});
  playback.tick(1/60);
  assert.equal(engine.total,4);
  assert.deepEqual(trajectory.map(({ticket,ready,bits,brightness})=>({ticket,ready,bits,brightness})),[
    {ticket:1,ready:false,bits:'1?',brightness:0},
    {ticket:2,ready:true,bits:'10',brightness:85},
    {ticket:3,ready:true,bits:'00',brightness:0},
    {ticket:4,ready:true,bits:'10',brightness:85},
  ]);
  assert.equal(paints.length,0);assert.equal(red(view),0);assert.deepEqual([...view.pendingLampDirty],[0]);
  view.refresh(engine);
  assert.equal(paints.length,1);assert.deepEqual(paints[0].indices,[0]);assert.ok(Math.abs(red(view)-linear(85))<1e-7);assert.equal(view.pendingLampDirty.size,0);
  view.refresh(engine);assert.equal(paints.length,1,'a second full sync cannot repaint already consumed changes');
});

test('same-value publications cause no paint, but a change and return within one frame still preserve both CPU states',t=>{
  const {engine,view,playback,paints,trajectory}=setup(t);
  playback.send({X0:1,X1:0});playback.tick(1/60);view.refresh(engine);paints.length=trajectory.length=0;
  playback.send({X0:1});playback.send({X0:1});playback.tick(1/60);
  assert.equal(trajectory.length,2);assert.ok(trajectory.every(r=>r.brightness===85));assert.equal(view.pendingLampDirty.size,0);
  view.refresh(engine);assert.equal(paints.length,0);
  trajectory.length=0;
  playback.send({X0:0});playback.send({X0:1});playback.tick(1/60);
  assert.deepEqual(trajectory.map(r=>r.brightness),[0,85]);assert.equal(paints.length,0);
  view.refresh(engine);assert.equal(paints.length,1);assert.deepEqual(paints[0].indices,[0]);assert.equal(paints[0].results[0].r.brightness,85);
});

test('non-Yi input notifications skip aggregation while pause, single-step and reset still synchronize live output',t=>{
  const {engine,view,playback,paints}=setup(t);
  let updates=0;const update=view.outputState.update.bind(view.outputState);view.outputState.update=values=>{updates++;return update(values);};
  playback.send({X0:1});assert.equal(updates,0);assert.equal(engine.total,0);assert.equal(paints.length,0);
  playback.pause();assert.equal(updates,1);
  playback.send({X1:0});assert.equal(updates,1);assert.equal(playback.running,false);
  playback.step();assert.equal(engine.total,1);assert.equal(view.outputState.results[0].r.ready,false);assert.equal(playback.running,false);
  playback.step();assert.equal(engine.total,2);assert.equal(view.outputState.results[0].r.brightness,85);assert.equal(paints.length,0);
  view.refresh(engine);assert.equal(paints.length,1);paints.length=0;
  playback.reset();assert.equal(engine.total,0);assert.equal(engine.length,0);assert.equal(playback.running,false);
  assert.equal(view.outputState.results[0].r.ready,false);assert.equal(view.outputState.results[0].r.brightness,0);assert.equal(paints.length,0);
  view.refresh(engine);assert.equal(paints.length,1);assert.equal(red(view),0);assert.equal(view.pendingLampDirty.size,0);
});

test('reconfiguration consumes pending indices from the previous lamp array and paints only the new configuration',t=>{
  const config=defaultDisplay(1,2);config.pixels[0].channels.r=bits(['Y0']);config.pixels[1].channels.r=bits(['Y1']);
  const {engine,view,playback,paints}=setup(t,config);
  playback.send({X0:1,X1:1});playback.tick(1/60);assert.deepEqual([...view.pendingLampDirty],[0,1]);
  const next=defaultDisplay(1,1);next.enabled=true;next.pixels[0].channels.r={kind:'fixed',value:7};
  view.setOutputDisplay(next);
  assert.equal(view.outputBoard.lamps.count,1);assert.equal(paints.length,1);assert.deepEqual(paints[0].indices,[0]);
  assert.equal(view.outputState.results[0].r.brightness,7);assert.equal(view.pendingLampDirty.size,0);
  view.refresh(engine);assert.equal(paints.length,1);assert.ok(Math.abs(red(view)-linear(7))<1e-7);
});

test('layout rebuilding paints pending values once and model replacement clears all old Yi values and pending work',t=>{
  const {engine,view,playback,paints}=setup(t);
  playback.send({X0:1,X1:1});playback.tick(1/60);assert.equal(view.pendingLampDirty.size,1);
  const position=view.camera.position.clone(),quaternion=view.camera.quaternion.clone();
  view.applyLayout({mode:'2D',bounds,positions:new Map()});
  assert.equal(paints.length,1);assert.equal(red(view),1);assert.equal(view.pendingLampDirty.size,0);
  assert.deepEqual(view.camera.position,position);assert.deepEqual(view.camera.quaternion.toArray(),quaternion.toArray());
  playback.send({X0:0});playback.tick(1/60);assert.equal(view.pendingLampDirty.size,1);paints.length=0;
  const empty=compileModel({nodes:[],initial_q:{0:[],1:[]},q_y:[]});view.requestLayout=()=>{};
  view.setModel(empty);
  assert.equal(view.engine,null);assert.equal(view.outputState.values.size,0);assert.equal(view.outputState.results[0].r.ready,false);
  assert.equal(paints.length,1);assert.equal(red(view),0);assert.equal(view.pendingLampDirty.size,0);
  view.refresh(new JKEngine(empty));assert.equal(paints.length,1);assert.deepEqual(view.camera.position,position);assert.deepEqual(view.camera.quaternion.toArray(),quaternion.toArray());
});

test('renderer recovery submits pending colors without discarding bindings, resources or the current view',async t=>{
  const {view,playback,paints}=setup(t);
  playback.send({X0:1,X1:1});playback.tick(1/60);
  const lamp=view.outputBoard.lamps,config=structuredClone(view.outputState.config);
  view.camera.position.set(9,3,15);view.camera.up.set(1,0,0);view.camera.lookAt(1,2,0);
  const controls={target:new THREE.Vector3(1,2,0),minDistance:.2,maxDistance:200,dispose(){},update(){}};
  view.controls=controls;view.renderer={domElement:{remove(){}},dispose(){}};
  view.init=async()=>{view.controls={...controls,target:new THREE.Vector3()};view.available=true;};
  const position=view.camera.position.clone(),quaternion=view.camera.quaternion.clone();
  await view.recover();
  assert.equal(paints.length,1);assert.equal(red(view),1);assert.equal(view.pendingLampDirty.size,0);assert.equal(view.outputBoard.lamps,lamp);
  assert.deepEqual(view.outputState.config,config);assert.deepEqual(view.camera.position,position);assert.deepEqual(view.camera.quaternion.toArray(),quaternion.toArray());
});
