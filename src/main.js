import "./style.css";
import { compileModel, JKEngine } from "./core/engine.js";
import { Playback } from "./core/playback.js";
import { FrameUpdates } from "./core/frame-updates.js";
import {
  loadDisplay,
  exportDisplayModel,
  exportCurrentDisplayModel,
} from "./output/output-display.js";
import { OutputDisplayUI, lampDetails } from "./output/output-display-ui.js";
import { NetworkView } from "./scene/view.js";
import { ImageInputUI } from "./input/image-input-ui.js";
import { displayNodeId } from "./core/node-id.js";
import { setupSceneFullscreen } from "./scene/fullscreen.js";
import { ModelManager } from "./models/model-manager.js";
import { APP_CONFIG } from "./config.js";
const $ = (id) => document.getElementById(id);
const cloneTemplate = (id) => $(id).content.firstElementChild.cloneNode(true);
const speedConfig = APP_CONFIG.playback.speed;
for (const key of ["min", "max", "step"]) $("speed")[key] = speedConfig[key];
$("speed").value = speedConfig.value;
$("skip").checked = APP_CONFIG.playback.skipAnimation;
$("queue").style.setProperty(
  "--queue-row-height",
  `${APP_CONFIG.lists.queue.rowHeight}px`,
);
for (const button of $("layout-buttons").querySelectorAll("[data-layout]")) {
  button.setAttribute(
    "aria-pressed",
    String(button.dataset.layout === APP_CONFIG.scene.layout),
  );
}
$("layout-status").textContent = `${APP_CONFIG.scene.layout} 拓扑布局`;
$("node-labels").setAttribute(
  "aria-pressed",
  String(APP_CONFIG.scene.nodeLabelsHidden),
);
$("node-labels").textContent = APP_CONFIG.scene.nodeLabelsHidden
  ? "显示名称和次数"
  : "隐藏名称和次数";
$("black-background").setAttribute(
  "aria-pressed",
  String(APP_CONFIG.scene.blackBackground),
);
let model,
  engine,
  playback,
  selected,
  view,
  modelVersion = 0;
const frameUpdates = new FrameUpdates(update, (event) =>
  view?.syncOutputs(engine, event),
);
const outputElements = new Map(),
  pickerElements = new Map();
const displayUI = new OutputDisplayUI(
  $("output-display-dialog"),
  (config) => {
    view?.setOutputDisplay(config);
    renderInspector();
  },
  () => {
    if (!model) return;
    const text = JSON.stringify(
      exportDisplayModel(model.raw, displayUI.config),
      null,
      2,
    );
    const blob = new Blob([text], { type: "application/json" }),
      url = URL.createObjectURL(blob),
      link = $("display-download-link");
    link.href = url;
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      if (link.href === url) link.removeAttribute("href");
    }, 1000);
    return text;
  },
);
const imageUI = new ImageInputUI(
  $("image-input-dialog"),
  (json, version) => {
    if (version !== modelVersion)
      throw new Error("模型已更换，请重新提取像素数据。");
    $("input-json").value = json;
    message("已填入图片像素数据，点击“发送信号”执行。");
  },
  () => $("input-json").focus(),
);
function message(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
}
function select(key, toggle = true) {
  selected = toggle && selected === key ? null : key;
  view?.select(selected);
  for (const [k, b] of pickerElements)
    b.classList.toggle("active", k === selected);
  $("inspector")
    .closest(".inspector")
    .classList.toggle("has-selection", selected != null);
  renderInspector();
}
function renderInspector() {
  if (!model) return;
  const panels = $("inspector").querySelectorAll("[data-inspector-panel]");
  for (const panel of panels) panel.hidden = true;
  if (selected?.startsWith("lamp:")) {
    const index = Number(selected.slice(5));
    const pixel = view?.outputState.config.pixels[index];
    $("selected-id").textContent = `灯 ${index + 1}`;
    $("inspector-lamp").hidden = false;
    $("inspector-lamp-readout").hidden = !pixel;
    $("inspector-lamp-edit").hidden = !pixel;
    $("inspector-lamp-missing").hidden = !!pixel;
    if (pixel)
      $("inspector-lamp-readout").textContent = lampDetails(
        pixel,
        view.outputState.results[index],
      );
    return;
  }
  const node = model.nodes.find((node) => node.key === selected);
  $("selected-id").textContent =
    node?.displayName ?? node?.id ?? selected ?? "—";
  if (!node) {
    if (selected == null) {
      $("inspector-empty").hidden = false;
    } else if (model.inputs.includes(selected)) {
      $("inspector-input").hidden = false;
      $("inspector-input-value").textContent =
        `最近发送：${engine.latest.get(selected) ?? "未发送"}`;
    } else {
      const output = model.outputs.find((output) => output.id === selected);
      if (output) {
        $("inspector-output").hidden = false;
        $("inspector-output-source").textContent =
          `输出来源 ${output.error ? (output.originalSource ?? output.source) : displayNodeId(model, output.source)}`;
        $("inspector-output-value").textContent =
          output.error ??
          `最近输出：${engine.outputs.get(output.id) ?? "未输出"}`;
      }
    }
    return;
  }
  $("inspector-jk").hidden = false;
  $("inspector-fixed-id").textContent = node.id;
  $("inspector-tag").textContent = node.tag ?? "无";
  $("inspector-expression").textContent = String(node.ex ?? "缺失 ex");
  $("inspector-node-errors").hidden = !node.errors.length;
  $("inspector-node-errors").textContent = node.errors.join("；");
  $("inspector-jk-state").hidden = !!node.errors.length;
  if (node.errors.length) return;
  $("inspector-q").textContent =
    node.initial === null ? "无状态" : engine.q.get(node.id);
  $("inspector-latest").textContent = engine.latest.get(node.id) ?? "—";
  $("inspector-count").textContent = engine.counts.get(node.key);
  $("inspector-type").textContent = node.initial === null ? "无状态" : "有状态";
  const waiting = engine.waiting(node).map((id) => displayNodeId(model, id));
  const cached = [...engine.cache.get(node.key)]
    .map(([id, value]) => `${displayNodeId(model, id)}=${value}`)
    .join(", ");
  $("inspector-waiting").textContent = node.required.length
    ? `下一次触发等待：${waiting.join("、") || "参数已齐"}${cached ? " · 已收到 " + cached : ""}`
    : "无到齐条件 · 每次参数通知触发";
  const last = engine.last.get(node.key);
  const evaluation = $("inspector-evaluation");
  evaluation.hidden = !last;
  if (last) {
    // Preserve an explicitly collapsed details element through live updates.
    if (evaluation.dataset.node !== node.key) evaluation.open = true;
    evaluation.dataset.node = node.key;
    $("inspector-evaluation-title").textContent =
      `最近求值 #${last.ticket} · 实际读取参数`;
    $("inspector-reads").textContent = JSON.stringify(last.reads);
    const steps = document.createDocumentFragment();
    for (const operation of last.operations) {
      const row = cloneTemplate("evaluation-step-template");
      row.textContent = `${operation.token} : ${operation.before} ${operation.token[0] === "J" ? "AND" : "XOR"} ${operation.input} → ${operation.after}`;
      steps.append(row);
    }
    $("inspector-operations").replaceChildren(steps);
  }
}
function renderQueue() {
  if (!engine) return;
  const host = $("queue");
  const { rowHeight, overscanBefore, overscanCount } = APP_CONFIG.lists.queue;
  $("queue-count").textContent = engine.length.toLocaleString();
  host.style.setProperty(
    "--queue-total-height",
    `${engine.length * rowHeight}px`,
  );
  const maxScroll = Math.max(0, engine.length * rowHeight - host.clientHeight);
  if (host.scrollTop > maxScroll) host.scrollTop = maxScroll;
  const start = Math.max(
    0,
    Math.floor(host.scrollTop / rowHeight) - overscanBefore,
  );
  const end = Math.min(
    engine.length,
    start + Math.ceil(host.clientHeight / rowHeight) + overscanCount,
  );
  host.style.setProperty("--queue-scroll-offset", `${start * rowHeight}px`);
  const fragment = document.createDocumentFragment();
  for (let index = start; index < end; index++) {
    const item = engine.itemAt(index);
    const row = cloneTemplate("queue-row-template");
    row.querySelector("button").dataset.nodeKey = item.node.key;
    row.querySelector("em").textContent = `#${item.ticket}`;
    row.querySelector("[data-node-name]").textContent =
      item.node.displayName ?? item.node.id;
    const values = row.querySelector(".values");
    values.textContent =
      Object.entries(item.values)
        .map(([id, value]) => `${displayNodeId(model, id)}:${value}`)
        .join(" ") || "执行时读取 q";
    values.title = JSON.stringify(item.values);
    fragment.append(row);
  }
  $("queue-rows").replaceChildren(fragment);
  $("queue-empty").hidden = engine.length > 0;
}
function update() {
  if (!engine) return;
  for (const o of model.outputs) {
    const cell = outputElements.get(o.id),
      v = engine.outputs.get(o.id);
    cell.textContent = o.error ? "异常" : v === null ? "未输出" : String(v);
    cell.classList.toggle("empty", v === null);
  }
  $("total").textContent = engine.total.toLocaleString();
  $("play").textContent = playback.running ? "Ⅱ 暂停" : "▶ 继续";
  $("total2").textContent = engine.total.toLocaleString();
  $("EXtotal").textContent = engine.exTotal.toLocaleString();
  $("step").disabled = false;
  const status = engine.capacityReached
    ? "队列保护 · 已暂停"
    : !playback.running
      ? "已暂停"
      : engine.length || playback.active || playback.visuals.length
        ? "运行中"
        : model.valid.some((n) => engine.waiting(n).length)
          ? "等待输入"
          : "就绪";
  $("run-status").textContent = status;
  $("footer-state").textContent =
    `${model.inputs.length} 输入 / ${model.nodes.length} JK / ${model.outputs.length} 输出 · ${engine.length} 待执行`;
  if (engine.capacityReached)
    message(
      "队列达到 10,000 项保护阈值，自动执行已暂停；可单步或重载。不会丢弃执行项。",
      true,
    );
  const fragment = document.createDocumentFragment();
  for (const event of engine.history
    .slice(-APP_CONFIG.lists.history.visibleEntries)
    .reverse()) {
    const row = cloneTemplate("history-row-template");
    row.querySelector("span").textContent =
      event.type === "input"
        ? "↗ " + (event.accepted.join(" · ") || "无匹配输入")
        : `#${event.ticket}  ${displayNodeId(model, event.node)}`;
    row.querySelector("b").textContent =
      event.type === "input"
        ? "发送"
        : `${event.before === null ? "·" : event.before} → ${event.value}`;
    fragment.append(row);
  }
  $("history").replaceChildren(fragment);
  renderQueue();
  view?.refresh(engine);
  displayUI.update(engine.outputs);
  renderInspector();
}
function install(raw) {
  const next = compileModel(raw); // Validate before replacing the current model.
  model = next;
  engine = new JKEngine(model);
  selected = model.valid[0]?.key ?? model.nodes[0]?.key ?? model.inputs[0];
  imageUI.setModel(model.inputs, ++modelVersion);
  playback = new Playback(engine, {
    onChange: (event) => frameUpdates.request(event),
    onVisual: (event) =>
      event ? view?.showTransfers(event.transfers) : view?.clearSignals(),
    onProgress: (t) => view?.progress(t),
  });
  playback.speed = Number($("speed").value);
  playback.skip = $("skip").checked;
  updateSpeedControl();
  $("model-name").textContent = String(raw.name ?? "未命名模型");
  $("model-md5").textContent = `MD5: ${raw.md5 ?? "未提供"}`;
  $("stat-nodes").textContent = model.nodes.length;
  $("stat-state").textContent = model.nodes.filter(
    (n) => n.initial !== null,
  ).length;
  $("stat-edges").textContent =
    model.nodes.reduce(
      (sum, n) => sum + n.tokens.filter((t) => t.source).length,
      0,
    ) + model.outputs.length;
  $("stat-ex").textContent = model.nodes.reduce(
    (sum, n) => sum + n.tokens.length,
    0,
  );
  const issues = [
    ...model.issues,
    ...model.nodes.flatMap((n) =>
      n.errors.map((e) => `${n.displayName ?? n.id}：${e}`),
    ),
    ...model.outputs.filter((o) => o.error).map((o) => `${o.id}：${o.error}`),
  ];
  $("model-errors").hidden = !issues.length;
  $("model-errors").textContent = issues.join("\n");
  $("metadata").textContent = JSON.stringify(
    Object.fromEntries(
      Object.entries(raw).filter(
        ([k]) => !["nodes", "initial_q", "q_y"].includes(k),
      ),
    ),
    null,
    2,
  );
  $("output-rows").replaceChildren();
  $("outputs-empty").hidden = model.outputs.length > 0;
  outputElements.clear();
  for (const output of model.outputs) {
    const row = cloneTemplate("output-row-template");
    row.querySelector("[data-output-id]").textContent = output.id;
    row.querySelector(".source").textContent = output.error
      ? (output.originalSource ?? output.source)
      : displayNodeId(model, output.source);
    const value = row.querySelector(".output-value");
    $("output-rows").append(row);
    outputElements.set(output.id, value);
  }
  $("node-picker").replaceChildren();
  pickerElements.clear();
  const pickerItems = [
    ...model.inputs.map((id) => ({ id, key: id })),
    ...model.nodes,
    ...model.outputs.map((output) => ({
      id: output.id,
      key: output.id,
      errors: output.error ? [output.error] : [],
    })),
  ];
  for (const item of pickerItems) {
    const button = cloneTemplate("node-button-template");
    button.textContent = item.displayName ?? item.id;
    button.classList.toggle("bad", !!item.errors?.length);
    button.dataset.nodeKey = item.key;
    $("node-picker").append(button);
    pickerElements.set(item.key, button);
  }
  const defaults = Object.fromEntries(
    model.inputs.map((id) => [id, APP_CONFIG.signals.defaultValue]),
  );
  if (model.inputs.join(",") === Object.keys(APP_CONFIG.signals.example).join(",")) {
    Object.assign(defaults, APP_CONFIG.signals.example);
  }
  $("input-json").value = JSON.stringify(defaults);
  $("queue").scrollTop = 0;
  const display = loadDisplay(raw.outputDisplay);
  view?.setModel(model);
  view?.syncOutputs(engine);
  view?.setOutputDisplay(display.config);
  displayUI.load(display.config, model.outputs, display.error);
  select(selected, false);
  frameUpdates.request();
  document.querySelector(".left-panel").scrollTop = 0;
  message(
    display.error ?? "已加载模型。发送信号或暂停后单步执行。",
    !!display.error,
  );
}
$("inspector-lamp-edit").addEventListener("click", () => {
  if (selected?.startsWith("lamp:")) displayUI.open(Number(selected.slice(5)));
});
for (const host of [$("queue-rows"), $("node-picker")]) {
  host.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-node-key]");
    if (button && host.contains(button)) select(button.dataset.nodeKey);
  });
}
$("queue").addEventListener("scroll", () => frameUpdates.invalidate());
new ResizeObserver(() => frameUpdates.invalidate()).observe($("queue"));
$("image-input").onclick = () => imageUI.open();
$("send").onclick = () => {
  try {
    const e = playback.send(JSON.parse($("input-json").value));
    message(
      `已发送 ${e.accepted.length} 个输入${e.ignored.length ? `，忽略 ${e.ignored.length} 个未匹配字段` : ""}${!playback.running ? "；保持暂停" : ""}。`,
    );
  } catch (e) {
    message(e.message, true);
  }
};
$("play").onclick = () => {
  try {
    playback.running ? playback.pause() : playback.resume();
  } catch (e) {
    message(e.message, true);
  }
};
$("step").onclick = () => {
  try {
    playback.step();
  } catch (e) {
    playback.pause();
    message(e.message, true);
  }
};
$("reset").onclick = () => {
  playback.reset();
  message("已重载初始状态，保持暂停。常量节点已重新入队。");
};
function updateSpeedControl() {
  const skip = $("skip").checked,
    speed = Number($("speed").value),
    budget =
      playback?.skipFrameBudgetMs ?? APP_CONFIG.playback.skipBudgetMs * speed;
  $("speed-label").textContent = skip ? "计算速度" : "动画速度";
  $("speed-value").textContent = speed + "×";
  $("speed-budget").hidden = !skip;
  $("speed-budget").textContent = `每帧预算 ${budget} ms`;
  $("speed").setAttribute(
    "aria-valuetext",
    skip ? `${speed} 倍，每帧计算预算 ${budget} 毫秒` : `动画速度 ${speed} 倍`,
  );
  $("speed").title = skip
    ? `每帧最多计算约 ${budget} 毫秒；高倍速可能降低画面流畅度，单项计算不会中断。`
    : "调节传播动画的播放速度";
}
$("speed").oninput = () => {
  if (playback) playback.speed = Number($("speed").value);
  updateSpeedControl();
};
$("skip").onchange = () => {
  if (playback) playback.skip = $("skip").checked;
  updateSpeedControl();
  frameUpdates.invalidate();
};
function layoutStatus(result) {
  for (const button of $("layout-buttons").querySelectorAll("[data-layout]"))
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.layout === result.requestedMode),
    );
  $("layout-buttons").setAttribute("aria-busy", String(!!result.pending));
  if (result.pending) {
    $("layout-status").textContent = "正在排列…";
    return;
  }
  if (result.error) {
    $("layout-status").textContent = `布局失败：${result.error}`;
    return;
  }
  $("layout-status").textContent =
    `${result.automatic ? "自动 → " : ""}${result.mode} · 间距 1`;
  $("layout-status").title =
    `${result.description}；实际连线总长 ${result.metrics.wireLength.toFixed(2)}；自动可读性评分为启发式结果`;
  $("viewport").dataset.layout = result.mode;
}
$("layout-buttons").onclick = (event) => {
  const button = event.target.closest("[data-layout]");
  if (button && view?.model) view.requestLayout(button.dataset.layout);
};
$("output-render").onclick = () => displayUI.open();
$("camera-reset").onclick = () => view?.resetCamera();
setupSceneFullscreen(
  document.querySelector(".main-view"),
  $("scene-fullscreen"),
  document.querySelector(".inspector"),
);
$("node-labels").onclick = () => {
  const button = $("node-labels"),
    hidden = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(hidden));
  button.textContent = hidden ? "显示名称和次数" : "隐藏名称和次数";
  view?.setNodeLabelsHidden(hidden);
};
$("black-background").onclick = () => {
  const enabled = $("black-background").getAttribute("aria-pressed") !== "true";
  $("black-background").setAttribute("aria-pressed", String(enabled));
  view?.setBlackBackground(enabled);
};
const modelManager = new ModelManager(install, message, (raw) =>
  exportCurrentDisplayModel(raw, model?.raw, displayUI.config),
);
function pauseAfterError(error, prefix) {
  let detail = "";
  try {
    playback?.pause();
  } catch (syncError) {
    detail = `；状态同步失败：${syncError.message}`;
  } finally {
    frameUpdates.invalidate();
  }
  message(`${prefix}：${error.message}${detail}`, true);
}
function renderingFailed(error) {
  pauseAfterError(error, "3D 渲染中断");
  $("backend").textContent = "渲染已停止";
  $("gpu-message").hidden = false;
  $("gpu-detail").textContent = error.message;
  message(
    `3D 渲染中断：${error.message}。可点击“恢复 3D”，模型与计算状态仍保留。`,
    true,
  );
}
$("gpu-retry").onclick = async () => {
  $("gpu-retry").disabled = true;
  try {
    await view.recover();
    $("gpu-message").hidden = true;
    $("backend").textContent = "WebGPU · 已连接";
    message("3D 已恢复，计算保持暂停，可继续或单步。");
  } catch (e) {
    renderingFailed(e);
  } finally {
    $("gpu-retry").disabled = false;
  }
};
async function start() {
  view = new NetworkView($("viewport"), select, renderingFailed, layoutStatus);
  await modelManager.loadInitial();
  frameUpdates.flush();
  let previous = performance.now(),
    lastStatus = "";
  function frame(now) {
    try {
      const dt = Math.min((now - previous) / 1000, 0.1);
      previous = now;
      try {
        playback.tick(dt);
      } catch (e) {
        pauseAfterError(e, "执行错误");
      }
      const status = `${playback.running}:${!!playback.active}:${playback.visuals.length}:${engine.length}`;
      if (status !== lastStatus) {
        lastStatus = status;
        frameUpdates.invalidate();
      }
      try {
        frameUpdates.flush();
      } catch (e) {
        pauseAfterError(e, "界面更新错误");
      }
      try {
        view.render(playback.running);
      } catch (e) {
        view.fail(e);
      }
    } finally {
      requestAnimationFrame(frame);
    }
  }
  requestAnimationFrame(frame);
  try {
    await view.init();
    $("backend").textContent = "WebGPU · 已连接";
    view.setModel(model);
    view.refresh(engine);
    view.select(selected);
  } catch (e) {
    $("backend").textContent = "WebGPU 不可用";
    $("gpu-message").hidden = false;
    $("gpu-detail").textContent = e.message;
  }
}
start().catch((e) => message(`启动失败：${e.message}`, true));
