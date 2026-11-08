import { APP_CONFIG } from '../../html/config.js';
import { clampSelection } from './rgb-image-input.js';

const defaults = APP_CONFIG.rgb.imageInput;

/** Import placement is explicit; decoded dimensions constrain values but never choose defaults. */
export function importedSelection(current, width, height, config = defaults) {
  const placement = config.import.selection;
  if (!['configured', 'center', 'retain'].includes(placement)) throw new Error('图片导入选区策略无效');
  const selection = clampSelection(placement === 'configured' ? config.selection : current, width, height);
  if (placement === 'center') {
    selection.x = Math.floor((width - selection.width) / 2);
    selection.y = Math.floor((height - selection.height) / 2);
  }
  return selection;
}

export function minimumImageScale(view, source, settings = defaults.view) {
  return Math.min(view.width / source.width, view.height / source.height, 1) / settings.minScaleDivisor;
}

export function fittedImageView(view, source, settings = defaults.view) {
  const scale = Math.min(settings.maxScale, Math.max(minimumImageScale(view, source, settings),
    Math.min((view.width - settings.fitPadding) / source.width, (view.height - settings.fitPadding) / source.height)));
  return { ...view, scale, x: (view.width - source.width * scale) / 2, y: (view.height - source.height * scale) / 2 };
}

export function importedImageView(view, source, config = defaults) {
  if (config.import.view === 'fit') return fittedImageView(view, source, config.view);
  if (config.import.view !== 'configured') throw new Error('图片导入视图策略无效');
  const { scale, x, y } = config.view;
  return { ...view, scale: Math.max(minimumImageScale(view, source, config.view), Math.min(config.view.maxScale, scale)), x, y };
}

export function zoomedImageView(view, source, scale, x, y, settings = defaults.view) {
  scale = Math.max(minimumImageScale(view, source, settings), Math.min(settings.maxScale, scale));
  const ratio = scale / view.scale;
  return { ...view, scale, x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio };
}

export function wheelImageScale(view, deltaY, deltaMode, settings = defaults.interaction.wheel) {
  const delta = deltaY * (deltaMode === 1 ? settings.linePixels : deltaMode === 2 ? view.height : 1);
  return view.scale * Math.exp(-delta * settings.sensitivity);
}
