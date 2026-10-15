import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { CanvasRenderer } from '../../src/scene/canvas-renderer.js';
import { NodeLabels } from '../../src/scene/node-labels.js';
import { OutputBoard } from '../../src/scene/output-board.js';
import { defaultDisplay } from '../../src/ui/output-display.js';

const config = { pixelRatio: 1, curveSegments: 16, minNodePixels: 2, minFontPixels: 8, maxFontPixels: 28,
  fontFamily: 'monospace', lineWidth: 1, activeLineWidth: 2, arrowPixels: 4, nodeSize: .1,
  edgeColors: { J: 0xe898c0, K: 0x689ef3, Y: 0x79dfae }, signalTextColor: '#eefcf8' };
function setup(t) {
  const contextTypes = [], calls = [];
  const context = {
    setTransform(...args) { calls.push({ type: 'transform', args }); },
    clearRect(...args) { calls.push({ type: 'clear', args }); },
    fillRect(...args) { calls.push({ type: 'rect', args, fill: this.fillStyle }); },
    beginPath() { this.path = []; }, moveTo(x, y) { this.path.push([x, y]); }, lineTo(x, y) { this.path.push([x, y]); }, closePath() {},
    fill() { calls.push({ type: 'fill', path: this.path, fill: this.fillStyle }); },
    stroke() { calls.push({ type: 'stroke', path: this.path, stroke: this.strokeStyle, width: this.lineWidth }); },
    fillText(text, x, y) { calls.push({ type: 'text', text, x, y, font: this.font, fill: this.fillStyle }); },
  };
  const canvas = { width: 0, height: 0, getContext(type) { contextTypes.push(type); assert.equal(type, '2d'); return context; } };
  const scene = new THREE.Scene(), labels = new NodeLabels();
  const view = { visuals: new Map(), edges: [], signals: [], outputBoard: new OutputBoard(scene) };
  const renderer = new CanvasRenderer(view, { canvas, config }); renderer.setSize(640, 480);
  const camera = new THREE.PerspectiveCamera(42, 640 / 480, .1, 100);
  camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  t.after(() => { renderer.dispose(); view.outputBoard.clear(); labels.dispose();
    for (const visual of view.visuals.values()) { visual.mesh.geometry.dispose(); visual.mesh.material.dispose(); }
  });
  function node(key, point = [0, 0, 0], color = 0xf1f6ff) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(.1, .1, .1), new THREE.MeshBasicMaterial({ color }));
    mesh.position.set(...point); mesh.updateMatrixWorld();
    const title = labels.add(key); title.position.copy(mesh.position).add(new THREE.Vector3(0, -.19, 0));
    const count = labels.add('0 次', { color: '#5c7a96', size: 17 }); count.position.copy(mesh.position).add(new THREE.Vector3(0, -.36, 0));
    const q = labels.add('q', { color: '#173145', size: 30 }); q.position.copy(mesh.position);
    const visual = { mesh, title, count, q, type: key.startsWith('Y') ? 'Y' : 'Q' };
    view.visuals.set(key, visual); return visual;
  }
  function draw() { calls.length = 0; renderer.render(scene, camera); return calls; }
  return { view, scene, renderer, camera, calls, canvas, contextTypes, node, draw };
}

test('software rendering requests only 2D and paints every node without CSS or GPU contexts', t => {
  const h = setup(t); h.node('Q0'); h.node('Q1', [.8, 0, 0]);
  h.renderer.setPixelRatio(1.5); h.draw();
  assert.deepEqual(h.contextTypes, ['2d']); assert.equal(h.renderer.isCanvasRenderer, true);
  assert.equal(h.canvas.width, 960); assert.equal(h.canvas.height, 720); assert.equal(h.canvas.style, undefined);
  assert.deepEqual(h.calls.filter(c => c.type === 'text' && /^Q/.test(c.text)).map(c => c.text), ['Q0', 'Q1']);
  assert.ok(h.calls.filter(c => c.type === 'fill').length >= 2);
  h.renderer.dispose(); const count = h.calls.length; h.renderer.render(h.scene, h.camera); assert.equal(h.calls.length, count);
});

test('no available 2D context produces a useful failure instead of an empty canvas', () => {
  assert.throws(() => new CanvasRenderer({}, { canvas: { getContext: () => null }, config }), /Canvas 2D/);
});

test('near-plane and viewport clipping keep crossing curves finite and omit geometry behind the camera', t => {
  const h = setup(t); h.camera.position.set(0, 0, 0); h.camera.lookAt(0, 0, -1);
  h.node('Q0', [0, 0, 2]);
  const curve = new THREE.LineCurve3(new THREE.Vector3(-.2, 0, -3), new THREE.Vector3(.2, 0, 2));
  h.view.edges.push({ curve, endT: 1, op: 'K', arrow: { scale: new THREE.Vector3(1, 1, 1) } });
  h.draw();
  assert.equal(h.calls.filter(c => c.type === 'fill' || c.type === 'text').length, 0);
  assert.ok(h.calls.some(c => c.type === 'stroke'));
  for (const command of h.renderer.commands) for (const p of command.points) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
    assert.ok(p.x >= -1e-6 && p.x <= 640 + 1e-6 && p.y >= -1e-6 && p.y <= 480 + 1e-6);
    assert.ok(p.z >= -1 - 1e-6 && p.z <= 1 + 1e-6);
  }
  h.view.edges.length = 0; h.node('Q1', [0, 0, -101]); h.draw();
  assert.equal(h.calls.filter(c => c.type === 'fill' || c.type === 'text').length, 0);
});

test('camera projection left by WebGPU clips the near plane in its zero-to-one depth convention', t => {
  const h = setup(t); h.camera.position.set(0, 0, 0); h.camera.lookAt(0, 0, -1);
  h.camera.coordinateSystem = THREE.WebGPUCoordinateSystem; h.camera.updateProjectionMatrix(); h.draw();
  assert.equal(h.renderer.project(new THREE.Vector3(0, 0, -.08)), null);
  assert.ok(h.renderer.project(new THREE.Vector3(0, 0, -.11)));
});

test('label toggles preserve state markers and redraw current count, position and model contents', t => {
  const h = setup(t), node = h.node('Q0'); h.draw();
  assert.deepEqual(h.calls.filter(c => c.type === 'text').map(c => c.text), ['Q0', '0 次', 'q']);
  node.title.visible = node.count.visible = false; h.draw();
  assert.deepEqual(h.calls.filter(c => c.type === 'text').map(c => c.text), ['q']);
  node.title.visible = node.count.visible = true; node.count.setText('123 次');
  const oldX = h.renderer.project(node.mesh.position).x; node.mesh.position.x = .9;
  node.title.position.x = node.count.position.x = node.q.position.x = .9; h.draw();
  assert.ok(h.calls.some(c => c.type === 'text' && c.text === '123 次'));
  assert.ok(h.calls.find(c => c.text === 'Q0').x > oldX);
  h.view.visuals.delete('Q0'); node.mesh.geometry.dispose(); node.mesh.material.dispose(); h.node('Q9'); h.draw();
  assert.ok(h.calls.some(c => c.text === 'Q9')); assert.equal(h.calls.some(c => c.text === 'Q0' || c.text === '123 次'), false);
});

test('depth order keeps nearer cubes over farther cubes, and selected edges retain width and arrows', t => {
  const h = setup(t); h.node('Q0', [0, 0, -1], 0xff0000); h.node('Q1', [0, 0, 1], 0x0000ff);
  const curve = new THREE.LineCurve3(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0));
  h.view.edges.push({ curve, endT: 1, op: 'K', arrow: { scale: new THREE.Vector3(1.35, 1.35, 1.35) },
    highlight: { visible: true, material: { color: new THREE.Color('#ff0000') } } });
  h.draw();
  const last = h.calls.filter(c => c.type === 'fill').at(-1);
  assert.match(last.fill, /^rgb\(0,0,\d+\)$/);
  assert.ok(h.calls.some(c => c.type === 'stroke' && c.width === config.activeLineWidth));
  assert.ok(h.calls.some(c => c.type === 'fill' && c.path.length === 3), 'direction arrow remains visible');
  assert.ok(h.renderer.commands.every((c, i, a) => !i || a[i - 1].depth >= c.depth));
});

test('RGB board displays painted colors only from its front and keeps its dark rear frame', t => {
  const h = setup(t); h.node('Y0', [0, 0, 0]);
  const board = h.view.outputBoard;
  const display = defaultDisplay(); display.enabled = true; display.rows = 1; display.cols = 1; display.pixels = [display.pixels[0]];
  display.pixels[0].channels.r = { kind: 'bits', bits: ['Y0'], order: 'lsb-first', mapping: 'scale' };
  board.rebuild(display, h.view.visuals, { bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } } });
  board.paint([{ r: { brightness: 255 }, g: { brightness: 64 }, b: { brightness: 0 } }], [0]);
  const center = board.positions[0]; h.camera.position.copy(center).add(new THREE.Vector3(5, 0, 0)); h.camera.lookAt(center); h.draw();
  assert.ok(h.calls.some(c => c.type === 'fill' && c.fill === 'rgb(255,64,0)'));
  board.select('lamp:0'); h.draw();
  assert.ok(h.calls.some(c => c.type === 'stroke' && c.stroke === new THREE.Color(0x9de4db).getStyle()));
  h.camera.position.copy(center).add(new THREE.Vector3(-5, 0, 0)); h.camera.lookAt(center); h.draw();
  assert.equal(h.calls.some(c => c.type === 'fill' && c.fill === 'rgb(255,64,0)'), false);
  assert.ok(h.calls.some(c => c.type === 'fill' && c.fill === new THREE.Color(0x080c12).getStyle()));
  assert.equal(h.calls.some(c => c.type === 'stroke' && c.stroke === new THREE.Color(0x9de4db).getStyle()), false);
  board.select('Y0'); h.draw();
  assert.ok(h.calls.some(c => c.type === 'stroke' && c.stroke === new THREE.Color('#ef6687').getStyle()),
    'rear input connections keep their selected channel color');
  board.group.visible = false; h.draw();
  assert.equal(h.calls.some(c => c.type === 'fill' && c.fill === new THREE.Color(0x080c12).getStyle()), false);
});

test('all nine RGB tiles remain uncovered by their backing at oblique front views', t => {
  const h = setup(t), board = h.view.outputBoard, display = defaultDisplay(3, 3);
  display.enabled = true;
  board.rebuild(display, h.view.visuals, { bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } } });
  board.paint(Array.from({ length: 9 }, (_, i) => ({ r: { brightness: 30 + i * 23 },
    g: { brightness: 225 - i * 19 }, b: { brightness: 40 + i * 17 } })), Array.from({ length: 9 }, (_, i) => i));
  const contains = (polygon, point) => {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [x, y] = polygon[i], [previousX, previousY] = polygon[j];
      if ((y > point.y) !== (previousY > point.y)
        && point.x < (previousX - x) * (point.y - y) / (previousY - y) + x) inside = !inside;
    }
    return inside;
  };
  const center = board.positions[4], color = new THREE.Color();
  for (const direction of [[6, 2, 5], [6, 2, -5], [3, -2, 8]]) {
    h.camera.position.copy(center).add(new THREE.Vector3(...direction)); h.camera.lookAt(center); h.draw();
    for (let i = 0; i < board.positions.length; i++) {
      const point = h.renderer.project(board.positions[i]); assert.ok(point, `tile ${i} must be in view`);
      board.lamps.getColorAt(i, color);
      const topmost = h.calls.filter(call => call.type === 'fill' && contains(call.path, point)).at(-1);
      assert.equal(topmost?.fill, color.getStyle(), `tile ${i} is covered from ${direction}`);
    }
  }
});

test('propagation values follow current positions and clear when transfers are removed', t => {
  const h = setup(t);
  const edge = { curve: new THREE.LineCurve3(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)), endT: 1 };
  const signal = { edge, value: 1, text: { position: new THREE.Vector3(-.5, .23, 0), renderOrder: 4 },
    tip: { material: { color: new THREE.Color(0xb4ffdf) } } };
  h.view.signals.push(signal); h.view.signalProgress = .25; h.draw();
  const first = h.calls.find(c => c.type === 'text' && c.text === '1'); assert.ok(first);
  signal.text.position.x = .5; signal.value = 0; h.view.signalProgress = .75; h.draw();
  const next = h.calls.find(c => c.type === 'text' && c.text === '0'); assert.ok(next.x > first.x);
  h.view.signals.length = 0; h.draw(); assert.equal(h.calls.some(c => c.type === 'text' || c.type === 'fill'), false);
});

test('background changes and grid visibility are respected without changing camera state', t => {
  const h = setup(t); h.view.grid = new THREE.GridHelper(5, 5); h.scene.add(h.view.grid);
  h.camera.position.set(0, 3, 5); h.camera.lookAt(0, 0, 0);
  const pose = [...h.camera.position, ...h.camera.quaternion]; h.draw(); assert.ok(h.calls.some(c => c.type === 'stroke'));
  h.view.grid.visible = false; h.scene.background = new THREE.Color(0x000000); h.draw();
  assert.equal(h.calls.some(c => c.type === 'stroke'), false);
  assert.ok(h.calls.some(c => c.type === 'rect' && c.fill === 'rgb(0,0,0)'));
  assert.deepEqual([...h.camera.position, ...h.camera.quaternion], pose);
  h.view.grid.geometry.dispose(); h.view.grid.material.dispose();
});
