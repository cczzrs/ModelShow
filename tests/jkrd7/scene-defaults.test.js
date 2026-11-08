import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { APP_CONFIG } from '../../html/config.js';
import { NetworkView } from '../../src/scene/view.js';
import { EditorControls } from '../../src/scene/editor-controls.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} ≈ ${expected}`);

test('camera projection, initial pose and fit use non-default tree values', () => {
  const settings = structuredClone(APP_CONFIG.scene);
  Object.assign(settings.camera.projection, { fov: 55, near: .25, far: 25 });
  settings.camera.initial = { position: { x: 4, y: 5, z: 6 }, target: { x: 1, y: 2, z: 3 } };
  Object.assign(settings.camera.fit, {
    direction: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 }, minDistance: 10,
    padding: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    farMultiplier: 3, maxDistanceMultiplier: 4,
  });
  Object.assign(settings.controls, { minDistance: .7, maxDistance: 7 });
  const view = new NetworkView({}, () => {}, undefined, undefined, undefined, settings);
  assert.equal(view.camera.fov, 55); assert.equal(view.camera.near, .25); assert.equal(view.camera.far, 25);
  assert.deepEqual(view.camera.position.toArray(), [4, 5, 6]);
  const initialDirection = view.camera.getWorldDirection(new THREE.Vector3());
  for (const value of initialDirection.toArray()) near(value, -1 / Math.sqrt(3));
  view.layout = { bounds: { min: { x: 2, y: 3, z: 4 }, max: { x: 2, y: 3, z: 4 } } };
  view.controls = { target: new THREE.Vector3(), update() {} };
  view.resetCamera();
  assert.deepEqual(view.camera.position.toArray(), [12, 3, 4]);
  assert.deepEqual(view.camera.up.toArray(), [0, 0, 1]);
  assert.deepEqual(view.controls.target.toArray(), [2, 3, 4]);
  assert.equal(view.camera.far, 30);
  assert.equal(view.controls.minDistance, .7); assert.equal(view.controls.maxDistance, 40);
  settings.camera.fit.minDistance = 5;
  view.resetCamera();
  assert.deepEqual(view.camera.position.toArray(), [7, 3, 4]);
  assert.equal(view.camera.far, 25); assert.equal(view.controls.maxDistance, 20);
});

test('camera fit padding and occupancy determine the configured framing', () => {
  const settings = structuredClone(APP_CONFIG.scene);
  Object.assign(settings.camera.projection, { fov: 90 });
  Object.assign(settings.camera.fit, {
    direction: { x: 0, y: 0, z: 1 }, minDistance: 0,
    padding: { min: { x: 2, y: 0, z: 0 }, max: { x: 2, y: 0, z: 0 } },
    occupancy: { horizontal: .5, vertical: .5 },
  });
  const view = new NetworkView({}, () => {}, undefined, undefined, undefined, settings);
  view.layout = { bounds: { min: { x: -1, y: -1, z: 0 }, max: { x: 1, y: 1, z: 0 } } };
  view.resetCamera();
  near(view.camera.position.z, 6);
  settings.camera.fit.occupancy.horizontal = 1;
  view.resetCamera();
  near(view.camera.position.z, 3);
  settings.camera.fit.padding.min.x = settings.camera.fit.padding.max.x = 0;
  view.resetCamera();
  near(view.camera.position.z, 2);
});

test('scene interaction speeds, zoom bounds and wheel sensitivity use controls defaults', t => {
  const previous = globalThis.window;
  let controls;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, pageXOffset: 0, pageYOffset: 0 };
  t.after(() => { controls?.dispose(); if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const element = {
    addEventListener() {}, removeEventListener() {}, style: {},
    ownerDocument: { documentElement: { clientLeft: 0, clientTop: 0 } },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
  const settings = structuredClone(APP_CONFIG.scene.controls);
  Object.assign(settings, { staticMoving: false, rotateSpeed: 3.5, panSpeed: .35, minDistance: .7, maxDistance: 100 });
  settings.wheel = { linePixels: 2, sensitivity: .01, minExponent: -.2, maxExponent: .2 };
  const camera = new THREE.PerspectiveCamera(42, 4 / 3, .1, 500); camera.position.set(0, 0, 10);
  controls = new EditorControls(camera, element, () => null, settings);
  assert.equal(controls.staticMoving, false); assert.equal(controls.rotateSpeed, 3.5); assert.equal(controls.panSpeed, .35);
  assert.equal(controls.minDistance, .7); assert.equal(controls.maxDistance, 100);
  controls.cursorWheel({ deltaY: 1, deltaMode: 1, clientX: 400, clientY: 300, preventDefault() {} });
  near(camera.position.distanceTo(controls.target), 10 * Math.exp(.02));
  controls.cursorWheel({ deltaY: -1000, deltaMode: 0, clientX: 400, clientY: 300, preventDefault() {} });
  near(camera.position.distanceTo(controls.target), 10 * Math.exp(.02 - .2));
});
