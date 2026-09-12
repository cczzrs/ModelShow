/** Deterministic layouts in world units. This module never reads or mutates runtime q. */
import { compareNodes } from './node-id.js';
export const LAYOUT_MODES = ['auto', '1D', '2D', '3D', '4D', '5D'];
export const DEFAULT_LAYOUT_MODE = '4D';
const EPS = 1e-9;
const radius2 = p => p.x*p.x + p.y*p.y + p.z*p.z;
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const nodeOrder = compareNodes;
const centerOrder = (a,b) => radius2(a)-radius2(b) || a.x-b.x || a.y-b.y || a.z-b.z;
const parameterCount = n => n.tokens.filter(t=>t.source).length;
const negate = value => value===0?0:-value;
const toWorldPoint = p => ({x:p.x,y:negate(p.z),z:p.y});
const toConstructionPoint = p => ({x:p.x,y:p.z,z:negate(p.y)});
const transformMap = (positions,transform) => new Map([...positions].map(([key,p])=>[key,transform(p)]));
const centered = points => {
  if(!points.length)return points;
  const b=bounds(points);
  return points.map(p=>({x:p.x-(b.min.x+b.max.x)/2,y:p.y-(b.min.y+b.max.y)/2,z:p.z-(b.min.z+b.max.z)/2}));
};
/** Construction coordinates; 1D stays vertical, other modes rotate Y/Z on return. */
export function gridPoints(count, dimensions) {
  if(!count)return [];
  if(dimensions===1)return Array.from({length:count},(_,i)=>({x:0,y:(count-1)/2-i,z:0}));
  const side=Math.ceil(Math.pow(count,1/dimensions));
  return centered(Array.from({length:count},(_,i)=>({
    x:dimensions===3?Math.floor(i/side)%side:0,y:-(i%side),z:dimensions===3?Math.floor(i/(side*side)):Math.floor(i/side),
  })));
}
/** Complete lattice shells, ordered from the sphere center outward. */
export function spherePoints(count) {
  if(!count)return [];
  let radius=Math.max(1,Math.ceil(Math.cbrt(count*3/(4*Math.PI)))),points=[];
  while(points.length<count){
    points=[];
    for(let x=-radius;x<=radius;x++)for(let y=-radius;y<=radius;y++)for(let z=-radius;z<=radius;z++)if(x*x+y*y+z*z<=radius*radius)points.push({x,y,z});
    if(points.length<count)radius++;
  }
  points.sort(centerOrder);
  // Keep the full outer shell so equal-radius directions are not truncated.
  const limit=radius2(points[count-1]);return points.filter(p=>radius2(p)<=limit);
}
export function layoutEdges(model) {
  const byId=new Map();
  for(const n of model.nodes)if(!byId.has(n.id))byId.set(n.id,n.key);
  const edges=[];
  for(const n of model.nodes)for(const t of n.tokens)if(t.source){
    const source=t.source.startsWith('X')?t.source:byId.get(t.source);
    if(source)edges.push({source,target:n.key}); // Repeated J/K tokens are real separate drawn edges.
  }
  for(const o of model.outputs)if(byId.has(o.source))edges.push({source:byId.get(o.source),target:o.id});
  return edges;
}
function bounds(points) {
  const b={min:{x:Infinity,y:Infinity,z:Infinity},max:{x:-Infinity,y:-Infinity,z:-Infinity}};
  for(const p of points)for(const a of ['x','y','z']){b.min[a]=Math.min(b.min[a],p[a]);b.max[a]=Math.max(b.max[a],p[a]);}
  if(b.min.x===Infinity)b.min=b.max={x:0,y:0,z:0};
  return b;
}
function terminals(model,positions,mode,envelope=[...positions.values()]) {
  const b=bounds(envelope);
  for(const [ids,input]of [[model.inputs,true],[model.outputs.map(o=>o.id),false]]){
    const ps=gridPoints(ids.length,mode==='1D'?1:2),pb=bounds(ps);
    const offset=input?b.min.x-3-pb.max.x:b.max.x+3-pb.min.x;
    ids.forEach((id,i)=>positions.set(id,{x:ps[i].x+offset,y:ps[i].y,z:ps[i].z}));
  }
  return positions;
}
export function wireLength(positions,edges) {
  return edges.reduce((sum,e)=>{const a=positions.get(e.source),b=positions.get(e.target);return sum+(a&&b?distance(a,b):0);},0);
}
function basic(model,nodes,mode) {
  const candidates=gridPoints(nodes.length,Number(mode[0]));
  const positions=new Map(nodes.map((n,i)=>[n.key,candidates[i]]));
  terminals(model,positions,mode);
  return {positions,candidates,mode,description:{'1D':'三列竖排 · Y 轴从上到下','2D':'YZ 平面 · 先沿 Z 再沿 Y 向下 · 三区中心沿 X 轴','3D':'YZ 输入输出 · JK 近似正方体'}[mode]};
}
/** Within fixed x slices, reduce actual wire length without reversing topology order. */
function optimizeSlices(positions,nodes,edges){
 const slices=new Map(),incident=new Map();
 for(const n of nodes){const x=positions.get(n.key).x;if(!slices.has(x))slices.set(x,[]);slices.get(x).push(n.key);}
 edges.forEach((e,i)=>{for(const k of new Set([e.source,e.target])){if(!incident.has(k))incident.set(k,[]);incident.get(k).push(i);}});
 for(let pass=0;pass<2;pass++)for(const keys of slices.values())for(let i=0;i<keys.length;i++){
  const a=keys[i];let best=null,bestDelta=-EPS;
  // Bounded neighborhood for large models; all alternatives on ordinary cube slices.
  for(let j=i+1;j<Math.min(keys.length,i+65);j++){
   const b=keys[j],pa=positions.get(a),pb=positions.get(b),affected=new Set([...(incident.get(a)??[]),...(incident.get(b)??[])]);
   const at=k=>k===a?pb:k===b?pa:positions.get(k);let delta=0;
   for(const eidx of affected){const e=edges[eidx],p=positions.get(e.source),q=positions.get(e.target);if(p&&q)delta+=distance(at(e.source),at(e.target))-distance(p,q);}
   if(delta<bestDelta){best=b;bestDelta=delta;}
  }
  if(best){const p=positions.get(a);positions.set(a,positions.get(best));positions.set(best,p);}
 }
}
function topological(model,nodes,edges){
 const topology=topologyOrder(nodes,edges);
 const candidates=gridPoints(nodes.length,3).sort((a,b)=>a.x-b.x||a.z-b.z||b.y-a.y);
 const sorted=[...nodes].sort((a,b)=>topology.ranks.get(a.key)-topology.ranks.get(b.key)||topology.components.get(a.key)-topology.components.get(b.key)||nodeOrder(a,b));
 const positions=new Map(sorted.map((n,i)=>[n.key,candidates[i]]));
 terminals(model,positions,'4D');optimizeSlices(positions,nodes,edges);
 return {positions,candidates,topologyRanks:topology.ranks,mode:'4D',description:'XYZ 拓扑结构 · 连线距离优化'};
}
/** Pin boundary nodes; optimize each free node's own referenced-source distances. */
function five(model,nodes,edges) {
  const base=topological(model,nodes,edges);
  const inputNodes=nodes.filter(n=>n.tokens.some(t=>t.source?.startsWith('X')));
  const inputSet=new Set(inputNodes.map(n=>n.key));
  const outputSources=new Set(model.outputs.map(o=>o.source));
  const dualKeys=nodes.filter(n=>inputSet.has(n.key)&&outputSources.has(n.id)).map(n=>n.key);
  // A single node cannot occupy both extreme planes. Input priority is explicit.
  const outputNodes=nodes.filter(n=>outputSources.has(n.id)&&!inputSet.has(n.key));
  const outputSet=new Set(outputNodes.map(n=>n.key));
  const remaining=nodes.filter(n=>!inputSet.has(n.key)&&!outputSet.has(n.key));
  const candidates=spherePoints(remaining.length),cb=bounds(candidates);
  const leftX=cb.min.x-1,rightX=cb.max.x+1;
  const positions=new Map(),slotByKey=new Map(),occupant=new Map();
  for(const [group,x]of [[inputNodes,leftX],[outputNodes,rightX]]){
    const ps=gridPoints(group.length,2);
    group.forEach((n,i)=>positions.set(n.key,{x,y:ps[i].y,z:ps[i].z}));
  }
  // Start from the 4D arrangement, assigning each free node to a unique nearby sphere slot.
  const vacant=new Set(candidates.map((_,i)=>i));
  for(const n of remaining){
    let best=-1,nearest=Infinity;
    for(const slot of vacant){const d=distance(base.positions.get(n.key),candidates[slot]);if(d<nearest-EPS){nearest=d;best=slot;}}
    positions.set(n.key,candidates[best]);slotByKey.set(n.key,best);occupant.set(best,n.key);vacant.delete(best);
  }
  terminals(model,positions,'5D');
  const seedPositions=new Map([...positions].map(([k,p])=>[k,{...p}]));
  const sources=new Map();for(const e of edges){if(!sources.has(e.target))sources.set(e.target,[]);sources.get(e.target).push(e.source);}
  const sorted=[...remaining].sort((a,b)=>parameterCount(b)-parameterCount(a)||base.topologyRanks.get(a.key)-base.topologyRanks.get(b.key)||nodeOrder(a,b));
  const free=new Set(candidates.map((_,i)=>i)),decisions=[];
  for(const n of sorted){
    const oldSlot=slotByKey.get(n.key),oldPosition=positions.get(n.key);
    let bestSlot=oldSlot,bestCost=Infinity;
    // spherePoints is ordered by radius: equal-cost choices expand from the center outward.
    for(const slot of free){
      const p=candidates[slot],other=occupant.get(slot);let cost=0;
      for(const source of sources.get(n.key)??[]){
        const q=source===n.key?p:source===other?oldPosition:positions.get(source);
        if(q)cost+=distance(p,q);
      }
      if(cost<bestCost-EPS){bestCost=cost;bestSlot=slot;}
    }
    const other=occupant.get(bestSlot);
    if(other&&other!==n.key){positions.set(other,oldPosition);slotByKey.set(other,oldSlot);occupant.set(oldSlot,other);}else occupant.delete(oldSlot);
    positions.set(n.key,candidates[bestSlot]);slotByKey.set(n.key,bestSlot);occupant.set(bestSlot,n.key);free.delete(bestSlot);
    decisions.push({key:n.key,slot:bestSlot,referenceDistance:bestCost,parameterCount:parameterCount(n)});
  }
  return {positions,candidates,seedPositions,decisions,inputKeys:[...inputSet],outputKeys:[...outputSet],dualKeys,conflictPolicy:'input-first',leftX,rightX,topologyRanks:base.topologyRanks,mode:'5D',description:'双侧第一排 · 球形扩张 · 引用距离优化'};
}
/** Iterative SCC condensation keeps feedback networks finite during layout. */
function topologyOrder(nodes,edges) {
  const keys=nodes.map(n=>n.key),keySet=new Set(keys),forward=new Map(keys.map(k=>[k,[]])),reverse=new Map(keys.map(k=>[k,[]]));
  for(const e of edges)if(keySet.has(e.source)&&keySet.has(e.target)){forward.get(e.source).push(e.target);reverse.get(e.target).push(e.source);}
  const seen=new Set(),finish=[];
  for(const key of keys){
    if(seen.has(key))continue;seen.add(key);const stack=[[key,0]];
    while(stack.length){const top=stack[stack.length-1],neighbors=forward.get(top[0]);if(top[1]<neighbors.length){const next=neighbors[top[1]++];if(!seen.has(next)){seen.add(next);stack.push([next,0]);}}else{finish.push(top[0]);stack.pop();}}
  }
  const component=new Map(),groups=[];
  for(const key of finish.reverse())if(!component.has(key)){
    const id=groups.length,group=[],stack=[key];component.set(key,id);
    while(stack.length){const v=stack.pop();group.push(v);for(const next of reverse.get(v))if(!component.has(next)){component.set(next,id);stack.push(next);}}
    groups.push(group);
  }
  const dag=groups.map(()=>new Set()),indegree=groups.map(()=>0),rank=groups.map(()=>0);
  for(const e of edges)if(component.has(e.source)&&component.has(e.target)){const a=component.get(e.source),b=component.get(e.target);if(a!==b&&!dag[a].has(b)){dag[a].add(b);indegree[b]++;}}
  const queue=indegree.flatMap((d,i)=>d===0?[i]:[]);
  for(let head=0;head<queue.length;head++){const a=queue[head];for(const b of dag[a]){rank[b]=Math.max(rank[b],rank[a]+1);if(--indegree[b]===0)queue.push(b);}}
  return {ranks:new Map(keys.map(k=>[k,rank[component.get(k)]])),components:component};
}
const project=(p,flat)=>flat?{x:p.x,y:p.y}:{x:.545*p.x-.839*p.z,y:-.237*p.x+.959*p.y-.154*p.z};
function crosses(a,b,c,d){const turn=(p,q,r)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);return turn(a,b,c)*turn(a,b,d)<-EPS&&turn(c,d,a)*turn(c,d,b)<-EPS;}
/** Score in construction coordinates so an axis swap alone preserves automatic selection. */
export function readability(result,edges) {
  const positions=result.axisOrder==='x,-z,y'?transformMap(result.positions,toConstructionPoint):result.positions;
  const flat=result.mode==='1D',screen=new Map([...positions].map(([k,p])=>[k,project(p,flat)]));
  const bins=new Map();let overlaps=0;
  for(const p of screen.values()){
    const x=Math.floor(p.x/.7),y=Math.floor(p.y/.7);
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const q of bins.get(`${x+dx},${y+dy}`)??[])if(Math.hypot(p.x-q.x,p.y-q.y)<.65)overlaps++;
    const key=`${x},${y}`;if(!bins.has(key))bins.set(key,[]);bins.get(key).push(p);
  }
  const sampled=edges.length<=256?edges:Array.from({length:256},(_,i)=>edges[Math.floor(i*edges.length/256)]);
  let crossing=0,backward=0,obstructed=0;
  const screenNodes=[...screen];
  const sampledNodes=screenNodes.length<=512?screenNodes:Array.from({length:512},(_,i)=>screenNodes[Math.floor(i*screenNodes.length/512)]);
  for(let i=0;i<sampled.length;i++){
    const a=sampled[i],p=screen.get(a.source),q=screen.get(a.target);if(!p||!q)continue;
    if(p.x>q.x+EPS)backward++;
    const dx=q.x-p.x,dy=q.y-p.y,squared=dx*dx+dy*dy;
    if(squared>EPS)for(const [key,r] of sampledNodes){
      if(key===a.source||key===a.target)continue;
      const t=((r.x-p.x)*dx+(r.y-p.y)*dy)/squared;
      if(t>0&&t<1&&Math.hypot(r.x-p.x-t*dx,r.y-p.y-t*dy)<.32)obstructed++;
    }
    for(let j=0;j<i;j++){const b=sampled[j];if([a.source,a.target].some(k=>k===b.source||k===b.target))continue;const r=screen.get(b.source),s=screen.get(b.target);if(r&&s&&crosses(p,q,r,s))crossing++;}
  }
  const b=bounds([...positions.values()]),width=b.max.x-b.min.x+1,height=b.max.y-b.min.y+1;
  const aspectPenalty=Math.max(width/height,height/width);
  const length=wireLength(result.positions,edges);
  return {score:overlaps*100+obstructed*10+crossing*3+backward*2+length/Math.max(1,edges.length)+aspectPenalty*.5,overlaps,obstructed,crossing,backward,wireLength:length};
}
export function createLayout(model,mode=DEFAULT_LAYOUT_MODE) {
  if(!LAYOUT_MODES.includes(mode))throw new Error(`未知布局：${mode}`);
  const nodes=[...model.nodes].sort(nodeOrder),edges=layoutEdges(model);
  let result;
  if(mode==='5D')result=five(model,nodes,edges);
  else if(mode==='4D')result=topological(model,nodes,edges);
  else if(mode!=='auto')result=basic(model,nodes,mode);
  else {
    const choices=[...['1D','2D','3D'].map(m=>basic(model,nodes,m)),topological(model,nodes,edges)];
    if(nodes.length<=256)choices.push(five(model,nodes,edges));
    choices.forEach(c=>{c.metrics=readability(c,edges);});choices.sort((a,b)=>a.metrics.score-b.metrics.score);
    result=choices[0];result.automatic=true;
  }
  result.metrics??=readability(result,edges);
  // Only 1D keeps its original top-to-bottom Y columns, including automatic 1D.
  if(result.mode==='1D')result.axisOrder='xyz';
  else {
    result.positions=transformMap(result.positions,toWorldPoint);
    result.candidates=result.candidates.map(toWorldPoint);
    if(result.seedPositions)result.seedPositions=transformMap(result.seedPositions,toWorldPoint);
    result.axisOrder='x,-z,y';
  }
  result.bounds=bounds([...result.positions.values()]);result.requestedMode=mode;
  return result;
}
