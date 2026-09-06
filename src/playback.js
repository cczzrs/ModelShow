/** A display scheduler, never a second logic/event queue. */
export class Playback {
  constructor(engine, { onChange = () => {}, onVisual = () => {}, onProgress = () => {} } = {}) {
    this.engine = engine; this.onChange = onChange; this.onVisual = onVisual; this.onProgress = onProgress;
    this.running = true; this.speed = 1; this.skip = false; this.active = null; this.visuals = []; this.duration = .85;
  }
  send(data) {
    if (this.visuals.length >= 400) throw new Error('待播放输入记录已满，请先播放或跳过动画');
    const event = this.engine.send(data);
    if(event.transfers.length)this.visuals.push(event);
    this.onChange(event); return event;
  }
  pause() { this.running = false; this.onChange(); }
  resume() { if (this.engine.capacityReached) throw new Error('队列达到保护阈值，请先单步消费队列或重载'); this.running = true; this.onChange(); }
  begin(event) { this.active = {event, progress:0}; this.onVisual(event); }
  finish() { this.onProgress(1); this.active = null; this.onVisual(null); }
  step() {
    this.running = false;
    if(this.active)this.finish();
    this.visuals=[]; // Their logical deliveries already happened; single-step skips old display effects.
    const event=this.engine.step();
    if(event){this.onVisual(event);this.onProgress(1);}
    this.onChange(event);return event;
  }
  reset() {this.engine.reset();this.active=null;this.visuals=[];this.running=false;this.onVisual(null);this.onChange();}
  tick(dt) {
    if(!this.running)return;
    if(this.engine.capacityReached){this.pause();return;}
    if(this.active){
      this.active.progress=this.skip?1:Math.min(1,this.active.progress+Math.max(0,dt)*this.speed/this.duration);
      this.onProgress(this.active.progress);
      if(this.active.progress>=1)this.finish();
      return;
    }
    if(this.visuals.length){const event=this.visuals.shift();if(!this.skip)this.begin(event);return;}
    const event=this.engine.step();
    if(event){this.onChange(event);if(!this.skip)this.begin(event);}
  }
}
