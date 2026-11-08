import { APP_CONFIG } from '../../html/config.js';

/** UI presets do not change model definitions or fill missing JKRD fields. */
export function modelDefaults(compiled, { builtin = false, config = APP_CONFIG.model } = {}) {
  const preset = builtin && Object.hasOwn(config.presets, compiled.name) ? config.presets[compiled.name] : null;
  const { startIndex, count } = config.defaults.input;
  return {
    path: preset?.path ?? `${compiled.name}.jkm.json`,
    input: structuredClone(preset?.input ?? compiled.inputs.slice(startIndex, startIndex + count)),
    observe: structuredClone(preset?.observe ?? config.defaults.observe),
  };
}
