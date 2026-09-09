import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {defaultDisplay,validateDisplay,loadDisplay,channelsOf,convertPixel,parseBrightness,evaluateChannel,DisplayState,batchDisplay,resizeDisplay,exportDisplayModel,displayConnections} from '../src/output-display.js';
import {OutputBoard} from '../src/output-board.js';
import {compileModel,JKEngine} from '../src/engine.js';
import {Playback} from '../src/playback.js';
const bits=(ids,order='lsb-first',mapping='scale')=>({kind:'bits',bits:ids,order,mapping});
const values=(...v)=>new Map(v.map((b,i)=>['Y'+i,b]));
const bound={min:{x:-3,y:-2,z:-1},max:{x:3,y:2,z:1}};
const visuals=()=>new Map([['Y0',{type:'Y',mesh:{position:new THREE.Vector3(3,1,0)}}]]);
test('bit order, reorder, 64-bit exact decimal values and normalized rounding',()=>{
 assert.equal(evaluateChannel(bits(['Y0','Y1','Y2','Y3']),values(1,0,1,0)).value,'5');
 assert.equal(evaluateChannel(bits(['Y0','Y1','Y2','Y3'],'msb-first'),values(1,0,1,0)).value,'10');
 assert.equal(evaluateChannel(bits(['Y1','Y0'],'lsb-first','direct'),values(1,0)).brightness,2);
 for(const n of [1,4,8,64]){const ids=Array.from({length:n},(_,i)=>'Y'+i),v=new Map(ids.map(id=>[id,1])),r=evaluateChannel(bits(ids),v);assert.equal(r.value,((1n<<BigInt(n))-1n).toString());assert.equal(r.brightness,255);assert.equal(evaluateChannel(bits(ids,'lsb-first','direct'),v).brightness,n===1?1:n===4?15:255);}
 assert.equal(evaluateChannel(bits(['Y0','Y1','Y2','Y3']),values(1,0,0,0)).brightness,17);
});
test('fixed binary/decimal values are equivalent, malformed or out-of-range rejected',()=>{
 assert.equal(parseBrightness('0b11111111',2),255);assert.equal(parseBrightness('11111111',2),parseBrightness('255'));assert.equal(parseBrightness('101',10),101);for(const s of ['256','-1','1.5','Infinity'])assert.throws(()=>parseBrightness(s));assert.throws(()=>parseBrightness('102',2));
});
test('packed RGB slicing, round-trip conversion, and unsupported lossy conversion',()=>{
 const p={mode:'packed',bits:['Y0','Y1','Y2','Y3'],widths:{r:1,g:2,b:1},order:'lsb-first',mapping:'scale'},c=channelsOf(p);assert.deepEqual(c.g.bits,['Y1','Y2']);assert.deepEqual(convertPixel(convertPixel(p,'channels'),'packed'),p);assert.throws(()=>convertPixel(defaultDisplay(1,1).pixels[0],'packed'),/无损/);
});
test('missing and invalid output bits turn off only the affected channel; repeat values do not dirty lamps',()=>{
 const config=defaultDisplay(1,2);config.pixels[0].channels.r=bits(['Y0','Y1']);config.pixels[0].channels.g={kind:'fixed',value:100};config.pixels[1].channels.b=bits(['Y2']);
 const state=new DisplayState(config,[{id:'Y0'},{id:'Y1'},{id:'Y2',error:'输出依赖异常'}]);assert.deepEqual(state.update(values(1,null,1)),[0,1]);assert.equal(state.results[0].r.ready,false);assert.equal(state.results[0].g.brightness,100);assert.equal(state.results[1].b.brightness,0);assert.match(state.results[1].b.missing[0],/异常/);
 assert.deepEqual(state.update(values(1,null,1)),[]);assert.deepEqual(state.update(values(1,0,1)),[0]);assert.equal(state.results[0].r.brightness,85);assert.equal(evaluateChannel(bits(['Y100']),values()).ready,false);
});
test('batch allocation is row major, validates supply and keeps per-light overrides across resizing',()=>{
 const outputs=Array.from({length:24},(_,i)=>({id:'Y'+i}));const c=batchDisplay(defaultDisplay(2,2),{start:'Y0',width:2},outputs);assert.deepEqual(c.pixels[1].channels.r.bits,['Y6','Y7']);assert.deepEqual(c.pixels[3].channels.b.bits,['Y22','Y23']);assert.throws(()=>batchDisplay(c,{start:'Y1',width:2},outputs),/不会重复/);
 const gray=batchDisplay(defaultDisplay(1,2),{start:'Y0',width:1,gray:true},outputs);assert.deepEqual(gray.pixels[0].channels.r.bits,gray.pixels[0].channels.b.bits);
 c.pixels[3].channels.r={kind:'fixed',value:42};assert.equal(resizeDisplay(c,3,3).pixels[4].channels.r.value,42);
});
test('configuration import isolates errors; export preserves all original model fields and hash',()=>{
 const raw={name:'a',md5:'original',nodes:[],initial_q:{0:[],1:[]},q_y:[],custom:{foo:42}},c=defaultDisplay(1,1);c.enabled=true;
 const exported=exportDisplayModel(raw,c);assert.equal(exported.md5,raw.md5);assert.deepEqual(exported.custom,raw.custom);assert.ok(!('outputDisplay'in raw));assert.deepEqual(loadDisplay(JSON.parse(JSON.stringify(exported)).outputDisplay).config,c);assert.equal(loadDisplay(undefined).config.enabled,false);
 for(const bad of [{...c,version:2},{...c,rows:33},{...c,pixels:[]},{...c,enabled:'yes'}]){assert.equal(loadDisplay(bad).config.enabled,false);assert.ok(loadDisplay(bad).error);}
 assert.throws(()=>validateDisplay({...c,pixels:[{mode:'packed',bits:['Y0'],widths:{r:1,g:1,b:1},order:'lsb-first',mapping:'scale'}]}));
});
test('screen scale is optional in legacy v1, validated, and retained through resize, bulk binding and export',()=>{
 const c=defaultDisplay(1,1),legacy=structuredClone(c);delete legacy.scale;assert.equal(validateDisplay(legacy).scale,1);
 for(const scale of [.25,1,2.5,8]){
  const config=validateDisplay({...c,scale}),resized=resizeDisplay(config,2,2),batch=batchDisplay(resized,{start:'Y0',width:1,gray:true},Array.from({length:4},(_,i)=>({id:'Y'+i})));
  assert.equal(resized.scale,scale);assert.equal(batch.scale,scale);assert.equal(loadDisplay(JSON.parse(JSON.stringify(exportDisplayModel({md5:'unchanged'},batch))).outputDisplay).config.scale,scale);
 }
 for(const scale of [0,.24,8.01,NaN,Infinity,null,'2']){const loaded=loadDisplay({...c,enabled:true,scale});assert.ok(loaded.error);assert.equal(loaded.config.enabled,false);}
});
test('actual FIFO, partial send, paused step, repeated values and reset project current Yi without extra events',()=>{
 const model=compileModel({nodes:[{id:'Q0',ex:'J0K(X0)'},{id:'Q1',ex:'J0K(X1)'}],initial_q:{0:[],1:[]},q_y:[{Y0:'Q0'},{Y1:'Q1'}]}),engine=new JKEngine(model),c=defaultDisplay(1,1);c.pixels[0].channels.r=bits(['Y0','Y1']);const state=new DisplayState(c,model.outputs);const p=new Playback(engine,{onChange:()=>state.update(engine.outputs)});p.pause();p.send({X0:1});assert.equal(engine.total,0);p.step();assert.equal(state.results[0].r.ready,false);p.send({X1:0});p.step();assert.equal(state.results[0].r.brightness,85);assert.equal(engine.total,2);p.send({X0:1,X1:0});p.step();p.step();assert.equal(state.results[0].r.brightness,85);assert.equal(engine.total,4);p.reset();assert.equal(state.results[0].r.ready,false);assert.equal(state.results[0].r.brightness,0);
});
test('deduplication is per Yi/lamp/channel, not across channels or lamps',()=>{
 const c=defaultDisplay(1,2);c.pixels[0].channels.r=bits(['Y0','Y0']);c.pixels[0].channels.g=bits(['Y0']);c.pixels[1].channels.r=bits(['Y0']);assert.equal(displayConnections(c).length,3);
});
test('board faces +X, columns run toward -Z, rows run downward, selection and floating reuse buffers',()=>{
 const board=new OutputBoard(new THREE.Scene()),c=defaultDisplay(2,2);c.enabled=true;c.pixels[0].channels.r=bits(['Y0']);board.rebuild(c,visuals(),{bounds:bound});assert.ok(board.bounds.min.x-3>=3);assert.equal(board.positions[0].x,board.positions[1].x);assert.ok(board.positions[0].z>board.positions[1].z);assert.ok(board.positions[0].y>board.positions[2].y);assert.equal(board.positions[0].z,board.positions[2].z);
 board.group.updateMatrixWorld(true);
 const frontRay=new THREE.Raycaster(board.positions[0].clone().add(new THREE.Vector3(2,0,0)),new THREE.Vector3(-1,0,0)),front=frontRay.intersectObjects(board.pickObjects(),false)[0];assert.equal(front.object,board.lamps);assert.equal(front.instanceId,0);assert.ok(front.face.normal.x>.999);
 const backRay=new THREE.Raycaster(board.positions[0].clone().sub(new THREE.Vector3(2,0,0)),new THREE.Vector3(1,0,0));assert.equal(backRay.intersectObjects(board.pickObjects(),false)[0].object,board.frame);assert.equal(backRay.intersectObject(board.lamps).length,0);assert.equal(board.frame.userData.outputLamp,undefined);
 const state=new DisplayState(c,[{id:'Y0'}]);const dirty=state.update(values(1));board.paint(state.results,dirty);const color=new THREE.Color();board.lamps.getColorAt(0,color);assert.equal(color.r,1);assert.equal(color.g,0);
 const array=board.batches[0].line.geometry.attributes.position.array,before=[...array];board.tick(10);assert.strictEqual(board.batches[0].line.geometry.attributes.position.array,array);assert.notDeepEqual([...array],before);board.select('lamp:0');assert.equal(board.marker.visible,true);board.lamps.getColorAt(0,color);assert.equal(color.r,1);assert.equal(color.g,0);board.select('Y0');assert.equal(board.marker.visible,false);assert.ok(board.fitBounds(bound).max.x>bound.max.x);board.clear();assert.equal(board.group.children.length,0);assert.deepEqual(board.pickObjects(),[]);
});
test('uniform screen scaling preserves the output gap, white border, bindings, selection and wire anchors',()=>{
 const board=new OutputBoard(new THREE.Scene()),c=defaultDisplay(2,3);c.enabled=true;c.pixels[0].channels.r=bits(['Y0']);
 for(const scale of [.25,1,2,8]){
  board.rebuild({...c,scale},visuals(),{bounds:bound});board.select('lamp:0');
  assert.ok(Math.abs(board.positions[0].distanceTo(board.positions[1])-.45*scale)<1e-10);
  assert.ok(Math.abs(board.positions[0].distanceTo(board.positions[3])-.45*scale)<1e-10);
  assert.equal(board.bounds.min.x,6.1);assert.equal(board.lamps.count,6);assert.equal(board.edges.length,1);
  const lampSize=board.lamps.geometry.parameters;assert.equal(lampSize.width,.422*scale);assert.equal(lampSize.height,.422*scale);assert.equal(lampSize.depth,undefined);
  for(const material of [board.lamps.material,board.border.children[0].material]){assert.equal(material.fog,false);assert.equal(material.toneMapped,false);assert.equal(material.transparent,false);assert.equal(material.side,THREE.FrontSide);}
  assert.equal(board.border.children.length,1);assert.equal(board.border.children[0].material.color.getHex(),0xffffff);
  assert.deepEqual(board.marker.position,board.positions[0]);assert.equal(board.edges[0].curve.end.x,board.bounds.min.x);assert.ok(Math.abs(board.edges[0].curve.end.z-board.positions[0].z+.04*scale)<1e-10);
  board.group.updateMatrixWorld(true);const actualBounds=new THREE.Box3().setFromObject(board.frame).union(new THREE.Box3().setFromObject(board.border)).union(new THREE.Box3().setFromObject(board.lamps)).union(new THREE.Box3().setFromObject(board.ports)).union(new THREE.Box3().setFromObject(board.marker));for(const axis of ['x','y','z']){assert.ok(actualBounds.min[axis]>=board.bounds.min[axis]-1e-6);assert.ok(actualBounds.max[axis]<=board.bounds.max[axis]+1e-6);}
 }
 let borderDisposed=0;board.border.children[0].material.addEventListener('dispose',()=>borderDisposed++);board.clear();assert.equal(borderDisposed,1);
});
test('white border and selected-lamp outline have real holes, while thin rims remain visible',()=>{
 const board=new OutputBoard(new THREE.Scene()),c=defaultDisplay(1,1);c.enabled=true;board.rebuild(c,visuals(),{bounds:bound});board.select('lamp:0');board.group.updateMatrixWorld(true);
 const origin=board.positions[0].clone().add(new THREE.Vector3(2,0,0)),ray=new THREE.Raycaster(origin,new THREE.Vector3(-1,0,0));
 assert.equal(ray.intersectObject(board.border,true).length,0);assert.equal(ray.intersectObject(board.marker).length,0);assert.ok(ray.intersectObject(board.lamps).length>0);
 origin.z+=(.45+.04)/2-.012/2;ray.set(origin,new THREE.Vector3(-1,0,0));assert.ok(ray.intersectObject(board.border,true).length>0);
 const normals=board.lamps.geometry.attributes.normal;for(let i=0;i<normals.count;i++)assert.ok(normals.getX(i)>.999);board.clear();
});
test('backside ports deduplicate per lamp/channel and floating links never cross the screen',()=>{
 const board=new OutputBoard(new THREE.Scene()),c=defaultDisplay(1,1);c.enabled=true;c.pixels[0].channels={r:bits(['Y0','Y1','Y0']),g:bits(['Y0']),b:bits(['Y1'])};const nodes=visuals();nodes.set('Y1',{type:'Y',mesh:{position:new THREE.Vector3(3,-2,-1)}});board.rebuild(c,nodes,{bounds:bound});
 assert.equal(board.edges.length,4);assert.equal(board.ports.count,3);const points=[],matrix=new THREE.Matrix4();for(let i=0;i<board.ports.count;i++){board.ports.getMatrixAt(i,matrix);points.push(new THREE.Vector3().setFromMatrixPosition(matrix));}
 assert.equal(new Set(points.map(p=>p.z)).size,3);for(const e of board.edges){assert.ok(points.some(p=>p.distanceTo(e.curve.end)<1e-6));for(const time of [0,8,40,120,1000]){e.curve.time=time;for(let i=0;i<=100;i++)assert.ok(e.curve.getPoint(i/100).x<=board.bounds.min.x);assert.deepEqual(e.curve.getPoint(0),nodes.get(e.source).mesh.position);assert.deepEqual(e.curve.getPoint(1),e.curve.end);}}
 const normals=board.ports.geometry.attributes.normal;for(let i=0;i<normals.count;i++)assert.ok(normals.getX(i)<-.999);board.clear();
});
test('32x32 board batches 1024 lamps and 3072 links and disposes instance and geometry resources',()=>{
 const c=defaultDisplay(32,32);c.enabled=true;for(const p of c.pixels)for(const k of ['r','g','b'])p.channels[k]=bits(['Y0']);const board=new OutputBoard(new THREE.Scene());board.rebuild(c,visuals(),{bounds:bound});assert.equal(board.lamps.count,1024);assert.equal(board.ports.count,3072);assert.equal(board.edges.length,3072);assert.equal(board.batches.length,3);const resources=[board.lamps,board.lamps.geometry,board.ports,board.ports.geometry,board.ports.material],disposed=resources.map(()=>0);resources.forEach((r,i)=>r.addEventListener('dispose',()=>disposed[i]++));board.rebuild({...c,enabled:false},visuals(),{bounds:bound});assert.deepEqual(disposed,[1,1,1,1,1]);assert.equal(board.group.children.length,0);assert.equal(board.fitBounds(bound),bound);assert.deepEqual(board.pickObjects(),[]);
});

test('lamp colors retain all pending indices in one upload range while the board is hidden or culled',()=>{
 const config=defaultDisplay(1,4);config.enabled=true;
 const board=new OutputBoard(new THREE.Scene());board.rebuild(config,visuals(),{bounds:bound});
 const results=Array.from({length:4},()=>({r:{brightness:0},g:{brightness:0},b:{brightness:0}}));
 results[0].r.brightness=255;board.paint(results,[0]);
 for(let i=0;i<1000;i++){results[3].g.brightness=i%256;board.paint(results,[3]);}
 assert.deepEqual(board.lamps.instanceColor.updateRanges,[{start:0,count:12}]);
 const color=new THREE.Color();board.lamps.getColorAt(0,color);assert.equal(color.r,1);
 board.lamps.getColorAt(3,color);assert.ok(Math.abs(color.g-new THREE.Color().setRGB(0,231/255,0,THREE.SRGBColorSpace).g)<1e-7);
 board.lamps.instanceColor.clearUpdateRanges();results[1].b.brightness=255;board.paint(results,[1]);
 assert.deepEqual(board.lamps.instanceColor.updateRanges,[{start:3,count:3}]);
 board.clear();
});

test('all layout changes preserve camera, board configuration and live output; explicit reset includes board',async()=>{
 const {NetworkView}=await import('../src/view.js');const view=new NetworkView({}),c=defaultDisplay(2,2);c.enabled=true;c.pixels[0].channels.r={kind:'fixed',value:255};view.layout={mode:'1D',bounds:bound};view.setOutputDisplay(c);view.camera.position.set(7,3,14);view.camera.lookAt(0,0,0);view.controls={target:new THREE.Vector3(),update(){}};
 const position=view.camera.position.clone(),quaternion=view.camera.quaternion.clone();
 for(const mode of ['1D','2D','3D','4D','5D','auto']){view.applyLayout({mode,bounds:bound,positions:new Map()});assert.deepEqual(view.camera.position,position);assert.deepEqual(view.camera.quaternion.toArray(),quaternion.toArray());assert.deepEqual(view.outputState.config,c);assert.equal(view.outputState.results[0].r.brightness,255);}
 view.setOutputDisplay({...c,scale:3});assert.deepEqual(view.camera.position,position);assert.deepEqual(view.camera.quaternion.toArray(),quaternion.toArray());assert.equal(view.outputState.config.scale,3);
 view.resetCamera();assert.ok(view.controls.target.x>0);view.outputBoard.clear();
});
test('renderer recovery retains board resources/configuration, output state and rolled camera',async()=>{
 const {NetworkView}=await import('../src/view.js');const view=new NetworkView({}),c=defaultDisplay(1,1);c.enabled=true;c.pixels[0].channels.r={kind:'fixed',value:128};view.layout={mode:'1D',bounds:bound};view.setOutputDisplay(c);
 view.camera.position.set(9,3,15);view.camera.up.set(1,0,0);view.camera.lookAt(1,2,0);const controls={target:new THREE.Vector3(1,2,0),minDistance:.2,maxDistance:200,dispose(){},update(){}};view.controls=controls;view.renderer={domElement:{remove(){}},dispose(){}};
 const p=view.camera.position.clone(),up=view.camera.up.clone(),lamp=view.outputBoard.lamps;view.init=async()=>{view.controls={...controls,target:new THREE.Vector3()};view.available=true;};await view.recover();assert.deepEqual(view.camera.position,p);assert.deepEqual(view.camera.up,up);assert.deepEqual(view.outputState.config,c);assert.strictEqual(view.outputBoard.lamps,lamp);assert.equal(view.outputState.results[0].r.brightness,128);view.outputBoard.clear();
});
