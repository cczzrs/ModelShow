import {compileSnapshot, serializeModel} from '../../src/jk/model-schema.js';
import {JKEngine} from '../../src/jk/engine.js';
export const timestamp = '2026-10-08T00:1791417600000000000';
export const structure = (nodes = ['J0K(X0)'], initial_q = {0:['Q0'],1:[]}, q_y = [{Y0:`Q${nodes.length-1}`}]) => ({nodes:nodes.map((ex,i)=>typeof ex==='string'?{id:`Q${i}`,ex}:{id:`Q${i}`,...ex}),initial_q,q_y});
export const snapshot = (raw = structure()) => serializeModel(raw,{createdAt:timestamp});
export const engineFor = (nodes, initial, outputs) => new JKEngine(compileSnapshot(snapshot(structure(nodes,initial,outputs))));
export function drain(engine) {
  const trace=[];
  while(engine.length){if(trace.length>10000)throw Error('unexpected nontermination');trace.push(engine.step());}
  return trace;
}
