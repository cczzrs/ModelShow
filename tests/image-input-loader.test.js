import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import {decodeInputImage} from '../src/image-input-loader.js';
import {IMAGE_INPUT_LIMITS} from '../src/image-input.js';

const fixture=async name=>readFile(new URL(`./fixtures/image-input-${name}`,import.meta.url));
const file=(bytes,name='pixels.png',type='application/octet-stream')=>Object.assign(new Blob([bytes],{type}),{name});
const bitmap=(width,height)=>({width,height,closed:0,close(){this.closed++;}});
function pngChunks(bytes){
  const chunks=[];for(let at=8;at+12<=bytes.length;){const length=bytes.readUInt32BE(at);chunks.push({type:bytes.toString('ascii',at+4,at+8),data:bytes.subarray(at+8,at+8+length)});at+=12+length;}return chunks;
}
function writePng(chunks){
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),...chunks.map(({type,data})=>{
    const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);
    let crc=0xffffffff;for(const byte of b.subarray(4,-4)){crc^=byte;for(let n=0;n<8;n++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;}
    b.writeUInt32BE((crc^0xffffffff)>>>0,b.length-4);return b;
  })]);
}

test('real PNG, JPEG and both WebP headers use magic bytes, canonical MIME and orientation options',async()=>{
  for(const [name,type] of [['rgba.png','image/png'],['rgb.jpg','image/jpeg'],['rgba.webp','image/webp'],['animated.webp','image/webp']]){
    const bytes=await fixture(name),decoded=bitmap(2,2);
    const result=await decodeInputImage(file(bytes,'mislabeled.gif','image/gif'),{createBitmap:async(source,options)=>{
      assert.equal(source.type,type);assert.deepEqual(Buffer.from(await source.arrayBuffer()),bytes);
      assert.deepEqual(options,{imageOrientation:'from-image',premultiplyAlpha:'none',colorSpaceConversion:'default'});return decoded;
    }});
    assert.equal(result.bitmap,decoded);assert.equal(result.name,'mislabeled.gif');assert.equal(result.width,2);assert.equal(decoded.closed,0);result.bitmap.close();
  }
});

test('file limits, unsupported magic and truncated image headers fail before allocating a bitmap',async()=>{
  let reads=0,decodes=0;const createBitmap=async()=>{decodes++;return bitmap(2,2);};
  await assert.rejects(decodeInputImage({size:IMAGE_INPUT_LIMITS.fileBytes+1,arrayBuffer(){reads++;}},{createBitmap}),/32 MB/);assert.equal(reads,0);
  for(const bytes of [Buffer.alloc(0),Buffer.from('GIF89a'),Buffer.from('<svg width="2" height="2"></svg>')])await assert.rejects(decodeInputImage(file(bytes),{createBitmap}),/图片|PNG/);
  for(const name of ['rgba.png','rgb.jpg','rgba.webp','animated.webp']){
    const bytes=await fixture(name);await assert.rejects(decodeInputImage(file(bytes.subarray(0,20)),{createBitmap}),/损坏/);
  }
  await assert.rejects(decodeInputImage({size:10,arrayBuffer(){throw Error('disk error');}},{createBitmap}),/读取失败/);
  await assert.rejects(decodeInputImage(file(await fixture('rgba.png')),{createBitmap:null}),/浏览器/);
  assert.equal(decodes,0);
});

test('PNG, JPEG, lossless WebP and extended WebP reject oversized dimensions before decoding',async()=>{
  let decodes=0;const createBitmap=async()=>{decodes++;return bitmap(2,2);};
  const png=await fixture('rgba.png');png.writeUInt32BE(5000,16);png.writeUInt32BE(4000,20);
  const jpeg=await fixture('rgb.jpg'),sof=jpeg.indexOf(Buffer.from([0xff,0xc0]));assert.ok(sof>0);jpeg.writeUInt16BE(4000,sof+5);jpeg.writeUInt16BE(5000,sof+7);
  const lossless=await fixture('rgba.webp');assert.equal(lossless.toString('ascii',12,16),'VP8L');lossless.writeUInt32LE(((4000-1)<<14)|(5000-1),21);
  const extended=await fixture('animated.webp');assert.equal(extended.toString('ascii',12,16),'VP8X');extended.writeUIntLE(4999,24,3);extended.writeUIntLE(3999,27,3);
  for(const bytes of [png,jpeg,lossless,extended])await assert.rejects(decodeInputImage(file(bytes),{createBitmap}),/1600 万/);
  assert.equal(decodes,0);
  png.writeUInt32BE(4000,16);const result=await decodeInputImage(file(png),{createBitmap:async()=>bitmap(4000,4000)});assert.equal(result.width*result.height,IMAGE_INPUT_LIMITS.imagePixels);result.bitmap.close();
});

test('lossy VP8 dimensions, zero dimensions and invalid WebP chunk lengths are checked',async()=>{
  const bytes=Buffer.alloc(30);bytes.write('RIFF',0);bytes.writeUInt32LE(22,4);bytes.write('WEBPVP8 ',8);bytes.writeUInt32LE(10,16);bytes.set([0,0,0,0x9d,1,0x2a],20);bytes.writeUInt16LE(2,26);bytes.writeUInt16LE(3,28);
  const decoded=await decodeInputImage(file(bytes),{createBitmap:async()=>bitmap(2,3)});assert.equal(decoded.height,3);decoded.bitmap.close();
  bytes.writeUInt16LE(0,26);await assert.rejects(decodeInputImage(file(bytes),{createBitmap:async()=>{assert.fail('must reject header first');}}),/损坏/);
  bytes.writeUInt32LE(100,16);await assert.rejects(decodeInputImage(file(bytes),{createBitmap:async()=>{assert.fail('must reject chunk first');}}),/损坏/);
});

test('decoder failures are reported and decoded invalid or oversized bitmaps are closed',async()=>{
  const source=file(await fixture('rgba.png'));
  await assert.rejects(decodeInputImage(source,{createBitmap:async()=>{throw new DOMException('InvalidStateError');}}),/解码失败/);
  for(const [width,height] of [[0,2],[NaN,2],[4001,4000]]){
    const decoded=bitmap(width,height);await assert.rejects(decodeInputImage(source,{createBitmap:async()=>decoded}),/损坏|1600 万/);assert.equal(decoded.closed,1);
  }
});

test('EXIF orientation may swap JPEG width and height, and returned dimensions describe oriented pixels',async()=>{
  const source=file(await fixture('oriented.jpg'),'camera.jpg');
  const decoded=bitmap(3,2),result=await decodeInputImage(source,{createBitmap:async(_,options)=>{assert.equal(options.imageOrientation,'from-image');return decoded;}});
  assert.equal(result.width,3);assert.equal(result.height,2);assert.equal(decoded.closed,0);decoded.close();
});

test('APNG with a separate white poster extracts red animation frame, preserves sRGB, and composites its offset on a transparent full-size canvas',async()=>{
  const source=file(await fixture('poster.apng'),'animation.png'),frame=bitmap(1,1),composed=bitmap(2,2),calls=[];
  const context={setTransform(...args){calls.push(['transform',...args]);},drawImage(...args){calls.push(['draw',...args]);}};
  let canvas,decodes=0;
  const result=await decodeInputImage(source,{
    createCanvas:(width,height)=>{assert.equal(width,2);assert.equal(height,2);return canvas={width,height,getContext(type,options){assert.equal(type,'2d');assert.equal(options.colorSpace,'srgb');return context;}};},
    createBitmap:async input=>{
      if(decodes++===0){
        const chunks=pngChunks(Buffer.from(await input.arrayBuffer()));assert.deepEqual(chunks.map(c=>c.type),['IHDR','sRGB','IDAT','IEND']);
        assert.equal(chunks[0].data.readUInt32BE(0),1);assert.equal(chunks[0].data.readUInt32BE(4),1);
        assert.deepEqual([...inflateSync(chunks.find(c=>c.type==='IDAT').data)],[0,255,0,0,255]);return frame;
      }
      assert.equal(input,canvas);return composed;
    },
  });
  assert.deepEqual(calls,[['transform',1,0,0,1,0,0],['draw',frame,1,1]]);
  assert.equal(frame.closed,1);assert.equal(composed.closed,0);assert.equal(canvas.width,0);assert.equal(canvas.height,0);assert.equal(result.bitmap,composed);composed.close();
});

test('APNG compositing failures release both temporary bitmap and canvas; invalid frame bounds reject before decode',async()=>{
  const bytes=await fixture('poster.apng');let decodes=0;
  const frame=bitmap(1,1),canvas={width:2,height:2,getContext(){return {setTransform(){},drawImage(){}};}};
  await assert.rejects(decodeInputImage(file(bytes),{createCanvas:()=>canvas,createBitmap:async()=>{if(decodes++===0)return frame;throw Error('GPU allocation failed');}}),/解码失败/);
  assert.equal(frame.closed,1);assert.equal(canvas.width,0);assert.equal(canvas.height,0);
  const control=bytes.indexOf('fcTL');bytes.writeUInt32BE(2,control+16);
  await assert.rejects(decodeInputImage(file(bytes),{createBitmap:async()=>{assert.fail('invalid rectangle must reject first');}}),/损坏/);
});

test('APNG applies EXIF orientation to the full canvas after offset composition, without rotating its subframe twice',async()=>{
  const chunks=pngChunks(await fixture('poster.apng'));
  chunks[0].data.writeUInt32BE(3,4);chunks.find(c=>c.type==='fcTL').data.writeUInt32BE(0,12);
  const exif=Buffer.from([73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);chunks.splice(1,0,{type:'eXIf',data:exif});
  let calls=0,transform,position;
  const result=await decodeInputImage(file(writePng(chunks)),{
    createBitmap:async source=>{
      if(calls++===0){assert.ok(!pngChunks(Buffer.from(await source.arrayBuffer())).some(c=>c.type==='eXIf'));return bitmap(1,1);}
      return bitmap(3,2);
    },
    createCanvas:(width,height)=>{
      assert.deepEqual([width,height],[3,2]);return {width,height,getContext(){return {
        setTransform(...args){transform=args;},
        drawImage(_,x,y){const [a,b,c,d,e,f]=transform;position=[a*(x+.5)+c*(y+.5)+e,b*(x+.5)+d*(y+.5)+f];},
      };}};
    },
  });
  assert.deepEqual(position,[1.5,.5]);assert.equal(result.width,3);assert.equal(result.height,2);result.bitmap.close();
});

test('APNG reads EXIF after the poster, between frames and at the tail without collecting later-frame pixels',async()=>{
  for(const location of ['after-poster','between-frames','tail']){
    const chunks=pngChunks(await fixture('poster.apng'));
    const insertAt=location==='after-poster'?chunks.findIndex(c=>c.type==='IDAT')+1:location==='between-frames'?chunks.findIndex(c=>c.type==='fdAT')+1:chunks.length-1;
    const exif=Buffer.from([73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);chunks.splice(insertAt,0,{type:'eXIf',data:exif});
    let calls=0,transform,position;
    const result=await decodeInputImage(file(writePng(chunks)),{
      createBitmap:async source=>{
        if(calls++===0){
          const rebuilt=pngChunks(Buffer.from(await source.arrayBuffer()));assert.ok(!rebuilt.some(c=>c.type==='eXIf'));
          const data=rebuilt.filter(c=>c.type==='IDAT');assert.equal(data.length,1,location);assert.deepEqual([...inflateSync(data[0].data)],[0,255,0,0,255],location);return bitmap(1,1);
        }
        return bitmap(2,2);
      },
      createCanvas:(width,height)=>({width,height,getContext(){return {
        setTransform(...args){transform=args;},
        drawImage(_,x,y){const [a,b,c,d,e,f]=transform;position=[a*(x+.5)+c*(y+.5)+e,b*(x+.5)+d*(y+.5)+f];},
      };}}),
    });
    assert.deepEqual(position,[.5,1.5],location);result.bitmap.close();
  }
});

test('APNG canvas-context failures and invalid composite bitmaps release all temporary resources',async()=>{
  const source=file(await fixture('poster.apng'));
  const frame=bitmap(1,1),missingContext={width:2,height:2,getContext(){return null;}};
  await assert.rejects(decodeInputImage(source,{createBitmap:async()=>frame,createCanvas:()=>missingContext}),/画布/);
  assert.equal(frame.closed,1);assert.equal(missingContext.width,0);
  let calls=0;const nextFrame=bitmap(1,1),invalid=bitmap(4001,4000);
  await assert.rejects(decodeInputImage(source,{createBitmap:async()=>calls++===0?nextFrame:invalid,createCanvas:()=>({width:2,height:2,getContext(){return {setTransform(){},drawImage(){}};}})}),/1600 万/);
  assert.equal(nextFrame.closed,1);assert.equal(invalid.closed,1);
});
