import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {NetworkBatches} from '../src/network-batches.js';

const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} is not close to ${b}`);
const curve=(x=0)=>new THREE.LineCurve3(new THREE.Vector3(x,0,0),new THREE.Vector3(x,4,0));
const proxy=(x,color=0xffffff)=>{
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(.1,.1,.1),new THREE.MeshBasicMaterial({color}));mesh.position.x=x;return mesh;
};

test('network geometry uses four render objects regardless of model size and keeps cube face shading',()=>{
  const batch=new NetworkBatches(1000,2400);
  assert.equal(batch.group.children.length,4);
  assert.equal(batch.nodes.count,1000);assert.equal(batch.arrows.count,2400);
  assert.equal(batch.lines.geometry.attributes.position.count,2400*36*2);
  assert.equal(batch.lines.geometry.attributes.color.itemSize,4);
  assert.equal(batch.selectedArrows.visible,false);
  assert.equal(batch.nodes.material.vertexColors,true);
  const color=batch.nodes.geometry.attributes.color;
  [.8,.65,1,.55,.92,.72].forEach((shade,face)=>near(color.getX(face*4),shade));
  batch.dispose();
  const empty=new NetworkBatches(0,0);
  assert.ok(empty.group.children.every(object=>!object.visible));empty.commit();empty.dispose();
});

test('edge edits affect only their segment range and commit once without replacing GPU buffers',()=>{
  const batch=new NetworkBatches(0,3,{segments:4}),geometry=batch.lines.geometry,position=geometry.attributes.position;
  const data=position.array,colors=geometry.attributes.color;
  batch.setEdge(1,curve(2),.9);batch.setEdgeStyle(1,0x689ef3,false);
  assert.ok(Array.from(data.slice(0,24)).every(value=>value===0));
  assert.ok(Array.from(data.slice(48)).every(value=>value===0));
  assert.deepEqual(Array.from(data.slice(24,30)),[2,0,0,2,1,0]);
  assert.deepEqual(Array.from(data.slice(42,48)),[2,3,0,2,4,0]);
  const rgb=new THREE.Color(0x689ef3);
  for(let i=8;i<16;i++){near(colors.getX(i),rgb.r);near(colors.getY(i),rgb.g);near(colors.getZ(i),rgb.b);near(colors.getW(i),.4);}
  let bounds=0;const compute=geometry.computeBoundingSphere.bind(geometry);geometry.computeBoundingSphere=()=>{bounds++;compute();};
  const version=position.version;batch.setEdge(1,curve(3),.9);batch.commit();
  assert.equal(position.version,version+1);assert.equal(bounds,1);
  assert.deepEqual(position.updateRanges,[{start:24,count:24}]);
  batch.commit();assert.equal(position.version,version+1);assert.equal(bounds,1);
  batch.setEdge(2,curve(6),.9);batch.commit();
  assert.equal(batch.lines.geometry,geometry);assert.equal(position.array,data);
  assert.deepEqual(position.updateRanges,[{start:24,count:48}],'pending pre-upload edits are retained in one bounded range');
  assert.ok(geometry.boundingSphere.distanceToPoint(new THREE.Vector3(6,4,0))<1e-6);
  batch.dispose();
});

test('repeated culled or hidden commits keep pending uploads bounded and retain the latest values',()=>{
  const batch=new NetworkBatches(0,3,{segments:2}),position=batch.lines.geometry.attributes.position;
  batch.setEdge(0,curve(1),.9);batch.commit();
  for(let i=0;i<1000;i++){batch.setEdge(2,curve(i+2),.9);batch.commit();}
  assert.deepEqual(position.updateRanges,[{start:0,count:36}]);
  assert.equal(position.getX(0),1);assert.equal(position.getX(8),1001);
  position.clearUpdateRanges(); // The GPU consumed the previous draw's pending edits.
  batch.setEdge(1,curve(7),.9);batch.commit();
  assert.deepEqual(position.updateRanges,[{start:12,count:12}]);
  batch.dispose();
});

test('selection preserves line alpha, real arrow enlargement and its target-facing tip',()=>{
  const batch=new NetworkBatches(0,2,{segments:2}),arrow=new THREE.Object3D();
  arrow.position.set(3,5,7);arrow.quaternion.setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/2);arrow.scale.setScalar(99);
  batch.setEdge(0,curve(),.8,arrow);batch.setEdgeStyle(0,0x79dfae,false);batch.setEdgeStyle(1,0xffffff,false);batch.commit();
  const matrix=new THREE.Matrix4(),position=new THREE.Vector3(),rotation=new THREE.Quaternion(),scale=new THREE.Vector3();
  batch.arrows.getMatrixAt(0,matrix);matrix.decompose(position,rotation,scale);
  assert.deepEqual(position.toArray(),[3,5,7]);near(scale.x,1);near(rotation.angleTo(arrow.quaternion),0);
  const arrowGeometry=batch.arrows.geometry,geometry=batch.lines.geometry;
  batch.setEdgeStyle(0,0xff596e,true);batch.commit();
  assert.equal(batch.selectedArrows.visible,true);assert.equal(batch.arrows.visible,true);
  batch.selectedArrows.getMatrixAt(0,matrix);matrix.decompose(position,rotation,scale);near(scale.x,1.35);near(scale.y,1.35);near(scale.z,1.35);
  assert.deepEqual(position.toArray(),[3,5,7]);
  for(let i=0;i<4;i++)assert.equal(geometry.attributes.color.getW(i),1);
  assert.equal(batch.selectedArrows.material.opacity,1);assert.equal(batch.arrows.material.opacity,.8);
  assert.equal(batch.arrows.geometry,arrowGeometry);assert.equal(batch.selectedArrows.geometry,arrowGeometry);
  assert.ok(arrowGeometry.attributes.position.array.every(Number.isFinite));
  const tipY=Math.max(...Array.from({length:arrowGeometry.attributes.position.count},(_,i)=>arrowGeometry.attributes.position.getY(i)));near(tipY,0);
  batch.setEdgeStyle(1,0xffffff,true);assert.equal(batch.arrows.visible,false);
  batch.setEdgeStyle(0,0x79dfae,false);batch.setEdgeStyle(1,0xffffff,false);assert.equal(batch.selectedArrows.visible,false);
  batch.dispose();
});

test('node transforms and colors only upload when changed and instance picking retains indices',()=>{
  const batch=new NetworkBatches(2,0),left=proxy(-2,0x73aaff),right=proxy(2,0x79dfae);
  batch.setNode(0,left);batch.setNode(1,right);batch.commit();
  const matrixVersion=batch.nodes.instanceMatrix.version,colorVersion=batch.nodes.instanceColor.version;
  batch.setNode(0,left);batch.setNode(1,right);batch.commit();
  assert.equal(batch.nodes.instanceMatrix.version,matrixVersion);assert.equal(batch.nodes.instanceColor.version,colorVersion);
  batch.group.updateMatrixWorld(true);
  const ray=new THREE.Raycaster(new THREE.Vector3(2,0,5),new THREE.Vector3(0,0,-1));
  const hit=ray.intersectObject(batch.nodes)[0];assert.equal(hit.instanceId,1);
  right.position.set(4,2,1);right.material.color.setHex(0xff596e);batch.setNode(1,right);batch.commit();
  assert.equal(batch.nodes.instanceMatrix.version,matrixVersion+1);assert.equal(batch.nodes.instanceColor.version,colorVersion+1);
  const color=new THREE.Color();batch.nodes.getColorAt(1,color);near(color.r,right.material.color.r);near(color.g,right.material.color.g);
  assert.ok(batch.nodes.boundingSphere.containsPoint(right.position));
  batch.dispose();for(const mesh of [left,right]){mesh.geometry.dispose();mesh.material.dispose();}
});

test('disposal releases batch resources exactly once without owning CPU proxy resources',()=>{
  const batch=new NetworkBatches(1,1),node=proxy(0),scene=new THREE.Scene();scene.add(batch.group);batch.setNode(0,node);
  const resources=[batch.nodes,batch.arrows,batch.selectedArrows,batch.nodes.geometry,batch.arrows.geometry,batch.lines.geometry,...batch.group.children.map(object=>object.material)];
  const counts=resources.map(()=>0);resources.forEach((resource,i)=>resource.addEventListener('dispose',()=>counts[i]++));
  let proxyDisposals=0;node.geometry.addEventListener('dispose',()=>proxyDisposals++);node.material.addEventListener('dispose',()=>proxyDisposals++);
  batch.dispose();batch.dispose();
  assert.deepEqual(counts,resources.map(()=>1));assert.equal(proxyDisposals,0);assert.equal(scene.children.length,0);assert.equal(batch.group.children.length,0);
  assert.throws(()=>batch.setNode(0,node),/disposed/);node.geometry.dispose();node.material.dispose();
});

test('invalid batch sizes and indices fail before mutating adjacent data',()=>{
  assert.throws(()=>new NetworkBatches(-1,0),RangeError);assert.throws(()=>new NetworkBatches(1,1,{segments:0}),RangeError);
  const batch=new NetworkBatches(0,1);assert.throws(()=>batch.setEdge(1,curve(),1),RangeError);assert.throws(()=>batch.setEdgeStyle(-1,0xffffff),RangeError);batch.dispose();
});
