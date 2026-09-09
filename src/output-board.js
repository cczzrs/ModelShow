import * as THREE from 'three/webgpu';
import {CHANNELS,displayConnections} from './output-display.js';
import {FloatingEdgeCurve} from './edge-curves.js';
import {disposeGroup} from './resources.js';
import {mergePendingRange} from './buffer-updates.js';
const PITCH=.45,SEGMENTS=16;
const TINT={r:new THREE.Color('#ef6687'),g:new THREE.Color('#70e6a1'),b:new THREE.Color('#70abff')};
// A real hole, not a white panel hidden behind overlapping black rectangles.
function outline(width,height,stroke){
 const shape=new THREE.Shape();shape.moveTo(-width/2,-height/2);shape.lineTo(width/2,-height/2);shape.lineTo(width/2,height/2);shape.lineTo(-width/2,height/2);shape.closePath();
 const w=width/2-stroke,h=height/2-stroke,hole=new THREE.Path();hole.moveTo(-w,-h);hole.lineTo(-w,h);hole.lineTo(w,h);hole.lineTo(w,-h);hole.closePath();shape.holes.push(hole);
 return new THREE.ShapeGeometry(shape).rotateY(Math.PI/2);
}
class BoardConnectionCurve extends FloatingEdgeCurve {
 getPoint(t,target=new THREE.Vector3()){super.getPoint(t,target);target.x=Math.min(target.x,this.end.x);return target;}
}
export class OutputBoard {
 constructor(scene){this.group=new THREE.Group();scene.add(this.group);this.edges=[];this.batches=[];this.selected=null;this.bounds=null;}
 clear(){this.lamps?.dispose();this.ports?.dispose();disposeGroup(this.group);this.lamps=null;this.ports=null;this.frame=null;this.border=null;this.edges=[];this.batches=[];this.bounds=null;}
 rebuild(config,visuals,layout,time=0){
  this.clear();this.config=config;this.group.visible=config.enabled;if(!config.enabled||!layout)return;
  const ys=[...visuals.values()].filter(v=>v.type==='Y').map(v=>v.mesh.position);
  const maxX=ys.length?Math.max(...ys.map(p=>p.x)):layout.bounds.max.x;
  const midY=ys.length?(Math.min(...ys.map(p=>p.y))+Math.max(...ys.map(p=>p.y)))/2:0;
  const z=ys.length?(Math.min(...ys.map(p=>p.z))+Math.max(...ys.map(p=>p.z)))/2:0;
  const scale=config.scale??1,pitch=PITCH*scale;
  const width=config.cols*pitch,height=config.rows*pitch,outerWidth=width+.04*scale,outerHeight=height+.04*scale;
  // The screen lies in YZ and faces +X. Viewed from its front, right is -Z.
  // Anchor its back to the output region so resizing never closes the 3-unit gap.
  const rearX=maxX+3.1,x=rearX+.043*scale;
  this.bounds={min:{x:rearX,y:midY-outerHeight/2,z:z-outerWidth/2},max:{x:rearX+.05*scale,y:midY+outerHeight/2,z:z+outerWidth/2}};
  this.frame=new THREE.Mesh(new THREE.BoxGeometry(.03*scale,outerHeight,outerWidth),new THREE.MeshBasicMaterial({color:0x080c12,fog:false,toneMapped:false}));this.frame.position.set(rearX+.025*scale,midY,z);this.group.add(this.frame);
  this.border=new THREE.Group();this.group.add(this.border);
  const border=new THREE.Mesh(outline(outerWidth,outerHeight,.012*scale),new THREE.MeshBasicMaterial({color:0xffffff,fog:false,toneMapped:false}));border.position.set(rearX+.042*scale,midY,z);this.border.add(border);
  // Flat, opaque, single-sided color tiles: no glowing sides or raised white bars.
  this.lamps=new THREE.InstancedMesh(new THREE.PlaneGeometry(.422*scale,.422*scale).rotateY(Math.PI/2),new THREE.MeshBasicMaterial({color:0xffffff,fog:false,toneMapped:false}),config.pixels.length);this.lamps.userData.outputLamp=true;this.lamps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);this.group.add(this.lamps);
  this.positions=config.pixels.map((_,i)=>new THREE.Vector3(x,midY+(config.rows/2-Math.floor(i/config.cols)-.5)*pitch,z+(config.cols/2-i%config.cols-.5)*pitch));
  const matrix=new THREE.Matrix4();for(let i=0;i<this.positions.length;i++){this.lamps.setMatrixAt(i,matrix.makeTranslation(...this.positions[i].toArray()));this.lamps.setColorAt(i,new THREE.Color(0));}this.lamps.instanceMatrix.needsUpdate=true;this.lamps.computeBoundingSphere();
  this.marker=new THREE.Mesh(outline(.438*scale,.438*scale,.006*scale).translate(.004*scale,0,0),new THREE.MeshBasicMaterial({color:0x9de4db,fog:false,toneMapped:false}));this.marker.visible=false;this.group.add(this.marker);
  const connections=displayConnections(config).filter(e=>visuals.has(e.source));
  const pairs=new Map();for(const e of connections){const key=e.source+':'+e.index;if(!pairs.has(key))pairs.set(key,[]);pairs.get(key).push(e);}
  for(const list of pairs.values())list.forEach((e,i)=>{const target=this.positions[e.index].clone();target.x=rearX;target.z+=(CHANNELS.indexOf(e.channel)-1)*.04*scale;e.curve=new BoardConnectionCurve(visuals.get(e.source).mesh.position,target,e.source,'lamp:'+e.index,i,list.length);e.curve.time=time;});
  this.edges=connections;
  if(connections.length){
   const ports=[...new Map(connections.map(e=>[`${e.index}:${e.channel}`,e])).values()];
   this.ports=new THREE.InstancedMesh(new THREE.CircleGeometry(.012*scale,8).rotateY(-Math.PI/2),new THREE.MeshBasicMaterial({color:0xffffff,fog:false,toneMapped:false}),ports.length);this.group.add(this.ports);
   ports.forEach((e,i)=>{this.ports.setMatrixAt(i,matrix.makeTranslation(...e.curve.end.toArray()));this.ports.setColorAt(i,TINT[e.channel]);});this.ports.instanceMatrix.needsUpdate=true;this.ports.instanceColor.needsUpdate=true;this.ports.computeBoundingSphere();
  }
  for(const channel of CHANNELS){const edges=connections.filter(e=>e.channel===channel);if(!edges.length)continue;const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(edges.length*SEGMENTS*6),3).setUsage(THREE.DynamicDrawUsage));geometry.setAttribute('color',new THREE.BufferAttribute(new Float32Array(edges.length*SEGMENTS*6),3).setUsage(THREE.DynamicDrawUsage));const line=new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.8,fog:false,toneMapped:false}));this.group.add(line);this.batches.push({edges,line,channel});}
  this.tick(time);this.select(this.selected);
 }
 pickObjects(){return this.group.visible&&this.lamps?[this.lamps,this.frame]:[];}
 paint(results,indices){
  if(!this.lamps||!indices.length)return;
  const color=new THREE.Color();let start=Infinity,end=0;
  for(const i of indices){const p=results[i];if(!p)continue;color.setRGB(p.r.brightness/255,p.g.brightness/255,p.b.brightness/255,THREE.SRGBColorSpace);this.lamps.setColorAt(i,color);start=Math.min(start,i*3);end=Math.max(end,i*3+3);}
  if(start<end)mergePendingRange(this.lamps.instanceColor,start,end-start);
 }
 select(key){this.selected=key;if(!this.lamps)return;const index=typeof key==='string'&&key.startsWith('lamp:')?Number(key.slice(5)):-1;this.marker.visible=Number.isInteger(index)&&index>=0&&index<this.positions.length;if(this.marker.visible)this.marker.position.copy(this.positions[index]);
  for(const {edges,line,channel} of this.batches){const a=line.geometry.attributes.color;edges.forEach((e,i)=>{const active=e.source===key||e.index===index,color=TINT[channel].clone().multiplyScalar(active?1:.32);for(let j=0;j<SEGMENTS*2;j++)a.setXYZ(i*SEGMENTS*2+j,color.r,color.g,color.b);});a.needsUpdate=true;}
 }
 tick(time){if(!this.group.visible)return;const p=new THREE.Vector3(),q=new THREE.Vector3();for(const {edges,line} of this.batches){const a=line.geometry.attributes.position;edges.forEach((e,i)=>{e.curve.time=time;e.curve.getPoint(0,p);for(let j=0;j<SEGMENTS;j++){e.curve.getPoint((j+1)/SEGMENTS,q);const n=i*SEGMENTS*2+j*2;a.setXYZ(n,p.x,p.y,p.z);a.setXYZ(n+1,q.x,q.y,q.z);p.copy(q);}});a.needsUpdate=true;line.geometry.computeBoundingSphere();}}
 fitBounds(bounds){if(!this.bounds||!this.group.visible)return bounds;return {min:Object.fromEntries(['x','y','z'].map(k=>[k,Math.min(bounds.min[k],this.bounds.min[k])])),max:Object.fromEntries(['x','y','z'].map(k=>[k,Math.max(bounds.max[k],this.bounds.max[k])]))};}
}
