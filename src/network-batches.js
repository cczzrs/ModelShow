import * as THREE from 'three/webgpu';
import {disposeGroup} from './resources.js';
import {mergePendingRange} from './buffer-updates.js';

/** Persistent network buffers. Node/arrow proxies can remain outside the scene for picking. */
export class NetworkBatches {
  constructor(nodeCount,edgeCount,{nodeSize=.1,segments=36}={}){
    if(!Number.isSafeInteger(nodeCount)||nodeCount<0||!Number.isSafeInteger(edgeCount)||edgeCount<0||!Number.isSafeInteger(segments)||segments<1)throw new RangeError('Invalid network batch size');
    this.nodeCount=nodeCount;this.edgeCount=edgeCount;this.segments=segments;this.group=new THREE.Group();
    this.dirty=new Map();this.active=new Uint8Array(edgeCount);this.activeCount=0;
    this.edgeColors=new Float64Array(edgeCount).fill(-1);this.arrowMatrices=new Float32Array(edgeCount*16);
    this.point=new THREE.Vector3();this.previous=new THREE.Vector3();this.direction=new THREE.Vector3();
    this.up=new THREE.Vector3(0,1,0);this.rotation=new THREE.Quaternion();this.scale=new THREE.Vector3(1,1,1);
    this.matrix=new THREE.Matrix4();this.color=new THREE.Color();
    const cube=new THREE.BoxGeometry(nodeSize,nodeSize,nodeSize),shades=[];
    for(const shade of [.8,.65,1,.55,.92,.72])for(let i=0;i<4;i++)shades.push(shade,shade,shade);
    cube.setAttribute('color',new THREE.Float32BufferAttribute(shades,3));
    this.nodes=this.instances(cube,new THREE.MeshBasicMaterial({vertexColors:true}),nodeCount);
    const geometry=new THREE.BufferGeometry(),vertices=edgeCount*segments*2;
    geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(vertices*3),3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color',new THREE.BufferAttribute(new Float32Array(vertices*4),4).setUsage(THREE.DynamicDrawUsage));
    this.lines=new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({vertexColors:true,transparent:true,depthWrite:false}));
    this.lines.visible=edgeCount>0;this.group.add(this.lines);
    const cone=new THREE.ConeGeometry(.035,.1,8).translate(0,-.05,0);
    this.arrows=this.instances(cone,new THREE.MeshBasicMaterial({transparent:true,opacity:.8}),edgeCount);
    this.selectedArrows=this.instances(cone,new THREE.MeshBasicMaterial({transparent:true,opacity:1}),edgeCount);
    this.selectedArrows.visible=false;
  }
  instances(geometry,material,count){
    const mesh=new THREE.InstancedMesh(geometry,material,count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(count*3).fill(1),3).setUsage(THREE.DynamicDrawUsage);
    // Hidden instances remain finite, including the homogeneous matrix component.
    for(let i=0;i<count;i++){mesh.instanceMatrix.array.fill(0,i*16,i*16+16);mesh.instanceMatrix.array[i*16+15]=1;}
    mesh.visible=count>0;this.group.add(mesh);return mesh;
  }
  mark(attribute,start,count){
    const range=this.dirty.get(attribute);
    if(range){range[0]=Math.min(range[0],start);range[1]=Math.max(range[1],start+count);}
    else this.dirty.set(attribute,[start,start+count]);
  }
  write(attribute,start,values){
    let changed=false;
    for(let i=0;i<values.length;i++){const value=Math.fround(values[i]);if(attribute.array[start+i]!==value){attribute.array[start+i]=value;changed=true;}}
    if(changed)this.mark(attribute,start,values.length);
    return changed;
  }
  check(index,count){if(this.disposed)throw new Error('Network batches have been disposed');if(!Number.isInteger(index)||index<0||index>=count)throw new RangeError('Network batch index is out of range');}
  /** Copy a CPU mesh's transform and color; repeated unchanged copies cause no upload. */
  setNode(index,proxy){
    this.check(index,this.nodeCount);proxy.updateMatrix();
    this.write(this.nodes.instanceMatrix,index*16,proxy.matrix.elements);
    const color=proxy.material.color;
    this.write(this.nodes.instanceColor,index*3,[color.r,color.g,color.b]);
  }
  /** Update one edge in its own segment range. The arrow proxy's scale is controlled by selection. */
  setEdge(index,curve,endT,arrow){
    this.check(index,this.edgeCount);
    const attribute=this.lines.geometry.attributes.position,start=index*this.segments*6,array=attribute.array;
    curve.getPoint(0,this.previous);let at=start;
    for(let i=1;i<=this.segments;i++){
      curve.getPoint(i/this.segments,this.point);
      array[at++]=this.previous.x;array[at++]=this.previous.y;array[at++]=this.previous.z;
      array[at++]=this.point.x;array[at++]=this.point.y;array[at++]=this.point.z;this.previous.copy(this.point);
    }
    this.mark(attribute,start,this.segments*6);
    if(arrow)this.matrix.compose(arrow.position,arrow.quaternion,this.scale);
    else{
      curve.getPoint(endT,this.point);curve.getTangent(endT,this.direction).normalize();
      this.rotation.setFromUnitVectors(this.up,this.direction);this.matrix.compose(this.point,this.rotation,this.scale);
    }
    this.arrowMatrices.set(this.matrix.elements,index*16);this.updateArrow(index);
  }
  updateArrow(index){
    this.matrix.fromArray(this.arrowMatrices,index*16);
    const selected=!!this.active[index];
    if(selected)this.matrix.scale(this.point.setScalar(1.35));
    this.write((selected?this.selectedArrows:this.arrows).instanceMatrix,index*16,this.matrix.elements);
    this.matrix.makeScale(0,0,0);
    this.write((selected?this.arrows:this.selectedArrows).instanceMatrix,index*16,this.matrix.elements);
  }
  /** Lines retain true per-edge alpha; selected arrowheads have separate opaque instances. */
  setEdgeStyle(index,color,selected=false){
    this.check(index,this.edgeCount);const active=selected?1:0;
    if(this.edgeColors[index]===color&&this.active[index]===active)return;
    if(this.active[index]!==active){this.activeCount+=active?1:-1;this.active[index]=active;this.updateArrow(index);}
    this.edgeColors[index]=color;this.color.setHex(color);
    const {r,g,b}=this.color,attribute=this.lines.geometry.attributes.color,start=index*this.segments*8;
    for(let offset=start;offset<start+this.segments*8;offset+=4){attribute.array[offset]=r;attribute.array[offset+1]=g;attribute.array[offset+2]=b;attribute.array[offset+3]=active?1:.4;}
    this.mark(attribute,start,this.segments*8);
    this.write(this.arrows.instanceColor,index*3,[r,g,b]);this.write(this.selectedArrows.instanceColor,index*3,[r,g,b]);
    this.arrows.visible=this.activeCount<this.edgeCount;this.selectedArrows.visible=this.activeCount>0;
  }
  /** Call once after a group of edits, before rendering. Bounds are recomputed once per batch. */
  commit(){
    if(this.disposed)return;
    if(this.dirty.has(this.lines.geometry.attributes.position))this.lines.geometry.computeBoundingSphere();
    for(const mesh of [this.nodes,this.arrows,this.selectedArrows])if(mesh.count&&this.dirty.has(mesh.instanceMatrix))mesh.computeBoundingSphere();
    for(const [attribute,[start,end]]of this.dirty){
      // Retain all earlier edits without queuing a duplicate upload for each commit.
      mergePendingRange(attribute,start,end-start);
    }
    this.dirty.clear();
  }
  dispose(){
    if(this.disposed)return;this.disposed=true;
    this.group.removeFromParent();this.nodes.dispose();this.arrows.dispose();this.selectedArrows.dispose();
    disposeGroup(this.group);this.dirty.clear();
  }
}
