import * as THREE from 'three/webgpu';
import { OutputBoard } from './output-board.js';
import { DisplayState, defaultDisplay } from './output-display.js';
import { EditorControls } from './editor-controls.js';
import { order } from './engine.js';
import { createLayout, DEFAULT_LAYOUT_MODE } from './layout.js';
import { disposeGroup } from './resources.js';
import { FloatingEdgeCurve, assignEdgeLanes, updateTubeGeometry } from './edge-curves.js';
import { NetworkBatches } from './network-batches.js';
import { NodeLabels } from './node-labels.js';
import { RenderSchedule } from './render-schedule.js';
const NODE_SIZE = .10;
const TITLE_OFFSET = -.19, COUNT_OFFSET = -.36;
// Find the last approach to the target box, including self-loop curves.
function arrowEnd(curve, center) {
  const box = new THREE.Box3().setFromCenterAndSize(center, new THREE.Vector3().setScalar(NODE_SIZE + .035));
  let inside = 1, outside = 0;
  for (let i = 99; i >= 0; i--) {
    const t = i / 100;
    if (!box.containsPoint(curve.getPoint(t))) { outside = t; break; }
    inside = t;
  }
  for (let i = 0; i < 16; i++) {
    const mid = (outside + inside) / 2;
    if (box.containsPoint(curve.getPoint(mid))) inside = mid; else outside = mid;
  }
  return outside;
}
const colors = { X: 0x73aaff, Q: 0xf1f6ff, Y: 0x79dfae, J: 0xe898c0, K: 0x689ef3, error: 0xff596e };
function paintLabel(canvas,text,color,size){
  const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.font=`500 ${size}px ui-monospace, SFMono-Regular, monospace`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=color;ctx.fillText(text,128,32);
}
function label(text, color = '#a5bcd3', size = 22) {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 64;
  paintLabel(canvas,text,color,size);
  const map = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false }));
  sprite.scale.set(1.35, .3375, 1); sprite.renderOrder = 4;
  return sprite;
}
export class NetworkView {
  constructor(container, onSelect, onError = () => {}, onLayout = () => {}) {
    this.layoutMode=DEFAULT_LAYOUT_MODE; this.layoutGeneration=0; this.onLayout=onLayout;
    this.container = container; this.onSelect = onSelect; this.onError = onError; this.available = false;
    this.scene = new THREE.Scene(); this.scene.fog = new THREE.FogExp2(0x0a1422, .012);
    this.camera = new THREE.PerspectiveCamera(42, 1, .1, 500);
    this.camera.position.set(12,8,18);this.camera.lookAt(0,0,0);
    this.edgeTime=0;this.renderSchedule=new RenderSchedule();
    this.group = new THREE.Group(); this.scene.add(this.group);
    this.signalGroup = new THREE.Group(); this.scene.add(this.signalGroup);
    this.visuals = new Map(); this.edges = []; this.signals = [];
    this.nodeLabelsHidden=false;
    this.outputBoard=new OutputBoard(this.scene);this.outputState=new DisplayState(defaultDisplay());this.pendingLampDirty=new Set();
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
  }
  async init() {
    if (!navigator.gpu) throw new Error('浏览器没有提供 WebGPU 接口。请使用支持 WebGPU 的浏览器，通过 localhost 或 HTTPS 打开。');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('未能获取可用的 GPU adapter。请检查浏览器硬件加速和设备支持。');
    this.renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true });
    const renderer = this.renderer;
    const handleLoss = renderer.onDeviceLost.bind(renderer);
    renderer.onDeviceLost = info => {
      handleLoss(info);
      if (this.renderer === renderer) this.fail(new Error(info.message || 'GPU 设备连接丢失'));
    };
    await renderer.init();
    if (!this.renderer.backend.isWebGPUBackend) { this.renderer.dispose(); throw new Error('WebGPU 初始化失败，本应用没有自动切换到 WebGL。'); }
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x091422, 0);
    this.container.append(this.renderer.domElement);
    this.controls = new EditorControls(this.camera, this.renderer.domElement,ndc=>{
      this.camera.updateMatrixWorld();this.raycaster.setFromCamera(ndc,this.camera);
      return this.raycaster.intersectObjects(this.pickObjects(),false)[0]?.point??null;
    });
    this.controls.addEventListener('change',()=>this.renderSchedule.interact(performance.now()));
    this.visibilityChanged??=()=>this.renderSchedule.resetClock();
    document.removeEventListener('visibilitychange',this.visibilityChanged);
    document.addEventListener('visibilitychange',this.visibilityChanged);
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(this.container);
    this.renderer.domElement.addEventListener('pointerdown', e => { this.down = e.button===0&&!e.shiftKey?{ id:e.pointerId,x:e.clientX,y:e.clientY,moved:false }:null; });
    this.renderer.domElement.addEventListener('pointermove',e=>{if(this.down&&Math.hypot(e.clientX-this.down.x,e.clientY-this.down.y)>5)this.down.moved=true;});
    this.renderer.domElement.addEventListener('pointercancel',()=>{this.down=null;});
    this.renderer.domElement.addEventListener('pointerup', e => {
      const down=this.down;this.down=null;
      if (!down || down.id!==e.pointerId || down.moved || e.button!==0 || Math.hypot(e.clientX-down.x,e.clientY-down.y)>5) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointer.set((e.clientX-rect.left)/rect.width*2-1, -(e.clientY-rect.top)/rect.height*2+1);
      this.raycaster.setFromCamera(this.pointer,this.camera);
      const hit = this.raycaster.intersectObjects(this.pickObjects(),false)[0];
      this.onSelect(hit?.object.userData.outputLamp?`lamp:${hit.instanceId}`:hit?.object.userData.key ?? null);
    });
    this.available = true; this.resize();
  }
  fail(error) {
    this.available = false;
    console.error('3D 渲染中断',error);
    this.onError(error);
  }
  async recover() {
    this.available = false;
    this.resizeObserver?.disconnect();
    const target=this.controls?.target.clone(),position=this.camera.position.clone(),quaternion=this.camera.quaternion.clone(),up=this.camera.up.clone();
    const limits=this.controls?{min:this.controls.minDistance,max:this.controls.maxDistance}:null;
    this.controls?.dispose();
    const old = this.renderer;
    this.renderer = null; // Ignore the old device's asynchronous loss callback.
    old?.domElement.remove();
    old?.dispose();
    await this.init();
    this.renderSchedule.resetClock();
    this.camera.position.copy(position);this.camera.up.copy(up);this.camera.quaternion.copy(quaternion);
    if(target){this.controls.target.copy(target);this.controls.minDistance=limits.min;this.controls.maxDistance=limits.max;this.controls.update();}
    this.refresh(this.engine);
  }
  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h || !this.renderer) return;
    this.camera.aspect = w/h; this.camera.updateProjectionMatrix(); this.renderer.setSize(w,h);this.controls?.handleResize();
    this.renderSchedule.invalidate();
  }
  resetCamera() {
    const b=this.layout&&this.outputBoard.fitBounds(this.layout.bounds);
    if(!b)return;
    const center=new THREE.Vector3((b.min.x+b.max.x)/2,(b.min.y+b.max.y)/2,(b.min.z+b.max.z)/2);
    const direction=new THREE.Vector3(.18,0,1).normalize();
    const right=new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0),direction).normalize();
    const up=new THREE.Vector3().crossVectors(direction,right);
    const tangent=Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2));
    let distance=4;
    // Fit every node and its labels, with room for the layout controls above.
    for(const x of [b.min.x-.6,b.max.x+.6])for(const y of [b.min.y-.9,b.max.y+.6])for(const z of [b.min.z-.4,b.max.z+.4]){
      const v=new THREE.Vector3(x,y,z).sub(center),depth=v.dot(direction);
      distance=Math.max(distance,depth+Math.max(Math.abs(v.dot(right))/(tangent*this.camera.aspect*.82),Math.abs(v.dot(up))/(tangent*.72)));
    }
    this.camera.position.copy(center).addScaledVector(direction,distance);
    this.camera.far=Math.max(500,distance*5);this.camera.updateProjectionMatrix();
    this.controls?.target.copy(center);this.camera.up.set(0,1,0);this.camera.lookAt(center);
    if(this.controls){this.controls.minDistance=.2;this.controls.maxDistance=Math.max(200,distance*4);this.controls.update();}
    this.renderSchedule.invalidate();
  }
  requestLayout(mode=this.layoutMode) {
    this.layoutMode=mode;
    const generation=++this.layoutGeneration;
    this.layoutWorker?.terminate();
    this.onLayout({pending:true,requestedMode:mode});
    const worker=new Worker(new URL('./layout-worker.js',import.meta.url),{type:'module'});
    this.layoutWorker=worker;
    worker.onmessage=({data})=>{
      if(generation!==this.layoutGeneration)return;
      worker.terminate();this.layoutWorker=null;
      if(data.error){this.onLayout({error:data.error,requestedMode:mode});return;}
      this.applyLayout(data.result);this.onLayout(data.result);
    };
    worker.onerror=event=>{
      if(generation!==this.layoutGeneration)return;
      worker.terminate();this.layoutWorker=null;
      this.onLayout({error:event.message||'布局计算失败',requestedMode:mode});
    };
    worker.postMessage({model:this.model,mode});
  }
  applyLayout(layout) {
    this.layout=layout;
    for(const [key,v] of this.visuals){
      const p=layout.positions.get(key);if(!p)continue;
      v.mesh.position.set(p.x,p.y,p.z);
      v.title.position.copy(v.mesh.position).add(new THREE.Vector3(0,TITLE_OFFSET,0));
      v.count.position.copy(v.mesh.position).add(new THREE.Vector3(0,COUNT_OFFSET,0));
      v.q?.position.copy(v.mesh.position);
      v.mesh.updateMatrixWorld();this.batches?.setNode(v.batchIndex,v.mesh);
    }
    const byId=new Map();for(const v of this.visuals.values())if(!byId.has(v.id))byId.set(v.id,v.mesh.position);
    for(const [index,edge] of this.edges.entries()){
      edge.curve=this.edgeCurve(byId.get(edge.source),this.visuals.get(edge.targetKey).mesh.position,edge.laneIndex,edge.laneCount,edge.source===edge.target,edge.sourceKey,edge.targetKey);
      if(edge.highlight){this.group.remove(edge.highlight);edge.highlight.geometry.dispose();edge.highlight.material.dispose();edge.highlight=null;}
      edge.endT=arrowEnd(edge.curve,this.visuals.get(edge.targetKey).mesh.position);
      edge.arrow.position.copy(edge.curve.getPoint(edge.endT));
      edge.arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),edge.curve.getTangent(edge.endT).normalize());
      this.batches?.setEdge(index,edge.curve,edge.endT,edge.arrow);
    }
    if(this.grid)this.grid.position.y=layout.bounds.min.y-1.5;
    this.rebuildOutputBoard();this.progress(this.signalProgress??0);this.refresh(this.engine);
  }
  edgeCurve(start,end,index,total,selfLoop,sourceKey,targetKey) {
    const curve=new FloatingEdgeCurve(start,end,sourceKey,targetKey,index,total);curve.time=this.edgeTime;return curve;
  }
  setModel(model) {
    this.labels?.dispose();this.batches?.dispose();
    for(const v of this.visuals.values())v.mesh.material.dispose();
    this.nodeGeometry?.dispose();
    disposeGroup(this.group); this.clearSignals(); this.visuals.clear(); this.edges = [];
    this.labels=new NodeLabels();this.group.add(this.labels.group);
    this.model = model; this.engine = null;
    this.outputState.configure(this.outputState.config,model.outputs);this.pendingLampDirty.clear();this.syncOutputs();
    const sorted = [...model.nodes].sort((a,b) => /^Q\d+$/.test(a.id)&&/^Q\d+$/.test(b.id) ? order(a.id,b.id) : a.key.localeCompare(b.key));
    this.layoutMode=DEFAULT_LAYOUT_MODE;
    this.layout=createLayout(model,this.layoutMode);
    this.nodeGeometry=new THREE.BoxGeometry(NODE_SIZE,NODE_SIZE,NODE_SIZE);
    const positions = new Map(),keysById=new Map();
    const add = (key,id,type,pos,state,error) => {
      // Lightweight off-scene proxies retain exact per-node picking and positions.
      const mesh = new THREE.Mesh(this.nodeGeometry, new THREE.MeshBasicMaterial({color:error?colors.error:colors[type]}));
      mesh.position.copy(pos); mesh.userData.key = key;mesh.updateMatrixWorld();
      const title = this.labels.add(id); title.position.copy(pos).add(new THREE.Vector3(0,TITLE_OFFSET,0));
      const count = this.labels.add(type==='Q'?'0 次':'',{color:'#5c7a96',size:17}); count.position.copy(pos).add(new THREE.Vector3(0,COUNT_OFFSET,0));
      title.visible=count.visible=!this.nodeLabelsHidden;
      const q = state ? this.labels.add('q',{color:'#173145',size:30,renderOrder:6}) : null;
      if(q){q.scale.set(.46,.115,1);q.position.copy(pos);}
      this.visuals.set(key,{mesh,title,count,q,id,type,error,base:colors[type],lastCount:0,batchIndex:this.visuals.size});
      if(!positions.has(id)){positions.set(id,pos);keysById.set(id,key);}
    };
    const at=key=>{const p=this.layout.positions.get(key);return new THREE.Vector3(p.x,p.y,p.z);};
    sorted.forEach(n=>add(n.key,n.id,'Q',at(n.key),n.initial!==null,!!n.errors.length));
    model.inputs.forEach(id=>add(id,id,'X',at(id),false,false));
    model.outputs.forEach(o=>add(o.id,o.id,'Y',at(o.id),false,!!o.error));
    const rawEdges=[];
    for(const n of model.nodes)for(const t of n.tokens)if(t.source)rawEdges.push({source:t.source,target:n.id,targetKey:n.key,op:t.op,index:t.index});
    for(const o of model.outputs)if(positions.has(o.source))rawEdges.push({source:o.source,target:o.id,targetKey:o.id,op:'Y',index:0});
    const drawable=rawEdges.filter(e=>positions.has(e.source)&&this.visuals.has(e.targetKey)).map(e=>({...e,sourceKey:keysById.get(e.source)}));
    for(const e of assignEdgeLanes(drawable)){
      const start=positions.get(e.source),end=this.visuals.get(e.targetKey)?.mesh.position;
      if(!start||!end)continue;
      const curve=this.edgeCurve(start,end,e.laneIndex,e.laneCount,e.source===e.target,e.sourceKey,e.targetKey);
      const endT=arrowEnd(curve,end);
      const arrow=new THREE.Object3D();
      arrow.position.copy(curve.getPoint(endT));arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),curve.getTangent(endT).normalize());
      this.edges.push({...e,curve,arrow,endT});
    }
    this.batches=new NetworkBatches(this.visuals.size,this.edges.length);this.group.add(this.batches.group);
    for(const v of this.visuals.values())this.batches.setNode(v.batchIndex,v.mesh);
    this.edges.forEach((e,i)=>{this.batches.setEdge(i,e.curve,e.endT,e.arrow);this.batches.setEdgeStyle(i,colors[e.op],false);});
    this.batches.commit();this.labels.flush();
    const b=this.layout.bounds;
    const size=Math.max(20,b.max.x-b.min.x+8,b.max.z-b.min.z+8);
    const grid=new THREE.GridHelper(size,Math.min(100,Math.ceil(size)),0x29445a,0x172c40);grid.position.y=b.min.y-1.5;grid.material.transparent=true;grid.material.opacity=.35;this.group.add(grid);this.grid=grid;this.setBlackBackground(this.blackBackground??false);
    this.rebuildOutputBoard();this.requestLayout();
  }
  pickObjects(){return [...this.visuals.values()].map(v=>v.mesh).concat(this.outputBoard.pickObjects());}
  setOutputDisplay(config){this.outputState.configure(config,this.model?.outputs??[]);this.pendingLampDirty.clear();this.syncOutputs();this.rebuildOutputBoard();}
  rebuildOutputBoard(){this.outputBoard.rebuild(this.outputState.config,this.visuals,this.layout,this.edgeTime);this.outputBoard.paint(this.outputState.results,this.outputState.results.map((_,i)=>i));this.pendingLampDirty.clear();this.outputBoard.select(this.selected);this.renderSchedule.invalidate();}
  setBlackBackground(enabled) {
    this.blackBackground=enabled;
    this.scene.background=enabled?new THREE.Color(0x000000):null;
    this.scene.fog=enabled?null:new THREE.FogExp2(0x0a1422,.012);
    if(this.grid)this.grid.visible=!enabled;
    this.container.closest('.main-view')?.classList.toggle('black-background',enabled);
    this.renderSchedule.invalidate();
  }
  setNodeLabelsHidden(hidden) {
    this.nodeLabelsHidden=hidden;
    for(const v of this.visuals.values())v.title.visible=v.count.visible=!hidden;
    this.renderSchedule.invalidate();
  }
  select(key) {this.selected=key;this.outputBoard.select(key);this.refresh(this.engine);}
  syncOutputs(engine,event) {
    if(engine)this.engine=engine;
    // Preserve every Yi publication in the projection while deferring GPU writes.
    if(event&&!event.transfers?.some(t=>/^Y(?:0|[1-9]\d*)$/.test(t.target)))return;
    for(const index of this.outputState.update(this.engine?.outputs??new Map()))this.pendingLampDirty.add(index);
  }
  refresh(engine) {
    this.syncOutputs(engine);
    if(this.pendingLampDirty.size){this.outputBoard.paint(this.outputState.results,[...this.pendingLampDirty]);this.pendingLampDirty.clear();}
    const selectedId=this.visuals.get(this.selected)?.id;
    const high=new Set();
    for(const [key,v]of this.visuals){
      const count=this.engine?.counts.get(key)??0;if(count>1000)high.add(v.id);
      const selected=key===this.selected;
      v.mesh.material.color.setHex(v.error||count>1000?colors.error:v.base);
      v.title.color.setHex(selected?0x85efd0:0xffffff);
      if(v.type==='Q'&&count!==v.lastCount){
        v.count.setText(`${count} 次`,count>1000?'#ff697e':'#5c7a96',17);v.lastCount=count;
      }
      v.title.visible=v.count.visible=!this.nodeLabelsHidden;
      this.batches?.setNode(v.batchIndex,v.mesh);
    }
    for(const [index,e] of this.edges.entries()){
      const active=!!selectedId&&(e.source===selectedId||e.targetKey===this.selected);
      const red=high.has(e.source)||high.has(e.target),color=red?colors.error:colors[e.op];
      e.arrow.scale.setScalar(active?1.35:1);
      this.batches?.setEdgeStyle(index,color,active);
      // A tube provides real thickness on WebGPU; LineBasicMaterial linewidth does not.
      if(active&&!e.highlight){
        e.highlight=new THREE.Mesh(new THREE.TubeGeometry(e.curve,36,.014,5,false),new THREE.MeshBasicMaterial({color}));
        this.group.add(e.highlight);
      }
      if(e.highlight){if(active&&!e.highlight.visible)updateTubeGeometry(e.highlight.geometry,e.curve);e.highlight.visible=active;e.highlight.material.color.setHex(color);}
    }
    this.batches?.commit();this.renderSchedule.invalidate();
  }
  clearSignals(){disposeGroup(this.signalGroup);this.signals=[];this.renderSchedule.invalidate();}
  showTransfers(transfers){
    this.clearSignals();
    if(!this.available)return;
    const lookup=new Map(transfers.map(t=>[t.source+'>'+t.target,t.value]));
    for(const edge of this.edges){
      const value=lookup.get(edge.source+'>'+edge.target);if(value===undefined)continue;
      const text=label(String(value),'#eefcf8',34);text.scale.set(1.5,.375,1);this.signalGroup.add(text);
      const tip=new THREE.Mesh(new THREE.ConeGeometry(.04,.11,8).translate(0,-.055,0),new THREE.MeshBasicMaterial({color:0xb4ffdf}));this.signalGroup.add(tip);
      this.signals.push({edge,text,tip});
    }
    this.progress(0);
  }
  progress(t){this.signalProgress=t;if(this.signals.length)this.renderSchedule.invalidate();for(const {edge,text,tip}of this.signals){const at=t*edge.endT;tip.position.copy(edge.curve.getPoint(at));tip.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),edge.curve.getTangent(at).normalize());text.position.copy(edge.curve.getPoint(Math.max(0,at-.09))).add(new THREE.Vector3(0,.23,0));}}
  render(animate=true){
    if(!this.available)return;
    const now=performance.now();this.controls.update();
    const frame=this.renderSchedule.sample(now,{animate,active:animate&&this.signals.length>0&&this.signalProgress<1,hidden:document.hidden});
    if(!frame)return;
    if(animate)this.edgeTime+=frame.deltaSeconds;
    // Gentle motion at 20Hz, with persistent buffers and coherent arrows/highlights/signals.
    if(animate&&now-(this.lastEdgeUpdate??0)>=50){
      this.lastEdgeUpdate=now;
      for(const [index,e] of this.edges.entries()){
        e.curve.time=this.edgeTime;e.curve.needsUpdate=true;
        e.endT=arrowEnd(e.curve,this.visuals.get(e.targetKey).mesh.position);
        e.arrow.position.copy(e.curve.getPoint(e.endT));e.arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),e.curve.getTangent(e.endT).normalize());
        this.batches.setEdge(index,e.curve,e.endT,e.arrow);
        if(e.highlight?.visible)updateTubeGeometry(e.highlight.geometry,e.curve);
      }
      this.outputBoard.tick(this.edgeTime);this.progress(this.signalProgress??0);
    }
    this.batches?.commit();this.labels?.flush();this.renderer.render(this.scene,this.camera);
  }
}
