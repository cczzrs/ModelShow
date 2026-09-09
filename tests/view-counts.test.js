import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {NetworkView} from '../src/view.js';
import {NodeLabels} from '../src/node-labels.js';

test('changing execution counts reuses glyph texture and handles without repainting the atlas',()=>{
  const draws=[],context={fillText(text){draws.push(text);},measureText(text){return {width:text.length*18};}};
  const labels=new NodeLabels({createCanvas:()=>({getContext:()=>context})});
  const count=labels.add('0 次',{color:'#5c7a96',size:17}),title=labels.add('Q0');
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(.1,.1,.1),new THREE.MeshBasicMaterial());
  count.position.set(2,-.36,3);
  const view=new NetworkView({}),visual={id:'Q0',type:'Q',base:0xffffff,mesh,title,count,lastCount:0};
  view.visuals.set('node-0',visual);view.labels=labels;labels.flush();
  const engine={outputs:new Map(),counts:new Map([['node-0',0]])};
  const texture=labels.atlas.texture;let disposed=0;texture.addEventListener('dispose',()=>disposed++);
  const version=texture.version,position=count.position.toArray(),initialDraws=draws.length;
  for(const value of [1,641,1000,1001,0]){
    engine.counts.set('node-0',value);view.refresh(engine);labels.flush();
    assert.equal(visual.count,count);assert.equal(labels.atlas.texture,texture);
    assert.deepEqual(count.position.toArray(),position);assert.equal(visual.lastCount,value);
    assert.equal(count.text,`${value} 次`);assert.equal(count.textColor.getHexString(),value>1000?'ff697e':'5c7a96');
    const stableVersion=texture.version;view.refresh(engine);labels.flush();assert.equal(texture.version,stableVersion);
  }
  assert.equal(texture.version,version);assert.equal(draws.length,initialDraws);assert.equal(disposed,0);
  labels.dispose();mesh.geometry.dispose();mesh.material.dispose();view.outputBoard.clear();assert.equal(disposed,1);
});
