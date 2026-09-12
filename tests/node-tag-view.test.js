import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileModel,JKEngine} from '../src/engine.js';
import {displayNodeId} from '../src/node-id.js';
import {createLayout,LAYOUT_MODES} from '../src/layout.js';
import {NetworkView} from '../src/view.js';
import {disposeGroup} from '../src/resources.js';

const raw={
  nodes:[
    {id:'Q9007199254740993',ex:'J0K(Q10)'},
    {id:'Q10',ex:'J0K(Q2)'},
    {id:'Q2',ex:'J0K(X0)'},
    {id:'Q9007199254740992',ex:'J0K(Q10)K(Q9007199254740993)'},
  ],
  initial_q:{0:[],1:[]},q_y:[{Y0:'Q9007199254740992'}],
};
function taggedModel(legacy=false){
  const next=structuredClone(raw);
  const tags=new Map(next.nodes.map((n,i)=>[n.id,`L${3-i}B7`]));
  for(const node of next.nodes){
    const tag=tags.get(node.id);
    if(legacy)node.id+=tag;else node.tag=tag;
    node.ex=node.ex.replace(/Q\d+/g,id=>id+tags.get(id));
  }
  if(legacy)next.q_y[0].Y0+=tags.get(next.q_y[0].Y0);
  return compileModel(next);
}

test('tags and legacy suffixes preserve every layout and numeric order beyond Number precision',()=>{
  const plain=compileModel(raw),tagged=taggedModel(),legacy=taggedModel(true);
  assert.equal(tagged.valid.length,4);assert.equal(legacy.valid.length,4);
  for(const mode of LAYOUT_MODES){
    const expected=createLayout(plain,mode);
    assert.deepEqual(createLayout(tagged,mode),expected);
    assert.deepEqual(createLayout(legacy,mode),expected);
  }
  const vertical=createLayout(legacy,'1D');
  const sorted=[...legacy.nodes].sort((a,b)=>vertical.positions.get(b.key).y-vertical.positions.get(a.key).y);
  assert.deepEqual(sorted.map(n=>n.id),['Q2','Q10','Q9007199254740992','Q9007199254740993']);
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

test('scene labels retain tags across layouts while selection and propagation use canonical IDs',t=>{
  const model=taggedModel(true),view=setupView(t,model),engine=new JKEngine(model);
  const selected=model.nodes.find(n=>n.id==='Q10'),camera=view.camera.position.toArray();
  view.refresh(engine);view.select(selected.key);
  for(const mode of LAYOUT_MODES){
    view.applyLayout(createLayout(model,mode));
    for(const node of model.nodes){
      const visual=view.visuals.get(node.key);
      assert.equal(visual.title.text,node.displayName);assert.equal(visual.id,node.id);
      assert.equal(visual.mesh.userData.key,node.key);
    }
    assert.deepEqual(view.camera.position.toArray(),camera);
    for(const edge of view.edges)assert.equal(!!edge.highlight?.visible,edge.source==='Q10'||edge.targetKey===selected.key);
  }
  view.available=true;view.showTransfers([{source:'Q10',target:'Q9007199254740993',value:1}]);
  assert.equal(view.signals.length,1);assert.ok(view.edges.every(e=>!/L\dB7/.test(e.source+e.target)));
});

test('duplicate fixed IDs keep each invalid node own display label and selection key',t=>{
  const model=compileModel({nodes:[{id:'Q215L9B7',ex:'J0K1'},{id:'Q215L9B8',ex:'J0K1'}],initial_q:{0:[],1:[]},q_y:[]});
  const view=setupView(t,model);
  assert.equal(model.valid.length,0);
  assert.deepEqual([...view.visuals.values()].map(v=>v.title.text),['Q215L9B7','Q215L9B8']);
  assert.equal(new Set([...view.visuals.values()].map(v=>v.mesh.userData.key)).size,2);
  assert.equal(displayNodeId(model,'Q215'),'Q215','ambiguous references must not borrow either tag');
});

// Run the actual inspector function with a minimal DOM, including its early error return.
const main=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
const inspectorSource=main.slice(main.indexOf('function renderInspector(){'),main.indexOf('\nfunction renderQueue(){'));
function element(tag,text,className){
  return {tag,textContent:text??'',className,children:[],append(...items){this.children.push(...items);},replaceChildren(){this.children=[];}};
}
const contents=node=>[node.textContent,...node.children.flatMap(child=>contents(child))];
test('inspector shows fixed ID and tag separately even when a tagged node is invalid',()=>{
  const model=compileModel({nodes:[{id:'Q215L9B7',ex:'J0K(MISSING)'}],initial_q:{0:[],1:[]},q_y:[]});
  const engine=new JKEngine(model),dom=new Map([['inspector',element('div')],['selected-id',element('h2')]]);
  const render=new Function('$','el','model','engine','selected','displayNodeId',`${inspectorSource};return renderInspector;`)(id=>dom.get(id),element,model,engine,model.nodes[0].key,displayNodeId);
  render();
  assert.equal(dom.get('selected-id').textContent,'Q215L9B7');
  const text=contents(dom.get('inspector'));
  for(const expected of ['固定 ID','Q215','标记','L9B7','J0K(MISSING)'])assert.ok(text.includes(expected),expected);
  assert.ok(text.some(value=>String(value).includes(model.nodes[0].errors[0])));
});

test('an invalid output reference displays its original mismatched tag',()=>{
  const model=compileModel({nodes:[{id:'Q215',tag:'L9B7',ex:'J0K1'}],initial_q:{0:[],1:[]},q_y:[{Y0:'Q215L9B8'}]});
  const engine=new JKEngine(model),dom=new Map([['inspector',element('div')],['selected-id',element('h2')]]);
  const render=new Function('$','el','model','engine','selected','displayNodeId',`${inspectorSource};return renderInspector;`)(id=>dom.get(id),element,model,engine,'Y0',displayNodeId);
  render();
  assert.ok(contents(dom.get('inspector')).includes('输出来源 Q215L9B8'));
  assert.ok(!contents(dom.get('inspector')).includes('输出来源 Q215L9B7'));
});
