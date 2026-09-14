/** Release only resources owned by this group, not Three.js global Sprite geometry. */
export function disposeGroup(group) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  group.traverse(obj => {
    // All THREE.Sprite instances (including future ones) share a single geometry.
    if (obj.geometry && !obj.isSprite) geometries.add(obj.geometry);
    for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) {
      if (!material) continue;
      materials.add(material);
      if (material.map) textures.add(material.map);
    }
  });
  group.clear();
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}
