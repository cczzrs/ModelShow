import * as THREE from 'three/webgpu';
import {TrackballControls} from 'three/addons/controls/TrackballControls.js';
import {APP_CONFIG} from '../../html/config.js';
/** Scale camera and pivot around the cursor's world anchor; its screen position is invariant. */
export function zoomAtCursor(camera,target,ndc,factor,minDistance=APP_CONFIG.scene.controls.minDistance,maxDistance=APP_CONFIG.scene.controls.maxDistance,hitPoint=null){
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
 constructor(camera,element,pick=()=>null,settings=APP_CONFIG.scene.controls){
  super(camera,element);
  this.staticMoving=settings.staticMoving;this.rotateSpeed=settings.rotateSpeed;this.panSpeed=settings.panSpeed;
  this.noZoom=true;this.keys=[];this.minDistance=settings.minDistance;this.maxDistance=settings.maxDistance;
  this.mouseButtons={LEFT:THREE.MOUSE.ROTATE,MIDDLE:THREE.MOUSE.PAN,RIGHT:THREE.MOUSE.PAN};
  this.prepareDrag=event=>{this.handleResize();this.mouseButtons.LEFT=event.shiftKey?THREE.MOUSE.PAN:THREE.MOUSE.ROTATE;};
  this.cursorWheel=event=>{
   if(!this.enabled)return;event.preventDefault();this.update();
   const rect=element.getBoundingClientRect();if(!rect.width||!rect.height)return;
   const ndc=new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,1-(event.clientY-rect.top)/rect.height*2);
   const wheel=settings.wheel;
   const pixels=event.deltaY*(event.deltaMode===1?wheel.linePixels:event.deltaMode===2?rect.height:1);
   zoomAtCursor(camera,this.target,ndc,Math.exp(THREE.MathUtils.clamp(pixels*wheel.sensitivity,wheel.minExponent,wheel.maxExponent)),this.minDistance,this.maxDistance,pick(ndc));
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
