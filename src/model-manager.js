import { compileModel } from './engine.js';
import { parseModelPool, defaultPoolEntry } from './model-pool.js';

const emptyModel = () => ({name:'模型池为空',nodes:[],initial_q:{0:[],1:[]},q_y:[]});
const emptyPool = () => ({version:1,revision:0,temporary:[],permanent:[]});
const apiUrl = import.meta.env?.VITE_MODEL_POOL_API_URL || './api/model-pool';
const newest = (entries, field) => entries.map((entry,index)=>({entry,index})).sort((a,b)=>Date.parse(b.entry[field])-Date.parse(a.entry[field])||b.index-a.index).map(item=>item.entry);

/** Shared records stay authoritative; disconnected imports live only in this page session. */
export class ModelManager {
  constructor(onLoad, onMessage, prepareDownload=raw=>raw) {
    this.onLoad=onLoad;this.onMessage=onMessage;this.busy=false;this.remote=false;this.writable=false;this.generation=0;
    this.prepareDownload=prepareDownload;
    this.localEntries=new Map();this.sharedPool=null;
    this.$=id=>document.getElementById(id);
    this.dialog=this.$('import-dialog');this.editor=this.$('model-json');this.picker=this.$('model-pool-select');
    this.authDialog=this.$('model-auth-dialog');this.pendingCommand=null;
    this.$('import-btn').onclick=()=>this.open();
    this.$('import-close').onclick=this.$('import-cancel').onclick=()=>this.close();
    this.dialog.addEventListener('cancel',event=>{if(this.busy||this.authDialog.open)event.preventDefault();else ++this.generation;});
    this.$('import-file').onclick=()=>this.$('file').click();
    this.$('file').onchange=async()=>{
      const file=this.$('file').files[0];if(!file)return;
      const generation=++this.generation;
      try {const text=await file.text();if(generation===this.generation&&this.dialog.open)await this.importText(text);}
      catch(error){if(generation===this.generation)this.error(error.message);}
      finally {this.$('file').value='';}
    };
    this.$('import-json').onclick=()=>this.importText(this.editor.value);
    this.$('model-download').onclick=()=>this.download();
    this.picker.onchange=()=>{++this.generation;this.select(this.picker.value,true);this.error('');};
    this.editor.oninput=()=>this.controls();
    this.$('model-pool-add').onclick=()=>this.mutate({action:'promote',id:this.selectedId});
    this.$('model-pool-delete').onclick=()=>{
      const entry=this.entry();
      if(entry)this.mutate({action:'delete',id:entry.id});
    };
    this.$('model-auth-confirm').onclick=()=>this.submitAuthorization();
    this.$('model-auth-cancel').onclick=()=>this.cancelAuthorization();
    this.$('model-auth-password').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();this.submitAuthorization();}};
    this.authDialog.addEventListener('cancel',event=>{event.preventDefault();this.cancelAuthorization();});
    this.controls();
  }

  entry(id=this.selectedId) {return this.pool&&[...this.pool.permanent,...this.pool.temporary].find(entry=>entry.id===id);}
  error(text) {this.$('import-error').textContent=text;this.$('import-error').hidden=!text;if(text)this.onMessage(text,true);}
  status(text) {
    const counts=this.pool?`永久 ${this.pool.permanent.length} 个 · 临时 ${this.pool.temporary.length} 个。`:'模型池未加载。';
    const access=!this.remote?'后端未连接：可导入、切换和下载模型；入池、删除暂不可用。':this.authRequired?'共享模型池 · 临时模型可直接导入、删除；入池或删除永久模型时需要口令。':'共享模型池 · 临时模型可直接导入、删除；永久模型管理尚未配置口令。';
    const local=this.localEntries.size?` ${this.localEntries.size} 个本页临时模型尚未确认共享保存，刷新页面会丢失，请下载或连接后入池。`:'';
    this.$('model-pool-status').textContent=`${text?text+' ':''}${counts} ${access}${local}`;
  }
  controls() {
    const blocked=this.busy||this.authDialog.open,allowed=this.remote&&this.writable&&!blocked,entry=this.entry();
    this.$('import-file').disabled=this.$('import-json').disabled=blocked;
    this.$('model-download').disabled=blocked||!this.editor.value.trim();
    this.$('model-pool-add').disabled=!allowed||!entry||!this.pool.temporary.some(item=>item.id===entry.id)||this.editor.value!==this.editorValue;
    this.$('model-pool-delete').disabled=!allowed||!entry;
    this.picker.disabled=blocked||!this.pool||!this.picker.options.length||!this.entry();
    this.editor.disabled=blocked;
    this.$('import-close').disabled=this.$('import-cancel').disabled=blocked;
    this.$('model-auth-confirm').disabled=this.$('model-auth-cancel').disabled=this.$('model-auth-password').disabled=this.busy;
  }
  select(id, load=false) {
    const entry=this.entry(id)??defaultPoolEntry(this.pool??emptyPool());
    this.selectedId=entry?.id??null;this.picker.value=this.selectedId??'';
    this.editor.value=this.editorValue=entry?JSON.stringify(entry.model,null,2):'';
    this.controls();
    if(load)this.onLoad(entry?.model??emptyModel());
  }
  render(preferredId=this.selectedId) {
    this.picker.replaceChildren();
    for(const [label,entries,field] of [['永久模型',this.pool.permanent,'promotedAt'],['临时模型',this.pool.temporary,'createdAt']]){
      const group=document.createElement('optgroup');group.label=label;
      for(const entry of newest(entries,field)){
        const option=document.createElement('option');option.value=entry.id;
        const time=Date.parse(entry[field])===0?'初始示例':new Date(entry[field]).toLocaleString();
        option.textContent=`${entry.model.name??'未命名模型'} · ${this.localEntries.has(entry.id)?'本页临时 · ':''}${time} · ${entry.id.slice(0,8)}`;
        group.append(option);
      }
      this.picker.append(group);
    }
    if(!this.pool.permanent.length&&!this.pool.temporary.length){const option=document.createElement('option');option.value='';option.textContent='模型池为空';this.picker.append(option);}
    this.select(preferredId);this.status();
  }

  applyPool(pool, preferredId=this.selectedId) {
    this.sharedPool=pool;
    this.pool={...pool,temporary:[...pool.temporary,...this.localEntries.values()]};
    this.render(preferredId);
  }
  importLocal(model, notice='已导入本页临时模型，可继续查看和下载。') {
    const id=`local-${crypto.randomUUID()}`;
    this.localEntries.set(id,{id,createdAt:new Date().toISOString(),promotedAt:null,model});
    this.applyPool(this.sharedPool??emptyPool(),id);this.select(id,true);
    this.status(notice);this.onMessage(notice);
  }
  download() {
    if(this.busy||this.authDialog.open)return;
    try {
      const draft=JSON.parse(this.editor.value);compileModel(draft);
      const raw=this.prepareDownload(draft);
      const text=JSON.stringify(raw,null,2)+'\n';
      const name=(typeof raw.name==='string'?raw.name:'jk-model').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').trim().replace(/[. ]+$/g,'').slice(0,100)||'jk-model';
      const url=URL.createObjectURL(new Blob([text],{type:'application/json;charset=utf-8'}));
      const link=document.createElement('a');link.href=url;link.download=`${name}.json`;
      try {document.body.append(link);link.click();}
      finally {link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
      this.error('');return text;
    } catch(error) {this.error(`下载失败：${error.message}`);}
  }
  disconnect() {
    this.remote=false;this.writable=false;this.authRequired=false;
    this.pendingCommand=null;this.$('model-auth-password').value='';this.authDialog.close();this.status();
  }

  async read() {
    try {
      const response=await fetch(apiUrl,{cache:'no-store',signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw new Error(`共享模型池读取失败（HTTP ${response.status}）`);
      const data=await response.json();const pool=parseModelPool(data.pool);
      return {pool,remote:true,writable:data.writable===true,authRequired:data.authRequired===true};
    } catch(error) {
      let pool=this.sharedPool;
      if(!pool){
        try {
          const response=await fetch('./example.json',{cache:'no-store',signal:AbortSignal.timeout(5000)});
          if(!response.ok)throw new Error('示例模型池不可用');
          pool=parseModelPool(await response.json());
        } catch {pool=emptyPool();}
      }
      return {pool,remote:false,writable:false,authRequired:false,connectionError:error.message};
    }
  }
  async refresh() {
    const previousId=this.selectedId,hadPool=!!this.pool;
    const draft=this.editor.value!==this.editorValue?this.editor.value:null;
    const {pool,...connection}=await this.read();Object.assign(this,connection);this.applyPool(pool);
    if(hadPool&&previousId===this.selectedId&&draft!==null){this.editor.value=draft;this.controls();}
    if(!this.remote&&hadPool)this.error(`后端连接失败：${this.connectionError}。仍可导入和下载模型。`);
    if(hadPool&&previousId!==this.selectedId)this.onLoad(this.entry()?.model??emptyModel());
  }
  async loadInitial() {
    this.busy=true;this.controls();
    try {await this.refresh();this.select(defaultPoolEntry(this.pool)?.id,true);}
    finally {this.busy=false;this.controls();}
  }
  async open() {
    if(!this.dialog.open)this.dialog.showModal();
    if(this.busy)return;
    this.error('');this.busy=true;this.controls();
    try {await this.refresh();}
    catch(error){this.writable=false;this.error(error.message);}
    finally {this.busy=false;this.controls();this.status();}
  }
  close() {if(!this.busy&&!this.authDialog.open){++this.generation;this.dialog.close();}}
  authError(text) {this.$('model-auth-error').textContent=text;this.$('model-auth-error').hidden=!text;}
  cancelAuthorization() {
    if(this.busy)return;
    this.pendingCommand=null;this.$('model-auth-password').value='';this.authError('');this.authDialog.close();this.controls();
  }
  requestAuthorization(command) {
    if(!this.authRequired){this.error('服务器尚未配置管理员口令，暂不能修改永久模型。');return;}
    ++this.generation;
    this.pendingCommand={...command};this.$('model-auth-password').value='';this.authError('');
    const name=this.entry(command.id)?.model.name??command.id;
    this.$('model-auth-description').textContent=command.action==='promote'?`将“${name}”移入永久模型组。`:`删除永久模型“${name}”，其他设备刷新后也将不再显示此模型。`;
    this.authDialog.showModal();this.controls();this.$('model-auth-password').focus();
  }
  async submitAuthorization() {
    if(this.busy||!this.pendingCommand)return;
    const token=this.$('model-auth-password').value.trim();
    if(!token){this.authError('请输入管理员口令。');return;}
    this.$('model-auth-password').value='';this.authError('');
    await this.mutate(this.pendingCommand,token);
  }
  async importText(text) {
    if(this.busy||this.authDialog.open)return;
    ++this.generation;
    try {
      const model=JSON.parse(text);compileModel(model);this.error('');
      if(!this.remote||!this.writable)this.importLocal(model);
      else await this.mutate({action:'import',model});
    }
    catch(error){this.error(`导入失败：${error.message}`);}
  }
  async mutate(command, authorization) {
    if(this.busy||!this.remote||!this.writable||(this.authDialog.open&&!authorization))return;
    const permanent=command.action==='promote'||(command.action==='delete'&&this.pool.permanent.some(entry=>entry.id===command.id));
    if(permanent&&!authorization){this.requestAuthorization(command);return;}
    this.busy=true;this.controls();this.error('');
    try {
      const local=this.localEntries.get(command.id);
      if(local&&command.action==='delete'){
        this.localEntries.delete(local.id);this.applyPool(this.sharedPool,defaultPoolEntry(this.sharedPool)?.id);
        this.select(this.selectedId,true);this.status('已删除本页临时模型。');return;
      }
      if(local&&command.action==='promote'){
        const uploaded=await this.post({action:'import',model:local.model});
        this.localEntries.delete(local.id);this.applyPool(uploaded.pool,uploaded.selectedId);
        command={action:'promote',id:uploaded.selectedId};this.pendingCommand=command;
      }
      const data=await this.post(command,authorization);
      const previousId=this.selectedId;
      this.pendingCommand=null;this.authDialog.close();
      this.applyPool(data.pool,data.selectedId);
      if(command.action!=='promote'||previousId!==this.selectedId)this.select(data.selectedId,true);
      const notice=command.action==='import'?'已导入临时模型，可点击“入池”保存为永久模型。':command.action==='promote'?'已保存为永久模型。':'已从共享模型池删除。';
      this.status(notice);this.onMessage(notice);
    } catch(error) {
      if(error.disconnected){
        this.disconnect();
        if(command.action==='import')this.importLocal(command.model,'共享保存未确认，已保留为本页临时模型；连接恢复后请核对。');
        else this.error('后端连接失败，共享操作结果未确认。当前模型已保留，可下载后重新打开模型管理核对。');
      } else if(error.status===409){
        this.pendingCommand=null;this.authDialog.close();await this.refresh();
        this.error('模型池已被其他设备更新，已刷新列表；请核对后重试。');
      } else if(this.authDialog.open)this.authError(error.message);else this.error(error.message);
    }
    finally {this.busy=false;this.controls();}
  }
  async post(command, authorization) {
    let response,data;
    try {
      response=await fetch(apiUrl,{method:'POST',headers:{...(authorization?{Authorization:`Bearer ${authorization}`}:{ }),'Content-Type':'application/json'},body:JSON.stringify({...command,revision:this.pool.revision}),signal:AbortSignal.timeout(10000)});
      data=await response.json();
    } catch(error) {throw Object.assign(error,{disconnected:true});}
    if(!response.ok)throw Object.assign(new Error(data.error??`保存失败（HTTP ${response.status}）`),{status:response.status,disconnected:response.status>=500});
    try {return {pool:parseModelPool(data.pool),selectedId:data.selectedId};}
    catch(error){throw Object.assign(error,{disconnected:true});}
  }
}
