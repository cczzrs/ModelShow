import {IMAGE_INPUT_LIMITS} from './image-input.js';

const PNG_SIGNATURE = [137,80,78,71,13,10,26,10];
const SOF = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
const damaged = () => new Error('图片数据损坏，或缺少有效的图片尺寸');
const textAt = (bytes, start, size) => String.fromCharCode(...bytes.subarray(start,start+size));
const viewOf = bytes => new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);

function checkDimensions(width,height){
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)throw damaged();
  if(width*height>IMAGE_INPUT_LIMITS.imagePixels)throw new Error('图片超过 1600 万像素，请先缩小图片');
}

const crcTable = Uint32Array.from({length:256},(_,i)=>{
  let crc=i;for(let n=0;n<8;n++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;return crc>>>0;
});
function pngChunk(type,data){
  const chunk=new Uint8Array(data.length+12),view=viewOf(chunk);view.setUint32(0,data.length);
  for(let i=0;i<4;i++)chunk[4+i]=type.charCodeAt(i);chunk.set(data,8);
  let crc=0xffffffff;for(let i=4;i<chunk.length-4;i++)crc=crcTable[(crc^chunk[i])&255]^(crc>>>8);
  view.setUint32(chunk.length-4,(crc^0xffffffff)>>>0);return chunk;
}

function exifOrientation(bytes){
  if(bytes.length<8)return 1;
  const little=bytes[0]===73&&bytes[1]===73;
  if(!little&&!(bytes[0]===77&&bytes[1]===77))return 1;
  const v=viewOf(bytes);if(v.getUint16(2,little)!==42)return 1;
  const offset=v.getUint32(4,little);if(offset+2>bytes.length)return 1;
  const count=v.getUint16(offset,little);
  for(let i=0;i<count;i++){
    const at=offset+2+i*12;if(at+12>bytes.length)return 1;
    if(v.getUint16(at,little)===0x112&&v.getUint16(at+2,little)===3&&v.getUint32(at+4,little)===1){
      const orientation=v.getUint16(at+8,little);return orientation>=1&&orientation<=8?orientation:1;
    }
  }
  return 1;
}

function inspectPng(bytes){
  const view=viewOf(bytes);
  if(bytes.length<33||view.getUint32(8)!==13||textAt(bytes,12,4)!=='IHDR')throw damaged();
  const width=view.getUint32(16),height=view.getUint32(20);checkDimensions(width,height);
  let firstFrame=null,sawImageData=false,animated=false,finished=false,orientation=1,collectFirstFrame=true;
  const metadata=[],frameData=[];
  for(let at=8;at+12<=bytes.length;){
    const length=view.getUint32(at),end=at+12+length;if(end>bytes.length)throw damaged();
    const type=textAt(bytes,at+4,4),data=bytes.subarray(at+8,end-4);
    if(type==='acTL'){
      if(length!==8||viewOf(data).getUint32(0)===0)throw damaged();animated=true;
    }else if(type==='fcTL'&&animated){
      if(length!==26)throw damaged();
      if(firstFrame)collectFirstFrame=false;
      else{
        const control=viewOf(data);
        firstFrame={width:control.getUint32(4),height:control.getUint32(8),x:control.getUint32(12),y:control.getUint32(16),hasPoster:sawImageData};
        checkDimensions(firstFrame.width,firstFrame.height);
        if(firstFrame.x+firstFrame.width>width||firstFrame.y+firstFrame.height>height||data[24]>2||data[25]>1)throw damaged();
      }
    }else if(type==='IDAT'){
      sawImageData=true;
    }else if(type==='fdAT'&&firstFrame?.hasPoster&&collectFirstFrame){
      if(length<=4)throw damaged();frameData.push(pngChunk('IDAT',data.subarray(4)));
    }else if(type==='eXIf'){
      // EXIF may follow image data, including later animation frames.
      orientation=exifOrientation(data);
    }else if(type==='IEND'){
      if(length!==0)throw damaged();finished=true;break;
    }else if(!sawImageData&&type!=='IHDR'){
      // Preserve palettes and colour profiles; apply EXIF after frame compositing.
      metadata.push(bytes.subarray(at,end));
    }
    at=end;
  }
  if(!sawImageData||!finished)throw damaged();
  if(!firstFrame?.hasPoster)return {mime:'image/png',width,height};
  if(!frameData.length)throw damaged();
  const ihdr=bytes.slice(16,29),ihdrView=viewOf(ihdr);ihdrView.setUint32(0,firstFrame.width);ihdrView.setUint32(4,firstFrame.height);
  const blob=new Blob([new Uint8Array(PNG_SIGNATURE),pngChunk('IHDR',ihdr),...metadata,...frameData,pngChunk('IEND',new Uint8Array())],{type:'image/png'});
  return {mime:'image/png',width,height,firstFrame:{...firstFrame,blob,orientation}};
}

function inspectJpeg(bytes){
  const view=viewOf(bytes);let at=2;
  while(at<bytes.length){
    if(bytes[at++]!==0xff)throw damaged();while(bytes[at]===0xff)at++;
    const marker=bytes[at++];
    if(marker===undefined||marker===0xda||marker===0xd9||marker===0)throw damaged();
    if(marker===1||(marker>=0xd0&&marker<=0xd7))continue;
    if(at+2>bytes.length)throw damaged();const length=view.getUint16(at);
    if(length<2||at+length>bytes.length)throw damaged();
    if(SOF.has(marker)){
      if(length<8)throw damaged();const height=view.getUint16(at+3),width=view.getUint16(at+5);checkDimensions(width,height);
      return {mime:'image/jpeg',width,height};
    }
    at+=length;
  }
  throw damaged();
}

function inspectWebp(bytes){
  const view=viewOf(bytes),end=view.getUint32(4,true)+8;
  if(end>bytes.length||end<20)throw damaged();
  const uint24=(at)=>bytes[at]+bytes[at+1]*256+bytes[at+2]*65536;
  for(let at=12;at+8<=end;){
    const type=textAt(bytes,at,4),length=view.getUint32(at+4,true),data=at+8;
    if(data+length>end)throw damaged();let width,height;
    if(type==='VP8X'){
      if(length!==10)throw damaged();width=uint24(data+4)+1;height=uint24(data+7)+1;
    }else if(type==='VP8 '){
      if(length<10||(bytes[data]&1)!==0||bytes[data+3]!==0x9d||bytes[data+4]!==1||bytes[data+5]!==0x2a)throw damaged();
      width=view.getUint16(data+6,true)&0x3fff;height=view.getUint16(data+8,true)&0x3fff;
    }else if(type==='VP8L'){
      if(length<5||bytes[data]!==0x2f)throw damaged();const packed=view.getUint32(data+1,true);
      width=(packed&0x3fff)+1;height=((packed>>>14)&0x3fff)+1;
    }
    if(width!==undefined){checkDimensions(width,height);return {mime:'image/webp',width,height};}
    at=data+length+(length%2);
  }
  throw damaged();
}

function inspectImage(bytes){
  if(PNG_SIGNATURE.every((b,i)=>bytes[i]===b))return inspectPng(bytes);
  if(bytes[0]===0xff&&bytes[1]===0xd8)return inspectJpeg(bytes);
  if(bytes.length>=12&&textAt(bytes,0,4)==='RIFF'&&textAt(bytes,8,4)==='WEBP')return inspectWebp(bytes);
  throw new Error('仅支持 PNG、JPEG、WebP 图片，请选择有效的图片文件');
}

function makeCanvas(width,height){
  if(typeof OffscreenCanvas==='function')return new OffscreenCanvas(width,height);
  if(globalThis.document){const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas;}
  throw new Error('当前环境无法合成动画图片的首帧');
}
function orientationTransform(value,width,height){
  return {1:[1,0,0,1,0,0],2:[-1,0,0,1,width,0],3:[-1,0,0,-1,width,height],4:[1,0,0,-1,0,height],5:[0,1,1,0,0,0],6:[0,1,-1,0,height,0],7:[0,-1,-1,0,height,width],8:[0,-1,1,0,0,width]}[value];
}

/** Decode one local image. The caller owns and must close the returned bitmap. */
export async function decodeInputImage(file,{createBitmap=globalThis.createImageBitmap,createCanvas=makeCanvas}={}){
  if(!file||typeof file.arrayBuffer!=='function'||!Number.isSafeInteger(file.size)||file.size<1)throw new Error('请选择有效的图片文件');
  if(file.size>IMAGE_INPUT_LIMITS.fileBytes)throw new Error('图片文件超过 32 MB，请先压缩或缩小图片');
  if(typeof createBitmap!=='function')throw new Error('当前浏览器不支持图片解码，请使用新版浏览器');
  let bytes;try{bytes=new Uint8Array(await file.arrayBuffer());}catch{throw new Error('图片文件读取失败，请重新选择');}
  if(bytes.byteLength>IMAGE_INPUT_LIMITS.fileBytes)throw new Error('图片文件超过 32 MB，请先压缩或缩小图片');
  const info=inspectImage(bytes),options={imageOrientation:'from-image',premultiplyAlpha:'none',colorSpaceConversion:'default'};
  let bitmap;
  try{
    bitmap=await createBitmap(info.firstFrame?.blob??new Blob([bytes],{type:info.mime}),options);
    checkDimensions(bitmap.width,bitmap.height);
    if(info.firstFrame){
      const frame=info.firstFrame;
      if(bitmap.width!==frame.width||bitmap.height!==frame.height)throw damaged();
      if(frame.x||frame.y||frame.width!==info.width||frame.height!==info.height||frame.orientation!==1){
        const swaps=frame.orientation>=5,width=swaps?info.height:info.width,height=swaps?info.width:info.height;
        const canvas=createCanvas(width,height);
        try{
          const context=canvas.getContext('2d',{colorSpace:'srgb'});
          if(!context)throw new Error('无法创建图片首帧画布');
          context.setTransform(...orientationTransform(frame.orientation,info.width,info.height));context.drawImage(bitmap,frame.x,frame.y);
          const composed=await createBitmap(canvas,options);bitmap.close();bitmap=composed;
        }finally{canvas.width=0;canvas.height=0;}
        checkDimensions(bitmap.width,bitmap.height);
      }
    }
    return {bitmap,width:bitmap.width,height:bitmap.height,name:typeof file.name==='string'?file.name:'图片'};
  }catch(error){
    bitmap?.close();
    if(error instanceof Error&&/图片|画布/.test(error.message))throw error;
    throw new Error('图片解码失败，文件可能损坏或格式不受浏览器支持');
  }
}
