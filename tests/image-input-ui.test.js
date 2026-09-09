import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ImageInputUI} from '../src/image-input-ui.js';
import {defaultImageInputConfig} from '../src/image-input.js';
import {compileModel,JKEngine} from '../src/engine.js';

const png=await readFile(new URL('./fixtures/image-input-rgba.png',import.meta.url));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const ids=(start=0,count=8)=>Array.from({length:count},(_,i)=>`X${start+i}`);
const element=()=>({value:'',textContent:'',hidden:false,disabled:false,classList:{add(){},remove(){},toggle(){}}});
const bitmap=(values=[1,2,4,8])=>({width:2,height:2,data:new Uint8ClampedArray(values.flatMap(v=>[v,v,v,255])),closed:0,close(){this.closed++;}});

// Only the Canvas/DOM boundary is replaced. Selection, import, conversion,
// model invalidation and apply all execute the real ImageInputUI methods.
function canvas(){
  const result={...element(),width:280,height:150,captured:new Set(),rect:{left:11,top:17,width:400,height:300}};
  const context={
    clearRect(){},setTransform(){},fillRect(){},save(){},restore(){},beginPath(){},rect(){},fill(){},moveTo(){},lineTo(){},stroke(){},strokeRect(){},
    drawImage(source){result.pixels=source.data??source.pixels;},
    putImageData(data){result.pixels=data.data;},
    getImageData(x,y,width,height){
      const data=new Uint8ClampedArray(width*height*4);
      for(let row=0;row<height;row++)for(let col=0;col<width;col++){
        const at=((y+row)*result.width+x+col)*4;
        data.set(result.pixels.subarray(at,at+4),(row*width+col)*4);
      }
      return {width,height,data};
    },
  };
  Object.assign(result,{getContext:()=>context,getBoundingClientRect:()=>result.rect,focus(){},setPointerCapture(id){this.captured.add(id);},hasPointerCapture(id){return this.captured.has(id);},releasePointerCapture(id){this.captured.delete(id);}});
  return result;
}

function harness(t){
  const saved=new Map(['document','ImageData','createImageBitmap'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const [key,descriptor]of saved)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
  const pending=[];
  globalThis.document={createElement(tag){assert.equal(tag,'canvas');return canvas();}};
  globalThis.ImageData=class{constructor(data,width,height){Object.assign(this,{data,width,height});}};
  globalThis.createImageBitmap=()=>{const job=pending.shift();assert.ok(job,'each decode must belong to a started import');job.started.resolve();return job.decoded.promise;};
  const ui=Object.create(ImageInputUI.prototype),fields=new Map(),infos=new Map(),actions=new Map(),empty=element(),screen=canvas();
  const lookup=map=>key=>{if(!map.has(key))map.set(key,element());return map.get(key);};
  Object.assign(ui,{
    config:{...defaultImageInputConfig(),encoding:'gray'},selection:{x:0,y:0,width:1,height:1},inputIds:ids(),modelVersion:1,generation:0,
    view:{scale:1,x:0,y:0,width:400,height:300},field:lookup(fields),info:lookup(infos),action:lookup(actions),canvas:screen,context:screen.getContext('2d'),
    preview:canvas(),jsonPreview:element(),stage:{querySelector:()=>empty},dialog:{open:true,close(){this.open=false;}},
    onApply(){},onApplied(){},
  });
  return {ui,async start(name){
    const job={started:deferred(),decoded:deferred()};pending.push(job);
    const done=ui.loadFile(Object.assign(new Blob([png]),{name}));await job.started.promise;
    return {done,finish:job.decoded.resolve,fail:job.decoded.reject};
  }};
}

async function loaded(t,values){
  const h=harness(t),job=await h.start('original.png'),image=bitmap(values);job.finish(image);await job.done;
  assert.equal(image.closed,1);assert.equal(h.ui.action('apply').disabled,false);return h;
}

test('a newer image wins even when an older import finishes last, and all bitmaps are released',async t=>{
  const h=await loaded(t),oldCanvas=h.ui.source,first=await h.start('first.png'),second=await h.start('second.png');
  const latest=bitmap([85,85,85,85]);second.finish(latest);await second.done;
  const source=h.ui.source,json=h.ui.result.json;
  assert.equal(h.ui.sourceName,'second.png');assert.equal(oldCanvas.width,0);assert.equal(oldCanvas.height,0);
  assert.equal(Object.values(JSON.parse(json)).join(''),'10101010');assert.equal(latest.closed,1);
  const stale=bitmap([255,255,255,255]);first.finish(stale);await first.done;
  assert.equal(stale.closed,1);assert.equal(h.ui.source,source);assert.equal(h.ui.result.json,json);
  assert.match(h.ui.info('file').textContent,/second\.png/);assert.equal(h.ui.loading,false);
});

test('closing cancels pending imports; their late results cannot cancel a new session or overwrite its image',async t=>{
  const h=await loaded(t),original=h.ui.source,late=await h.start('cancelled.png');
  h.ui.close();assert.equal(h.ui.dialog.open,false);assert.equal(h.ui.loading,false);
  h.ui.dialog.open=true;
  const next=await h.start('reopened.png'),cancelledBitmap=bitmap();late.finish(cancelledBitmap);await late.done;
  assert.equal(cancelledBitmap.closed,1);assert.equal(h.ui.source,original);assert.equal(h.ui.loading,true);
  assert.equal(h.ui.action('apply').disabled,true);assert.equal(h.ui.info('file').textContent,'正在解码图片…');
  const image=bitmap([165,165,165,165]);next.finish(image);await next.done;
  assert.equal(image.closed,1);assert.equal(h.ui.sourceName,'reopened.png');assert.equal(h.ui.action('apply').disabled,false);
  assert.equal(Object.values(JSON.parse(h.ui.result.json)).join(''),'10100101');
});

test('failed image replacement preserves the previous image, selection and usable JSON',async t=>{
  const h=await loaded(t),source=h.ui.source,selection={...h.ui.selection},json=h.ui.result.json;
  const failed=await h.start('broken.png');failed.fail(new Error('decoder rejected file'));await failed.done;
  assert.equal(h.ui.source,source);assert.equal(h.ui.sourceName,'original.png');assert.deepEqual(h.ui.selection,selection);
  assert.equal(h.ui.result.json,json);assert.equal(h.ui.action('apply').disabled,false);
  assert.equal(h.ui.info('error').hidden,false);assert.match(h.ui.info('error').textContent,/图片导入失败/);
});

test('model changes invalidate old mappings and an in-flight image maps only the latest Xi before applying inert JSON',async t=>{
  const h=await loaded(t),ui=h.ui,job=await h.start('pending.png');
  ui.setModel(ids(40,16),2);
  assert.equal(ui.action('apply').disabled,true);assert.equal(ui.jsonPreview.value,'');
  let calls=0,text='previous',appliedVersion,focus=0;
  ui.onApply=(json,version)=>{calls++;text=json;appliedVersion=version;};ui.onApplied=()=>focus++;
  ui.apply();assert.equal(calls,0);
  ui.setModel(ids(80),3);const image=bitmap([165,165,165,165]);job.finish(image);await job.done;
  assert.deepEqual(Object.keys(JSON.parse(ui.jsonPreview.value)),ids(80));assert.equal(ui.result.modelVersion,3);
  const model=compileModel({nodes:ids(80).map((id,i)=>({id:`Q${i}`,ex:`J0K(${id})`})),initial_q:{0:[],1:[]},q_y:[{Y0:'Q0'}]}),engine=new JKEngine(model);
  ui.apply();assert.equal(calls,1);assert.equal(appliedVersion,3);assert.equal(focus,1);assert.equal(ui.dialog.open,false);
  assert.deepEqual(Object.keys(JSON.parse(text)),ids(80));assert.equal(Object.values(JSON.parse(text)).join(''),'10100101');
  assert.equal(engine.length,0);assert.equal(engine.total,0);assert.equal(engine.latest.size,0);assert.equal(engine.history.length,0);
});

test('apply rejection leaves the dialog open and does not claim the JSON was written',async t=>{
  const {ui}=await loaded(t);let applied=0;
  ui.onApply=()=>{throw new Error('模型已更换，请重新提取像素数据。');};ui.onApplied=()=>applied++;
  ui.apply();assert.equal(ui.dialog.open,true);assert.equal(applied,0);assert.match(ui.info('error').textContent,/模型已更换/);
});

test('zoom and pan preserve extracted bits while a one-pixel selection drag changes the exact source pixel',async t=>{
  const {ui}=await loaded(t),json=ui.result.json,selection={...ui.selection};
  const anchor={x:127,y:93},before={x:(anchor.x-ui.view.x)/ui.view.scale,y:(anchor.y-ui.view.y)/ui.view.scale};
  ui.zoom(ui.view.scale/2,anchor.x,anchor.y);
  assert.ok(Math.abs((anchor.x-ui.view.x)/ui.view.scale-before.x)<1e-9);
  assert.ok(Math.abs((anchor.y-ui.view.y)/ui.view.scale-before.y)<1e-9);
  const pointer=(x,y,button=0)=>({pointerId:1,button,clientX:x+11,clientY:y+17,preventDefault(){}});
  ui.pointerDown(pointer(100,90,1));ui.pointerMove(pointer(180,45,1));ui.pointerEnd(pointer(180,45,1));
  assert.deepEqual(ui.selection,selection);assert.equal(ui.result.json,json);
  const x=ui.view.x+(ui.selection.x+.5)*ui.view.scale,y=ui.view.y+(ui.selection.y+.5)*ui.view.scale;
  ui.pointerDown(pointer(x,y));assert.equal(ui.action('apply').disabled,true);
  ui.pointerMove(pointer(x+ui.view.scale,y));ui.pointerEnd(pointer(x+ui.view.scale,y));
  assert.deepEqual(ui.selection,{x:1,y:0,width:1,height:1});assert.equal(Object.values(JSON.parse(ui.result.json)).join(''),'01000000');
  assert.equal(ui.action('apply').disabled,false);assert.equal(ui.canvas.captured.size,0);
});
