import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultDisplay, exportDisplayModel, exportCurrentDisplayModel} from '../src/output-display.js';

const bits = ids => ({kind:'bits',bits:ids,order:'msb-first',mapping:'direct'});
const liveDisplay = () => ({
  ...defaultDisplay(1,2),enabled:true,scale:2.5,
  pixels:[
    {mode:'channels',channels:{r:bits(['Y0','Y1']),g:{kind:'fixed',value:128},b:{kind:'fixed',value:0}}},
    {mode:'packed',bits:['Y1','Y0','Y2','Y3'],widths:{r:1,g:2,b:1},order:'lsb-first',mapping:'scale'},
  ],
});
const original = () => ({
  name:'same model',md5:'retain-this-original-hash',
  nodes:[{id:'Q0Old',ex:' J0 K(X0) '},{id:'Q1',tag:'L2',ex:'J0K(X1)'}],
  initial_q:{0:[],1:[]},q_y:[{Y0:'Q0Old'},{Y1:'Q1'}],
  metadata:{version:1,notes:[null,'unchanged'],nested:{custom:true}},
  outputDisplay:defaultDisplay(1,1),
});
const freeze = value => {
  if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}
  return value;
};
const reverseKeys = value => Array.isArray(value)
  ?value.map(reverseKeys)
  :value&&typeof value==='object'
    ?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reverseKeys(value[key])]))
    :value;

test('both export entry points capture the same current board and retain raw model fields',()=>{
  const loaded=freeze(original()),raw=freeze(JSON.parse(JSON.stringify(loaded))),config=freeze(liveDisplay());
  const exported=exportCurrentDisplayModel(raw,loaded,config);
  assert.deepEqual(exported,exportDisplayModel(loaded,config));
  assert.deepEqual(exported.outputDisplay,config);
  assert.equal(exported.md5,loaded.md5);
  assert.deepEqual(exported.nodes,loaded.nodes);
  assert.deepEqual(exported.metadata,loaded.metadata);
  assert.deepEqual(exported.initial_q,loaded.initial_q);
  assert.deepEqual(exported.q_y,loaded.q_y);
  assert.equal(raw.outputDisplay.scale,1,'the current scale is exported without changing the raw model');
  assert.equal(loaded.outputDisplay.enabled,false);
});

test('JSON formatting and nested object key order do not detach the loaded model from its board',()=>{
  const loaded=freeze(original()),raw=reverseKeys(JSON.parse(JSON.stringify(loaded,null,4))),config=liveDisplay();
  assert.notEqual(JSON.stringify(raw),JSON.stringify(loaded));
  const exported=exportCurrentDisplayModel(raw,loaded,config);
  assert.deepEqual(exported.outputDisplay,config);
  assert.deepEqual(exported.metadata,loaded.metadata);
  assert.deepEqual(exported.nodes,loaded.nodes);
});

test('a hidden current board still exports its dimensions, size and complete bindings',()=>{
  const loaded=original(),config=freeze({...liveDisplay(),enabled:false});
  const exported=exportCurrentDisplayModel(structuredClone(loaded),loaded,config);
  assert.deepEqual(exported.outputDisplay,config);
  assert.equal(exported.outputDisplay.enabled,false);
  assert.equal(exported.outputDisplay.rows,1);
  assert.equal(exported.outputDisplay.cols,2);
  assert.equal(exported.outputDisplay.scale,2.5);
  assert.deepEqual(exported.outputDisplay.pixels[1].bits,['Y1','Y0','Y2','Y3']);
});

test('a matching legacy model without outputDisplay gains the current configuration',()=>{
  const loaded=original();delete loaded.outputDisplay;
  const raw=freeze(structuredClone(loaded)),config=liveDisplay();
  assert.deepEqual(exportCurrentDisplayModel(raw,loaded,config),exportDisplayModel(loaded,config));
  assert.equal(Object.hasOwn(raw,'outputDisplay'),false);
});

test('drafts sharing a name and MD5 keep their own JSON instead of borrowing the loaded board',()=>{
  const loaded=freeze(original()),config=freeze(liveDisplay());
  const changes=[
    ['node expression',draft=>{draft.nodes[0].ex='J0K(X7)';}],
    ['output mapping',draft=>{draft.q_y[0].Y0='Q1';}],
    ['node array order',draft=>{draft.nodes.reverse();}],
    ['output array order',draft=>{draft.q_y.reverse();}],
    ['explicit display edit',draft=>{draft.outputDisplay.scale=7.5;}],
    ['removed display',draft=>{delete draft.outputDisplay;}],
    ['metadata key changed',draft=>{draft.metadata.nested={different:true};}],
    ['metadata primitive type',draft=>{draft.metadata.version='1';}],
  ];
  for(const [label,change] of changes){
    const draft=structuredClone(loaded);change(draft);freeze(draft);
    assert.equal(draft.name,loaded.name);
    assert.equal(draft.md5,loaded.md5);
    const exported=exportCurrentDisplayModel(draft,loaded,config);
    assert.deepEqual(exported,draft,label);
    assert.notEqual(exported,draft,`${label}: return an independent snapshot`);
  }
});

test('without a loaded model, a draft keeps its own board or absence of one',()=>{
  for(const loaded of [undefined,null]){
    for(const hasDisplay of [true,false]){
      const raw=original();if(!hasDisplay)delete raw.outputDisplay;freeze(raw);
      const exported=exportCurrentDisplayModel(raw,loaded,liveDisplay());
      assert.deepEqual(exported,raw);
      assert.notEqual(exported,raw);
      assert.equal(Object.hasOwn(exported,'outputDisplay'),hasDisplay);
    }
  }
});

test('export snapshots share no mutable model or board arrays with their inputs',()=>{
  const loaded=freeze(original()),config=freeze(liveDisplay());
  const exported=exportCurrentDisplayModel(structuredClone(loaded),loaded,config);
  exported.nodes[0].ex='changed after export';
  exported.metadata.notes.push('added after export');
  exported.outputDisplay.pixels[0].channels.r.bits.reverse();
  assert.equal(loaded.nodes[0].ex,' J0 K(X0) ');
  assert.deepEqual(loaded.metadata.notes,[null,'unchanged']);
  assert.deepEqual(config.pixels[0].channels.r.bits,['Y0','Y1']);
  const draft=original();draft.name='not installed';draft.outputDisplay=liveDisplay();freeze(draft);
  const draftExport=exportCurrentDisplayModel(draft,loaded,config);
  draftExport.metadata.nested.custom=false;
  draftExport.outputDisplay.pixels[1].bits.push('Y9');
  assert.equal(draft.metadata.nested.custom,true);
  assert.deepEqual(draft.outputDisplay.pixels[1].bits,['Y1','Y0','Y2','Y3']);
});
