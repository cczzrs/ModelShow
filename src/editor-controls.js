import * as THREE from 'three/webgpu';
import {TrackballControls} from 'three/addons/controls/TrackballControls.js';
/** Scale camera and pivot around the cursor's world anchor; its screen position is invariant. */
export function zoomAtCursor(camera,target,ndc,factor,minDistance=.2,maxDistance=200,hitPoint=null){
 if(!Number.isFinite(factor)||factor<=0)return;
 camera.updateMatrixWorld();
 const ray=new THREE.Raycaster();ray.setFromCamera(ndc,camera);
 const normal=camera.getWorldDirection(new THREE.Vector3());
 const anchor=hitPoint?.clone()??ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal,target),new THREE.Vector3());
 if(!anchor)return;
 const distance=camera.position.distanceTo(target);if(distance<1e-9)return;
 const depth=anchor.clone().sub(camera.position).dot(normal);
 const minFactor=Math.max(minDistance/distance,depth>0?camera.near*2/depth:0);
 const scale=Math.max(minFactor,Math.min(maxDistance/distance,factor));
 camera.position.sub(anchor).multiplyScalar(scale).add(anchor);
 target.sub(anchor).multiplyScalar(scale).add(anchor);
 camera.updateMatrixWorld();
}
export class EditorControls extends TrackballControls {
 constructor(camera,element,pick=()=>null){
  super(camera,element);
  this.staticMoving=true;this.rotateSpeed=2;this.panSpeed=.8;
  this.noZoom=true;this.keys=[];this.minDistance=.2;this.maxDistance=200;
  this.mouseButtons={LEFT:THREE.MOUSE.ROTATE,MIDDLE:THREE.MOUSE.PAN,RIGHT:THREE.MOUSE.PAN};
  this.prepareDrag=event=>{this.handleResize();this.mouseButtons.LEFT=event.shiftKey?THREE.MOUSE.PAN:THREE.MOUSE.ROTATE;};
  this.cursorWheel=event=>{
   if(!this.enabled)return;event.preventDefault();this.update();
   const rect=element.getBoundingClientRect();if(!rect.width||!rect.height)return;
   const ndc=new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,1-(event.clientY-rect.top)/rect.height*2);
   const pixels=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?rect.height:1);
   zoomAtCursor(camera,this.target,ndc,Math.exp(THREE.MathUtils.clamp(pixels*.0015,-.5,.5)),this.minDistance,this.maxDistance,pick(ndc));
   this.update();
  };
  element.addEventListener('pointerdown',this.prepareDrag,true);
  element.addEventListener('wheel',this.cursorWheel,{passive:false});
 }
 dispose(){
  this.domElement.removeEventListener('pointerdown',this.prepareDrag,true);
  this.domElement.removeEventListener('wheel',this.cursorWheel);
  super.dispose();
 }
}
