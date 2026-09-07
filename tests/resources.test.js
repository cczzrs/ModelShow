import test from 'node:test';
import assert from 'node:assert/strict';
import { Group, Sprite, SpriteMaterial, Texture, Mesh, BoxGeometry, MeshBasicMaterial } from 'three/webgpu';
import { disposeGroup } from '../src/resources.js';

test('clearing model or animation sprites preserves the geometry shared with live and future labels', () => {
  const live = new Sprite(), old = new Sprite(), group = new Group();
  group.add(old);
  assert.equal(old.geometry, live.geometry);
  let disposals = 0;
  const onDispose = () => disposals++;
  live.geometry.addEventListener('dispose', onDispose);
  try {
    disposeGroup(group);
    const next = new Sprite();
    assert.equal(next.geometry, live.geometry);
    assert.equal(disposals, 0, 'must not destroy buffers shared with the rest of the scene');
    assert.equal(group.children.length, 0);
    next.material.dispose();
  } finally {
    live.geometry.removeEventListener('dispose', onDispose);
    live.material.dispose();
  }
});

test('owned resources are released once even when reused inside the disposed group', () => {
  const texture = new Texture(), material = new SpriteMaterial({map: texture});
  const geometry = new BoxGeometry(), meshMaterial = new MeshBasicMaterial();
  const group = new Group();
  group.add(new Sprite(material), new Sprite(material), new Mesh(geometry,meshMaterial), new Mesh(geometry,meshMaterial));
  const counts = [0,0,0,0];
  [texture,material,geometry,meshMaterial].forEach((r,i)=>r.addEventListener('dispose',()=>counts[i]++));
  disposeGroup(group);
  assert.deepEqual(counts,[1,1,1,1]);
});
