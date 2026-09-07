import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {NetworkView} from '../src/view.js';
import {FloatingEdgeCurve,assignEdgeLanes,updateLineGeometry,updateTubeGeometry} from '../src/edge-curves.js';
test('layout changes retain camera position, orientation, zoom and controls target; explicit reset changes them',()=>{
 const view=new NetworkView({});view.camera.position.set(9,4,-7);view.camera.lookAt(2,1,3);view.camera.zoom=1.7;
 let updates=0;view.controls={target:new THREE.Vector3(2,1,3),update(){updates++;}};
 const snapshot=()=>({p:view.camera.position.toArray(),q:view.camera.quaternion.toArray(),zoom:view.camera.zoom,target:view.controls.target.toArray()});const before=snapshot();
 for(const mode of ['1D','2D','3D','4D','5D'])view.applyLayout({mode,positions:new Map(),bounds:{min:{x:-5,y:-3,z:-4},max:{x:6,y:7,z:3}}});
 assert.deepEqual(snapshot(),before);assert.equal(updates,0);
 view.resetCamera();assert.notDeepEqual(view.camera.position.toArray(),before.p);assert.equal(updates,1);
 const direction=view.camera.position.clone().sub(view.controls.target).normalize();
 assert.ok(Math.abs(direction.y)<1e-12);assert.ok(direction.x>0&&direction.x<.2);assert.ok(direction.z>.98);
});
test('even singleton edges are bowed with fixed endpoints on every principal axis',()=>{
 for(const end of [new THREE.Vector3(3,0,0),new THREE.Vector3(0,3,0),new THREE.Vector3(0,0,3)]){
  const start=new THREE.Vector3(),c=new FloatingEdgeCurve(start,end,'A','B');
  for(const time of [0,1,12]){c.time=time;assert.deepEqual(c.getPoint(0),start);assert.deepEqual(c.getPoint(1),end);assert.ok(c.getPoint(.5).distanceTo(end.clone().multiplyScalar(.5))>.03);assert.ok(c.getTangent(.5).toArray().every(Number.isFinite));}
 }
});
test('repeated and reciprocal edges have distinct curves in a shared lane allocation',()=>{
 const edges=assignEdgeLanes(Array.from({length:8},(_,i)=>({sourceKey:i%2?'B':'A',targetKey:i%2?'A':'B'})));
 assert.ok(edges.every(e=>e.laneCount===8));const a=new THREE.Vector3(),b=new THREE.Vector3(4,0,0);
 for(const time of [0,2,10]){const mids=edges.map(e=>{const c=new FloatingEdgeCurve(e.sourceKey==='A'?a:b,e.sourceKey==='A'?b:a,e.sourceKey,e.targetKey,e.laneIndex,e.laneCount);c.time=time;return c.getPoint(.5);});
 for(let i=0;i<mids.length;i++)for(let j=0;j<i;j++)assert.ok(mids[i].distanceTo(mids[j])>.1);}
});
test('self-loops remain distinct and close on their source',()=>{
 const a=new THREE.Vector3(1,2,3),curves=Array.from({length:3},(_,i)=>new FloatingEdgeCurve(a,a,'A','A',i,3));
 for(const c of curves){assert.deepEqual(c.getPoint(0),a);assert.deepEqual(c.getPoint(1),a);assert.ok(c.getLength()>1);}
 assert.ok(curves[1].getPoint(.5).distanceTo(curves[0].getPoint(.5))>.2);
});
test('floating updates reuse buffers and keep highlighted tube aligned to current curvature',()=>{
 const c=new FloatingEdgeCurve(new THREE.Vector3(),new THREE.Vector3(4,1,0),'A','B');
 c.seed=12345;c.speed=.5;
 const line=new THREE.BufferGeometry().setFromPoints(c.getPoints(36)),tube=new THREE.TubeGeometry(c,36,.014,5,false);
 const lineBuffer=line.attributes.position.array,tubeBuffer=tube.attributes.position.array,before=c.getPoint(.5);c.time=4;c.needsUpdate=true;
 updateLineGeometry(line,c);updateTubeGeometry(tube,c);
 assert.strictEqual(line.attributes.position.array,lineBuffer);assert.strictEqual(tube.attributes.position.array,tubeBuffer);assert.ok(c.getPoint(.5).distanceTo(before)>.0001);assert.ok(c.getPoint(.5).distanceTo(before)<.8);
 assert.ok(new THREE.Vector3().fromBufferAttribute(line.attributes.position,18).distanceTo(c.getPoint(.5))<1e-6);
 for(let i=0;i<=36;i++){const center=c.getPointAt(i/36);for(let j=0;j<=5;j++)assert.ok(Math.abs(new THREE.Vector3().fromBufferAttribute(tube.attributes.position,i*6+j).distanceTo(center)-.014)<1e-5);}
 line.dispose();tube.dispose();
});
test('random drift is bounded, smooth across waypoints and independent for parallel edges',()=>{
 const a=new FloatingEdgeCurve(new THREE.Vector3(),new THREE.Vector3(4,0,0),'A','B');
 const b=new FloatingEdgeCurve(a.start,a.end,'A','B');a.seed=12345;b.seed=67890;a.speed=b.speed=.5;
 let different=false;const samples=[];
 for(let i=0;i<40;i++){
  a.time=b.time=i*.5;const p=a.getPoint(.5);samples.push(p);different ||= p.distanceTo(b.getPoint(.5))>1e-4;
  const baseline=a.start.clone().lerp(a.end,.5).addScaledVector(a.u,a.bow).addScaledVector(a.v,a.wave);
  assert.ok(p.distanceTo(baseline)<.37);
  a.time+=1e-5;assert.ok(p.distanceTo(a.getPoint(.5))<1e-5);
 }
 assert.ok(different);
 assert.ok(Math.max(...samples.flatMap(p=>samples.map(q=>p.distanceTo(q))))>.2,'breeze must visibly travel more than a node width');
});
test('default wind transitions take 15–25 seconds and retain the same path at slower speed',()=>{
 const slow=new FloatingEdgeCurve(new THREE.Vector3(),new THREE.Vector3(8,0,0),'A','B');
 const previous=new FloatingEdgeCurve(slow.start,slow.end,'A','B');
 assert.ok(slow.speed>=1/25&&slow.speed<=1/15);
 previous.seed=slow.seed=12345;previous.speed=.2;
 for(const seconds of [0,1,5,10,20,40]){
  slow.time=seconds;previous.time=seconds*slow.speed/previous.speed;
  for(const t of [.2,.5,.8])assert.ok(slow.getPoint(t).distanceTo(previous.getPoint(t))<1e-12);
 }
});
