/** Rate-limit GPU submission independently of FIFO execution and UI updates. */
export class RenderSchedule {
  constructor({idleFps=30,activeFps=60,interactionTailMs=180,maxDeltaMs=100}={}) {
    if (![idleFps,activeFps,maxDeltaMs].every(value=>Number.isFinite(value)&&value>0)
      || !Number.isFinite(interactionTailMs) || interactionTailMs<0) throw new RangeError('Invalid render schedule settings');
    this.idleInterval=1000/idleFps;this.activeInterval=1000/activeFps;
    this.interactionTailMs=interactionTailMs;this.maxDeltaMs=maxDeltaMs;
    this.interactionUntil=-Infinity;this.dirty=true;
    this.lastSample=null;this.lastDraw=null;this.nextDraw=null;this.interval=null;this.elapsed=0;
  }
  invalidate(){this.dirty=true;}
  interact(now){this.interactionUntil=now+this.interactionTailMs;this.invalidate();}
  // Call on visibility changes even if the browser suspends RAF before a hidden sample.
  resetClock(){this.lastSample=null;this.lastDraw=null;this.nextDraw=null;this.elapsed=0;this.invalidate();}
  sample(now,{animate=true,active=false,hidden=false}={}) {
    if(hidden){this.resetClock();return null;}
    if(this.lastSample!==null&&now<this.lastSample)this.resetClock();
    const delta=this.lastSample===null?0:Math.min(now-this.lastSample,this.maxDeltaMs);
    this.lastSample=now;
    this.elapsed=animate?this.elapsed+delta:0;
    const interacting=active||now<this.interactionUntil;
    if(!this.dirty&&!animate&&!interacting)return null;
    const interval=interacting||!animate?this.activeInterval:this.idleInterval;
    if(this.interval!==interval){this.interval=interval;this.nextDraw=this.lastDraw===null?null:this.lastDraw+interval;}
    if(this.nextDraw!==null&&now+1e-6<this.nextDraw)return null;
    const result={deltaSeconds:this.elapsed/1000};
    this.elapsed=0;this.dirty=false;this.lastDraw=now;
    // Retain the fractional deadline at 120/144 Hz, but never issue catch-up draws.
    this.nextDraw=this.nextDraw===null?now+interval:this.nextDraw+(Math.floor(Math.max(0,now+1e-6-this.nextDraw)/interval)+1)*interval;
    return result;
  }
}
