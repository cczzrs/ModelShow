import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import * as THREE from 'three/webgpu';
import {createRenderer} from '../../src/scene/renderer-backend.js';

function deferred(){
  let resolve,reject;
  const promise=new Promise((ok,fail)=>{resolve=ok;reject=fail;});
  return {promise,resolve,reject};
}

function harness(overrides={}){
  const events=[],view={},canvas={kind:'canvas'};
  const renderer={backend:{isWebGPUBackend:true},async init(){events.push('init');},dispose(){events.push('dispose');}};
  const options={
    mode:'auto',timeoutMs:1000,
    gpu:{async requestAdapter(){events.push('adapter');return {};}},
    createGPU(){events.push('gpu');return renderer;},
    createCanvas(){events.push('canvas');return canvas;},
    ...overrides,
  };
  return {events,view,canvas,renderer,options,run(){return createRenderer(view,options);}};
}

function assertFallback(result,h){
  assert.equal(result.renderer,h.canvas);
  assert.equal(result.backend,'canvas');
  assert.equal(typeof result.reason,'string');
  assert.ok(result.reason.length>0,'an automatic fallback explains its cause');
  assert.equal(h.events.filter(event=>event==='canvas').length,1);
}

test('explicit Canvas mode never probes or creates a GPU renderer',async()=>{
  const h=harness({mode:'canvas'}),result=await h.run();
  assert.equal(result.renderer,h.canvas);assert.equal(result.backend,'canvas');
  assert.deepEqual(h.events,['canvas']);
});

test('an absent GPU interface renders with Canvas',async()=>{
  const h=harness({gpu:null});assertFallback(await h.run(),h);
  assert.deepEqual(h.events,['canvas']);
});

test('an unavailable adapter renders with Canvas without constructing WebGPU',async()=>{
  const h=harness({gpu:{async requestAdapter(){return null;}}});
  assertFallback(await h.run(),h);assert.deepEqual(h.events,['canvas']);
});

test('a rejected adapter request renders with Canvas',async()=>{
  const h=harness({gpu:{async requestAdapter(){throw new Error('adapter denied');}}});
  assertFallback(await h.run(),h);assert.deepEqual(h.events,['canvas']);
});

test('a successful WebGPU initialization does not construct Canvas or dispose WebGPU',async()=>{
  const h=harness(),result=await h.run();
  assert.equal(result.renderer,h.renderer);assert.equal(result.backend,'webgpu');assert.equal(result.reason,null);
  assert.deepEqual(h.events,['adapter','gpu','init']);
});

test('a failed WebGPU constructor still renders with Canvas',async()=>{
  const h=harness({createGPU(){throw new Error('renderer construction failed');}});
  assertFallback(await h.run(),h);assert.deepEqual(h.events,['adapter','canvas']);
});

test('failed WebGPU initialization releases its renderer and renders with Canvas',async()=>{
  const h=harness();h.renderer.init=async()=>{h.events.push('init');throw new Error('device unavailable');};
  assertFallback(await h.run(),h);
  assert.deepEqual(h.events,['adapter','gpu','init','dispose','canvas']);
});

test('failed initialization of a real Three renderer never retries through dispose or emits an unhandled rejection',async t=>{
  const renderer=new THREE.WebGPURenderer({canvas:{width:32,height:32}}),unhandled=[];
  const originalDispose=renderer.dispose;
  let initializations=0,unconfigured=0,destroyed=0;
  renderer.init=async()=>{initializations++;throw new Error('device initialization denied');};
  renderer.backend.context={unconfigure(){unconfigured++;}};
  renderer.backend.device={destroy(){destroyed++;}};
  const onUnhandled=error=>unhandled.push(error);
  process.on('unhandledRejection',onUnhandled);t.after(()=>process.off('unhandledRejection',onUnhandled));
  const h=harness({createGPU:()=>renderer});
  assertFallback(await h.run(),h);
  await nextTurn();await nextTurn();
  assert.equal(renderer.dispose,originalDispose,'retain Three disposal behavior in this regression test');
  assert.equal(initializations,1,'cleanup must not start a second asynchronous init');
  assert.equal(unconfigured,1);assert.equal(destroyed,1);
  assert.deepEqual(unhandled,[]);
});

test('a device lost during otherwise successful initialization is replaced with Canvas',async()=>{
  const h=harness();
  h.renderer.init=async()=>{h.events.push('init');h.renderer._isDeviceLost=true;};
  assertFallback(await h.run(),h);
  assert.deepEqual(h.events,['adapter','gpu','init','dispose','canvas']);
});

test('a failed renderer cleanup cannot block the software fallback',async()=>{
  const h=harness();
  h.renderer.init=async()=>{throw new Error('device unavailable');};
  h.renderer.dispose=()=>{h.events.push('dispose');throw new Error('lost device cleanup failed');};
  assertFallback(await h.run(),h);
  assert.deepEqual(h.events,['adapter','gpu','dispose','canvas']);
});

test('Three WebGL fallback is disposed and replaced with actual software rendering',async()=>{
  const h=harness();h.renderer.backend={isWebGLBackend:true};
  assertFallback(await h.run(),h);
  assert.deepEqual(h.events,['adapter','gpu','init','dispose','canvas']);
});

test('a hanging adapter request times out and a late adapter cannot replace Canvas',async()=>{
  const pending=deferred(),h=harness({timeoutMs:10,gpu:{requestAdapter(){return pending.promise;}}});
  assertFallback(await h.run(),h);
  pending.resolve({});await nextTurn();
  assert.deepEqual(h.events,['canvas'],'a completed timeout must not start another GPU renderer');
});

test('a hanging initialization falls back and a late success releases the initialized GPU',async()=>{
  const pending=deferred(),h=harness({timeoutMs:10});let initialized=false;
  h.renderer.init=async()=>{h.events.push('init');await pending.promise;initialized=true;};
  h.renderer.dispose=()=>h.events.push(initialized?'dispose:ready':'dispose:pending');
  const result=await h.run();assertFallback(result,h);
  pending.resolve();await nextTurn();
  assert.ok(h.events.includes('dispose:ready'),'GPU allocations created by late init must be released');
  assert.equal(result.renderer,h.canvas);assert.equal(h.events.filter(event=>event==='canvas').length,1);
});

test('a late initialization rejection is handled after the Canvas fallback',async()=>{
  const pending=deferred(),h=harness({timeoutMs:10});
  h.renderer.init=()=>pending.promise;
  assertFallback(await h.run(),h);
  pending.reject(new Error('late initialization failure'));await nextTurn();
  assert.ok(h.events.includes('dispose'));
  assert.equal(h.events.filter(event=>event==='canvas').length,1);
});
