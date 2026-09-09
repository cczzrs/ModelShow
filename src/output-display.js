/** Output-only projection. Never publishes events or changes the JK engine. */
export const CHANNELS=['r','g','b'];
const fail=message=>{throw new Error(message);};
const integer=(v,min,max,label)=>Number.isInteger(v)&&v>=min&&v<=max?v:fail(`${label} 必须为 ${min}～${max} 的整数`);
const choice=(v,values,label)=>values.includes(v)?v:fail(`${label} 无效`);
export const fixed=value=>({kind:'fixed',value});
export const emptyPixel=()=>({mode:'channels',channels:{r:fixed(0),g:fixed(0),b:fixed(0)}});
export function defaultDisplay(rows=4,cols=4){integer(rows,1,32,'行数');integer(cols,1,32,'列数');return {version:1,enabled:false,rows,cols,scale:1,pixels:Array.from({length:rows*cols},emptyPixel)};}
function bitList(bits,max=64){if(!Array.isArray(bits)||bits.length<1||bits.length>max)fail(`Yi 列表需要 1～${max} 位`);return bits.map(id=>typeof id==='string'&&/^Y(0|[1-9]\d*)$/.test(id)?id:fail(`无效 Yi：${String(id)}`));}
const order=v=>choice(v,['lsb-first','msb-first'],'位序');
const mapping=v=>choice(v,['scale','direct'],'亮度换算');
function channel(c){if(!c||typeof c!=='object')fail('缺少通道配置');if(c.kind==='fixed')return fixed(integer(c.value,0,255,'固定亮度'));if(c.kind!=='bits')fail('通道来源无效');return {kind:'bits',bits:bitList(c.bits),order:order(c.order),mapping:mapping(c.mapping)};}
export function validateDisplay(raw){
 if(!raw||raw.version!==1)fail('不支持的 outputDisplay 版本');
 if(typeof raw.enabled!=='boolean')fail('显示开关必须为布尔值');
 const rows=integer(raw.rows,1,32,'行数'),cols=integer(raw.cols,1,32,'列数');
 const scale=raw.scale===undefined?1:raw.scale;
 if(typeof scale!=='number'||!Number.isFinite(scale)||scale<.25||scale>8)fail('画板大小必须为 0.25～8 倍');
 if(!Array.isArray(raw.pixels)||raw.pixels.length!==rows*cols)fail('灯数量必须等于行数 × 列数');
 const pixels=raw.pixels.map((p,i)=>{try{
  if(p?.mode==='channels')return {mode:'channels',channels:Object.fromEntries(CHANNELS.map(k=>[k,channel(p.channels?.[k]??fixed(0))]))};
  if(p?.mode!=='packed')fail('灯配置模式无效');
  const widths=Object.fromEntries(CHANNELS.map(k=>[k,integer(p.widths?.[k],1,64,`${k.toUpperCase()} 位数`)])),bits=bitList(p.bits,192);
  if(bits.length!==Object.values(widths).reduce((a,b)=>a+b,0))fail('打包 Yi 数量必须等于 R/G/B 位数之和');
  return {mode:'packed',bits,widths,order:order(p.order),mapping:mapping(p.mapping)};
 }catch(e){fail(`灯 ${i+1}：${e.message}`);}});
 return {version:1,enabled:raw.enabled,rows,cols,scale,pixels};
}
export function loadDisplay(raw){try{return {config:raw===undefined?defaultDisplay():validateDisplay(raw),error:null};}catch(e){return {config:defaultDisplay(),error:`输出渲染配置无效，画板已禁用：${e.message}`};}}
export function channelsOf(pixel){if(pixel.mode==='channels')return pixel.channels;let offset=0;return Object.fromEntries(CHANNELS.map(k=>{const bits=pixel.bits.slice(offset,offset+=pixel.widths[k]);return [k,{kind:'bits',bits,order:pixel.order,mapping:pixel.mapping}];}));}
export function convertPixel(pixel,mode){
 if(pixel.mode===mode)return structuredClone(pixel);
 const channels=channelsOf(pixel);if(mode==='channels')return {mode,channels:structuredClone(channels)};
 const values=CHANNELS.map(k=>channels[k]);
 if(values.some(c=>c.kind!=='bits')||values.some(c=>c.order!==values[0].order||c.mapping!==values[0].mapping))fail('无损打包需要三个通道均使用 Yi，且位序和亮度换算相同；可先编辑通道再转换');
 return {mode:'packed',bits:values.flatMap(c=>c.bits),widths:Object.fromEntries(CHANNELS.map(k=>[k,channels[k].bits.length])),order:values[0].order,mapping:values[0].mapping};
}
export function parseBrightness(text,radix=10){const s=String(text).trim();if(radix===2?!/^(?:0b)?[01]+$/i.test(s):!/^\d+$/.test(s))fail(radix===2?'请输入二进制整数':'请输入十进制整数');const value=BigInt(radix===2?'0b'+s.replace(/^0b/i,''):s);if(value>255n)fail('固定亮度必须为 0～255');return Number(value);}
export function evaluateChannel(c,values,errors=new Map()){
 if(c.kind==='fixed')return {ready:true,bits:null,value:String(c.value),brightness:c.value,missing:[]};
 const missing=c.bits.filter(id=>errors.has(id)||!values.has(id)||![0,1].includes(values.get(id)));
 if(missing.length)return {ready:false,bits:c.bits.map(id=>[0,1].includes(values.get(id))&&!errors.has(id)?values.get(id):'?').join(''),value:null,brightness:0,missing:[...new Set(missing)].map(id=>`${id}（${errors.get(id)??(values.has(id)?'未输出':'引用失效')}）`)};
 const bits=c.bits.map(id=>values.get(id)),significant=c.order==='lsb-first'?[...bits].reverse():bits;
 const value=BigInt('0b'+significant.join('')),max=(1n<<BigInt(bits.length))-1n;
 const brightness=Number(c.mapping==='direct'?(value>255n?255n:value):(value*255n+max/2n)/max);
 return {ready:true,bits:bits.join(''),value:value.toString(),brightness,missing:[]};
}
export const evaluatePixel=(p,values,errors)=>Object.fromEntries(CHANNELS.map(k=>[k,evaluateChannel(channelsOf(p)[k],values,errors)]));
export function resizeDisplay(config,rows,cols){const next=defaultDisplay(rows,cols);next.enabled=config.enabled;next.scale=config.scale===undefined?1:config.scale;for(let r=0;r<Math.min(rows,config.rows);r++)for(let c=0;c<Math.min(cols,config.cols);c++)next.pixels[r*cols+c]=structuredClone(config.pixels[r*config.cols+c]);return next;}
export function batchDisplay(config,{start,width=8,order:bitOrder='lsb-first',mapping:map='scale',gray=false},outputs){
 integer(width,1,64,'通道位数');const ids=outputs.map(o=>o.id),at=ids.indexOf(start),required=config.rows*config.cols*width*(gray?1:3);
 if(at<0||ids.length-at<required)fail(`需要 ${required} 个 Yi，从 ${start} 起只有 ${Math.max(0,ids.length-at)} 个，不会重复填充`);
 const next=structuredClone(config);let cursor=at;
 next.pixels=next.pixels.map(()=>{const channels={};let shared;if(gray){shared=ids.slice(cursor,cursor+width);cursor+=width;}for(const k of CHANNELS){const bits=gray?[...shared]:ids.slice(cursor,cursor+=width);channels[k]={kind:'bits',bits,order:bitOrder,mapping:map};}return {mode:'channels',channels};});
 return validateDisplay(next);
}
export function exportDisplayModel(raw,config){return {...structuredClone(raw),outputDisplay:validateDisplay(config)};}
export function displayConnections(config){return config.pixels.flatMap((p,index)=>CHANNELS.flatMap(k=>{const c=channelsOf(p)[k];return c.kind==='bits'?[...new Set(c.bits)].map(source=>({source,index,channel:k})):[];}));}
export class DisplayState {
 constructor(config,outputs=[]){this.configure(config,outputs);}
 configure(config,outputs){this.config=validateDisplay(config);this.errors=new Map(outputs.filter(o=>o.error).map(o=>[o.id,o.error]));this.dependents=new Map();for(const e of displayConnections(config)){if(!this.dependents.has(e.source))this.dependents.set(e.source,new Set());this.dependents.get(e.source).add(e.index);}this.values=new Map();this.results=[];this.initial=true;}
 update(values){const dirty=new Set();if(this.initial){this.config.pixels.forEach((_,i)=>dirty.add(i));this.initial=false;}
  for(const [id,indices] of this.dependents)if(this.values.has(id)!==values.has(id)||this.values.get(id)!==values.get(id))for(const i of indices)dirty.add(i);
  this.values=new Map(values);for(const i of dirty)this.results[i]=evaluatePixel(this.config.pixels[i],values,this.errors);return [...dirty];
 }
}
