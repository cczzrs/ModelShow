import * as THREE from 'three/webgpu';
import { APP_CONFIG } from '../../html/config.js';

// All geometry remains in the same world space as the GPU scene and its pick proxies.
// Clip before dividing by w: geometry crossing the camera must not flip or explode.
const CLIP_PLANES = [v => v.w + v.x, v => v.w - v.x, v => v.w + v.y,
  v => v.w - v.y, v => v.w + v.z, v => v.w - v.z];
const WEBGPU_CLIP_PLANES = [...CLIP_PLANES.slice(0, 4), v => v.z, CLIP_PLANES[5]];
const FACES = [
  { indices: [1, 3, 7, 5], normal: [1, 0, 0], shade: .8 },
  { indices: [0, 4, 6, 2], normal: [-1, 0, 0], shade: .65 },
  { indices: [2, 6, 7, 3], normal: [0, 1, 0], shade: 1 },
  { indices: [0, 1, 5, 4], normal: [0, -1, 0], shade: .55 },
  { indices: [4, 5, 7, 6], normal: [0, 0, 1], shade: .92 },
  { indices: [0, 2, 3, 1], normal: [0, 0, -1], shade: .72 },
];
const vector = point => new THREE.Vector3(point.x, point.y, point.z);

export class CanvasRenderer {
  constructor(view, { canvas = document.createElement('canvas'), config = APP_CONFIG.scene.renderer.software } = {}) {
    this.view = view; this.config = config; this.domElement = canvas; this.isCanvasRenderer = true;
    this.context = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
    if (!this.context) throw new Error('浏览器无法建立 Canvas 2D 软件渲染画布。');
    this.pixelRatio = config.pixelRatio; this.width = this.height = 1;
    this.clearColor = new THREE.Color(); this.clearAlpha = 0;
    this.clipMatrix = new THREE.Matrix4(); this.clipPlanes = CLIP_PLANES; this.cameraPosition = new THREE.Vector3();
    this.color = new THREE.Color(); this.commands = []; this.labels = [];
  }
  setPixelRatio(ratio) {
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    this.pixelRatio = ratio; this.setSize(this.width, this.height);
  }
  setClearColor(color, alpha = 1) { this.clearColor.set(color); this.clearAlpha = alpha; }
  setSize(width, height) {
    this.width = Math.max(1, Math.floor(width)); this.height = Math.max(1, Math.floor(height));
    // The viewport owns CSS sizing; the renderer only controls backing-store pixels.
    this.domElement.width = Math.max(1, Math.round(this.width * this.pixelRatio));
    this.domElement.height = Math.max(1, Math.round(this.height * this.pixelRatio));
  }
  clipPoint(point) { return new THREE.Vector4(point.x, point.y, point.z, 1).applyMatrix4(this.clipMatrix); }
  screen(point) {
    if (!Number.isFinite(point.w) || point.w <= 0) return null;
    const x = point.x / point.w, y = point.y / point.w, z = point.z / point.w;
    return [x, y, z].every(Number.isFinite) ? { x: (x + 1) * this.width / 2, y: (1 - y) * this.height / 2, z } : null;
  }
  project(point) {
    const p = this.clipPoint(point);
    return this.clipPlanes.every(plane => plane(p) >= 0) ? this.screen(p) : null;
  }
  clippedLine(a, b) {
    let start = this.clipPoint(a), end = this.clipPoint(b);
    for (const plane of this.clipPlanes) {
      const da = plane(start), db = plane(end);
      if (da < 0 && db < 0) return null;
      if (da < 0 || db < 0) {
        const intersection = start.clone().lerp(end, da / (da - db));
        if (da < 0) start = intersection; else end = intersection;
      }
    }
    const points = [this.screen(start), this.screen(end)];
    return points.every(Boolean) ? points : null;
  }
  clippedPolygon(points) {
    let polygon = points.map(point => this.clipPoint(point));
    for (const plane of this.clipPlanes) {
      const next = [];
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length], da = plane(a), db = plane(b);
        if (da >= 0) next.push(a);
        if ((da < 0) !== (db < 0)) next.push(a.clone().lerp(b, da / (da - db)));
      }
      polygon = next;
      if (polygon.length < 3) return [];
    }
    const projected = polygon.map(point => this.screen(point));
    return projected.every(Boolean) ? projected : [];
  }
  queue(points, { fill, stroke, width = this.config.lineWidth, alpha = 1, close = false } = {}) {
    if (points.length < 2) return;
    this.commands.push({ points, fill, stroke, width, alpha, close,
      depth: points.reduce((sum, point) => sum + point.z, 0) / points.length });
  }
  line(a, b, color, width = this.config.lineWidth, alpha = 1) {
    const points = this.clippedLine(a, b);
    if (points) this.queue(points, { stroke: color, width, alpha });
  }
  polygon(points, fill, stroke, width) {
    this.queue(this.clippedPolygon(points), { fill, stroke, width, close: true });
  }
  style(value, shade = 1) { return this.color.set(value).multiplyScalar(shade).getStyle(); }
  cube(mesh, size, { shade = true, minimum = false, omitFront = false } = {}) {
    if (!mesh || mesh.visible === false) return;
    mesh.updateWorldMatrix(true, false);
    const corners = [];
    for (const z of [-1, 1]) for (const y of [-1, 1]) for (const x of [-1, 1]) {
      corners.push(new THREE.Vector3(x * size.x / 2, y * size.y / 2, z * size.z / 2).applyMatrix4(mesh.matrixWorld));
    }
    const center = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld), projected = this.project(center);
    const onScreen = corners.map(point => this.project(point)).filter(Boolean);
    const minimumPixels = this.config.minNodePixels * (this.view.networkStyles ? mesh.scale.x : 1);
    if (minimum && projected && onScreen.length === 8
      && Math.max(...onScreen.map(p => p.x)) - Math.min(...onScreen.map(p => p.x)) < minimumPixels
      && Math.max(...onScreen.map(p => p.y)) - Math.min(...onScreen.map(p => p.y)) < minimumPixels) {
      const half = minimumPixels / 2;
      this.queue([{ ...projected, x: projected.x - half, y: projected.y - half },
        { ...projected, x: projected.x + half, y: projected.y - half },
        { ...projected, x: projected.x + half, y: projected.y + half },
        { ...projected, x: projected.x - half, y: projected.y + half }], { fill: this.style(mesh.material.color), close: true });
      return;
    }
    for (const face of FACES) {
      if (omitFront && face.normal[0] === 1) continue;
      const normal = new THREE.Vector3(...face.normal).transformDirection(mesh.matrixWorld);
      const faceCenter = face.indices.reduce((sum, i) => sum.add(corners[i]), new THREE.Vector3()).multiplyScalar(.25);
      if (normal.dot(this.cameraPosition.clone().sub(faceCenter)) <= 0) continue;
      this.polygon(face.indices.map(i => corners[i]), this.style(mesh.material.color, shade ? face.shade : 1));
    }
  }
  curve(curve, color, width, alpha, endT = 1) {
    const segments = Math.max(1, Math.floor(this.config.curveSegments));
    let previous = curve.getPoint(0);
    for (let i = 1; i <= segments; i++) {
      const point = curve.getPoint(endT * i / segments);
      this.line(previous, point, color, width, alpha); previous = point;
    }
  }
  arrow(curve, t, color, scale = 1, alpha = 1) {
    const point = this.project(curve.getPoint(t));
    if (!point) return;
    const tangent = curve.getTangent(t), base = curve.getPoint(t).addScaledVector(tangent, -this.config.nodeSize);
    const clipped = this.clippedLine(base, curve.getPoint(t));
    if (!clipped) return;
    const dx = point.x - clipped[0].x, dy = point.y - clipped[0].y, length = Math.hypot(dx, dy);
    if (length < 1e-6) return;
    const ux = dx / length, uy = dy / length, size = this.config.arrowPixels * scale;
    this.queue([point, { x: point.x - ux * size - uy * size / 2, y: point.y - uy * size + ux * size / 2, z: point.z },
      { x: point.x - ux * size + uy * size / 2, y: point.y - uy * size - ux * size / 2, z: point.z }], { fill: color, close: true, alpha });
  }
  label(label) {
    if (!label || label.visible === false || !label.text) return;
    const point = this.project(label.position); if (!point) return;
    const depth = -vector(label.position).applyMatrix4(this.camera.matrixWorldInverse).z;
    const worldHeight = label.fontSize * label.scale.y / 64;
    const height = worldHeight * this.camera.projectionMatrix.elements[5] * this.height / (this.camera.isPerspectiveCamera ? 2 * depth : 2);
    const scale = this.view.appearance?.fontScale ?? 1;
    const fontSize = THREE.MathUtils.clamp(height, this.config.minFontPixels * scale, this.config.maxFontPixels * scale);
    const color = this.color.copy(label.textColor).multiply(label.color).getStyle();
    this.labels.push({ point, text: label.text, fontSize, color, order: label.renderOrder ?? 4 });
  }
  grid(grid) {
    if (!grid || !grid.visible) return;
    grid.updateWorldMatrix(true, false);
    const position = grid.geometry?.attributes.position, colors = grid.geometry?.attributes.color;
    if (!position) return;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (let i = 0; i + 1 < position.count; i += 2) {
      a.fromBufferAttribute(position, i).applyMatrix4(grid.matrixWorld);
      b.fromBufferAttribute(position, i + 1).applyMatrix4(grid.matrixWorld);
      const color = colors ? this.color.fromBufferAttribute(colors, i).getStyle() : this.style(grid.material.color);
      this.line(a, b, color, this.config.lineWidth, grid.material.opacity);
    }
  }
  board(board) {
    if (!board?.group?.visible || !board.frame || !board.positions?.length) return;
    const size = board.frame.geometry.parameters;
    const front = this.cameraPosition.x > board.positions[0].x;
    this.cube(board.frame, new THREE.Vector3(size.width, size.height, size.depth), { shade: false, omitFront: front });
    for (const batch of board.batches ?? []) {
      const colors = batch.line.geometry.attributes.color, segments = colors.count / (batch.edges.length * 2);
      batch.edges.forEach((edge, i) => {
        const color = this.color.fromBufferAttribute(colors, i * segments * 2).getStyle();
        this.curve(edge.curve, color, this.config.lineWidth, batch.line.material.opacity);
      });
    }
    // Tiles are single-sided +X faces, exactly like the actual board. A rear view
    // shows its opaque back, never mirrored RGB pixels shining through the frame.
    if (!front) return;
    const scale = board.config.scale ?? APP_CONFIG.scene.outputBoard.scale;
    const rectangle = (p, halfY, halfZ) => [new THREE.Vector3(p.x, p.y - halfY, p.z - halfZ),
      new THREE.Vector3(p.x, p.y + halfY, p.z - halfZ), new THREE.Vector3(p.x, p.y + halfY, p.z + halfZ),
      new THREE.Vector3(p.x, p.y - halfY, p.z + halfZ)];
    const tile = board.lamps.geometry.parameters;
    // A single, slanted backing face has a mean depth in front of its farther
    // tiles. Draw only the actual gaps at the tile plane instead: none of these
    // small background polygons overlap a pixel, regardless of painter order.
    const frameColor = this.style(board.frame.material.color);
    const halfHeight = size.height / 2, halfWidth = size.depth / 2;
    const top = board.frame.position.y + halfHeight, bottom = board.frame.position.y - halfHeight;
    const left = board.frame.position.z + halfWidth, right = board.frame.position.z - halfWidth;
    for (let i = 0; i < board.positions.length; i++) {
      const position = board.positions[i], row = Math.floor(i / board.config.cols), col = i % board.config.cols;
      const above = row === 0 ? top : (position.y + board.positions[i - board.config.cols].y) / 2;
      const below = row === board.config.rows - 1 ? bottom : (position.y + board.positions[i + board.config.cols].y) / 2;
      const before = col === 0 ? left : (position.z + board.positions[i - 1].z) / 2;
      const after = col === board.config.cols - 1 ? right : (position.z + board.positions[i + 1].z) / 2;
      const tileTop = position.y + tile.height / 2, tileBottom = position.y - tile.height / 2;
      const tileLeft = position.z + tile.width / 2, tileRight = position.z - tile.width / 2;
      const gap = (y0, y1, z0, z1) => {
        if (y1 <= y0 || z1 <= z0) return;
        const center = new THREE.Vector3(position.x, (y0 + y1) / 2, (z0 + z1) / 2);
        this.polygon(rectangle(center, (y1 - y0) / 2, (z1 - z0) / 2), frameColor);
      };
      gap(tileTop, above, after, before); gap(below, tileBottom, after, before);
      gap(tileBottom, tileTop, tileLeft, before); gap(tileBottom, tileTop, after, tileRight);
    }
    const border = board.border?.children[0];
    if (border) this.polygon(rectangle(border.position, size.height / 2, size.depth / 2), null,
      this.style(border.material.color), this.config.lineWidth);
    for (let i = 0; i < board.positions.length; i++) {
      board.lamps.getColorAt(i, this.color);
      this.polygon(rectangle(board.positions[i], tile.height / 2, tile.width / 2), this.color.getStyle());
    }
    if (board.marker?.visible) {
      const marker = board.marker.position.clone(); marker.x += .004 * scale;
      this.polygon(rectangle(marker, .219 * scale, .219 * scale), null,
        this.style(board.marker.material.color), this.config.activeLineWidth);
    }
  }
  render(scene, camera) {
    if (this.disposed) return;
    this.camera = camera; camera.updateMatrixWorld();
    this.clipPlanes = camera.coordinateSystem === THREE.WebGPUCoordinateSystem ? WEBGPU_CLIP_PLANES : CLIP_PLANES;
    camera.getWorldPosition(this.cameraPosition);
    this.clipMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.commands.length = this.labels.length = 0;
    const context = this.context;
    context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, this.domElement.width, this.domElement.height);
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0); context.globalAlpha = 1;
    const background = scene.background?.isColor ? scene.background : this.clearAlpha ? this.clearColor : null;
    if (background) {
      context.fillStyle = background.getStyle(); context.globalAlpha = scene.background ? 1 : this.clearAlpha;
      context.fillRect(0, 0, this.width, this.height); context.globalAlpha = 1;
    }
    this.grid(this.view.grid);
    for (const [index, edge] of this.view.edges.entries()) {
      if (edge.visible === false) continue;
      const active = !!edge.highlight?.visible;
      const color = this.style(edge.highlight?.material?.color ?? this.view.batches?.edgeColors[index] ?? this.config.edgeColors[edge.op]);
      const opacity = edge.styleOpacity ?? .4;
      this.curve(edge.curve, color, active ? this.config.activeLineWidth : this.config.lineWidth, active ? Math.min(1, opacity / .4) : opacity, edge.endT);
      this.arrow(edge.curve, edge.endT, color, edge.arrow.scale.x, Math.min(1, opacity / .4));
    }
    for (const visual of this.view.visuals.values()) {
      const size = visual.mesh.geometry?.parameters;
      this.cube(visual.mesh, new THREE.Vector3(size?.width ?? this.config.nodeSize, size?.height ?? this.config.nodeSize,
        size?.depth ?? this.config.nodeSize), { minimum: true });
      this.label(visual.title); this.label(visual.count); this.label(visual.q);
    }
    this.board(this.view.outputBoard);
    for (const signal of this.view.signals) {
      if (signal.edge.visible === false || signal.text.visible === false || signal.tip.visible === false) continue;
      const at = (this.view.signalProgress ?? 0) * signal.edge.endT;
      this.arrow(signal.edge.curve, at, this.style(signal.tip.material.color), 1, signal.tip.material.opacity);
      const point = this.project(signal.text.position);
      if (point && signal.value !== undefined) this.labels.push({ point, text: String(signal.value),
        fontSize: this.config.maxFontPixels * (this.view.appearance?.fontScale ?? 1),
        color: this.style(this.view.labelColor?.(this.config.signalTextColor) ?? this.config.signalTextColor), order: signal.text.renderOrder,
        alpha: signal.text.material.opacity });
    }
    // Far geometry is painted first; labels follow the GPU's depthTest:false behavior.
    this.commands.sort((a, b) => b.depth - a.depth);
    context.lineJoin = 'round'; context.lineCap = 'round';
    for (const command of this.commands) {
      context.globalAlpha = command.alpha; context.beginPath();
      context.moveTo(command.points[0].x, command.points[0].y);
      for (const point of command.points.slice(1)) context.lineTo(point.x, point.y);
      if (command.close) context.closePath();
      if (command.fill) { context.fillStyle = command.fill; context.fill(); }
      if (command.stroke) { context.strokeStyle = command.stroke; context.lineWidth = command.width; context.stroke(); }
    }
    context.globalAlpha = 1; context.textAlign = 'center'; context.textBaseline = 'middle';
    this.labels.sort((a, b) => a.order - b.order || b.point.z - a.point.z);
    for (const label of this.labels) {
      context.globalAlpha = label.alpha ?? 1;
      context.fillStyle = label.color; context.font = `500 ${label.fontSize}px ${this.config.fontFamily}`;
      context.fillText(label.text, label.point.x, label.point.y);
    }
    context.globalAlpha = 1;
  }
  dispose() { this.disposed = true; this.commands.length = this.labels.length = 0; this.context = null; this.view = null; }
}
