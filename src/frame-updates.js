/** Keep event-side data updates synchronous; defer expensive presentation to the frame. */
export class FrameUpdates {
  constructor(refresh, onChange = () => {}) {
    this.refresh = refresh;
    this.onChange = onChange;
    this.pending = false;
  }
  invalidate() { this.pending = true; }
  request(event) {
    this.invalidate(); // A failed observer must not hide already-completed computation.
    this.onChange(event);
  }
  flush() {
    if (!this.pending) return false;
    this.pending = false;
    try { this.refresh(); }
    catch (error) { this.pending = true; throw error; }
    return true;
  }
}
