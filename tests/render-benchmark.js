// Development-only, bounded WebGPU benchmark. No engine events are executed.
import {compileModel} from '../src/engine.js';
import {NetworkView} from '../src/view.js';
const params=new URLSearchParams(location.search);
const raw={name:'896 nodes / 3136 edges',nodes:Array.from({length:768},(_,i)=>({id:`Q${i}`,ex:`J0K(X${i%64})K(X${(i+1)%64})J(${i?'Q'+(i-1):'X2'})K(${i>1?'Q'+(i-2):'X3'})`})),initial_q:{0:[],1:[]},q_y:Array.from({length:64},(_,i)=>({['Y'+i]:'Q'+(704+i)}))};
const view=new NetworkView(document.querySelector('#viewport'),()=>{});
view.requestLayout=()=>{};
const output=document.querySelector('#result');
try{
  await view.init();view.setModel(compileModel(raw));view.resetCamera();
  if(params.has('hide'))view.setNodeLabelsHidden(true);
  const durations=[],draws=[],intervals=[];let last=0,count=0,frames=0,start=performance.now();
  function frame(now){
    try{
      const before=view.renderer.info.render.calls,t=performance.now();view.render(true);
      const elapsed=performance.now()-t,rendered=view.renderer.info.render.calls!==before;
      if(count++>30){frames++;durations.push(elapsed);if(rendered){draws.push(view.renderer.info.render.drawCalls);if(last)intervals.push(now-last);last=now;}}
      if(count<151){requestAnimationFrame(frame);return;}
      const average=a=>a.reduce((x,y)=>x+y,0)/Math.max(1,a.length),percentile=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length*.95)]??0;
      const result={nodes:view.visuals.size,edges:view.edges.length,canvas:[view.renderer.domElement.width,view.renderer.domElement.height],elapsedMs:performance.now()-start,rafSamples:frames,renderedFrames:draws.length,averageCpuMs:average(durations),p95CpuMs:percentile(durations),averageDrawCalls:average(draws),averageRenderIntervalMs:average(intervals),geometries:view.renderer.info.memory.geometries,textures:view.renderer.info.memory.textures};
      const initialCalls=view.renderer.info.render.calls;let paused=0;
      function pausedFrame(){
        view.render(false);
        if(++paused<60){requestAnimationFrame(pausedFrame);return;}
        result.pausedDraws=view.renderer.info.render.calls-initialCalls;
        output.textContent=JSON.stringify(result,null,2);document.querySelector('#recover').disabled=false;
      }
      requestAnimationFrame(pausedFrame);
      window.addEventListener('pagehide',()=>{view.renderer.dispose();},{once:true});
    }catch(error){output.textContent=error.stack;}
  }
  requestAnimationFrame(frame);
  document.querySelector('#recover').onclick=async()=>{
    const report=document.querySelector('#recovery');report.textContent='Restoring…';
    try{
      const before=view.camera.position.toArray(),geometry=view.batches.nodes.geometry;
      await view.recover();view.render(false);
      report.textContent=JSON.stringify({available:view.available,cameraPreserved:JSON.stringify(before)===JSON.stringify(view.camera.position.toArray()),geometryPreserved:geometry===view.batches.nodes.geometry,drawCalls:view.renderer.info.render.drawCalls});
    }catch(error){report.textContent=error.stack;}
  };
}catch(error){output.textContent=error.stack;}
