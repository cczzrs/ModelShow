import { APP_CONFIG } from "../../html/config.js";

/** A display scheduler, never a second logic/event queue. */
export class Playback {
  constructor(
    engine,
    {
      onChange = () => {},
      onVisual = () => {},
      onProgress = () => {},
      now = () => performance.now(),
      skipBudgetMs = APP_CONFIG.playback.skipBudgetMs,
      maxSkipSteps = APP_CONFIG.playback.maxSkipSteps,
    } = {},
  ) {
    if (typeof now !== "function") throw new TypeError("now 必须为时钟函数");
    if (!Number.isFinite(skipBudgetMs) || skipBudgetMs <= 0)
      throw new RangeError("跳过动画的帧预算必须大于 0");
    if (!Number.isSafeInteger(maxSkipSteps) || maxSkipSteps < 1)
      throw new RangeError("每帧执行上限必须为正整数");
    this.engine = engine;
    this.onChange = onChange;
    this.onVisual = onVisual;
    this.onProgress = onProgress;
    this.now = now;
    this.skipBudgetMs = skipBudgetMs;
    this.maxSkipSteps = maxSkipSteps;
    this.running = APP_CONFIG.playback.running;
    this.speed = APP_CONFIG.playback.speed.value;
    this._skip = APP_CONFIG.playback.skipAnimation;
    this.active = null;
    this.visuals = [];
    this.duration = APP_CONFIG.playback.duration;
    this._revision = 0;
    this._ticking = false;
    this._hasVisual = false;
  }
  get skip() {
    return this._skip;
  }
  set skip(value) {
    const next = Boolean(value);
    if (next === this._skip) return;
    this._skip = next;
    this._revision++;
    if (next) {
      this.active = null;
      this.visuals = [];
      this._hasVisual = false;
      this.onVisual(null);
    }
  }
  get skipFrameBudgetMs() {
    return this.skipBudgetMs * this.speed;
  }
  send(data) {
    const event = this.engine.send(data);
    // send updates external Xi and immediately queues input-copy tasks.
    this.onChange(event);
    return event;
  }
  pause() {
    this._revision++;
    this.running = false;
    this.onChange();
  }
  resume() {
    this._revision++;
    this.running = true;
    this.onChange();
  }
  begin(event) {
    this.active = { event, progress: 0 };
    this._hasVisual = true;
    this.onVisual(event);
  }
  finish() {
    this.onProgress(1);
    this.active = null;
    this._hasVisual = false;
    this.onVisual(null);
  }
  step() {
    this._revision++;
    this.running = false;
    if (this.active) this.finish();
    this.visuals = []; // Single-step discards display effects, never pending EX tasks.
    const event = this.engine.step();
    if (event) {
      this._hasVisual = true;
      this.onVisual(event);
      this.onProgress(1);
    }
    this.onChange(event);
    return event;
  }
  reset() {
    this._revision++;
    this.running = false;
    this.engine.reset();
    this.active = null;
    this.visuals = [];
    this._hasVisual = false;
    this.onVisual(null);
    this.onChange();
  }
  runSkipBatch() {
    const revision = this._revision,
      started = this.now(),
      budget = this.skipFrameBudgetMs;
    // Single-step leaves values at the endpoints even in skip mode. Clear that
    // static display once when automatic skip resumes, including an empty queue.
    if (this._hasVisual) {
      this._hasVisual = false;
      this.onVisual(null);
    }
    for (let count = 0; count < this.maxSkipSteps; count++) {
      if (!this.running || !this.skip || revision !== this._revision) return;
      if (!this.engine.length) return;
      const event = this.engine.step();
      if (!event) return;
      // Every completed item publishes its own change. Rendering may coalesce it,
      // but the time spent in this callback still belongs to this frame's budget.
      this.onChange(event);
      if (!this.running || !this.skip || revision !== this._revision) return;
      if (!this.engine.length || this.now() - started >= budget) return;
    }
  }
  tick(dt) {
    if (!this.running || this._ticking) return;
    this._ticking = true;
    try {
      if (this.skip) {
        this.runSkipBatch();
        return;
      }
      const revision = this._revision;
      if (this.active) {
        const active = this.active;
        active.progress = Math.min(
          1,
          active.progress + (Math.max(0, dt) * this.speed) / this.duration,
        );
        this.onProgress(active.progress);
        if (
          this.active === active &&
          revision === this._revision &&
          active.progress >= 1
        )
          this.finish();
        return;
      }
      if (this.visuals.length) {
        this.begin(this.visuals.shift());
        return;
      }
      const event = this.engine.step();
      if (event) {
        this.onChange(event);
        if (this.running && !this.skip && revision === this._revision)
          this.begin(event);
      }
    } catch (error) {
      // A step is atomic; do not retry an item whose engine work may have begun.
      this.running = false;
      this._revision++;
      throw error;
    } finally {
      this._ticking = false;
    }
  }
}
