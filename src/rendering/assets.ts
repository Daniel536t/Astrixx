import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export interface AssetCatalog {
  createTree(variant: number): THREE.Group;
  createWorker(variant?: number): THREE.Group;
  createSettlement(): THREE.Group;
  createHouse(): THREE.Group;
  createCabin(): THREE.Group;
  createCottage(): THREE.Group;
  createWell(): THREE.Group;
  createFarm(): THREE.Group;
  createVillager(variant: number): THREE.Group;
  createLog(): THREE.Group;
  createWater(): THREE.Group;
  createBerryPatch(): THREE.Group;
  createFood(): THREE.Group;
  createBranch(): THREE.Group;
  createStone(): THREE.Group;
  createPond(): THREE.Group;
  createShelter(): THREE.Group;
  createAnimal(variant?: number): THREE.Group;
}

function timberMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: '#76523d', roughness: 1 });
}

export class ProceduralAssetCatalog implements AssetCatalog {
  private readonly bark = new THREE.MeshStandardMaterial({ color: '#735641', roughness: 1 });
  private readonly foliage = ['#48785a', '#5d8961', '#748d5b'].map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.96, flatShading: true }));
  private readonly pine = new THREE.MeshStandardMaterial({ color: '#426c5a', roughness: 1, flatShading: true });
  private readonly rootMaterial = new THREE.MeshStandardMaterial({ color: '#80634a', roughness: 1 });
  private readonly trunkGeometry = new THREE.CylinderGeometry(0.22, 0.3, 1.7, 7);
  private readonly rootGeometry = new THREE.CylinderGeometry(0.05, 0.14, 0.9, 5);
  private readonly canopyGeometry = new THREE.IcosahedronGeometry(1.0, 1);
  private readonly pineGeometry = new THREE.ConeGeometry(0.95, 2.1, 7);
  private readonly logGeometry = new THREE.CylinderGeometry(0.13, 0.13, 0.8, 8);

  createTree(variant: number): THREE.Group {
    const group = new THREE.Group();
    const trunk = new THREE.Mesh(this.trunkGeometry, this.bark);
    trunk.position.y = 0.85;
    trunk.userData['part'] = 'trunk';
    trunk.castShadow = true;
    group.add(trunk);
    for (let rootIndex = 0; rootIndex < 4; rootIndex += 1) {
      const root = new THREE.Mesh(this.rootGeometry, this.rootMaterial);
      const angle = rootIndex * Math.PI / 2 + variant * 0.37;
      root.position.set(Math.cos(angle) * 0.34, 0.12, Math.sin(angle) * 0.34);
      root.rotation.z = Math.cos(angle) * 0.9;
      root.rotation.x = Math.sin(angle) * 0.9;
      root.scale.set(0.72, 1, 0.72);
      root.userData['part'] = 'root';
      root.castShadow = true;
      group.add(root);
    }
    if (variant % 3 === 2) {
      for (let tier = 0; tier < 3; tier += 1) {
        const foliage = new THREE.Mesh(this.pineGeometry, this.pine);
        foliage.position.y = 1.55 + tier * 0.52;
        foliage.userData['part'] = 'canopy';
        foliage.userData['originalScale'] = foliage.scale.clone();
        foliage.scale.set(0.98 - tier * 0.17, 0.9, 0.98 - tier * 0.17);
        foliage.castShadow = true;
        group.add(foliage);
      }
    } else {
      const crown = new THREE.Mesh(this.canopyGeometry, this.foliage[variant % this.foliage.length]);
      crown.position.set(0, 1.82, 0);
      crown.userData['part'] = 'canopy';
      crown.userData['originalScale'] = crown.scale.clone();
      crown.scale.set(1.13, 1.22, 1.05);
      crown.castShadow = true;
      group.add(crown);
      const crownlet = new THREE.Mesh(this.canopyGeometry, this.foliage[(variant + 1) % this.foliage.length]);
      crownlet.position.set(0.25, 2.22, -0.12);
      crownlet.userData['part'] = 'canopy';
      crownlet.userData['originalScale'] = crownlet.scale.clone();
      crownlet.userData['secondaryCanopy'] = true;
      crownlet.scale.set(0.69, 0.71, 0.67);
      crownlet.castShadow = true;
      group.add(crownlet);
      const shoulder = new THREE.Mesh(this.canopyGeometry, this.foliage[(variant + 2) % this.foliage.length]);
      shoulder.position.set(-0.43, 1.66, 0.18);
      shoulder.userData['part'] = 'canopy';
      shoulder.userData['originalScale'] = shoulder.scale.clone();
      shoulder.userData['secondaryCanopy'] = true;
      shoulder.scale.set(0.68, 0.74, 0.7);
      shoulder.castShadow = true;
      group.add(shoulder);
    }
    return group;
  }

  createWorker(variant = 0): THREE.Group {
    const group = new THREE.Group();
    // Tunic tint per worker so the crew reads as individuals. Purely
    // presentational: derived from the variant, never from game state.
    const tunics = ['#d47c48', '#7a8a4d', '#5d7a8a', '#a86a7a'];
    const cloth = new THREE.MeshStandardMaterial({ color: tunics[variant % tunics.length], roughness: 0.9 });
    cloth.userData['part'] = 'tunic';
    const trousers = new THREE.MeshStandardMaterial({ color: '#495e59', roughness: 1 });
    const skin = new THREE.MeshStandardMaterial({ color: '#efc49c', roughness: 0.9 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.38, 3, 6), cloth);
    body.position.y = 0.54;
    body.castShadow = true;
    group.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), skin);
    head.position.y = 0.91;
    head.castShadow = true;
    group.add(head);
    const arm = new THREE.Group();
    arm.position.set(0.19, 0.67, 0);
    arm.userData['part'] = 'axe-arm';
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.34, 6), cloth);
    sleeve.position.y = -0.13;
    sleeve.rotation.z = -0.28;
    arm.add(sleeve);
    const axeHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.028, 0.38, 5), timberMaterial());
    axeHandle.position.set(0.02, -0.31, 0);
    axeHandle.rotation.z = -0.28;
    arm.add(axeHandle);
    const axeHead = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.14, 0.075), new THREE.MeshStandardMaterial({ color: '#aeb1a0', metalness: 0.35, roughness: 0.7 }));
    axeHead.position.set(0.07, -0.48, 0);
    axeHead.rotation.z = -0.24;
    axeHead.userData['part'] = 'axe-head';
    arm.add(axeHead);
    group.add(arm);
    const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.1, 8), new THREE.MeshStandardMaterial({ color: '#cfaa71', roughness: 1 }));
    hat.position.y = 1.04;
    group.add(hat);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.045, 10), new THREE.MeshStandardMaterial({ color: '#b99560', roughness: 1 }));
    brim.position.y = 1.005;
    group.add(brim);
    const packMaterial = new THREE.MeshStandardMaterial({ color: '#8b6447', roughness: 1 });
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.31, 0.17), packMaterial);
    pack.position.set(-0.18, 0.57, -0.03);
    pack.castShadow = true;
    group.add(pack);
    const bedroll = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.28, 7), new THREE.MeshStandardMaterial({ color: '#c4a876', roughness: 1 }));
    bedroll.rotation.z = Math.PI / 2;
    bedroll.position.set(-0.2, 0.78, -0.035);
    group.add(bedroll);
    const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.34, 6), trousers);
    legs.userData['part'] = 'legs';
    legs.position.set(0, 0.17, 0);
    group.add(legs);
    const bootMaterial = new THREE.MeshStandardMaterial({ color: '#4b4037', roughness: 1 });
    for (const side of [-1, 1]) {
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.08, 0.2), bootMaterial);
      boot.position.set(side * 0.07, 0.055, 0.045);
      group.add(boot);
    }
    return group;
  }

  /**
   * Wilderness camp anchor: a modest fire ring, bedroll, and supply crate —
   * deliberately NOT a cabin. The settlement entity remains the authoritative
   * delivery/build anchor until Phase 4 replaces it with inventory storage,
   * but it must read as one inhabitant's camp, never as a prebuilt village.
   */
  createSettlement(): THREE.Group {
    const group = new THREE.Group();
    const timber = new THREE.MeshStandardMaterial({ color: '#76523d', roughness: 1 });
    const stone = new THREE.MeshStandardMaterial({ color: '#8d8f94', roughness: 1, flatShading: true });
    // Trampled ground cloth.
    const cloth = new THREE.Mesh(new THREE.CircleGeometry(1.5, 14), new THREE.MeshStandardMaterial({ color: '#c9b992', roughness: 1 }));
    cloth.rotation.x = -Math.PI / 2;
    cloth.position.y = 0.02;
    cloth.receiveShadow = true;
    group.add(cloth);
    // Stone fire ring + logs + ember glow.
    for (let i = 0; i < 8; i += 1) {
      const angle = (i / 8) * Math.PI * 2;
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.13, 0), stone);
      rock.position.set(Math.cos(angle) * 0.42, 0.09, Math.sin(angle) * 0.42);
      rock.castShadow = true;
      group.add(rock);
    }
    for (const tilt of [-0.5, 0.5]) {
      const log = new THREE.Mesh(this.logGeometry, timber);
      log.rotation.z = Math.PI / 2;
      log.rotation.y = tilt;
      log.position.y = 0.12;
      log.scale.setScalar(0.55);
      log.castShadow = true;
      group.add(log);
    }
    const ember = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 8, 6),
      new THREE.MeshStandardMaterial({ color: '#d98a3d', emissive: '#a33d12', emissiveIntensity: 0.9, roughness: 0.6 }),
    );
    ember.position.y = 0.2;
    ember.userData['part'] = 'camp-ember';
    group.add(ember);
    // Bedroll.
    const bedroll = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.7, 3, 8), new THREE.MeshStandardMaterial({ color: '#5d6b5a', roughness: 1 }));
    bedroll.rotation.z = Math.PI / 2;
    bedroll.rotation.y = 0.5;
    bedroll.position.set(-1.0, 0.2, 0.5);
    bedroll.castShadow = true;
    group.add(bedroll);
    // Supply crate + waterskin post.
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.5), timber);
    crate.position.set(1.0, 0.2, -0.5);
    crate.castShadow = true;
    group.add(crate);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.0, 6), timber);
    post.position.set(1.0, 0.5, 0.35);
    post.castShadow = true;
    group.add(post);
    return group;
  }

  /**
   * Wilderness shelter: a small lean-to, visually distinct from the camp and
   * the cabin/house. Three stage groups (frame → roof → body) toggle from
   * authoritative progress in WorldRenderer.sync — never on their own.
   */
  createShelter(): THREE.Group {
    const group = new THREE.Group();
    const timber = new THREE.MeshStandardMaterial({ color: '#6e4f36', roughness: 1 });
    const canvas = new THREE.MeshStandardMaterial({ color: '#a8936b', roughness: 1, side: THREE.DoubleSide });
    const bedding = new THREE.MeshStandardMaterial({ color: '#5d6b5a', roughness: 1 });
    const frame = new THREE.Group();
    frame.userData['part'] = 'shelter-frame';
    for (const x of [-0.9, 0.9]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 1.5, 6), timber);
      post.position.set(x, 0.75, -0.5);
      post.castShadow = true;
      frame.add(post);
    }
    const ridge = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.1, 6), timber);
    ridge.rotation.z = Math.PI / 2;
    ridge.position.set(0, 1.48, -0.5);
    ridge.castShadow = true;
    frame.add(ridge);
    group.add(frame);
    const roof = new THREE.Group();
    roof.userData['part'] = 'shelter-roof';
    const cover = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.08, 1.7), canvas);
    cover.position.set(0, 1.1, 0.15);
    cover.rotation.x = 0.5;
    cover.castShadow = true;
    roof.add(cover);
    group.add(roof);
    const body = new THREE.Group();
    body.userData['part'] = 'shelter-body';
    const bedroll = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.7, 3, 8), bedding);
    bedroll.rotation.z = Math.PI / 2;
    bedroll.position.set(0, 0.2, 0.35);
    bedroll.castShadow = true;
    body.add(bedroll);
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.36, 0.42), timber);
    crate.position.set(-0.75, 0.18, 0.45);
    crate.castShadow = true;
    body.add(crate);
    group.add(body);
    return group;
  }

  /**
   * Timber cabin: taller and narrower than the homestead, steep gable,
   * dark timber, stone chimney. Same house-frame/house-body parts so
   * construction staging reuses the authoritative progress sync.
   */
  createCabin(): THREE.Group {
    const group = new THREE.Group();
    const timber = new THREE.MeshStandardMaterial({ color: '#5d4128', roughness: 1 });
    const stone = new THREE.MeshStandardMaterial({ color: '#8d8f94', roughness: 1, flatShading: true });
    const frame = new THREE.Group();
    frame.userData['part'] = 'house-frame';
    for (const [x, z] of [[-0.7, -0.55], [0.7, -0.55], [-0.7, 0.55], [0.7, 0.55]] as const) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 1.7, 6), timber);
      post.position.set(x, 0.85, z);
      post.castShadow = true;
      frame.add(post);
    }
    group.add(frame);
    const body = new THREE.Group();
    body.userData['part'] = 'house-body';
    const walls = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.7, 1.25), timber);
    walls.position.y = 0.95;
    walls.castShadow = true;
    walls.receiveShadow = true;
    body.add(walls);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.25, 1.3, 4), new THREE.MeshStandardMaterial({ color: '#6e3f30', roughness: 1, flatShading: true }));
    roof.position.y = 2.45;
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1.05, 1, 0.82);
    roof.castShadow = true;
    body.add(roof);
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.1, 0.3), stone);
    chimney.position.set(0.45, 2.3, -0.25);
    chimney.castShadow = true;
    body.add(chimney);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.85, 0.08), new THREE.MeshStandardMaterial({ color: '#3d2c1c', roughness: 1 }));
    door.position.set(0, 0.5, 0.65);
    body.add(door);
    group.add(body);
    return group;
  }

  /**
   * Thatched cottage: wide and low with a pale thatch roof and shutters.
   * Unmistakable next to the cabin at any distance.
   */
  createCottage(): THREE.Group {
    const group = new THREE.Group();
    const plaster = new THREE.MeshStandardMaterial({ color: '#e6d3a8', roughness: 1 });
    const thatch = new THREE.MeshStandardMaterial({ color: '#c8a95e', roughness: 1, flatShading: true });
    const timber = new THREE.MeshStandardMaterial({ color: '#76523d', roughness: 1 });
    const frame = new THREE.Group();
    frame.userData['part'] = 'house-frame';
    for (const [x, z] of [[-1.0, -0.7], [1.0, -0.7], [-1.0, 0.7], [1.0, 0.7]] as const) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.85, 6), timber);
      post.position.set(x, 0.43, z);
      post.castShadow = true;
      frame.add(post);
    }
    group.add(frame);
    const body = new THREE.Group();
    body.userData['part'] = 'house-body';
    const walls = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.85, 1.55), plaster);
    walls.position.y = 0.55;
    walls.castShadow = true;
    walls.receiveShadow = true;
    body.add(walls);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.7, 0.85, 4), thatch);
    roof.position.y = 1.4;
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1.15, 1, 0.9);
    roof.castShadow = true;
    body.add(roof);
    for (const x of [-0.62, 0.62]) {
      const shutter = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.34, 0.06), timber);
      shutter.position.set(x, 0.62, 0.8);
      body.add(shutter);
    }
    group.add(body);
    return group;
  }

  createHouse(): THREE.Group {
    const group = new THREE.Group();
    const plaster = new THREE.MeshStandardMaterial({ color: '#e2cfae', roughness: 1 });
    const roofMaterial = new THREE.MeshStandardMaterial({ color: '#8a5a44', roughness: 1, flatShading: true });
    const timber = new THREE.MeshStandardMaterial({ color: '#76523d', roughness: 1 });
    const stone = new THREE.MeshStandardMaterial({ color: '#9a917f', roughness: 1 });
    // Construction frame: visible while the house is under construction.
    const frame = new THREE.Group();
    frame.userData['part'] = 'house-frame';
    for (const [x, z] of [[-0.8, -0.62], [0.8, -0.62], [-0.8, 0.62], [0.8, 0.62]] as const) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.15, 6), timber);
      post.position.set(x, 0.58, z);
      post.castShadow = true;
      frame.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.1, 0.1), timber);
    beam.position.set(0, 1.12, 0.62);
    frame.add(beam);
    group.add(frame);
    // Finished body: hidden until authoritative state says complete.
    const body = new THREE.Group();
    body.userData['part'] = 'house-body';
    const foundation = new THREE.Mesh(new THREE.BoxGeometry(1.94, 0.2, 1.6), stone);
    foundation.position.y = 0.1;
    foundation.receiveShadow = true;
    body.add(foundation);
    const walls = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.0, 1.35), plaster);
    walls.position.y = 0.7;
    walls.castShadow = true;
    walls.receiveShadow = true;
    body.add(walls);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.32, 1.0, 4), roofMaterial);
    roof.position.y = 1.68;
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1.02, 1, 0.84);
    roof.castShadow = true;
    body.add(roof);
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.85, 0.28), timber);
    chimney.position.set(0.62, 1.75, -0.3);
    chimney.castShadow = true;
    body.add(chimney);
    const chimneyCap = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.1, 0.38), stone);
    chimneyCap.position.set(0.62, 2.2, -0.3);
    body.add(chimneyCap);
    const windowGlass = new THREE.MeshStandardMaterial({ color: '#c69258', roughness: 0.55, emissive: '#4b3019', emissiveIntensity: 0.12 });
    const window = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.36, 0.06), windowGlass);
    window.position.set(-0.42, 0.82, 0.69);
    body.add(window);
    const crossbar = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.06, 0.08), timber);
    crossbar.position.set(-0.42, 0.82, 0.72);
    body.add(crossbar);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.64, 0.07), timber);
    door.position.set(0.3, 0.5, 0.69);
    body.add(door);
    const step = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.24), stone);
    step.position.set(0.3, 0.14, 0.82);
    body.add(step);
    group.add(body);
    return group;
  }

  createWell(): THREE.Group {
    const group = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ color: '#9a917f', roughness: 1, flatShading: true });
    const timber = timberMaterial();
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.7, 0.55, 10), stone);
    ring.position.y = 0.28;
    ring.castShadow = true;
    ring.receiveShadow = true;
    group.add(ring);
    const water = new THREE.Mesh(new THREE.CircleGeometry(0.5, 16), new THREE.MeshStandardMaterial({ color: '#4f7d86', roughness: 0.25 }));
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.46;
    group.add(water);
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.25, 6), timber);
      post.position.set(side * 0.55, 0.9, 0);
      post.castShadow = true;
      group.add(post);
    }
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.2, 6), timber);
    axle.rotation.z = Math.PI / 2;
    axle.position.y = 1.42;
    group.add(axle);
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.55, 4), timber);
    rope.position.set(0.2, 1.12, 0);
    group.add(rope);
    const bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.09, 0.2, 7), timber);
    bucket.position.set(0.2, 0.8, 0);
    bucket.castShadow = true;
    group.add(bucket);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.85, 0.55, 4), new THREE.MeshStandardMaterial({ color: '#8a5a44', roughness: 1, flatShading: true }));
    roof.position.y = 1.85;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    group.add(roof);
    return group;
  }

  createFarm(): THREE.Group {
    const group = new THREE.Group();
    const soil = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.16, 1.4), new THREE.MeshStandardMaterial({ color: '#6b5138', roughness: 1 }));
    soil.position.y = 0.08;
    soil.receiveShadow = true;
    group.add(soil);
    const crops = new THREE.Group();
    crops.userData['part'] = 'farm-crops';
    const sprout = new THREE.MeshStandardMaterial({ color: '#5d8a52', roughness: 0.9, flatShading: true });
    const ripe = new THREE.MeshStandardMaterial({ color: '#c9a44a', roughness: 0.9, flatShading: true });
    const sproutGeometry = new THREE.ConeGeometry(0.14, 0.5, 6);
    for (let row = 0; row < 2; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        const plant = new THREE.Mesh(sproutGeometry, sprout.clone());
        plant.position.set(-0.6 + col * 0.6, 0.3, -0.33 + row * 0.66);
        plant.userData['part'] = 'farm-plant';
        plant.castShadow = true;
        crops.add(plant);
      }
    }
    crops.userData['ripeMaterial'] = ripe;
    group.add(crops);
    return group;
  }

  createVillager(variant: number): THREE.Group {
    const group = new THREE.Group();
    const cloth = new THREE.MeshStandardMaterial({ color: variant % 2 === 0 ? '#7d8b6f' : '#a08c5b', roughness: 1 });
    const skin = new THREE.MeshStandardMaterial({ color: '#eec39a', roughness: 0.9 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.3, 3, 6), cloth);
    body.position.y = 0.44;
    body.castShadow = true;
    body.userData['part'] = 'villager-body';
    group.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), skin);
    head.position.y = 0.76;
    head.castShadow = true;
    group.add(head);
    return group;
  }

  createBerryPatch(): THREE.Group {
    const group = new THREE.Group();
    const leaves = new THREE.MeshStandardMaterial({ color: '#4e7550', roughness: 1, flatShading: true });
    const twig = new THREE.MeshStandardMaterial({ color: '#786148', roughness: 1 });
    const berry = new THREE.MeshStandardMaterial({ color: '#9e4650', roughness: 0.75 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.76, 0.88, 0.12, 10), new THREE.MeshStandardMaterial({ color: '#aa9a6c', roughness: 1 }));
    base.position.y = 0.07;
    base.userData['part'] = 'patch-base';
    group.add(base);
    for (let index = 0; index < 5; index += 1) {
      const angle = index * Math.PI * 0.4;
      const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.38 + (index % 2) * 0.06, 1), leaves);
      bush.position.set(Math.cos(angle) * 0.42, 0.47 + (index % 2) * 0.08, Math.sin(angle) * 0.42);
      bush.scale.set(1, 0.88, 0.96);
      bush.castShadow = true;
      bush.userData['part'] = 'patch-leaves';
      group.add(bush);
      for (let fruit = 0; fruit < 3; fruit += 1) {
        const berryMesh = new THREE.Mesh(new THREE.SphereGeometry(0.075, 7, 6), berry);
        berryMesh.position.set(Math.cos(angle + fruit * 2.1) * 0.19 + Math.cos(angle) * 0.4, 0.56 + (fruit % 2) * 0.1, Math.sin(angle + fruit * 2.1) * 0.19 + Math.sin(angle) * 0.4);
        berryMesh.castShadow = true;
        berryMesh.userData['part'] = 'patch-fruit';
        group.add(berryMesh);
      }
    }
    const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.8, 5), twig);
    marker.position.set(0.94, 0.4, 0.5);
    marker.rotation.z = -0.16;
    group.add(marker);
    return group;
  }

  createFood(): THREE.Group {
    const group = new THREE.Group();
    const basket = new THREE.MeshStandardMaterial({ color: '#ab8254', roughness: 1 });
    const berry = new THREE.MeshStandardMaterial({ color: '#9e4650', roughness: 0.75 });
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.23, 0.28, 8, 1, true), basket);
    bowl.position.y = 0.3;
    bowl.castShadow = true;
    group.add(bowl);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.045, 5, 10), basket);
    rim.position.y = 0.44;
    rim.rotation.x = Math.PI / 2;
    group.add(rim);
    for (let index = 0; index < 7; index += 1) {
      const angle = index * 2.4;
      const fruit = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 7), berry);
      fruit.position.set(Math.cos(angle) * 0.19, 0.49 + (index % 2) * 0.08, Math.sin(angle) * 0.19);
      fruit.castShadow = true;
      group.add(fruit);
    }
    return group;
  }

  createLog(): THREE.Group {
    const group = new THREE.Group();
    const log = new THREE.Mesh(this.logGeometry, this.bark);
    log.rotation.z = Math.PI / 2;
    log.position.y = 0.16;
    log.castShadow = true;
    group.add(log);
    const end = new THREE.Mesh(new THREE.CircleGeometry(0.13, 8), new THREE.MeshStandardMaterial({ color: '#b28761', roughness: 1 }));
    end.position.set(0.405, 0.16, 0);
    end.rotation.y = Math.PI / 2;
    group.add(end);
    return group;
  }

  /** Filled waterskin: the carried/delivered form of drawn water. */
  createWater(): THREE.Group {
    const group = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: '#7d6a55', roughness: 0.95 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 7), skin);
    body.position.y = 0.2;
    body.scale.set(1, 0.85, 0.8);
    body.castShadow = true;
    group.add(body);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.16, 6), skin);
    neck.position.y = 0.4;
    group.add(neck);
    const stopper = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), timberMaterial());
    stopper.position.y = 0.5;
    group.add(stopper);
    return group;
  }

  /** Fallen branch: two crossed sticks. Hidden once collected. */
  createBranch(): THREE.Group {
    const group = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: '#7a5a3e', roughness: 1 });
    const twig = new THREE.MeshStandardMaterial({ color: '#5d6b3f', roughness: 1 });
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.9, 6), wood);
    stick.rotation.z = Math.PI / 2;
    stick.rotation.y = 0.4;
    stick.position.y = 0.08;
    stick.castShadow = true;
    group.add(stick);
    const offshoot = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.5, 5), twig);
    offshoot.rotation.z = Math.PI / 2;
    offshoot.rotation.y = -0.5;
    offshoot.position.set(0.1, 0.14, 0.12);
    offshoot.castShadow = true;
    group.add(offshoot);
    return group;
  }

  /** Loose stone: low-poly rock cluster. Hidden once collected. */
  createStone(): THREE.Group {
    const group = new THREE.Group();
    const rock = new THREE.MeshStandardMaterial({ color: '#8d8f94', roughness: 1, flatShading: true });
    const main = new THREE.Mesh(new THREE.DodecahedronGeometry(0.26, 0), rock);
    main.position.y = 0.2;
    main.castShadow = true;
    group.add(main);
    const small = new THREE.Mesh(new THREE.DodecahedronGeometry(0.14, 0), rock);
    small.position.set(0.28, 0.1, 0.1);
    small.castShadow = true;
    group.add(small);
    return group;
  }

  /** Pond: shallow disc with reeds. Static natural water source. */
  createPond(): THREE.Group {
    const group = new THREE.Group();
    const bed = new THREE.Mesh(
      new THREE.CircleGeometry(1.5, 24),
      new THREE.MeshStandardMaterial({ color: '#3d5a4c', roughness: 1 }),
    );
    bed.rotation.x = -Math.PI / 2;
    bed.position.y = 0.02;
    group.add(bed);
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(1.32, 24),
      new THREE.MeshStandardMaterial({ color: '#4f86a8', roughness: 0.35, transparent: true, opacity: 0.85 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.06;
    water.userData['part'] = 'pond-water';
    group.add(water);
    const reed = new THREE.MeshStandardMaterial({ color: '#4f7048', roughness: 1 });
    for (let i = 0; i < 5; i += 1) {
      const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.7, 5), reed);
      const angle = (i / 5) * Math.PI * 2;
      stalk.position.set(Math.cos(angle) * 1.45, 0.35, Math.sin(angle) * 1.45);
      group.add(stalk);
    }
    return group;
  }

  /** Wild deer: body + head + legs, distinguishable from props. */
  createAnimal(variant = 0): THREE.Group {
    const group = new THREE.Group();
    const coat = new THREE.MeshStandardMaterial({ color: variant % 2 === 0 ? '#9a7350' : '#7d8a6a', roughness: 1 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.55, 3, 8), coat);
    body.rotation.z = Math.PI / 2;
    body.position.y = 0.62;
    body.castShadow = true;
    group.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 7), coat);
    head.position.set(0.48, 0.95, 0);
    head.castShadow = true;
    group.add(head);
    for (const [lx, lz] of [[0.22, 0.14], [0.22, -0.14], [-0.22, 0.14], [-0.22, -0.14]] as const) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.55, 5), coat);
      leg.position.set(lx, 0.28, lz);
      group.add(leg);
    }
    return group;
  }
}

export class GlbNatureAssetCatalog extends ProceduralAssetCatalog {
  private readonly loader = new GLTFLoader();
  private readonly cache = new Map<string, Promise<THREE.Group>>();
  private readonly paths = ['/assets/kenney-broadleaf.glb', '/assets/kenney-oak.glb', '/assets/kenney-pine.glb'];
  private readonly stumpPath = '/assets/kenney-stump.glb';

  override createTree(variant: number): THREE.Group {
    const group = new THREE.Group();
    group.userData['treeDepleted'] = false;
    const model = new THREE.Group();
    model.userData['part'] = 'tree-model';
    model.visible = false;
    group.add(model);
    const fallback = super.createTree(variant);
    fallback.userData['part'] = 'tree-fallback';
    group.add(fallback);
    const stump = new THREE.Group();
    stump.userData['part'] = 'tree-stump';
    stump.visible = false;
    group.add(stump);

    const path = this.paths[Math.abs(variant) % this.paths.length]!;
    void this.load(path, 2.2).then((tree) => {
      model.add(tree);
      const depleted = Boolean(group.userData['treeDepleted']);
      model.visible = !depleted;
      fallback.visible = false;
      const stump = group.children.find((child) => child.userData['part'] === 'tree-stump');
      if (stump) stump.visible = depleted && stump.children.length > 0;
    }).catch(() => {
      fallback.visible = true;
    });
    void this.load(this.stumpPath, 0.5).then((tree) => {
      stump.add(tree);
      stump.visible = Boolean(group.userData['treeDepleted']);
    }).catch(() => {});
    return group;
  }

  private load(path: string, height: number): Promise<THREE.Group> {
    const cacheKey = `${path}:${height}`;
    let pending = this.cache.get(cacheKey);
    if (!pending) {
      pending = this.loader.loadAsync(path).then(({ scene }) => {
        const model = scene.clone(true);
        model.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(model);
        const size = bounds.getSize(new THREE.Vector3());
        model.scale.setScalar(height / Math.max(size.y, 0.001));
        model.updateMatrixWorld(true);
        const scaledBounds = new THREE.Box3().setFromObject(model);
        model.position.y -= scaledBounds.min.y;
        model.traverse((node) => {
          if (!(node instanceof THREE.Mesh)) return;
          node.castShadow = true;
          node.receiveShadow = true;
          node.material = Array.isArray(node.material) ? node.material.map((material) => material.clone()) : node.material.clone();
          for (const material of (Array.isArray(node.material) ? node.material : [node.material])) {
            if (!(material instanceof THREE.MeshStandardMaterial)) continue;
            material.roughness = 0.94;
            material.metalness = 0;
            if (/leaf/i.test(material.name)) material.color.set('#75966b');
            else if (/bark|wood/i.test(material.name)) material.color.set('#79583f');
          }
        });
        return model;
      });
      this.cache.set(cacheKey, pending);
    }
    return pending.then((model) => model.clone(true));
  }
}
