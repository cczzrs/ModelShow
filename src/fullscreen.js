/** Expand the existing scene without recreating its renderer or camera. */
export function setupSceneFullscreen(scene, button, inspector) {
  const doc = scene.ownerDocument;
  const inspectorHome = doc.createComment('Node inspector position outside fullscreen');
  inspector.before(inspectorHome);
  let fallback = false, pending = false, active = false;
  const sync = () => {
    const wasActive = active;
    active = fallback || doc.fullscreenElement === scene;
    scene.classList.toggle('scene-fullscreen', active);
    doc.documentElement.classList.toggle('scene-fullscreen-open', active);
    if (active !== wasActive) {
      // Native fullscreen only displays descendants of the fullscreen element.
      if (active) scene.append(inspector);
      else inspectorHome.parentNode.insertBefore(inspector, inspectorHome.nextSibling);
    }
    button.textContent = active ? '⛶ 退出全屏' : '⛶ 全屏';
    button.setAttribute('aria-pressed', String(active));
    button.title = active ? `退出全屏（Esc）${fallback ? ' · 当前为页面内全屏' : ''}` : '全屏展示模型网络';
    if (wasActive && !active) button.focus({preventScroll: true});
  };
  button.addEventListener('click', async () => {
    if (pending) return;
    pending = true; button.disabled = true;
    let error;
    try {
      if (doc.fullscreenElement === scene) await doc.exitFullscreen();
      else if (fallback) fallback = false;
      else {
        if (scene.requestFullscreen && doc.fullscreenEnabled !== false) {
          try { await scene.requestFullscreen(); }
          catch { fallback = true; }
        } else fallback = true;
      }
    } catch (e) { error = e; }
    finally {
      pending = false; button.disabled = false; sync();
      if (error) button.title = `退出全屏失败：${error.message}；可按 Esc 退出`;
    }
  });
  doc.addEventListener('fullscreenchange', sync);
  doc.addEventListener('keydown', event => {
    // A modal's Esc closes the modal first; keep the expanded scene underneath.
    if (event.key === 'Escape' && active && !doc.querySelector('dialog[open]')) {
      button.click(); event.preventDefault();
    }
  });
  sync();
}
