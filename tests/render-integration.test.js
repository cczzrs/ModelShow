import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {NetworkView} from '../src/view.js';
import {compileModel,JKEngine} from '../src/engine.js';
import {createLayout} from '../src/layout.js';
import {disposeGroup} from '../src/resources.js';

function setup(t){
  const oldDocument=globalThis.document,oldWorker=globalThis.Worker;
  const context={clearRect(){},fillText(){},measureText(text){return {width:text.length*19};}};
  globalThis.document={hidden:false,createElement(){return {width:0,height:0,getContext:()=>context};}};
  globalThis.Worker=class {postMessage(message){this.message=message;}terminate(){this.terminated=true;}};
  let now=0; t.mock.method(performance,'now',()=>now);
  const model=compileModel({nodes:[{id:'Q0',ex:'J0K(X0)'},{id:'Q1',ex:'J0K(Q0)'},{id:'Q2',ex:'J(Q0)K(Q2)'}],initial_q:{0:['Q2'],1:[]},q_y:[{Y0:'Q1'}]});
  const view=new NetworkView({closest:()=>null}),engine=new JKEngine(model),draws=[];
  view.setModel(model);view.refresh(engine);view.available=true;
  view.controls={target:new THREE.Vector3(),update(){},dispose(){},minDistance:.2,maxDistance:200};
  view.renderer={render(){draws.push(now);},dispose(){},domElement:{remove(){}}};
  t.after(()=>{
    view.layoutWorker?.terminate();view.labels?.dispose();view.batches?.dispose();
    for(const v of view.visuals.values())v.mesh.material.dispose();view.nodeGeometry?.dispose();
    disposeGroup(view.group);disposeGroup(view.signalGroup);view.outputBoard.clear();
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
    if(oldWorker===undefined)delete globalThis.Worker;else globalThis.Worker=oldWorker;
  });
  return {view,engine,model,draws,draw(time,animate=true){now=time;view.render(animate);}};
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-5,`${a} != ${b}`);

test('all layouts keep off-scene pick proxies aligned with batch matrices and bounds without changing the camera',t=>{
  const {view,model}=setup(t),matrix=new THREE.Matrix4();
  view.camera.position.set(5,3,-8);view.camera.up.set(1,0,0);view.camera.lookAt(1,2,0);view.controls.target.set(1,2,0);
  const camera=[...view.camera.position.toArray(),...view.camera.quaternion.toArray(),...view.controls.target.toArray()];
  for(const mode of ['1D','2D','3D','4D','5D']){
    view.applyLayout(createLayout(model,mode));
    assert.deepEqual([...view.camera.position.toArray(),...view.camera.quaternion.toArray(),...view.controls.target.toArray()],camera);
    for(const [key,visual] of view.visuals){
      assert.equal(visual.mesh.parent,null,'picking proxies must not add per-node draw calls');
      assert.ok(view.pickObjects().includes(visual.mesh));
      view.batches.nodes.getMatrixAt(visual.batchIndex,matrix);
      const position=new THREE.Vector3().setFromMatrixPosition(matrix);
      near(position.distanceTo(visual.mesh.position),0);
      assert.ok(view.batches.nodes.boundingSphere.containsPoint(position));
      const ray=new THREE.Raycaster(position.clone().add(new THREE.Vector3(0,0,.5)),new THREE.Vector3(0,0,-1));
      assert.equal(ray.intersectObject(visual.mesh)[0].object.userData.key,key);
    }
  }
});

test('selection changes line alpha, arrow instances and thick connected curves even while wind is paused',t=>{
  const {view,model,draw}=setup(t),key=model.nodes.find(n=>n.id==='Q0').key;
  draw(0,false);view.select(key);draw(20,false);
  assert.ok(view.edges.some(edge=>edge.highlight?.visible));
  for(const [index,edge] of view.edges.entries()){
    const selected=edge.source==='Q0'||edge.targetKey===key;
    assert.equal(!!view.batches.active[index],selected);
    assert.equal(!!edge.highlight?.visible,selected);
    near(view.batches.lines.geometry.attributes.color.getW(index*72),selected?1:.4);
    if(selected){
      const matrix=new THREE.Matrix4(),scale=new THREE.Vector3();view.batches.selectedArrows.getMatrixAt(index,matrix);
      matrix.decompose(new THREE.Vector3(),new THREE.Quaternion(),scale);near(scale.x,1.35);
    }
  }
  view.applyLayout(createLayout(model,'2D'));draw(40,false);
  assert.ok(view.edges.filter(edge=>edge.source==='Q0'||edge.targetKey===key).every(edge=>edge.highlight?.visible));
  view.select(null);draw(60,false);
  assert.equal(view.batches.selectedArrows.visible,false);assert.ok(view.edges.every(edge=>!edge.highlight?.visible));
});

test('the real view stops paused submissions, wakes for labels and selections, and freezes hidden wind',t=>{
  const {view,model,draws,draw}=setup(t);
  draw(0,false);draw(20,false);draw(40,false);assert.equal(draws.length,1);
  view.setNodeLabelsHidden(true);draw(60,false);assert.equal(draws.length,2);
  assert.ok([...view.visuals.values()].every(v=>!v.title.visible&&!v.count.visible));
  draw(80,false);assert.equal(draws.length,2);
  view.select(model.nodes[0].key);draw(100,false);assert.equal(draws.length,3);
  draw(120,false);assert.equal(draws.length,3);
  const before=view.edgeTime;draw(140,true);draw(174,true);assert.ok(view.edgeTime>before);
  const wind=view.edgeTime,count=draws.length;
  document.hidden=true;draw(10000,true);draw(20000,true);
  assert.equal(view.edgeTime,wind);assert.equal(draws.length,count);
  document.hidden=false;draw(30000,true);assert.equal(view.edgeTime,wind);assert.equal(draws.length,count+1);
});

test('moving propagation gets the active cadence but a paused single-step endpoint does not render forever',t=>{
  const {view,draws,draw}=setup(t);
  view.showTransfers([{source:'X0',target:'Q0',value:1}]);assert.equal(view.signals.length,1);
  view.progress(.5);draw(0);draw(17);draw(34);assert.equal(draws.length,3);
  view.progress(1);draw(51,false);const count=draws.length;
  draw(68,false);draw(85,false);draw(102,false);assert.equal(draws.length,count);
  assert.equal(view.signals.length,1,'single-step values remain at the endpoint while drawing sleeps');
});

test('model replacement releases each old batch, label and proxy resource once',t=>{
  const {view,model}=setup(t);view.select(model.nodes[0].key);
  const resources=[view.nodeGeometry,...[...view.visuals.values()].map(v=>v.mesh.material),
    view.batches.nodes,view.batches.arrows,view.batches.selectedArrows,view.batches.nodes.geometry,view.batches.arrows.geometry,view.batches.lines.geometry,
    ...view.batches.group.children.map(v=>v.material),view.labels.atlas.texture,...view.labels.pages.flatMap(p=>[p.geometry,p.material]),
    ...view.edges.filter(e=>e.highlight).flatMap(e=>[e.highlight.geometry,e.highlight.material])];
  assert.equal(new Set(resources).size,resources.length);
  const counts=resources.map(()=>0);resources.forEach((resource,i)=>resource.addEventListener('dispose',()=>counts[i]++));
  view.setModel(model);assert.deepEqual(counts,resources.map(()=>1));
});

test('renderer recovery retains batch and atlas identities, values, selection and rolled camera',async t=>{
  const {view,model,engine,draw}=setup(t);view.select(model.nodes[0].key);draw(0,false);
  view.camera.position.set(9,3,15);view.camera.up.set(1,0,0);view.camera.lookAt(1,2,0);view.controls.target.set(1,2,0);
  const state={batches:view.batches,labels:view.labels,atlas:view.labels.atlas.texture,selected:view.selected,
    camera:[...view.camera.position.toArray(),...view.camera.quaternion.toArray(),...view.camera.up.toArray(),...view.controls.target.toArray()]};
  const oldControls=view.controls,oldRenderer=view.renderer;view.init=async()=>{view.controls={...oldControls,target:new THREE.Vector3()};view.renderer={...oldRenderer};view.available=true;};
  await view.recover();assert.equal(view.batches,state.batches);assert.equal(view.labels,state.labels);assert.equal(view.labels.atlas.texture,state.atlas);
  assert.equal(view.selected,state.selected);assert.equal(view.engine,engine);
  assert.deepEqual([...view.camera.position.toArray(),...view.camera.quaternion.toArray(),...view.camera.up.toArray(),...view.controls.target.toArray()],state.camera);
  const wind=view.edgeTime;draw(1000,true);assert.equal(view.edgeTime,wind,'GPU downtime must not advance the first recovered wind frame');
});
