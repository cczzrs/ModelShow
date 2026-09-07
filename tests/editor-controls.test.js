import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {EditorControls,zoomAtCursor} from '../src/editor-controls.js';

class Surface {
 constructor(){this.listeners=new Map();this.style={};this.ownerDocument={documentElement:{clientLeft:0,clientTop:0}};}
 addEventListener(type,fn,options){const list=this.listeners.get(type)??[];list.push({fn,capture:options===true});this.listeners.set(type,list);}
 removeEventListener(type,fn){this.listeners.set(type,(this.listeners.get(type)??[]).filter(v=>v.fn!==fn));}
 emit(type,data){const event={pointerId:1,pointerType:'mouse',button:0,pageX:400,pageY:300,clientX:400,clientY:300,preventDefault(){},...data};for(const {fn} of [...(this.listeners.get(type)??[])].sort((a,b)=>Number(b.capture)-Number(a.capture)))fn(event);}
 getBoundingClientRect(){return {left:0,top:0,width:800,height:600};}
 setPointerCapture(){} releasePointerCapture(){}
}
function setup(){globalThis.window=new Surface();window.pageXOffset=window.pageYOffset=0;const camera=new THREE.PerspectiveCamera(50,4/3,.01,1000);camera.position.set(0,0,10);camera.lookAt(0,0,0);const surface=new Surface();return {camera,surface,controls:new EditorControls(camera,surface)};}
function close(a,b){assert.ok(a.distanceTo(b)<1e-8,`${a.toArray()} != ${b.toArray()}`);}

test('horizontal and vertical pointer drags complete full revolutions without pole clamps',()=>{
 for(const axis of ['pageX','pageY']){
  const {camera,surface,controls}=setup(),start=camera.position.clone();
  surface.emit('pointerdown',{});
  for(let step=1;step<=64;step++){
   surface.emit('pointermove',{[axis]:(axis==='pageX'?400:300)+step/64*Math.PI*400});controls.update();
   assert.ok(Math.abs(camera.position.length()-10)<1e-8);
   if(step===32){assert.ok(camera.position.z<-9.99);if(axis==='pageY')assert.ok(camera.up.y<-.99);}
  }
  close(camera.position,start);close(camera.up,new THREE.Vector3(0,1,0));surface.emit('pointerup',{});controls.dispose();
 }
});
test('right, middle and shift-left pan translate pivot and camera together',()=>{
 for(const data of [{button:2},{button:1},{button:0,shiftKey:true}]){
  const {camera,surface,controls}=setup(),start=camera.position.clone(),q=camera.quaternion.clone();
  surface.emit('pointerdown',data);surface.emit('pointermove',{...data,pageX:500,pageY:350});controls.update();
  assert.ok(controls.target.length()>0);close(camera.position.clone().sub(start),controls.target);assert.ok(camera.quaternion.angleTo(q)<1e-7);
  surface.emit('pointerup',data);controls.dispose();
 }
});
test('cursor zoom preserves the projected anchor and moves the pivot, including rolled views',()=>{
 for(const roll of [0,2.1])for(const useHit of [false,true]){
  const {camera,controls}=setup();camera.up.set(Math.sin(roll),Math.cos(roll),0);controls.update();camera.updateMatrixWorld();
  const ndc=new THREE.Vector2(.5,-.3),ray=new THREE.Raycaster();ray.setFromCamera(ndc,camera);
  const anchor=ray.ray.at(useHit?6:10/-ray.ray.direction.z,new THREE.Vector3()),projected=anchor.clone().project(camera);
  const original=camera.position.clone();
  zoomAtCursor(camera,controls.target,ndc,.7,.2,200,useHit?anchor:null);controls.update();camera.updateMatrixWorld();
  const after=anchor.clone().project(camera);assert.ok(Math.hypot(after.x-projected.x,after.y-projected.y)<1e-8);assert.ok(controls.target.length()>0);assert.ok(Math.abs(camera.position.distanceTo(controls.target)-7)<1e-8);
  zoomAtCursor(camera,controls.target,ndc,1/.7,.2,200,useHit?anchor:null);controls.update();close(camera.position,original);close(controls.target,new THREE.Vector3());controls.dispose();
 }
});
test('wheel respects distance limits and disposal removes wheel handling',()=>{
 const {camera,surface,controls}=setup();
 for(let i=0;i<50;i++)surface.emit('wheel',{deltaY:-500,deltaMode:0});
 assert.ok(Math.abs(camera.position.distanceTo(controls.target)-.2)<1e-8);
 for(let i=0;i<50;i++)surface.emit('wheel',{deltaY:500,deltaMode:0});
 assert.ok(Math.abs(camera.position.distanceTo(controls.target)-200)<1e-8);
 controls.dispose();const before=camera.position.clone();surface.emit('wheel',{deltaY:-500,deltaMode:0});close(camera.position,before);
});
