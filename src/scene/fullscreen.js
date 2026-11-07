/** Expand existing content without recreating its renderer, camera or windows. */
export function setupSceneFullscreen(scene, button, inspector, companions = [], options = {}) {
  const doc = scene.ownerDocument;
  const label = button.querySelector('[data-fullscreen-label]');
  const resolveTarget = options.resolveTarget ?? (() => ({ element: scene, className: 'scene-fullscreen' }));
  const attachments = [...new Set([inspector, ...companions])].filter(element => element && element !== scene)
    .map(element => ({ element, home: doc.createComment('Companion position outside fullscreen') }));
  let target = null, fallback = false, pending = null, phase = null, active = false;
  const isActive = () => Boolean(target && (fallback || doc.fullscreenElement === target.element));
  const sync = () => {
    const wasActive = active;
    active = isActive();
    target?.element.classList.toggle(target.className, active);
    doc.documentElement.classList.toggle('scene-fullscreen-open', active);
    if (active !== wasActive) {
      // RGB keeps its existing companion behavior. JKM supplies no companions:
      // both the scene and the single-panel desktop keep their original DOM.
      for (const { element, home } of attachments) {
        if (active) {
          if (target.element.contains(element)) continue;
          element.before(home); target.element.append(element);
        } else if (home.parentNode) {
          home.parentNode.insertBefore(element, home.nextSibling); home.remove();
        }
      }
    }
    let description = target;
    if (!description) {
      try { description = resolveTarget(); } catch { /* A failed entry remains retryable. */ }
    }
    const enterText = `全屏展示${description?.label || '模型网络'}`;
    const exitText = description?.label ? `退出${description.label}全屏` : '退出全屏';
    if (label) label.textContent = active ? '退出全屏' : '全屏';
    else button.textContent = active ? '⛶ 退出全屏' : '⛶ 全屏';
    button.setAttribute('aria-pressed', String(active));
    if (label) button.setAttribute('aria-label', active ? exitText : enterText);
    button.title = active ? `${exitText}（Esc）${fallback ? ' · 当前为页面内全屏' : ''}` : enterText;
    if (wasActive && !active) button.focus({ preventScroll: true });
    // Keep an in-flight request bound to its original target even if the mode
    // changes before the browser resolves requestFullscreen().
    if (!active && phase !== 'enter') target = null;
  };
  const change = enter => {
    if (pending) return pending;
    button.disabled = true; phase = enter ? 'enter' : 'exit';
    const operation = (async () => {
      try {
        if (!enter) {
          if (target && doc.fullscreenElement === target.element) await doc.exitFullscreen();
          fallback = false;
        } else {
          const next = resolveTarget();
          if (!next?.element || next.element.ownerDocument !== doc || typeof next.className !== 'string' || !next.className || /\s/.test(next.className)) {
            throw new Error('全屏目标不可用');
          }
          target = { element: next.element, className: next.className, label: next.label };
          if (target.element.requestFullscreen && doc.fullscreenEnabled !== false) {
            try { await target.element.requestFullscreen(); }
            catch { fallback = true; }
          } else fallback = true;
        }
      } finally {
        phase = null; button.disabled = false; sync();
      }
    })();
    pending = operation;
    operation.then(() => { if (pending === operation) pending = null; }, () => { if (pending === operation) pending = null; });
    return operation;
  };
  button.addEventListener('click', async () => {
    if (pending) return;
    const enter = !isActive();
    try { await change(enter); }
    catch (error) { button.title = `${enter ? '进入' : '退出'}全屏失败：${error.message}${enter ? '' : '；可按 Esc 退出'}`; }
  });
  doc.addEventListener('fullscreenchange', sync);
  doc.addEventListener('keydown', event => {
    // A modal's Esc closes the modal first; keep the expanded content underneath.
    if (event.key === 'Escape' && active && !doc.querySelector('dialog[open]')) {
      button.click(); event.preventDefault();
    }
  });
  sync();
  return {
    refresh: sync,
    /** Exit the locked target before its workspace or display mode is changed. */
    async exit() {
      if (pending) await pending;
      if (isActive()) await change(false);
    },
  };
}
