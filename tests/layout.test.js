import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileModel,JKEngine} from '../src/engine.js';
import {createLayout,LAYOUT_MODES,spherePoints,layoutEdges,readability} from '../src/layout.js';
const make=(ex,outputs=[])=>compileModel({nodes:ex.map((ex,i)=>({id:`Q${i}`,ex})),initial_q:{'0':[],'1':[]},q_y:outputs});
const fixture=()=>compileModel(JSON.parse(readFileSync(new URL('jk-logic-structure-v262.json',import.meta.url),'utf8')));
const b=ps=>Object.fromEntries(['x','y','z'].map(a=>[a,[Math.min(...ps.map(p=>p[a])),Math.max(...ps.map(p=>p[a]))]]));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const separation=r=>{const ps=[...r.positions.values()];for(let i=0;i<ps.length;i++){assert.ok(Object.values(ps[i]).every(Number.isFinite));for(let j=0;j<i;j++)assert.ok(distance(ps[i],ps[j])>=1-1e-9);}};
test('all layouts deterministic, finite and separated for fixture, singleton, empty and feedback graphs',()=>{
 for(const model of [fixture(),make(['J0K(X0)']),make([]),make(['J0K(Q1)','J0K(Q0)','J0K(Q2)','J0'])])for(const mode of LAYOUT_MODES){const r=createLayout(model,mode);assert.deepEqual(r,createLayout(model,mode));separation(r);assert.ok(Number.isFinite(r.metrics.score));}
});
test('1D has three vertical columns, numbered from top to bottom on Y with Z zero',()=>{
 const model=fixture(),r=createLayout(model,'1D');
 const columns=[model.inputs,model.nodes.map(n=>n.key),model.outputs.map(o=>o.id)];
 let last=-Infinity;
 for(const keys of columns){const ps=keys.map(k=>r.positions.get(k));assert.equal(new Set(ps.map(p=>p.x)).size,1);assert.ok(ps.every(p=>p.z===0));assert.ok(ps[0].x>last);last=ps[0].x;for(let i=1;i<ps.length;i++)assert.equal(ps[i-1].y-ps[i].y,1);}
});
test('swapped axes fill all node groups downward on Y with matching world bounds and scores',()=>{
 const model=make(Array.from({length:5},(_,i)=>`J0K(X${i})`),Array.from({length:5},(_,i)=>({['Y'+i]:'Q'+i}))),r=createLayout(model,'2D');
 for(const keys of [model.inputs,model.nodes.map(n=>n.key),model.outputs.map(o=>o.id)]){
  const ps=keys.map(k=>r.positions.get(k));assert.deepEqual(ps.map(p=>[p.y,p.z]),[[.5,1],[.5,0],[.5,-1],[-.5,1],[-.5,0]]);
 }
 for(const mode of LAYOUT_MODES){const layout=createLayout(model,mode),box=b([...layout.positions.values()]);for(const axis of ['x','y','z']){assert.equal(layout.bounds.min[axis],box[axis][0]);assert.equal(layout.bounds.max[axis],box[axis][1]);}assert.equal(layout.axisOrder,layout.mode==='1D'?'xyz':'x,-z,y');const metrics=readability(layout,layoutEdges(model));assert.ok(Math.abs(metrics.score-layout.metrics.score)<1e-9);}
});
test('2D gives each category a nearly square YZ plane centered along the X axis',()=>{
 const model=fixture(),r=createLayout(model,'2D');
 for(const keys of [model.inputs,model.nodes.map(n=>n.key),model.outputs.map(o=>o.id)]){const ps=keys.map(k=>r.positions.get(k)),box=b(ps);assert.ok(ps.every(p=>p.x===ps[0].x));assert.equal(box.y[0]+box.y[1],0);assert.equal(box.z[0]+box.z[1],0);assert.ok(Math.abs((box.z[1]-box.z[0])-(box.y[1]-box.y[0]))<=1);assert.ok(box.z[1]>box.z[0]);}
});
test('3D uses a near cube only for JK; terminals stay identical YZ planes',()=>{
 const model=fixture(),r=createLayout(model,'3D'),flat=createLayout(model,'2D');
 const box=b(model.nodes.map(n=>r.positions.get(n.key))),sizes=['x','y','z'].map(a=>box[a][1]-box[a][0]);assert.ok(sizes.every(v=>v>0));assert.ok(Math.max(...sizes)-Math.min(...sizes)<=1);
 for(const keys of [model.inputs,model.outputs.map(o=>o.id)]){const ps=keys.map(k=>r.positions.get(k));assert.ok(ps.every(p=>p.x===ps[0].x));const shift=ps[0].x-flat.positions.get(keys[0]).x;keys.forEach((k,i)=>assert.deepEqual(ps[i],{...flat.positions.get(k),x:flat.positions.get(k).x+shift}));}
});
test('4D uses references rather than numeric IDs and never reverses acyclic edges on X',()=>{
 const model=make(Array.from({length:16},(_,i)=>i===15?'J0K(X0)':`J0K(Q${i+1})`));
 const r=createLayout(model,'4D'),regular=createLayout(model,'3D');assert.notDeepEqual(r.positions,regular.positions);
 for(const e of layoutEdges(model))if(r.topologyRanks.has(e.source))assert.ok(r.positions.get(e.source).x<=r.positions.get(e.target).x);
 const box=b(model.nodes.map(n=>r.positions.get(n.key)));assert.ok(['x','y','z'].every(a=>box[a][1]>box[a][0]));
});
test('all modes preserve at least three units between the three regions',()=>{
 const model=fixture();for(const mode of LAYOUT_MODES){const r=createLayout(model,mode),qs=model.nodes.map(n=>r.positions.get(n.key).x);assert.ok(model.inputs.every(k=>r.positions.get(k).x<=Math.min(...qs)-3));assert.ok(model.outputs.every(o=>r.positions.get(o.id).x>=Math.max(...qs)+3));}
});
test('5D pins direct input references and output sources to opposite single boundary planes',()=>{
 const model=make(['J0K(X0)','J0K(X1)','J0K(Q0)','J0K(Q1)','J0K(Q2)K(Q3)','J0K(Q4)'],[{Y0:'Q5'},{Y1:'Q1'}]);const r=createLayout(model,'5D');
 assert.deepEqual(r.inputKeys,['node-0','node-1']);assert.deepEqual(r.outputKeys,['node-5']);assert.deepEqual(r.dualKeys,['node-1']);assert.equal(r.conflictPolicy,'input-first');
 for(const k of r.inputKeys)assert.equal(r.positions.get(k).x,r.leftX);
 for(const k of r.outputKeys)assert.equal(r.positions.get(k).x,r.rightX);
 for(const d of r.decisions){const x=r.positions.get(d.key).x;assert.ok(x>r.leftX&&x<r.rightX);}separation(r);
});
test('sphere candidates expand in complete unit lattice shells',()=>{
 const ps=spherePoints(24);let last=-1;const keys=new Set(ps.map(p=>`${p.x},${p.y},${p.z}`));
 for(const p of ps){const rr=p.x*p.x+p.y*p.y+p.z*p.z;assert.ok(rr>=last);last=rr;assert.ok(Object.values(p).every(Number.isInteger));assert.ok(keys.has(`${-p.x},${-p.y},${-p.z}`));}
});
test('5D chooses minimum own-reference distance among available spherical slots, including repeated refs',()=>{
 const model=make(['J0K(X0)','J0K(Q0)','J0K(Q0)K(Q1)K(Q1)','J0K(Q2)','J0K(Q2)K(Q3)','J0K(Q4)'],[{Y0:'Q5'}]);
 const r=createLayout(model,'5D'),positions=new Map(r.seedPositions),free=new Set(r.candidates.map((_,i)=>i)),slots=new Map(),occupants=new Map(),edges=layoutEdges(model);
 assert.equal(edges.filter(e=>e.source==='node-1'&&e.target==='node-2').length,2);
 for(const d of r.decisions){const p=positions.get(d.key),slot=r.candidates.findIndex(q=>distance(p,q)<1e-9);slots.set(d.key,slot);occupants.set(slot,d.key);}
 for(const d of r.decisions){const old=slots.get(d.key),p=positions.get(d.key),refs=edges.filter(e=>e.target===d.key);let minimum=Infinity;
  for(const slot of free){const q=r.candidates[slot],other=occupants.get(slot);const cost=refs.reduce((sum,e)=>sum+distance(q,e.source===d.key?q:e.source===other?p:positions.get(e.source)),0);minimum=Math.min(minimum,cost);}
  assert.ok(Math.abs(minimum-d.referenceDistance)<1e-8);
  const other=occupants.get(d.slot);if(other&&other!==d.key){positions.set(other,p);slots.set(other,old);occupants.set(old,other);}else occupants.delete(old);
  positions.set(d.key,r.candidates[d.slot]);slots.set(d.key,d.slot);occupants.set(d.slot,d.key);free.delete(d.slot);
 }
 assert.deepEqual(positions,r.positions);
});
test('automatic chooses only the five defined modes and the lowest candidate score',()=>{
 const model=fixture(),auto=createLayout(model,'auto');assert.ok(LAYOUT_MODES.slice(1).includes(auto.mode));for(const mode of LAYOUT_MODES.slice(1))assert.ok(auto.metrics.score<=createLayout(model,mode).metrics.score+1e-9);
 if(auto.mode==='1D')assert.deepEqual(auto.positions,createLayout(model,'1D').positions);
});
test('omitting the layout mode selects 4D topology rather than automatic selection',()=>{
 const model=fixture(),layout=createLayout(model);assert.equal(layout.mode,'4D');assert.equal(layout.requestedMode,'4D');assert.equal(layout.automatic,undefined);assert.deepEqual(layout.positions,createLayout(model,'4D').positions);
});
test('layout changes leave model, q and queued execution unchanged',()=>{
 const e=new JKEngine(fixture());e.send(Object.fromEntries(e.model.inputs.map(k=>[k,0])));const before={length:e.length,item:e.itemAt(0),q:[...e.latest],model:structuredClone(e.model)};
 for(const mode of LAYOUT_MODES)createLayout(e.model,mode);assert.equal(e.length,before.length);assert.deepEqual(e.itemAt(0),before.item);assert.deepEqual([...e.latest],before.q);assert.deepEqual(e.model,before.model);
});
