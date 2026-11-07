import { APP_CONFIG } from '../../html/config.js';
import * as THREE from 'three/webgpu';
import { OutputBoard } from './output-board.js';
import { DisplayState, defaultDisplay } from './display-state.js';
import { EditorControls } from './editor-controls.js';
import { compareDisplayNodes as compareNodes } from './model-view.js';
import { createLayout, DEFAULT_LAYOUT_MODE } from './layout.js';
import { disposeGroup } from './resources.js';
import { FloatingEdgeCurve, assignEdgeLanes, updateTubeGeometry } from './edge-curves.js';
import { NetworkBatches } from './network-batches.js';
import { NodeLabels } from './node-labels.js';
import { RenderSchedule } from './render-schedule.js';
import { createRenderer, disposeRenderer } from './renderer-backend.js';
import { adjustNetworkLayout, edgeStyleType, resolveNodeStyle } from './network-style.js';
const NODE_SIZE = .10;
const TITLE_OFFSET = -.19, COUNT_OFFSET = -.36;
// Find the last approach to the target box, including self-loop curves.
export function arrowEnd(curve, center, size = 1) {
  const box = new THREE.Box3().setFromCenterAndSize(center, new THREE.Vector3().setScalar(NODE_SIZE * size + .035));
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
  sprite.userData.label = { text, color, size };
  return sprite;
}
export class NetworkView {
  constructor(container, onSelect, onError = () => {}, onLayout = () => {}, onBackend = () => {}) {
    this.layoutMode=DEFAULT_LAYOUT_MODE; this.layoutGeneration=0; this.onLayout=onLayout;
    this.container = container; this.onSelect = onSelect; this.onError = onError; this.available = false;
    this.onBackend = onBackend;
    this.scene = new THREE.Scene(); this.scene.fog = new THREE.FogExp2(0x0a1422, .012);
    this.camera = new THREE.PerspectiveCamera(42, 1, .1, 500);
    this.camera.position.set(12,8,18);this.camera.lookAt(0,0,0);
    this.edgeTime=0;this.renderSchedule=new RenderSchedule();
    this.group = new THREE.Group(); this.scene.add(this.group);
    this.signalGroup = new THREE.Group(); this.scene.add(this.signalGroup);
    this.visuals = new Map(); this.edges = []; this.signals = [];
    this.appearance = null; this.labelAppearance = new WeakMap();
    this.networkStyles = null; this.originalLayout = null;
    this.nodeLabelsHidden=APP_CONFIG.scene.nodeLabelsHidden;
    this.outputBoard=new OutputBoard(this.scene);this.outputState=new DisplayState(defaultDisplay());this.pendingLampDirty=new Set();
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
  }
  /** Appearance is presentation-only and may arrive before renderer/model initialization. */
  applyAppearance(appearance) {
    const defaults = { ...APP_CONFIG.desktop.appearance, ...APP_CONFIG.desktop.windows.scene.appearance };
    const previous = this.appearance ?? defaults;
    const color = (value, fallback) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
    const numeric = (value, key) => {
      const range = APP_CONFIG.desktop.windows.scene.appearanceLimits?.[key] ?? APP_CONFIG.desktop.appearance.limits[key];
      return typeof value === 'number' && Number.isFinite(value) ? THREE.MathUtils.clamp(value, range.min, range.max) : previous[key];
    };
    const next = {
      background: color(appearance?.background, previous.background),
      opacity: numeric(appearance?.opacity, 'opacity'),
      foreground: color(appearance?.foreground, previous.foreground),
      fontScale: numeric(appearance?.fontScale, 'fontScale'),
    };
    if (this.appearance && Object.keys(next).every(key => next[key] === previous[key])) return { changed: false, blackBackgroundChanged: false };
    // CSS paints the configured gradient once. A deliberate background edit
    // exits the opaque black override; initial restoration preserves that mode.
    const blackBackgroundChanged = Boolean(this.appearance && this.blackBackground
      && (next.background !== previous.background || next.opacity !== previous.opacity));
    this.appearance = next;
    if (blackBackgroundChanged) this.setBlackBackground(false);
    this.syncLabelAppearance();
    this.renderSchedule.invalidate();
    return { changed: true, blackBackgroundChanged };
  }
  labelColor(base) {
    // Unconfigured views retain semantic colors; configured labels use their foreground.
    return this.appearance ? this.appearance.foreground : base;
  }
  styleNodeLabel(handle, original) {
    if (!handle) return;
    let base = this.labelAppearance.get(handle);
    if (!base) {
      base = { size: handle.fontSize, color: handle.textColor.clone() };
      this.labelAppearance.set(handle, base);
    }
    if (original) { base.size = original.size; base.color.set(original.color); }
    handle.fontSize = base.size * (this.appearance?.fontScale ?? 1);
    handle.textColor.set(this.labelColor(base.color));
  }
  styleSignalLabel(signal) {
    const handle = signal.text, original = handle.userData.label;
    let base = this.labelAppearance.get(handle);
    if (!base) {
      base = { scale: handle.scale.clone(), color: original.color };
      this.labelAppearance.set(handle, base);
    }
    const color = this.labelColor(original.color);
    if (base.color !== color) {
      paintLabel(handle.material.map.image, original.text, color, original.size);
      handle.material.map.needsUpdate = true; base.color = color;
    }
    handle.scale.copy(base.scale).multiplyScalar(this.appearance?.fontScale ?? 1);
  }
  syncLabelAppearance() {
    for (const visual of this.visuals.values()) {
      this.styleNodeLabel(visual.title); this.styleNodeLabel(visual.count); this.styleNodeMarker(visual);
    }
    for (const signal of this.signals) this.styleSignalLabel(signal);
  }
  styleNodeMarker(visual, style = resolveNodeStyle(visual, this.networkStyles)) {
    if (!visual.q) return;
    const defaults = APP_CONFIG.scene.styles.nodes.computationTypes.ex.marker;
    const marker = this.networkStyles?.computation?.ex?.marker;
    this.styleNodeLabel(visual.q);
    if (marker?.color !== undefined) visual.q.textColor.set(marker.color);
    visual.q.visible = visual.mesh.visible && (marker?.visible ?? (defaults.visible && style?.labels !== false));
  }
  setNetworkStyles(state) {
    const next = state ? structuredClone(state) : null;
    if (JSON.stringify(next) === JSON.stringify(this.networkStyles)) return;
    const before = this.networkStyles;
    this.networkStyles = next;
    const geometry = value => JSON.stringify({ lengths: ['J', 'K', 'trigger', 'source', 'observe'].map(key => value?.edges?.[key]?.length ?? 1),
      sizes: [...this.visuals.values()].map(node => resolveNodeStyle(node, value)?.size ?? 1) });
    if (this.originalLayout && geometry(before) !== geometry(next)) this.applyLayout(this.originalLayout, { preserveMotion: true });
    else this.refresh(this.engine);
  }
  placeVisualLabels(visual) {
    const offset = NODE_SIZE * (visual.mesh.scale.y - 1) / 2;
    visual.title.position.copy(visual.mesh.position).add(new THREE.Vector3(0, TITLE_OFFSET - offset, 0));
    visual.count.position.copy(visual.mesh.position).add(new THREE.Vector3(0, COUNT_OFFSET - offset, 0));
    visual.q?.position.copy(visual.mesh.position);
  }
  styleVisual(visual) {
    const style = resolveNodeStyle(visual, this.networkStyles);
    visual.mesh.visible = style?.visible !== false;
    visual.mesh.scale.setScalar(style?.size ?? 1);
    visual.styleColor = style ? new THREE.Color(style.color).getHex() : visual.base;
    visual.title.visible = visual.count.visible = visual.mesh.visible && style?.labels !== false && !this.nodeLabelsHidden;
    this.styleNodeMarker(visual, style);
    this.placeVisualLabels(visual);
    visual.mesh.updateMatrixWorld();
  }
  syncSignalStyles() {
    for (const signal of this.signals) {
      const visible = signal.edge.visible !== false;
      const opacity = this.networkStyles ? Math.min(1, (signal.edge.styleOpacity ?? .4) / .4) : 1;
      signal.text.visible = signal.tip.visible = visible;
      signal.text.material.opacity = opacity;
      signal.tip.material.transparent = opacity < 1; signal.tip.material.opacity = opacity;
    }
  }
  async init(options) {
    let result = await createRenderer(this, options);
    if (result.backend === 'webgpu' && result.renderer._isDeviceLost) {
      disposeRenderer(result.renderer);
      result = await createRenderer(this, { mode: 'canvas' });
    }
    this.renderer = result.renderer;this.backend = result.backend;this.fallbackReason = result.reason;
    const renderer = this.renderer;
    if (this.backend === 'webgpu') {
      const handleLoss = renderer.onDeviceLost.bind(renderer);
      renderer.onDeviceLost = info => {
        handleLoss(info);
        if (this.renderer === renderer) this.fail(new Error(info.message || 'GPU 设备连接丢失'));
      };
    }
    const settings = APP_CONFIG.scene.renderer;
    this.renderSchedule = new RenderSchedule(this.backend === 'canvas' ? settings.software : settings.gpu);
    this.renderer.setPixelRatio(this.backend === 'canvas' ? settings.software.pixelRatio : Math.min(globalThis.devicePixelRatio || 1, settings.gpu.maxPixelRatio));
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
      this.camera.updateMatrixWorld();
      this.raycaster.setFromCamera(this.pointer,this.camera);
      const hit = this.raycaster.intersectObjects(this.pickObjects(),false)[0];
      this.onSelect(hit?.object.userData.outputLamp?`lamp:${hit.instanceId}`:hit?.object.userData.key ?? null);
    });
    this.available = true; this.resize();this.onBackend(this.backend);
  }
  fail(error) {
    this.available = false;
    if (this.fallbackPending) return this.fallbackPending;
    if (this.backend === 'webgpu') {
      // Keep the scene, execution state, camera and interactions while replacing only the renderer.
      this.fallbackPending = this.recover({ mode: 'canvas' }).catch(fallbackError => {
        this.available = false;this.onError(fallbackError);
      }).finally(() => { this.fallbackPending = null; });
      return this.fallbackPending;
    }
    console.error('3D 渲染中断',error);
    this.onError(error);
  }
  async recover(options) {
    this.available = false;
    this.resizeObserver?.disconnect();
    const target=this.controls?.target.clone(),position=this.camera.position.clone(),quaternion=this.camera.quaternion.clone(),up=this.camera.up.clone();
    const limits=this.controls?{min:this.controls.minDistance,max:this.controls.maxDistance}:null;
    this.controls?.dispose();
    const old = this.renderer;
    this.renderer = null; // Ignore the old device's asynchronous loss callback.
    old?.domElement.remove();
    disposeRenderer(old);
    await this.init(options);
    this.renderSchedule.resetClock();
    this.camera.position.copy(position);this.camera.up.copy(up);this.camera.quaternion.copy(quaternion);
    if(target){this.controls.target.copy(target);this.controls.minDistance=limits.min;this.controls.maxDistance=limits.max;this.controls.update();}
    this.refresh(this.engine);
  }
  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h || !this.renderer) return;
    this.camera.aspect = w/h; this.camera.updateProjectionMatrix(); this.renderer.setSize(w,h,false);this.controls?.handleResize();
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
  applyLayout(layout, { preserveMotion = false } = {}) {
    this.originalLayout = layout;
    layout = adjustNetworkLayout(layout, this.edges, this.networkStyles, APP_CONFIG.scene.styles.layout);
    this.layout=layout;
    for(const [key,v] of this.visuals){
      const p=layout.positions.get(key);if(!p)continue;
      v.mesh.position.set(p.x,p.y,p.z);
      this.styleVisual(v);
      v.mesh.updateMatrixWorld();this.batches?.setNode(v.batchIndex,v.mesh);
    }
    const byId=new Map();for(const v of this.visuals.values())if(!byId.has(v.id))byId.set(v.id,v.mesh.position);
    for(const [index,edge] of this.edges.entries()){
      const prior=edge.curve;
      edge.curve=this.edgeCurve(byId.get(edge.source),this.visuals.get(edge.targetKey).mesh.position,edge.laneIndex,edge.laneCount,edge.sourceKey,edge.targetKey);
      if(preserveMotion){edge.curve.seed=prior.seed;edge.curve.speed=prior.speed;}
      if(edge.highlight){this.group.remove(edge.highlight);edge.highlight.geometry.dispose();edge.highlight.material.dispose();edge.highlight=null;}
      edge.endT=arrowEnd(edge.curve,this.visuals.get(edge.targetKey).mesh.position,this.visuals.get(edge.targetKey).mesh.scale.x);
      edge.arrow.position.copy(edge.curve.getPoint(edge.endT));
      edge.arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),edge.curve.getTangent(edge.endT).normalize());
      this.batches?.setEdge(index,edge.curve,edge.endT,edge.arrow);
    }
    if(this.grid)this.grid.position.y=layout.bounds.min.y-1.5;
    this.rebuildOutputBoard();this.progress(this.signalProgress??0);this.refresh(this.engine);
  }
  edgeCurve(start,end,index,total,sourceKey,targetKey) {
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
    const sorted = [...model.nodes].sort(compareNodes);
    this.layoutMode=DEFAULT_LAYOUT_MODE;
    this.layout=createLayout(model,this.layoutMode);
    this.originalLayout=this.layout;
    this.nodeGeometry=new THREE.BoxGeometry(NODE_SIZE,NODE_SIZE,NODE_SIZE);
    const positions = new Map(),keysById=new Map();
    const add = (key,id,type,pos,hasEX,error,displayName=id) => {
      // Lightweight off-scene proxies retain exact per-node picking and positions.
      const mesh = new THREE.Mesh(this.nodeGeometry, new THREE.MeshBasicMaterial({color:error?colors.error:colors[type]}));
      mesh.position.copy(pos); mesh.userData.key = key;mesh.updateMatrixWorld();
      const title = this.labels.add(displayName); title.position.copy(pos).add(new THREE.Vector3(0,TITLE_OFFSET,0));
      const count = this.labels.add(type==='Q'?'0 次':'',{color:'#5c7a96',size:17}); count.position.copy(pos).add(new THREE.Vector3(0,COUNT_OFFSET,0));
      title.visible=count.visible=!this.nodeLabelsHidden;
      const marker = APP_CONFIG.scene.styles.nodes.computationTypes.ex.marker;
      const q = hasEX ? this.labels.add(APP_CONFIG.scene.nodeMarker.text,{color:marker.color,size:marker.size,renderOrder:6}) : null;
      if(q){q.scale.set(.46,.115,1);q.position.copy(pos);}
      this.visuals.set(key,{mesh,title,count,q,id,type,hasEX,error,base:colors[type],lastCount:0,batchIndex:this.visuals.size});
      if(!positions.has(id)){positions.set(id,pos);keysById.set(id,key);}
    };
    const at=key=>{const p=this.layout.positions.get(key);return new THREE.Vector3(p.x,p.y,p.z);};
    sorted.forEach(n=>{
      add(n.key,n.id,'Q',at(n.key),n.hasEX,!!n.errors.length,n.displayName??n.id);
      const visual=this.visuals.get(n.key);visual.tags=n.tags??[];visual.isInput=!!n.isInput;
      if(n.isInput){visual.base=colors.X;visual.mesh.material.color.setHex(colors.X);}
    });
    model.inputs.forEach(id=>add(id,id,'X',at(id),false,false));
    model.outputs.forEach(o=>{add(o.id,o.id,'Y',at(o.id),false,!!o.error,o.displayName??o.id);this.visuals.get(o.id).tags=o.tags??[];});
    const rawEdges=[];
    for(const n of model.nodes)for(const t of n.tokens)if(t.source)rawEdges.push({source:t.source,target:n.id,targetKey:n.key,op:t.op,index:t.index,relation:t.relation});
    for(const o of model.outputs)if(positions.has(o.source))rawEdges.push({source:o.source,target:o.id,targetKey:o.id,op:'Y',index:0,relation:'observe'});
    const drawable=rawEdges.filter(e=>positions.has(e.source)&&this.visuals.has(e.targetKey)).map(e=>({...e,sourceKey:keysById.get(e.source)}));
    for(const e of assignEdgeLanes(drawable)){
      const start=positions.get(e.source),end=this.visuals.get(e.targetKey)?.mesh.position;
      if(!start||!end)continue;
      const curve=this.edgeCurve(start,end,e.laneIndex,e.laneCount,e.sourceKey,e.targetKey);
      const endT=arrowEnd(curve,end);
      const arrow=new THREE.Object3D();
      arrow.position.copy(curve.getPoint(endT));arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),curve.getTangent(endT).normalize());
      this.edges.push({...e,curve,arrow,endT});
    }
    this.batches=new NetworkBatches(this.visuals.size,this.edges.length);this.group.add(this.batches.group);
    for(const v of this.visuals.values())this.batches.setNode(v.batchIndex,v.mesh);
    this.edges.forEach((e,i)=>{this.batches.setEdge(i,e.curve,e.endT,e.arrow);this.batches.setEdgeStyle(i,colors[e.op],false);});
    this.batches.commit();this.syncLabelAppearance();this.labels.flush();
    const b=this.layout.bounds;
    const size=Math.max(20,b.max.x-b.min.x+8,b.max.z-b.min.z+8);
    const grid=new THREE.GridHelper(size,Math.min(100,Math.ceil(size)),0x29445a,0x172c40);grid.position.y=b.min.y-1.5;grid.material.transparent=true;grid.material.opacity=.35;this.group.add(grid);this.grid=grid;this.setBlackBackground(this.blackBackground??APP_CONFIG.scene.blackBackground);
    this.rebuildOutputBoard();if(this.networkStyles)this.applyLayout(this.originalLayout,{preserveMotion:true});this.requestLayout();
  }
  pickObjects(){return [...this.visuals.values()].filter(v=>v.mesh.visible!==false).map(v=>v.mesh).concat(this.outputBoard.pickObjects());}
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
    for(const v of this.visuals.values())this.styleVisual(v);
    this.renderSchedule.invalidate();
  }
  select(key) {this.selected=key;this.outputBoard.select(key);this.refresh(this.engine);}
  syncOutputs(engine,event) {
    if(engine)this.engine=engine;
    // A read-only projection of externally observed JKRD7 values; never a runtime output port.
    for(const index of this.outputState.update(this.engine?.outputs??new Map()))this.pendingLampDirty.add(index);
  }
  refresh(engine) {
    this.syncOutputs(engine);
    if(this.pendingLampDirty.size){this.outputBoard.paint(this.outputState.results,[...this.pendingLampDirty]);this.pendingLampDirty.clear();}
    const selectedId=this.visuals.get(this.selected)?.id;
    const high=new Set();
    for(const [key,v]of this.visuals){
      this.styleVisual(v);
      const count=this.engine?.counts.get(key)??0;if(count>1000)high.add(v.id);
      const selected=key===this.selected;
      v.mesh.material.color.setHex(v.error||count>1000?colors.error:v.styleColor);
      v.title.color.setHex(selected?0x85efd0:0xffffff);
      if(v.type==='Q'&&count!==v.lastCount){
        const countColor=count>1000?'#ff697e':'#5c7a96';
        v.count.setText(`${count} 次`,countColor,17);this.styleNodeLabel(v.count,{color:countColor,size:17});v.lastCount=count;
      }
      this.batches?.setNode(v.batchIndex,v.mesh);
    }
    for(const [index,e] of this.edges.entries()){
      const style=this.networkStyles?.edges?.[edgeStyleType(e)];
      e.visible=style?.visible!==false&&(style?.opacity??.4)>0&&this.visuals.get(e.sourceKey)?.mesh.visible!==false&&this.visuals.get(e.targetKey)?.mesh.visible!==false;
      e.styleOpacity=style?.opacity??.4;
      const active=e.visible&&!!selectedId&&(e.source===selectedId||e.targetKey===this.selected);
      const red=high.has(e.source)||high.has(e.target),color=red?colors.error:style?new THREE.Color(style.color).getHex():colors[e.op];
      e.arrow.scale.setScalar(active?1.35:1);
      this.batches?.setEdgeStyle(index,color,active,this.networkStyles?{opacity:e.styleOpacity,visible:e.visible}:null);
      // A tube provides real thickness on WebGPU; LineBasicMaterial linewidth does not.
      if(active&&!e.highlight){
        e.highlight=new THREE.Mesh(new THREE.TubeGeometry(e.curve,36,.014,5,false),new THREE.MeshBasicMaterial({color}));
        this.group.add(e.highlight);
      }
      if(e.highlight){if(active&&!e.highlight.visible)updateTubeGeometry(e.highlight.geometry,e.curve);e.highlight.visible=active;e.highlight.material.color.setHex(color);e.highlight.material.opacity=Math.min(1,e.styleOpacity/.4);e.highlight.material.transparent=e.highlight.material.opacity<1;}
    }
    this.syncSignalStyles();
    this.batches?.commit();this.renderSchedule.invalidate();
  }
  clearSignals(){disposeGroup(this.signalGroup);this.signals=[];this.renderSchedule.invalidate();}
  showTransfers(transfers){
    this.clearSignals();
    if(!this.available)return;
    for(const edge of this.edges){
      if(edge.visible===false)continue;
      const transfer=transfers.find(t=>t.source===edge.source&&t.target===edge.target
        &&(t.relation===undefined||t.relation===edge.relation)
        &&(t.index===undefined||t.index===edge.index));
      const value=transfer?.value;if(value===undefined)continue;
      const text=label(String(value),'#eefcf8',34);text.scale.set(1.5,.375,1);this.signalGroup.add(text);
      const tip=new THREE.Mesh(new THREE.ConeGeometry(.04,.11,8).translate(0,-.055,0),new THREE.MeshBasicMaterial({color:0xb4ffdf}));this.signalGroup.add(tip);
      const signal={edge,text,tip,value};this.signals.push(signal);this.styleSignalLabel(signal);
    }
    this.syncSignalStyles();
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
        e.endT=arrowEnd(e.curve,this.visuals.get(e.targetKey).mesh.position,this.visuals.get(e.targetKey).mesh.scale.x);
        e.arrow.position.copy(e.curve.getPoint(e.endT));e.arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),e.curve.getTangent(e.endT).normalize());
        this.batches.setEdge(index,e.curve,e.endT,e.arrow);
        if(e.highlight?.visible)updateTubeGeometry(e.highlight.geometry,e.curve);
      }
      this.outputBoard.tick(this.edgeTime);this.progress(this.signalProgress??0);
    }
    this.batches?.commit();this.labels?.flush();this.renderer.render(this.scene,this.camera);
  }
}
