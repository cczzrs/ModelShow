import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {FloatingEdgeCurve} from '../src/edge-curves.js';

// Freeze the original uncached equations as the numerical oracle for this optimization.
function originalDrift(time,seed){
  const n=Math.floor(time),f=time-n,s=f*f*f*(f*(f*6-15)+10);
  const value=i=>{let h=Math.imul(i^seed,0x45d9f3b);h=Math.imul(h^(h>>>16),0x45d9f3b);return ((h^(h>>>16))>>>0)/4294967295*2-1;};
  return value(n)*(1-s)+value(n+1)*s;
}
function originalPoint(curve,t,target=new THREE.Vector3()){
  if(t<=0)return target.copy(curve.start);if(t>=1)return target.copy(curve.end);
  const time=curve.time*curve.speed,envelope=Math.sin(Math.PI*t);
  const float=originalDrift(time,curve.seed)*.025,side=originalDrift(time,curve.seed^0x9e3779b9)*.025;
  const breeze=curve.sway*(.8*originalDrift(time+.7*t,curve.seed^0x85ebca6b)+.2*originalDrift(time*1.7-1.1*t,curve.seed^0xc2b2ae35));
  if(curve.loop){const angle=2*Math.PI*t;return target.copy(curve.start).addScaledVector(curve.u,Math.sin(angle)*(curve.radius+float)+envelope*breeze).addScaledVector(curve.v,(1-Math.cos(angle))*(curve.radius+side));}
  return target.copy(curve.start).lerp(curve.end,t).addScaledVector(curve.u,envelope*(curve.bow+float)).addScaledVector(curve.v,envelope*(curve.wave+breeze));
}
const originalTangent=(curve,t)=>originalPoint(curve,Math.min(1,t+.0001)).sub(originalPoint(curve,Math.max(0,t-.0001))).normalize();

test('cached wind matches every component of the original curve and finite-difference tangent',()=>{
  const start=new THREE.Vector3(1,-2,3),point=new THREE.Vector3();
  for(const loop of [false,true]){
    const curve=new FloatingEdgeCurve(start,loop?start:new THREE.Vector3(-4,8,-9),'Q7',loop?'Q7':'Q2',2,4);
    for(const seed of [0,12345,0x7fffffff,0xffffffff])for(const speed of [1/25,1/15,.5]){
      curve.seed=seed;curve.speed=speed;
      for(const time of [0,.05,4,19.999999,20,20.000001,80,600,1e10,-.05,-20]){
        curve.time=time;
        // Arrow search samples arrive out of order, unlike the regular line samples.
        for(const t of [-1,0,.99,.98123456789,.0001,.5,.99999,1,2,...Array.from({length:35},(_,i)=>(i+1)/36)]){
          assert.equal(curve.getPoint(t,point),point);
          assert.deepEqual(point.toArray(),originalPoint(curve,t).toArray());
        }
        for(const t of [0,.00001,.37,.98,.99999,1])assert.deepEqual(curve.getTangent(t).toArray(),originalTangent(curve,t).toArray());
      }
    }
  }
});

test('wind cache follows time reversal, seed replacement and speed changes at the same time',()=>{
  const curve=new FloatingEdgeCurve(new THREE.Vector3(),new THREE.Vector3(8,4,2),'X0','Q0');
  for(const [time,seed,speed] of [[40,12345,.05],[40,67890,.05],[40,67890,.2],[2,67890,.2],[2,67890,.2],[40,12345,.05]]){
    curve.time=time;curve.seed=seed;curve.speed=speed;
    for(const t of [.98,.1,.9,.5,.98])assert.deepEqual(curve.getPoint(t).toArray(),originalPoint(curve,t).toArray());
  }
});
