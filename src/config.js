/** Page defaults and limits. Runtime state must copy these frozen branches. */
function freezeTree(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") freezeTree(child);
  }
  return Object.freeze(value);
}

export const APP_CONFIG = freezeTree({
  imageInput: {
    defaultPreset: "b1.png",
    selection: { x: 0, y: 0, width: 3, height: 3 },
    encoding: "rgb",
    arrangement: "pixel",
    bitOrder: "lsb-first",
    background: "white",
    fields: {
      size: { min: 1, step: 1 },
      coordinate: { min: 0, step: 1 },
    },
    limits: {
      fileBytes: 32 * 1024 * 1024,
      imagePixels: 16000000,
      outputBits: 65536,
      previewEntries: 128,
    },
    view: {
      scale: 1,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      maxScale: 64,
      pixelRatio: 2,
    },
  },
  outputBoard: {
    version: 1,
    enabled: false,
    rows: 3,
    cols: 3,
    scale: 3,
    limits: {
      dimension: { min: 1, max: 32 },
      scale: { min: 0.25, max: 8, step: 0.25 },
      channelBits: { min: 1, max: 64 },
      brightness: { min: 0, max: 255 },
    },
    // Legacy serialized data and the data API have separate compatibility rules.
    compatibility: { scale: 1, batchGray: false },
    batch: { width: 8, order: "lsb-first", mapping: "scale", gray: true },
    channel: { value: 0, radix: 10 },
    packed: {
      widths: { r: 8, g: 8, b: 8 },
      order: "lsb-first",
      mapping: "scale",
    },
  },
  playback: {
    running: true,
    speed: { value: 1, min: 0.25, max: 4, step: 0.25 },
    skipAnimation: true,
    skipBudgetMs: 4,
    maxSkipSteps: 10000,
    duration: 0.85,
    maxVisuals: 400,
    // Standalone Playback consumers historically begin in animated mode.
    compatibility: { skipAnimation: false },
  },
  scene: {
    layout: "5D",
    nodeLabelsHidden: false,
    blackBackground: false,
  },
  lists: {
    queue: { rowHeight: 36, overscanBefore: 2, overscanCount: 5 },
    history: { visibleEntries: 60 },
  },
  signals: {
    defaultValue: 0,
    example: { X0: 1, X1: 0, X2: 1, X3: 0 },
  },
});
