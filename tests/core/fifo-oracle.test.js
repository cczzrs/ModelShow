import test from 'node:test';
import assert from 'node:assert/strict';
import {engineFor} from '../helpers/v4-model.js';

// Deliberately independent representation: plain objects and two shift queues;
// does not import the engine's parser, compiler, fingerprint or scheduling helpers.
function reference(raw) {
 const state=new Set([...raw.initial_q[0],...raw.initial_q[1]]),q={},x={},arrivals={},xi=[],qi=[],outputs=[],counts={};
 const nodes=raw.nodes.map(n=>({...n,ops:[...n.ex.matchAll(/([JK])(?:([01])|\(([XQ]\d+)\))/g)].map(m=>({op:m[1],arg:m[3]??Number(m[2])}))}));
 for(const n of nodes){q[n.id]=state.has(n.id)?Number(raw.initial_q[1].includes(n.id)):null;arrivals[n.id]={};counts[n.id]=0;n.sources=[...new Set(n.ops.map(t=>t.arg).filter(v=>typeof v==='string'&&v!==n.id))];n.required=n.sources.filter(v=>v[0]==='Q'&&!state.has(v));}
 return {q,arrivals,counts,outputs,xi,qi,send(data){for(const id of Object.keys(data).sort((a,b)=>Number(a.slice(1))-Number(b.slice(1)))){x[id]=data[id];xi.push({id:'Q'+id.slice(1),data:{}});}},step(){
 const task=(xi.length?xi:qi).shift();if(!task)return null;
 const node=nodes.find(n=>n.id===task.id),reads={};
 for(const op of node.ops)if(typeof op.arg==='string')reads[op.arg]=op.arg[0]==='X'?x[op.arg]:state.has(op.arg)?q[op.arg]:task.data[op.arg];
 if(Object.values(reads).some(v=>v!==0&&v!==1))return task.id;
 let bit=state.has(node.id)?q[node.id]:0;
 for(const op of node.ops){const arg=typeof op.arg==='string'?reads[op.arg]:op.arg;bit=op.op==='J'?Number(Boolean(bit)&&Boolean(arg)):Number(bit!==arg);}
 q[node.id]=bit;counts[node.id]++;
 if(node.pro&&node.pro!=='q=0/1'&&node.pro!==`q=${bit}`)return task.id;
 for(const target of nodes.filter(n=>n.sources.includes(node.id))){
 if(target.required.length){if(!target.required.includes(node.id))continue;arrivals[target.id][node.id]=bit;if(!target.required.every(s=>Object.hasOwn(arrivals[target.id],s)))continue;}
 qi.push({id:target.id,data:{...arrivals[target.id]}});arrivals[target.id]={};
 }
 for(const bind of raw.q_y)for(const [id,source] of Object.entries(bind))if(source===node.id)outputs.push([id,bit]);
 return task.id;
 }};
}
test('seeded V4 DAGs agree with independent task oracle after every interleaved send/step',()=>{
 let seed=0x40102026;const next=n=>(seed=(Math.imul(seed,1664525)+1013904223)>>>0)%n;
 for(let graph=0;graph<24;graph++){
 const nodes=['J0K(X0)','J0K(X1)'],initial={0:['Q0','Q1'],1:[]};
 for(let i=2;i<8;i++){
 const stateful=Boolean(next(2));if(stateful)initial[next(2)].push(`Q${i}`);
 const sources=i===2?['Q0','Q1']:[`Q${i-1}`,`Q${next(i)}`];
 if(stateful&&next(2))sources.push(`Q${i}`);
 const ex=(stateful?'':'J0')+sources.map((s,j)=>(j%2?'J':'K')+`(${s})`).join('');
 nodes.push({ex,pro:i===7?'q=0/1':['q=0/1','q=0','q=1',...(stateful?['q=']:[])][next(stateful?4:3)]});
 }
 const e=engineFor(nodes,initial),r=reference(e.model.raw),actual=[];
 function step(){const event=e.step();assert.equal(event?.node??null,r.step());if(event)actual.push(...event.outputChanges.map(c=>[c.id,c.value]));assert.deepEqual(Object.fromEntries(e.q),r.q);assert.deepEqual(Object.fromEntries(e.model.nodes.map(n=>[n.id,e.counts.get(n.key)])),r.counts);assert.deepEqual(actual,r.outputs);assert.deepEqual(e.model.nodes.map(n=>Object.fromEntries(e.cache.get(n.key))),e.model.nodes.map(n=>r.arrivals[n.id]));assert.deepEqual(e.capture().fifos,{'Xi.FIFO':r.xi.map(t=>({[t.id]:t.data})),'Qi.FIFO':r.qi.map(t=>({[t.id]:t.data}))});}
 for(let turn=0;turn<80;turn++){const input=next(3)===0?{X0:next(2),X1:next(2)}:{['X'+next(2)]:next(2)};e.send(input);r.send(input);for(let i=0;i<next(7);i++)step();}
 let guard=0;while(e.length){assert.ok(guard++<10000);step();}
 }
});
