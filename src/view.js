import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { order } from './engine.js';
const colors = { X: 0x73aaff, Q: 0xf1f6ff, Y: 0x79dfae, J: 0xe898c0, K: 0x689ef3, error: 0xff596e };
function label(text, color = '#a5bcd3', size = 22) {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = `500 ${size}px ui-monospace, SFMono-Regular, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color; ctx.fillText(text, 128, 32);
  const map = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false }));
  sprite.scale.set(2.7, .675, 1); sprite.renderOrder = 4;
  return sprite;
}
function disposeGroup(group) {
  group.traverse(obj => {
    obj.geometry?.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) if (m) { m.map?.dispose(); m.dispose(); }
  });
  group.clear();
}
export class NetworkView {
  constructor(container, onSelect) {
    this.container = container; this.onSelect = onSelect; this.available = false;
    this.scene = new THREE.Scene(); this.scene.fog = new THREE.FogExp2(0x0a1422, .012);
    this.camera = new THREE.PerspectiveCamera(42, 1, .1, 500);
    this.group = new THREE.Group(); this.scene.add(this.group);
    this.signalGroup = new THREE.Group(); this.scene.add(this.signalGroup);
    this.visuals = new Map(); this.edges = []; this.signals = [];
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
  }
  async init() {
    if (!navigator.gpu) throw new Error('浏览器没有提供 WebGPU 接口。请使用支持 WebGPU 的浏览器，通过 localhost 或 HTTPS 打开。');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('未能获取可用的 GPU adapter。请检查浏览器硬件加速和设备支持。');
    this.renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true });
    await this.renderer.init();
    if (!this.renderer.backend.isWebGPUBackend) { this.renderer.dispose(); throw new Error('WebGPU 初始化失败，本应用没有自动切换到 WebGL。'); }
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x091422, 0);
    this.container.append(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = .08; this.controls.minDistance = 4; this.controls.maxDistance = 200;
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(this.container);
    this.renderer.domElement.addEventListener('pointerdown', e => { this.down = { x: e.clientX, y: e.clientY }; });
    this.renderer.domElement.addEventListener('pointerup', e => {
      if (!this.down || Math.hypot(e.clientX-this.down.x,e.clientY-this.down.y)>5) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointer.set((e.clientX-rect.left)/rect.width*2-1, -(e.clientY-rect.top)/rect.height*2+1);
      this.raycaster.setFromCamera(this.pointer,this.camera);
      const hit = this.raycaster.intersectObjects([...this.visuals.values()].map(x=>x.mesh),false)[0];
      if (hit) this.onSelect(hit.object.userData.key);
    });
    this.available = true; this.resize(); this.resetCamera();
  }
  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h || !this.renderer) return;
    this.camera.aspect = w/h; this.camera.updateProjectionMatrix(); this.renderer.setSize(w,h);
  }
  resetCamera() {
    const span = this.span ?? 14;
    const fit = Math.max(1, 1 / Math.max(.4, this.camera.aspect));
    this.camera.position.set(span*.42, span*.43, span*1.02*fit);
    this.controls?.target.set(0,0,0); this.camera.lookAt(0,0,0); this.controls?.update();
  }
  setModel(model) {
    disposeGroup(this.group); this.clearSignals(); this.visuals.clear(); this.edges = [];
    this.model = model;
    const sorted = [...model.nodes].sort((a,b) => /^Q\d+$/.test(a.id)&&/^Q\d+$/.test(b.id) ? order(a.id,b.id) : a.key.localeCompare(b.key));
    const rows = Math.max(2,Math.ceil(Math.sqrt(sorted.length / 2))), columns = Math.max(1,Math.ceil(sorted.length/rows));
    const width = Math.max(5,(columns-1)*2.7), side = width/2+3.5;
    this.span = Math.max(side*2+2, Math.min(Math.max(model.inputs.length,model.outputs.length),12)*1.5,rows*2.5);
    const positions = new Map();
    const add = (key,id,type,pos,state,error) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(type==='Q'?.34:.25,20,14), new THREE.MeshBasicMaterial({ color:error?colors.error:colors[type] }));
      mesh.position.copy(pos); mesh.userData.key = key; this.group.add(mesh);
      const halo = new THREE.Mesh(new THREE.SphereGeometry(type==='Q'?.48:.37,16,12),new THREE.MeshBasicMaterial({ color: colors[type], transparent:true,opacity:.055,depthWrite:false }));
      halo.position.copy(pos); this.group.add(halo);
      const title = label(id); title.position.copy(pos).add(new THREE.Vector3(0,-.67,0)); this.group.add(title);
      const count = label(type==='Q'?'0 次':type==='X'?'INPUT':'OUTPUT','#5c7a96',17); count.position.copy(pos).add(new THREE.Vector3(0,-1.04,0)); this.group.add(count);
      const q = state ? label('q','#173145',30) : null;
      if(q){q.scale.set(1.8,.45,1);q.position.copy(pos);q.renderOrder=6;this.group.add(q);}
      const ring = new THREE.Mesh(new THREE.TorusGeometry(.57,.016,8,48),new THREE.MeshBasicMaterial({color:0x86e8cc,depthTest:false}));ring.position.copy(pos);ring.visible=false;this.group.add(ring);
      this.visuals.set(key,{mesh,halo,title,count,q,ring,id,type,error,base:colors[type],lastCount:0});
      if(!positions.has(id))positions.set(id,pos);
    };
    sorted.forEach((n,i)=>add(n.key,n.id,'Q',new THREE.Vector3((Math.floor(i/rows)-(columns-1)/2)*2.7,((rows-1)/2-i%rows)*2.4,(i%2===0?-1:1)*.65),n.initial!==null,!!n.errors.length));
    const terminalPosition = (i,length,x) => new THREE.Vector3(x,((Math.min(length,12)-1)/2-i%12)*1.7,Math.floor(i/12)*1.8);
    model.inputs.forEach((id,i)=>add(id,id,'X',terminalPosition(i,model.inputs.length,-side),false,false));
    model.outputs.forEach((o,i)=>add(o.id,o.id,'Y',terminalPosition(i,model.outputs.length,side),false,!!o.error));
    const rawEdges=[];
    for(const n of model.nodes)for(const t of n.tokens)if(t.source)rawEdges.push({source:t.source,target:n.id,targetKey:n.key,op:t.op,index:t.index});
    for(const o of model.outputs)if(positions.has(o.source))rawEdges.push({source:o.source,target:o.id,targetKey:o.id,op:'Y',index:0});
    const groups=new Map();
    for(const e of rawEdges){const k=e.source+'>'+e.targetKey;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(e);}
    for(const es of groups.values())es.forEach((e,i)=>{
      const start=positions.get(e.source),end=this.visuals.get(e.targetKey)?.mesh.position;
      if(!start||!end)return;
      let curve;
      if(e.source===e.target){curve=new THREE.CubicBezierCurve3(start.clone(),start.clone().add(new THREE.Vector3(-1.5,2,0)),start.clone().add(new THREE.Vector3(1.5,2,0)),end.clone());}
      else {const mid=start.clone().lerp(end,.5);mid.z+=(i-(es.length-1)/2)*1.0+.25;mid.y+=.15;curve=new THREE.QuadraticBezierCurve3(start.clone(),mid,end.clone());}
      const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(36)),new THREE.LineBasicMaterial({color:colors[e.op],transparent:true,opacity:.48}));this.group.add(line);
      const arrow=new THREE.Mesh(new THREE.ConeGeometry(.07,.22,8),new THREE.MeshBasicMaterial({color:colors[e.op],transparent:true,opacity:.8}));
      arrow.position.copy(curve.getPoint(.76));arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),curve.getTangent(.76).normalize());this.group.add(arrow);
      this.edges.push({...e,curve,line,arrow});
    });
    const grid=new THREE.GridHelper(Math.max(40,this.span*2),40,0x29445a,0x172c40);grid.position.y=-Math.max(5,rows*1.3);grid.material.transparent=true;grid.material.opacity=.35;this.group.add(grid);
    this.resetCamera();
  }
  select(key) {this.selected=key;this.refresh(this.engine);}
  refresh(engine) {
    if(engine)this.engine=engine;
    const selectedId=this.visuals.get(this.selected)?.id;
    const high=new Set();
    for(const [key,v]of this.visuals){
      const count=this.engine?.counts.get(key)??0;if(count>1000)high.add(v.id);
      const selected=key===this.selected;
      v.mesh.material.color.setHex(v.error||count>1000?colors.error:v.base);
      v.halo.material.opacity=selected?.17:.055;v.ring.visible=selected;
      if(count!==v.lastCount){this.group.remove(v.count);v.count.material.map.dispose();v.count.material.dispose();v.count=label(`${count} 次`,count>1000?'#ff697e':'#5c7a96',17);v.count.position.copy(v.mesh.position).add(new THREE.Vector3(0,-1.04,0));this.group.add(v.count);v.lastCount=count;}
    }
    for(const e of this.edges){const active=e.source===selectedId||e.target===selectedId;const red=high.has(e.source)||high.has(e.target);e.line.material.color.setHex(red?colors.error:colors[e.op]);e.arrow.material.color.setHex(red?colors.error:colors[e.op]);e.line.material.opacity=active?.95:.4;}
  }
  clearSignals(){disposeGroup(this.signalGroup);this.signals=[];}
  showTransfers(transfers){
    this.clearSignals();
    if(!this.available)return;
    const lookup=new Map(transfers.map(t=>[t.source+'>'+t.target,t.value]));
    for(const edge of this.edges){
      const value=lookup.get(edge.source+'>'+edge.target);if(value===undefined)continue;
      const text=label(String(value),'#eefcf8',34);text.scale.set(1.5,.375,1);this.signalGroup.add(text);
      const tip=new THREE.Mesh(new THREE.ConeGeometry(.11,.28,8),new THREE.MeshBasicMaterial({color:0xb4ffdf}));this.signalGroup.add(tip);
      this.signals.push({edge,text,tip});
    }
    this.progress(0);
  }
  progress(t){for(const {edge,text,tip}of this.signals){tip.position.copy(edge.curve.getPoint(t));tip.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),edge.curve.getTangent(t).normalize());text.position.copy(edge.curve.getPoint(Math.max(0,t-.09))).add(new THREE.Vector3(0,.23,0));}}
  render(){if(!this.available)return;this.controls.update();for(const v of this.visuals.values())v.ring.quaternion.copy(this.camera.quaternion);this.renderer.render(this.scene,this.camera);}
}
