import './style.css';
import { compileModel, JKEngine } from './engine.js';
import { Playback } from './playback.js';
import { NetworkView } from './view.js';
const $ = id => document.getElementById(id);
const el = (tag, text, className) => { const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e; };
let model,engine,playback,selected,view,importGeneration=0;
const outputElements=new Map(),pickerElements=new Map();
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
function select(key,toggle=true){selected=toggle&&selected===key?null:key;view?.select(selected);for(const [k,b]of pickerElements)b.classList.toggle('active',k===selected);renderInspector();}
function renderInspector(){
  if(!model)return;
  const box=$('inspector');box.replaceChildren();
  const n=model.nodes.find(n=>n.key===selected);
  $('selected-id').textContent=n?.id??selected??'—';
  if(!n){
    if(selected==null){box.append(el('p','选择节点，查看状态与求值过程。','muted'));return;}
    if(model.inputs.includes(selected)){box.append(el('p','输入节点 · 无持久状态','muted'),el('div',`最近发送：${engine.latest.get(selected)??'未发送'}`,'expression'));}
    else {const o=model.outputs.find(o=>o.id===selected);if(o){box.append(el('p',`输出来源 ${o.source}`,'muted'),el('div',o.error??`最近输出：${engine.outputs.get(o.id)??'未输出'}`,'expression'));}}
    return;
  }
  box.append(el('code',String(n.ex??'缺失 ex'),'expression'));
  if(n.errors.length){box.append(el('div',n.errors.join('；'),'errors'));return;}
  const grid=el('div',undefined,'detail-grid');
  for(const [name,value]of [['持久 q',n.initial===null?'无状态':engine.q.get(n.id)],['最近输出',engine.latest.get(n.id)??'—'],['执行次数',engine.counts.get(n.key)],['类型',n.initial===null?'无状态':'有状态']]){const cell=el('div');cell.append(el('span',name),el('b',String(value)));grid.append(cell);}
  box.append(grid);
  const wait=engine.waiting(n),cached=[...engine.cache.get(n.key)].map(([k,v])=>`${k}=${v}`).join(', ');
  box.append(el('div',n.required.length?`下一次触发等待：${wait.join('、')||'参数已齐'}${cached?' · 已收到 '+cached:''}`:'无到齐条件 · 每次参数通知触发','waiting'));
  const last=engine.last.get(n.key);
  if(last){const detail=el('details');detail.open=true;detail.append(el('summary',`最近求值 #${last.ticket} · 实际读取参数`));detail.append(el('pre',JSON.stringify(last.reads),'operation-list'));const ops=el('div',undefined,'operation-list');for(const op of last.operations)ops.append(el('div',`${op.token} : ${op.before} ${op.token[0]==='J'?'AND':'XOR'} ${op.input} → ${op.after}`));detail.append(ops);box.append(detail);}
}
function renderQueue(){
  if(!engine)return;
  const host=$('queue'),rowHeight=36;
  $('queue-count').textContent=engine.length.toLocaleString();$('queue-spacer').style.height=`${engine.length*rowHeight}px`;
  const maxScroll=Math.max(0,engine.length*rowHeight-host.clientHeight);if(host.scrollTop>maxScroll)host.scrollTop=maxScroll;
  const start=Math.max(0,Math.floor(host.scrollTop/rowHeight)-2),end=Math.min(engine.length,start+Math.ceil(host.clientHeight/rowHeight)+5);
  $('queue-rows').style.transform=`translateY(${start*rowHeight}px)`;
  const frag=document.createDocumentFragment();
  for(let i=start;i<end;i++){const item=engine.itemAt(i),row=el('div',undefined,'queue-row'),left=el('button');left.append(el('em',`#${item.ticket}`),el('span',item.node.id));left.onclick=()=>select(item.node.key);const val=el('span',Object.entries(item.values).map(([k,v])=>`${k}:${v}`).join(' ')||'执行时读取 q','values');val.title=JSON.stringify(item.values);row.append(left,val);frag.append(row);}
  $('queue-rows').replaceChildren(frag);$('queue-empty').hidden=engine.length>0;
}
function update(){
  if(!engine)return;
  for(const o of model.outputs){const cell=outputElements.get(o.id),v=engine.outputs.get(o.id);cell.textContent=o.error?'异常':v===null?'未输出':String(v);cell.classList.toggle('empty',v===null);}
  $('total').textContent=engine.total.toLocaleString();$('play').textContent=playback.running?'Ⅱ 暂停':'▶ 继续';
  $('step').disabled=false;
  const status=engine.capacityReached?'队列保护 · 已暂停':!playback.running?'已暂停':engine.length||playback.active||playback.visuals.length?'运行中':model.valid.some(n=>engine.waiting(n).length)?'等待输入':'就绪';
  $('run-status').textContent=status;
  $('footer-state').textContent=`${model.inputs.length} 输入 / ${model.nodes.length} JK / ${model.outputs.length} 输出 · ${engine.length} 待执行`;
  if(engine.capacityReached)message('队列达到 10,000 项保护阈值，自动执行已暂停；可单步或重载。不会丢弃执行项。',true);
  const fragment=document.createDocumentFragment();
  for(const event of engine.history.slice(-60).reverse()){
    const row=el('div',undefined,'history-row');
    if(event.type==='input')row.append(el('span','↗ '+(event.accepted.join(' · ')||'无匹配输入')),el('b','发送'));
    else row.append(el('span',`#${event.ticket}  ${event.node}`),el('b',`${event.before===null?'·':event.before} → ${event.value}`));fragment.append(row);
  }
  $('history').replaceChildren(fragment);renderQueue();renderInspector();view?.refresh(engine);
}
function install(raw){
  const next=compileModel(raw); // Validate before replacing the current model.
  model=next;engine=new JKEngine(model);selected=model.valid[0]?.key??model.nodes[0]?.key??model.inputs[0];
  playback=new Playback(engine,{onChange:update,onVisual:event=>event?view?.showTransfers(event.transfers):view?.clearSignals(),onProgress:t=>view?.progress(t)});
  playback.speed=Number($('speed').value);playback.skip=$('skip').checked;
  $('model-name').textContent=String(raw.name??'未命名模型');$('model-md5').textContent=`MD5: ${raw.md5??'未提供'}`;$('stat-nodes').textContent=model.nodes.length;$('stat-state').textContent=model.nodes.filter(n=>n.initial!==null).length;
  $('stat-edges').textContent=model.nodes.reduce((sum,n)=>sum+n.tokens.filter(t=>t.source).length,0)+model.outputs.length;
  const issues=[...model.issues,...model.nodes.flatMap(n=>n.errors.map(e=>`${n.id}：${e}`)),...model.outputs.filter(o=>o.error).map(o=>`${o.id}：${o.error}`)];
  $('model-errors').hidden=!issues.length;$('model-errors').textContent=issues.join('\n');
  $('metadata').textContent=JSON.stringify(Object.fromEntries(Object.entries(raw).filter(([k])=>!['nodes','initial_q','q_y'].includes(k))),null,2);
  $('outputs').replaceChildren();outputElements.clear();
  for(const o of model.outputs){const row=el('div',undefined,'output-row'),value=el('span','未输出','output-value empty');row.append(el('span',o.id),el('span',o.source,'source'),value);$('outputs').append(row);outputElements.set(o.id,value);}
  if(!model.outputs.length)$('outputs').append(el('p','此模型没有输出映射','muted'));
  $('node-picker').replaceChildren();pickerElements.clear();
  for(const item of [...model.inputs.map(id=>({id,key:id})),...model.nodes,...model.outputs.map(o=>({id:o.id,key:o.id,errors:o.error?[o.error]:[]}))]){const b=el('button',item.id);b.classList.toggle('bad',!!item.errors?.length);b.onclick=()=>select(item.key);$('node-picker').append(b);pickerElements.set(item.key,b);}
  const defaults=Object.fromEntries(model.inputs.map(id=>[id,0]));
  if(model.inputs.join(',')==='X0,X1,X2,X3')Object.assign(defaults,{X0:1,X2:1});
  $('input-json').value=JSON.stringify(defaults);$('queue').scrollTop=0;
  view?.setModel(model);select(selected,false);update();document.querySelector('.left-panel').scrollTop=0;message('已加载模型。发送信号或暂停后单步执行。');
}
$('queue').addEventListener('scroll',renderQueue);new ResizeObserver(renderQueue).observe($('queue'));
$('send').onclick=()=>{try{const e=playback.send(JSON.parse($('input-json').value));message(`已发送 ${e.accepted.length} 个输入${e.ignored.length?`，忽略 ${e.ignored.length} 个未匹配字段`:''}${!playback.running?'；保持暂停':''}。`);}catch(e){message(e.message,true);}};
$('play').onclick=()=>{try{playback.running?playback.pause():playback.resume();}catch(e){message(e.message,true);}};
$('step').onclick=()=>{try{playback.step();}catch(e){playback.pause();message(e.message,true);}};
$('reset').onclick=()=>{playback.reset();message('已重载初始状态，保持暂停。常量节点已重新入队。');};
$('speed').oninput=()=>{if(playback)playback.speed=Number($('speed').value);$('speed-value').textContent=$('speed').value+'×';};
$('skip').onchange=()=>{if(playback)playback.skip=$('skip').checked;};
function layoutStatus(result) {
  for(const button of $('layout-buttons').querySelectorAll('[data-layout]')) button.setAttribute('aria-pressed',String(button.dataset.layout===result.requestedMode));
  $('layout-buttons').setAttribute('aria-busy',String(!!result.pending));
  if(result.pending){$('layout-status').textContent='正在排列…';return;}
  if(result.error){$('layout-status').textContent=`布局失败：${result.error}`;return;}
  const mode=result.mode==='layered'?'拓扑分层':result.mode;
  $('layout-status').textContent=`${result.automatic?'自动 → ':''}${mode} · 间距 1`;
  $('layout-status').title=`${result.description}；实际连线总长 ${result.metrics.wireLength.toFixed(2)}；自动可读性评分为启发式结果`;
  $('viewport').dataset.layout=result.mode;
}
$('layout-buttons').onclick=event=>{
  const button=event.target.closest('[data-layout]');
  if(button&&view?.model)view.requestLayout(button.dataset.layout);
};
$('camera-reset').onclick=()=>view?.resetCamera();
$('node-labels').onclick=()=>{const button=$('node-labels'),hidden=button.getAttribute('aria-pressed')!=='true';button.setAttribute('aria-pressed',String(hidden));button.textContent=hidden?'显示名称和次数':'隐藏名称和次数';view?.setNodeLabelsHidden(hidden);};
$('black-background').onclick=()=>{const enabled=$('black-background').getAttribute('aria-pressed')!=='true';$('black-background').setAttribute('aria-pressed',String(enabled));view?.setBlackBackground(enabled);};
function importError(error) {
  $('import-error').textContent=`导入失败：${error.message}`;
  $('import-error').hidden=false;
  message(`导入失败：${error.message}`,true);
}
$('import-btn').onclick=()=>{$('import-error').hidden=true;$('import-dialog').showModal();};
$('import-close').onclick=$('import-cancel').onclick=()=>$('import-dialog').close();
$('import-file').onclick=()=>$('file').click();
$('import-json').onclick=()=>{
  ++importGeneration;
  try { install(JSON.parse($('model-json').value)); $('import-dialog').close(); }
  catch(e) { importError(e); }
};
$('file').onchange=async()=>{
  const file=$('file').files[0];if(!file)return;
  const generation=++importGeneration;
  try {
    const text=await file.text();
    if(generation===importGeneration){install(JSON.parse(text));$('import-dialog').close();}
  } catch(e) { if(generation===importGeneration)importError(e); }
  finally { $('file').value=''; }
};
function renderingFailed(error) {
  playback?.pause();
  $('backend').textContent='渲染已停止';
  $('gpu-message').hidden=false;
  $('gpu-detail').textContent=error.message;
  message(`3D 渲染中断：${error.message}。可点击“恢复 3D”，模型与计算状态仍保留。`,true);
}
$('gpu-retry').onclick=async()=>{
  $('gpu-retry').disabled=true;
  try {
    await view.recover();
    $('gpu-message').hidden=true;
    $('backend').textContent='WebGPU · 已连接';
    message('3D 已恢复，计算保持暂停，可继续或单步。');
  } catch(e) { renderingFailed(e); }
  finally { $('gpu-retry').disabled=false; }
};
async function start(){
  view=new NetworkView($('viewport'),select,renderingFailed,layoutStatus);
  const response=await fetch('./example.json');if(!response.ok)throw new Error('无法加载示例模型');install(await response.json());
  try{await view.init();$('backend').textContent='WebGPU · 已连接';view.setModel(model);view.select(selected);}catch(e){$('backend').textContent='WebGPU 不可用';$('gpu-message').hidden=false;$('gpu-detail').textContent=e.message;}
  let previous=performance.now(),lastStatus='';
  function frame(now){
    const dt=Math.min((now-previous)/1000,.1);previous=now;
    try{playback.tick(dt);const status=`${playback.running}:${!!playback.active}:${playback.visuals.length}:${engine.length}`;if(status!==lastStatus){lastStatus=status;update();}}
    catch(e){playback.pause();message(`执行错误：${e.message}`,true);}
    try { view.render(playback.running); } catch(e) { view.fail(e); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
start().catch(e=>message(`启动失败：${e.message}`,true));
