import test from 'node:test';
import assert from 'node:assert/strict';
import {compileModel,JKEngine} from '../src/engine.js';
import {IMAGE_INPUT_LIMITS,defaultImageInputConfig,validateConfig,validateSelection,clampSelection,selectionBitCount,extractPixelData,mapPixelData} from '../src/image-input.js';

const config=overrides=>({...defaultImageInputConfig(),...overrides});
const image=(width,height,data)=>({width,height,data:new Uint8ClampedArray(data)});
const whole={x:0,y:0,width:2,height:2};
const sample=image(2,2,[1,2,4,255,128,64,32,255,255,0,85,255,10,20,30,255]);
const ids=count=>Array.from({length:count},(_,i)=>`X${i}`);

test('2×2 RGB scans rows before columns and supports both channel arrangements',()=>{
 const original=sample.data.slice(),pixel=extractPixelData(sample,whole,config());
 assert.deepEqual([...pixel.bytes],[1,2,4,128,64,32,255,0,85,10,20,30]);
 assert.deepEqual([...pixel.rgba],[...sample.data]);assert.equal(pixel.bitCount,96);
 assert.deepEqual([...extractPixelData(sample,whole,config({arrangement:'channel'})).bytes],[1,128,255,10,2,64,0,20,4,32,85,30]);
 assert.deepEqual(sample.data,original,'conversion must not overwrite the original image');
 const crop=extractPixelData(sample,{x:1,y:0,width:1,height:2},config());
 assert.deepEqual([...crop.bytes],[128,64,32,10,20,30]);
});

test('grayscale uses the specified rounded coefficients and does not depend on channel arrangement',()=>{
 const colors=image(2,2,[255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255]);
 const gray=extractPixelData(colors,whole,config({encoding:'gray'}));
 assert.deepEqual([...gray.bytes],[76,150,29,255]);assert.equal(gray.bitCount,32);
 assert.deepEqual([...gray.rgba],[76,76,76,255,150,150,150,255,29,29,29,255,255,255,255,255]);
 assert.deepEqual(extractPixelData(colors,whole,config({encoding:'gray',arrangement:'channel'})),gray);
});

test('alpha is composited against white or black before grayscale conversion',()=>{
 const transparent=image(2,2,[100,200,50,128,9,99,201,0,1,2,4,255,0,0,0,128]);
 assert.deepEqual([...extractPixelData(transparent,whole,config()).bytes],[177,227,152,255,255,255,1,2,4,127,127,127]);
 assert.deepEqual([...extractPixelData(transparent,whole,config({background:'black'})).bytes],[50,100,25,0,0,0,1,2,4,0,0,0]);
 assert.deepEqual([...extractPixelData(transparent,whole,config({encoding:'gray'})).bytes],[204,255,2,127]);
 assert.ok([...extractPixelData(transparent,whole,config()).rgba].filter((_,i)=>i%4===3).every(a=>a===255));
});

test('bytes become numeric bits with independent LSB/MSB order',()=>{
 const one=image(1,1,[129,2,85,255]),area={x:0,y:0,width:1,height:1},pixels=extractPixelData(one,area,config());
 const low=mapPixelData(pixels,config(),ids(24)),high=mapPixelData(pixels,config({bitOrder:'msb-first'}),ids(24));
 assert.equal(Object.values(low.values).join(''),'100000010100000010101010');
 assert.equal(Object.values(high.values).join(''),'100000010000001001010101');
 assert.ok(Object.values(low.values).every(v=>typeof v==='number'&&(v===0||v===1)));
 assert.deepEqual(JSON.parse(low.json),low.values);assert.deepEqual(JSON.parse(low.previewJson),low.values);assert.equal(low.omittedCount,0);
});

test('mapping sorts exact numeric Xi suffixes without filling noncontinuous or huge IDs',()=>{
 const xi=['X9007199254740993','X10','X0','X9007199254740992','X3','X4','X100','X2'];
 const pixels=extractPixelData(image(1,1,[129,129,129,255]),{x:0,y:0,width:1,height:1},config({encoding:'gray'}));
 const mapped=mapPixelData(pixels,config({encoding:'gray'}),xi);
 assert.deepEqual(Object.keys(mapped.values),['X0','X2','X3','X4','X10','X100','X9007199254740992','X9007199254740993']);
 assert.deepEqual(Object.values(mapped.values),[1,0,0,0,0,0,0,1]);assert.equal(Object.hasOwn(mapped.values,'X1'),false);
 assert.deepEqual(xi,['X9007199254740993','X10','X0','X9007199254740992','X3','X4','X100','X2']);
});

test('mapping requires an exact unique valid Xi list and current encoding',()=>{
 const pixels=extractPixelData(sample,whole,config());
 assert.throws(()=>mapPixelData(pixels,config(),ids(95)),/超出 1 位/);
 assert.throws(()=>mapPixelData(pixels,config(),ids(97)),/不足 1 位/);
 for(const invalid of ['X01','Y0','X-1',1,null])assert.throws(()=>mapPixelData(pixels,config(),[invalid,...ids(95)]),/无效 Xi/);
 assert.throws(()=>mapPixelData(pixels,config(),['X1',...ids(95)]),/Xi 重复/);
 assert.throws(()=>mapPixelData(pixels,config({encoding:'gray'}),ids(32)),/请重新提取/);
});

test('preview truncates only its own JSON; full mapping remains complete',()=>{
 const data=image(6,1,Array.from({length:24},(_,i)=>i%4===3?255:17)),area={x:0,y:0,width:6,height:1};
 const result=mapPixelData(extractPixelData(data,area,config()),config(),ids(144));
 assert.equal(Object.keys(JSON.parse(result.previewJson)).length,128);assert.equal(result.omittedCount,16);
 assert.equal(Object.keys(JSON.parse(result.json)).length,144);assert.equal(Object.hasOwn(result.values,'X143'),true);
});

test('output bit limit is checked before allocating selection buffers, including grayscale boundary',()=>{
 const gray=config({encoding:'gray'}),area={x:0,y:0,width:8192,height:1},data=image(8192,1,new Uint8ClampedArray(8192*4));
 const extracted=extractPixelData(data,area,gray);
 assert.equal(extracted.bitCount,65536);assert.equal(Object.keys(mapPixelData(extracted,gray,ids(65536)).values).length,65536);
 assert.equal(selectionBitCount({width:8193,height:1},'gray'),65544,'UI can display an over-limit count');
 assert.throws(()=>extractPixelData({width:8193,height:1,data:null},{...area,width:8193},gray),/单次提取最多/);
 assert.throws(()=>mapPixelData({width:8193,height:1},gray,[]),/单次提取最多/);
 assert.throws(()=>extractPixelData({width:4001,height:4000,data:null},{x:0,y:0,width:1,height:1},config()),/图片最多/);
 assert.equal(IMAGE_INPUT_LIMITS.fileBytes,33554432);assert.equal(IMAGE_INPUT_LIMITS.imagePixels,16000000);
});

test('selection validation rejects fractions and out-of-bounds; clamping handles every corner and resize',()=>{
 for(const area of [whole,{x:0,y:1,width:1,height:1},{x:1,y:0,width:1,height:1},{x:1,y:1,width:1,height:1}])assert.deepEqual(validateSelection(area,2,2),area);
 for(const area of [{...whole,x:-1},{...whole,x:1},{...whole,height:0},{...whole,width:3},{...whole,y:.5}])assert.throws(()=>validateSelection(area,2,2));
 for(const x of [-100,100])for(const y of [-100,100])assert.deepEqual(clampSelection({x,y,width:1,height:1},2,2),{x:x<0?0:1,y:y<0?0:1,width:1,height:1});
 assert.deepEqual(clampSelection({x:1,y:1,width:100,height:100},2,2),whole);
 assert.deepEqual(clampSelection({x:1,y:1,width:0,height:-2},2,2),{x:1,y:1,width:1,height:1});
 for(const v of [NaN,Infinity,.5,'1',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>clampSelection({...whole,x:v},2,2),/安全整数/);
 assert.throws(()=>selectionBitCount({width:Number.MAX_SAFE_INTEGER,height:2},'rgb'),/安全整数/);
});

test('configuration and malformed source buffers fail clearly; defaults are independent objects',()=>{
 const first=defaultImageInputConfig();first.encoding='gray';assert.equal(defaultImageInputConfig().encoding,'rgb');
 for(const field of ['encoding','arrangement','bitOrder','background'])assert.throws(()=>validateConfig(config({[field]:'invalid'})),/无效/);
 assert.throws(()=>extractPixelData({width:2,height:2,data:new Uint8ClampedArray(4)},whole,config()),/RGBA 数据/);
 assert.throws(()=>extractPixelData({width:0,height:2,data:new Uint8ClampedArray()},whole,config()),/必须大于 0/);
 assert.throws(()=>extractPixelData(sample,{...whole,width:1.5},config()),/安全整数/);
});

test('generated JSON is inert until explicitly sent and passes the existing JK engine',()=>{
 const model=compileModel({nodes:ids(8).map((id,i)=>({id:`Q${i}`,ex:`J0K(${id})`})),initial_q:{0:[],1:[]},q_y:ids(8).map((_,i)=>({[`Y${i}`]:`Q${i}`}))});
 const engine=new JKEngine(model),gray=config({encoding:'gray'});
 const output=mapPixelData(extractPixelData(image(1,1,[165,165,165,255]),{x:0,y:0,width:1,height:1},gray),gray,model.inputs);
 assert.equal(engine.length,0);assert.equal(engine.total,0);assert.equal(engine.history.length,0);assert.equal(engine.latest.size,0);
 const sent=engine.send(JSON.parse(output.json));assert.equal(sent.accepted.length,8);assert.equal(sent.ignored.length,0);
 while(engine.length)engine.step();
 assert.deepEqual([...engine.outputs.values()],[1,0,1,0,0,1,0,1]);
});
