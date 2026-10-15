import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectorHarness} from '../helpers/ui-harness.js';
import {compileModel,JKEngine} from '../../src/jk/engine.js';
import {displayNodeId} from '../../src/jk/node-id.js';
import {createLayout,LAYOUT_MODES} from '../../src/scene/layout.js';
import {NetworkView} from '../../src/scene/view.js';
import {disposeGroup} from '../../src/scene/resources.js';

const raw={
  nodes:[
    {id:'Q0',ex:'J0K(X0)'},
    {id:'Q1',ex:'J0K(Q0)'},
    {id:'Q2',ex:'J0K(Q1)'},
    {id:'Q3',ex:'J0K(Q1)K(Q2)'},
  ],
  initial_q:{0:['Q0'],1:[]},q_y:[{Y0:'Q3'}],
};
test('V4 fixed identities preserve deterministic layout and numeric order',()=>{
  const plain=compileModel(raw),tagged=compileModel(structuredClone(raw));
  assert.equal(tagged.valid.length,4);
  for(const mode of LAYOUT_MODES){
    const expected=createLayout(plain,mode);
    assert.deepEqual(createLayout(tagged,mode),expected);
  }
  const vertical=createLayout(tagged,'1D');
  const sorted=[...tagged.nodes].sort((a,b)=>vertical.positions.get(b.key).y-vertical.positions.get(a.key).y);
  assert.deepEqual(sorted.map(n=>n.id),['Q0','Q1','Q2','Q3']);
});

function setupView(t,model){
  const oldDocument=globalThis.document,oldWorker=globalThis.Worker;
  const context={clearRect(){},fillText(){},measureText(text){return {width:text.length*19};}};
  globalThis.document={hidden:false,createElement(){return {width:0,height:0,getContext:()=>context};}};
  globalThis.Worker=class {postMessage(){}terminate(){}};
  const view=new NetworkView({closest:()=>null});view.setModel(model);
  t.after(()=>{
    view.layoutWorker?.terminate();view.labels?.dispose();view.batches?.dispose();
    for(const v of view.visuals.values())v.mesh.material.dispose();view.nodeGeometry?.dispose();
    disposeGroup(view.group);disposeGroup(view.signalGroup);view.outputBoard.clear();
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
    if(oldWorker===undefined)delete globalThis.Worker;else globalThis.Worker=oldWorker;
  });
  return view;
}

test('scene labels use fixed IDs across layouts and event selection',t=>{
  const model=compileModel(structuredClone(raw)),view=setupView(t,model),engine=new JKEngine(model);
  const selected=model.nodes.find(n=>n.id==='Q1'),camera=view.camera.position.toArray();
  view.refresh(engine);view.select(selected.key);
  for(const mode of LAYOUT_MODES){
    view.applyLayout(createLayout(model,mode));
    for(const node of model.nodes){
      const visual=view.visuals.get(node.key);
      assert.equal(visual.title.text,node.displayName);assert.equal(visual.id,node.id);
      assert.equal(visual.mesh.userData.key,node.key);
    }
    assert.deepEqual(view.camera.position.toArray(),camera);
    for(const edge of view.edges)assert.equal(!!edge.highlight?.visible,edge.source==='Q1'||edge.targetKey===selected.key);
  }
  view.available=true;view.showTransfers([{source:'Q1',target:'Q2',value:1}]);
  assert.equal(view.signals.length,1);assert.ok(view.edges.every(e=>!/L\dB7/.test(e.source+e.target)));
});

test('duplicate fixed IDs retain separate diagnostic rows and selection keys',t=>{
  const model=compileModel({nodes:[{id:'Q0',tag:'L9B7',ex:'J0K(X0)'},{id:'Q0',tag:'L9B8',ex:'J0K(X0)'}],initial_q:{0:[],1:[]},q_y:[]});
  const view=setupView(t,model);
  assert.equal(model.valid.length,0);
  const rows=model.nodes.map(node=>view.visuals.get(node.key));
  assert.deepEqual(rows.map(v=>v.title.text),['Q0','Q0']);
  assert.equal(new Set(rows.map(v=>v.mesh.userData.key)).size,2);
  assert.equal(displayNodeId(model,'Q0'),'Q0','ambiguous references must not borrow either tag');
});

// Run the actual inspector against the fixed panel elements in index.html.
test('inspector reports forbidden tag metadata without rendering it as an identity', () => {
  const model = compileModel({nodes: [{id: 'Q0', tag:'L9B7', ex: 'J0K(MISSING)'}], initial_q: {0: [], 1: []}, q_y: []});
  const engine = new JKEngine(model);
  const { $, render } = inspectorHarness(model, engine, model.nodes[0].key, displayNodeId);
  render();
  assert.equal($('selected-id').textContent, 'Q0');
  assert.equal($('inspector-jk').hidden, false);
  assert.equal($('inspector-fixed-id').textContent, 'Q0');
  assert.equal($('inspector-expression').textContent, 'J0K(MISSING)');
  assert.match($('inspector-jk').textContent, /固定 ID/);
  assert.match($('inspector-node-errors').textContent, /未定义字段 tag/);
  assert.ok($('inspector-node-errors').textContent.includes(model.nodes[0].errors[0]));
  assert.equal($('inspector-node-errors').hidden, false);
  assert.equal($('inspector-jk-state').hidden, true);
});

test('an invalid output reference displays its original mismatched tag', () => {
  const model = compileModel({nodes: [{id: 'Q0', tag: 'L9B7', ex: 'J0K(X0)'}], initial_q: {0: [], 1: []}, q_y: [{Y0: 'Q0L9B8'}]});
  const engine = new JKEngine(model);
  const { $, render } = inspectorHarness(model, engine, 'Y0', displayNodeId);
  render();
  assert.equal($('inspector-output').hidden, false);
  assert.equal($('inspector-output-source').textContent, '输出来源 Q0L9B8');
  assert.notEqual($('inspector-output-source').textContent, '输出来源 Q0L9B7');
  assert.equal($('inspector-output-value').textContent, model.outputs[0].error);
});
