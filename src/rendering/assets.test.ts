/**
 * Blueprint assets stay distinct: one registry key, one silhouette. These
 * are geometric facts (bounding boxes, part names), not taste judgments —
 * the browser screenshots prove the look, these tests pin the difference.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ProceduralAssetCatalog } from './assets';

function bounds(group: THREE.Group): { x: number; y: number; z: number } {
  const box = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  box.getSize(size);
  return { x: size.x, y: size.y, z: size.z };
}

function partNames(group: THREE.Group): string[] {
  const names: string[] = [];
  group.traverse((part) => {
    const name = part.userData['part'];
    if (typeof name === 'string') names.push(name);
  });
  return [...new Set(names)].sort();
}

describe('blueprint assets', () => {
  it('cabin stands taller and narrower than the cottage', () => {
    const catalog = new ProceduralAssetCatalog();
    const cabin = bounds(catalog.createCabin());
    const cottage = bounds(catalog.createCottage());
    const house = bounds(catalog.createHouse());
    expect(cabin.y).toBeGreaterThan(cottage.y);
    expect(cottage.x).toBeGreaterThan(cabin.x);
    // All three differ in overall volume: no shared-silent model.
    const volumes = [cabin, cottage, house].map((b) => b.x * b.y * b.z);
    expect(new Set(volumes.map((v) => v.toFixed(2))).size).toBe(3);
  });

  it('all residential designs expose staged construction parts', () => {
    const catalog = new ProceduralAssetCatalog();
    for (const group of [catalog.createHouse(), catalog.createCabin(), catalog.createCottage()]) {
      const parts = partNames(group);
      expect(parts).toContain('house-frame');
      expect(parts).toContain('house-body');
    }
  });

  it('the shelter stages expose frame, roof, and body separately', () => {
    const catalog = new ProceduralAssetCatalog();
    expect(partNames(catalog.createShelter())).toEqual(['shelter-body', 'shelter-frame', 'shelter-roof']);
  });
});
