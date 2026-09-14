import * as THREE from 'three/webgpu';
const hash=text=>{let h=2166136261;for(const c of text)h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;};
// Independent random waypoints, interpolated smoothly instead of frame-by-frame jitter.
function driftValue(i,seed){let h=Math.imul(i^seed,0x45d9f3b);h=Math.imul(h^(h>>>16),0x45d9f3b);return ((h^(h>>>16))>>>0)/4294967295*2-1;}
function drift(time,seed){
 const n=Math.floor(time),f=time-n,s=f*f*f*(f*(f*6-15)+10);
 return driftValue(n,seed)*(1-s)+driftValue(n+1,seed)*s;
}
/** Share lane allocation across BOTH directions so reciprocal edges do not coincide. */
export function assignEdgeLanes(edges){
 const groups=new Map();
 for(const edge of edges){const key=JSON.stringify([edge.sourceKey,edge.targetKey].sort());if(!groups.has(key))groups.set(key,[]);groups.get(key).push(edge);}
 for(const es of groups.values())es.forEach((e,i)=>{e.laneIndex=i;e.laneCount=es.length;});
 return edges;
}
/** Endpoint-fixed bows with slow, wind-like sway; nodes never move. */
export class FloatingEdgeCurve extends THREE.Curve {
 constructor(start,end,sourceKey,targetKey,laneIndex=0,laneCount=1){
  super();this.start=start.clone();this.end=end.clone();this.time=0;this.driftTime=NaN;this.driftSeed=NaN;
  const id=JSON.stringify([sourceKey,targetKey].sort()),h=hash(id);
  // One main wind transition takes 15–25 seconds, independent of playback speed.
  this.seed=(Math.random()*4294967296)>>>0;this.speed=1/(15+Math.random()*10);this.loop=sourceKey===targetKey;
  this.sway=Math.min(.55,.18+start.distanceTo(end)*.045);
  this.radius=.42+laneIndex*.18;
  const direction=end.clone().sub(start);if(sourceKey>targetKey)direction.negate();
  if(direction.lengthSq()<1e-12)direction.set(1,0,0);direction.normalize();
  const axis=Math.abs(direction.y)<.9?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0);
  this.u=new THREE.Vector3().crossVectors(direction,axis).normalize();
  this.v=new THREE.Vector3().crossVectors(direction,this.u).normalize();
  this.bow=.16+Math.min(.16,start.distanceTo(end)*.025)+(laneIndex-(laneCount-1)/2)*.2;
  this.wave=.04+(h%11)*.003;
 }
 getPoint(t,target=new THREE.Vector3()){
  if(t<=0)return target.copy(this.start);if(t>=1)return target.copy(this.end);
  const time=this.time*this.speed,envelope=Math.sin(Math.PI*t);
  // Keep lane-normal motion narrow; the larger sway is perpendicular to lane spacing.
  // These two terms do not depend on t: all samples and arrow searches share them.
  if(this.driftTime!==time||this.driftSeed!==this.seed){
   this.driftTime=time;this.driftSeed=this.seed;
   this.float=drift(time,this.seed)*.025;this.side=drift(time,this.seed^0x9e3779b9)*.025;
  }
  const float=this.float,side=this.side;
  const breeze=this.sway*(.8*drift(time+.7*t,this.seed^0x85ebca6b)+.2*drift(time*1.7-1.1*t,this.seed^0xc2b2ae35));
  if(this.loop){const angle=2*Math.PI*t;return target.copy(this.start).addScaledVector(this.u,Math.sin(angle)*(this.radius+float)+envelope*breeze).addScaledVector(this.v,(1-Math.cos(angle))*(this.radius+side));}
  return target.copy(this.start).lerp(this.end,t).addScaledVector(this.u,envelope*(this.bow+float)).addScaledVector(this.v,envelope*(this.wave+breeze));
 }
}
/** Update existing GPU buffers; do not allocate/dispose geometry on each animation frame. */
export function updateLineGeometry(geometry,curve){
 const p=geometry.attributes.position,v=new THREE.Vector3();
 for(let i=0;i<p.count;i++){curve.getPoint(i/(p.count-1),v);p.setXYZ(i,v.x,v.y,v.z);}p.needsUpdate=true;geometry.computeBoundingSphere();
}
export function updateTubeGeometry(geometry,curve){
 const {tubularSegments,radialSegments,radius}=geometry.parameters,frames=curve.computeFrenetFrames(tubularSegments,false),p=geometry.attributes.position,center=new THREE.Vector3();let index=0;
 for(let i=0;i<=tubularSegments;i++){curve.getPointAt(i/tubularSegments,center);for(let j=0;j<=radialSegments;j++){
  const angle=j/radialSegments*Math.PI*2,n=frames.normals[i],b=frames.binormals[i],s=Math.sin(angle),c=-Math.cos(angle);
  p.setXYZ(index++,center.x+radius*(c*n.x+s*b.x),center.y+radius*(c*n.y+s*b.y),center.z+radius*(c*n.z+s*b.z));
 }}p.needsUpdate=true;geometry.computeBoundingSphere();
}
