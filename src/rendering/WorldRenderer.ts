import * as THREE from 'three';
import type { WorldState } from '../world/types';
import { FARM_SLOTS } from '../world/types';
import type { AssetCatalog } from './assets';
import { GlbNatureAssetCatalog } from './assets';

/** Fixed village dressing coordinates (presentation-only; no gameplay). */
const POND_POSITION = { x: 6.0, z: -4.2 };
const POND_RADIUS = 1.5;
const ROCK_SPOTS: Array<{ x: number; z: number; scale: number }> = [
  { x: -4.6, z: 1.6, scale: 0.9 },
  { x: 3.2, z: 3.4, scale: 1.2 },
  { x: -0.8, z: -4.2, scale: 0.8 },
  { x: 2.2, z: -3.4, scale: 1.0 },
  { x: -5.2, z: -1.2, scale: 0.7 },
];

export class WorldRenderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-12, 12, 8, -8, 0.1, 100);
  readonly renderer: THREE.WebGLRenderer;
  private readonly entityViews = new Map<string, THREE.Group>();
  private readonly farmFences = new Map<number, THREE.Group>();
  private readonly treeShadows = new Map<string, THREE.Mesh>();
  private readonly treeAssetParts = new Map<string, { model: THREE.Group; fallback: THREE.Group; stump: THREE.Group }>();
  private readonly targetMarker: THREE.Mesh;
  private readonly worldRoot = new THREE.Group();
  private readonly workerBadges = new Map<string, { sprite: THREE.Sprite; texture: THREE.CanvasTexture; label: string }>();
  private readonly smokePuffs = new Map<string, THREE.Sprite>();
  private smokeTexture: THREE.CanvasTexture | null = null;
  private pondWater: THREE.MeshStandardMaterial | null = null;
  private cameraYaw = Math.atan2(13, 16);
  private cameraPitch = Math.asin(16 / Math.hypot(13, 16, 16));
  private cameraDistance = Math.hypot(13, 16, 16);
  private dragPoint: { x: number; y: number } | null = null;
  private readonly assetCatalog: AssetCatalog;
  private readonly resizeObserver: ResizeObserver;
  private frame = 0;
  private lastFrameAt = 0;

  constructor(private readonly canvas: HTMLCanvasElement, assets: AssetCatalog = new GlbNatureAssetCatalog()) {
    this.assetCatalog = assets;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.scene.background = new THREE.Color('#cfdfd1');
    this.scene.fog = new THREE.Fog('#cfdfd1', 31, 64);
    this.scene.add(this.worldRoot);
    this.camera.position.set(13, 16, 16);
    this.camera.lookAt(0, 0, 0);
    this.camera.zoom = 1.04;
    this.camera.updateProjectionMatrix();
    this.buildEnvironment();
    this.targetMarker = new THREE.Mesh(new THREE.RingGeometry(0.76, 0.9, 32), new THREE.MeshBasicMaterial({ color: '#d29a56', transparent: true, opacity: 0.82, side: THREE.DoubleSide, depthWrite: false }));
    this.targetMarker.rotation.x = -Math.PI / 2;
    this.targetMarker.position.y = 0.035;
    this.targetMarker.visible = false;
    this.targetMarker.renderOrder = 1;
    this.worldRoot.add(this.targetMarker);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.bindCameraControls();
    this.resize();
    this.animate();
  }

  private buildEnvironment(): void {
    const hemi = new THREE.HemisphereLight('#f5f4df', '#82977a', 2.15);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight('#fff1d0', 3.0);
    sun.position.set(-8, 15, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -13;
    sun.shadow.camera.right = 13;
    sun.shadow.camera.top = 13;
    sun.shadow.camera.bottom = -13;
    sun.shadow.bias = -0.00035;
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight('#d8e6ce', 0.55);
    fill.position.set(9, 8, -7);
    this.scene.add(fill);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(70, 70, 84, 84), new THREE.MeshStandardMaterial({ color: '#91a879', roughness: 1, map: this.makeGroundTexture() }));
    this.shapeGround(ground.geometry as THREE.PlaneGeometry);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.035;
    ground.receiveShadow = true;
    this.worldRoot.add(ground);

    const clearing = new THREE.Mesh(new THREE.ShapeGeometry(this.createClearingShape(0)), new THREE.MeshStandardMaterial({ color: '#c7bf94', roughness: 1 }));
    clearing.rotation.x = -Math.PI / 2;
    clearing.position.y = -0.005;
    clearing.receiveShadow = true;
    this.worldRoot.add(clearing);

    const clearingLip = new THREE.Mesh(new THREE.ShapeGeometry(this.createClearingShape(0.34, true)), new THREE.MeshStandardMaterial({ color: '#7e9b70', roughness: 1, flatShading: true }));
    clearingLip.rotation.x = -Math.PI / 2;
    clearingLip.position.y = 0.015;
    this.worldRoot.add(clearingLip);

    const pathMaterial = new THREE.MeshStandardMaterial({ color: '#b9ad7e', roughness: 1 });
    const footpath = new THREE.Mesh(new THREE.ShapeGeometry(this.createWindingPath()), pathMaterial);
    footpath.rotation.x = -Math.PI / 2;
    footpath.position.y = 0.018;
    footpath.receiveShadow = true;
    this.worldRoot.add(footpath);

    const dirtScuffs = new THREE.MeshStandardMaterial({ color: '#a99d73', roughness: 1 });
    for (let index = 0; index < 42; index += 1) {
      const t = index / 41;
      const x = 0.5 - t * 3.9 + Math.sin(t * Math.PI * 2) * 0.16;
      const z = 1.15 + t * 5.05;
      const stone = new THREE.Mesh(new THREE.CircleGeometry(0.075 + (index % 3) * 0.022, 7), dirtScuffs);
      stone.rotation.x = -Math.PI / 2;
      stone.position.set(x + Math.sin(index * 8.31) * 0.34, 0.022, z + Math.cos(index * 4.17) * 0.17);
      stone.scale.set(1.5, 1, 0.72);
      this.worldRoot.add(stone);
    }
    this.buildWaterside();
    this.buildFarmFences();
    this.buildRocks();

    const flowerGeometry = new THREE.ConeGeometry(0.08, 0.22, 5);
    const flowerMaterials = ['#dfb767', '#c87662', '#efe2b2'].map((color) => new THREE.MeshStandardMaterial({ color, roughness: 1 }));
    const meadowPositions = this.createMeadowPositions(320, 10.7, 10.35, 12.8);
    const coverMaterials = [...this.grassMaterials, ...flowerMaterials];
    for (let materialIndex = 0; materialIndex < coverMaterials.length; materialIndex += 1) {
      const instances = meadowPositions
        .map((position, index) => ({ ...position, index }))
        .filter(({ index }) => index % coverMaterials.length === materialIndex);
      if (instances.length === 0) continue;
      const grass = new THREE.InstancedMesh(flowerGeometry, coverMaterials[materialIndex]!, instances.length);
      grass.castShadow = false;
      grass.receiveShadow = false;
      grass.frustumCulled = true;
      const transform = new THREE.Object3D();
      instances.forEach(({ x, z, scale, rotation }, index) => {
        transform.position.set(x, 0.1 * scale, z);
        transform.rotation.set(0, rotation, 0);
        transform.scale.setScalar(scale);
        transform.updateMatrix();
        grass.setMatrixAt(index, transform.matrix);
      });
      grass.instanceMatrix.needsUpdate = true;
      this.worldRoot.add(grass);
    }

    for (let index = 0; index < 50; index += 1) {
      const angle = index * 2.399 + Math.sin(index * 1.71) * 0.15;
      const radius = 13.05 + this.seededNoise(index * 17 + 3) * 5.4;
      const groupX = Math.cos(angle) * radius;
      const groupZ = Math.sin(angle) * radius;
      if (Math.sqrt((groupX / 10.65) ** 2 + (groupZ / 7.85) ** 2) < 1.04) continue;
      const scale = 0.78 + this.seededNoise(index * 29 + 11) * 0.44;
      if (index % 5 !== 4) {
        const tree = this.assetCatalog.createTree(index % 3);
        tree.position.set(groupX, 0, groupZ);
        tree.scale.setScalar(scale * 1.15);
        tree.rotation.y = angle;
        tree.traverse((part) => { if (part instanceof THREE.Mesh) part.castShadow = false; });
        this.worldRoot.add(tree);
      } else {
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.18 + (index % 3) * 0.07, 0), new THREE.MeshStandardMaterial({ color: index % 2 ? '#87927c' : '#aeaa8c', roughness: 1, flatShading: true }));
        rock.position.set(groupX, 0.13, groupZ);
        rock.scale.y = 0.62;
        this.worldRoot.add(rock);
      }
    }
  }

  /** Pond, reeds, pads, and the village well. Static dressing; no gameplay. */
  private buildWaterside(): void {
    const pondBed = new THREE.Mesh(
      new THREE.CircleGeometry(POND_RADIUS, 28),
      new THREE.MeshStandardMaterial({ color: '#8ba47c', roughness: 1 }),
    );
    pondBed.rotation.x = -Math.PI / 2;
    pondBed.position.set(POND_POSITION.x, 0.008, POND_POSITION.z);
    pondBed.scale.set(1.2, 0.85, 1);
    pondBed.receiveShadow = true;
    this.worldRoot.add(pondBed);
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(POND_RADIUS * 0.86, 28),
      new THREE.MeshStandardMaterial({ color: '#5d858c', roughness: 0.25, transparent: true, opacity: 0.94 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(POND_POSITION.x, 0.02, POND_POSITION.z);
    water.scale.set(1.2, 0.85, 1);
    water.userData['part'] = 'pond-water';
    this.worldRoot.add(water);
    this.pondWater = water.material as THREE.MeshStandardMaterial;
    const reedMaterial = new THREE.MeshStandardMaterial({ color: '#5f7d4a', roughness: 1, flatShading: true });
    const reedGeometry = new THREE.ConeGeometry(0.07, 0.75, 5);
    const cattailMaterial = new THREE.MeshStandardMaterial({ color: '#6b4f35', roughness: 1 });
    for (let index = 0; index < 7; index += 1) {
      const angle = index / 7 * Math.PI * 2 + 0.4;
      const reed = new THREE.Mesh(reedGeometry, reedMaterial);
      reed.position.set(
        POND_POSITION.x + Math.cos(angle) * POND_RADIUS * 1.02,
        0.36,
        POND_POSITION.z + Math.sin(angle) * POND_RADIUS * 0.78,
      );
      reed.rotation.z = Math.sin(index * 3.7) * 0.12;
      reed.castShadow = true;
      this.worldRoot.add(reed);
      if (index % 2 === 0) {
        const cattail = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.22, 5), cattailMaterial);
        cattail.position.set(reed.position.x, 0.72, reed.position.z);
        this.worldRoot.add(cattail);
      }
    }
    const padMaterial = new THREE.MeshStandardMaterial({ color: '#4f7d4a', roughness: 0.9 });
    for (const [dx, dz, scale] of [[-0.4, 0.2, 1], [0.35, -0.3, 0.7], [0.1, 0.45, 0.55]] as const) {
      const pad = new THREE.Mesh(new THREE.CircleGeometry(0.16 * scale, 9), padMaterial);
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(POND_POSITION.x + dx, 0.032, POND_POSITION.z + dz);
      this.worldRoot.add(pad);
    }
    // The well itself is entity-owned (createEntityView 'well' case), not
    // static dressing, so its visuals track authoritative state.
  }

  /** Split-rail runs along the outer edges of the fixed farm plots. */
  private buildFarmFences(): void {
    const timber = new THREE.MeshStandardMaterial({ color: '#76523d', roughness: 1 });
    FARM_SLOTS.forEach((slot, index) => {
      // One group per plot, toggled in sync(): empty plots show no fence —
      // a fence must never imply a farm the simulation doesn't have.
      const fences = new THREE.Group();
      fences.userData['farmSlot'] = index;
      for (const edge of [-1, 1]) {
        for (const corner of [-1, 1]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.62, 5), timber);
          post.position.set(slot.x + corner * 1.35, 0.31, slot.z + edge * 1.05);
          post.castShadow = true;
          fences.add(post);
        }
        const rail = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.07, 0.07), timber);
        rail.position.set(slot.x, 0.48, slot.z + edge * 1.05);
        rail.castShadow = true;
        fences.add(rail);
      }
      this.farmFences.set(index, fences);
      this.worldRoot.add(fences);
    });
  }

  private buildRocks(): void {
    const rockMaterial = new THREE.MeshStandardMaterial({ color: '#8d8d84', roughness: 1, flatShading: true });
    const mossMaterial = new THREE.MeshStandardMaterial({ color: '#6d7f52', roughness: 1, flatShading: true });
    for (const spot of ROCK_SPOTS) {
      // Boulders, not pebbles: clearly larger than collectible stones, sunk
      // into the ground so they read as bedded outcrops.
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.62 * spot.scale, 0), rockMaterial);
      rock.position.set(spot.x, 0.2 * spot.scale, spot.z);
      rock.rotation.set(spot.x, spot.z, 0.4);
      rock.castShadow = true;
      rock.receiveShadow = true;
      this.worldRoot.add(rock);
      const moss = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3 * spot.scale, 0), mossMaterial);
      moss.position.set(spot.x + 0.38 * spot.scale, 0.16 * spot.scale, spot.z + 0.24 * spot.scale);
      this.worldRoot.add(moss);
    }
  }

  private shapeGround(geometry: THREE.PlaneGeometry): void {
    const position = geometry.attributes['position'];
    if (!position) return;
    for (let index = 0; index < position.count; index += 1) {
      const x = position.getX(index);
      const z = -position.getY(index);
      const edge = Math.sqrt((x / 11.5) ** 2 + (z / 8.6) ** 2);
      const ridge = THREE.MathUtils.smoothstep(edge, 0.88, 1.8);
      const rolling = (Math.sin(x * 0.31 + z * 0.12) * Math.cos(z * 0.27 - x * 0.09) * 0.22 + this.seededNoise(Math.round((x + 40) * 19 + (z + 40) * 7)) * 0.12 - 0.06) * ridge;
      position.setZ(index, rolling + ridge * 0.58);
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  private createClearingShape(expansion: number, withUnderstoryRing = false): THREE.Shape {
    const centerX = -0.2;
    const centerZ = 0.2;
    const segments = 96;
    const radiusX = withUnderstoryRing ? 11.2 + expansion : 10.65 + expansion;
    const radiusZ = withUnderstoryRing ? 8.35 + expansion * 0.72 : 7.85 + expansion * 0.72;
    const pointAt = (index: number, scale: number): THREE.Vector2 => {
      const angle = index / segments * Math.PI * 2;
      const organic = 1 + Math.sin(angle * 3 + 0.4) * 0.035 + Math.cos(angle * 5 - 0.8) * 0.022 + Math.sin(angle * 9) * 0.012;
      return new THREE.Vector2(centerX + Math.cos(angle) * radiusX * organic * scale, -(centerZ + Math.sin(angle) * radiusZ * organic * scale));
    };
    const shape = new THREE.Shape();
    for (let index = 0; index <= segments; index += 1) {
      const point = pointAt(index, 1);
      if (index === 0) shape.moveTo(point.x, point.y);
      else shape.lineTo(point.x, point.y);
    }
    shape.closePath();
    if (withUnderstoryRing) {
      const hole = new THREE.Path();
      for (let index = segments; index >= 0; index -= 1) {
        const point = pointAt(index, 0.96);
        if (index === segments) hole.moveTo(point.x, point.y);
        else hole.lineTo(point.x, point.y);
      }
      hole.closePath();
      shape.holes.push(hole);
    }
    return shape;
  }

  private seededNoise(seed: number): number {
    const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return value - Math.floor(value);
  }

  private createWindingPath(): THREE.Shape {
    const shape = new THREE.Shape();
    shape.moveTo(0.45, -0.8);
    shape.bezierCurveTo(1.3, -1.75, 0.5, -2.55, -0.1, -3.25);
    shape.bezierCurveTo(-0.9, -4.2, -1.45, -4.55, -2.05, -5.25);
    shape.bezierCurveTo(-2.52, -5.8, -2.92, -6.32, -3.65, -6.55);
    shape.lineTo(-3.92, -5.96);
    shape.bezierCurveTo(-3.18, -5.68, -2.96, -5.13, -2.55, -4.65);
    shape.bezierCurveTo(-1.95, -3.93, -1.4, -3.67, -0.63, -2.83);
    shape.bezierCurveTo(-0.1, -2.27, 0.57, -1.78, -0.25, -1.09);
    shape.closePath();
    return shape;
  }

  private createMeadowPositions(count: number, innerRadius: number, clearingRadius: number, outerRadius: number): Array<{ x: number; z: number; scale: number; rotation: number }> {
    const positions: Array<{ x: number; z: number; scale: number; rotation: number }> = [];
    for (let index = 0; positions.length < count && index < count * 8; index += 1) {
      const angle = index * 2.399963;
      const radius = innerRadius + Math.sqrt((index + 1) / count) * (outerRadius - innerRadius);
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const ellipseDistance = Math.sqrt((x / 10.65) ** 2 + (z / 7.85) ** 2);
      if (ellipseDistance < clearingRadius / 9.2 || Math.abs(x) < 6.9 && Math.abs(z) < 7.5) continue;
      positions.push({ x, z, scale: 0.48 + (index % 5) * 0.12, rotation: index * 1.7 });
    }
    return positions;
  }

  private readonly grassMaterials = ['#66845b', '#789364', '#87996a'].map((color) => new THREE.MeshStandardMaterial({ color, roughness: 1 }));

  private bindCameraControls(): void {
    this.canvas.style.cursor = 'grab';
    this.canvas.style.touchAction = 'none';
    this.canvas.addEventListener('pointerdown', (event) => {
      this.dragPoint = { x: event.clientX, y: event.clientY };
      this.canvas.setPointerCapture(event.pointerId);
      this.canvas.style.cursor = 'grabbing';
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.dragPoint) return;
      this.cameraYaw -= (event.clientX - this.dragPoint.x) * 0.006;
      this.cameraPitch = THREE.MathUtils.clamp(this.cameraPitch + (event.clientY - this.dragPoint.y) * 0.005, 0.38, 1.25);
      this.dragPoint = { x: event.clientX, y: event.clientY };
      this.updateCameraOrbit();
    });
    const stopDrag = () => {
      this.dragPoint = null;
      this.canvas.style.cursor = 'grab';
    };
    this.canvas.addEventListener('pointerup', stopDrag);
    this.canvas.addEventListener('pointercancel', stopDrag);
    this.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.cameraDistance = THREE.MathUtils.clamp(this.cameraDistance + event.deltaY * 0.018, 17, 38);
      this.updateCameraOrbit();
    }, { passive: false });
  }

  private updateCameraOrbit(): void {
    const horizontal = Math.cos(this.cameraPitch) * this.cameraDistance;
    this.camera.position.set(Math.sin(this.cameraYaw) * horizontal, Math.sin(this.cameraPitch) * this.cameraDistance, Math.cos(this.cameraYaw) * horizontal);
    this.camera.lookAt(0, 0, 0);
  }

  /**
   * Direct selection: map a canvas pixel to the y=0 ground plane in world
   * coordinates. Presentation helper only — the returned point becomes a
   * command like any typed coordinates, validated by the simulation.
   */
  pickGround(clientX: number, clientY: number): { x: number; z: number } | null {
    const bounds = this.canvas.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;
    const ndc = new THREE.Vector2(
      ((clientX - bounds.left) / bounds.width) * 2 - 1,
      -((clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const point = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), point)) return null;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) return null;
    return { x: Math.round(point.x * 100) / 100, z: Math.round(point.z * 100) / 100 };
  }

  private makeGroundTexture(): THREE.CanvasTexture {
    const source = document.createElement('canvas');
    source.width = 256;
    source.height = 256;
    const context = source.getContext('2d');
    if (context) {
      context.fillStyle = '#a5b183';
      context.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 4600; i += 1) {
        const tint = i % 5 === 0 ? 'rgba(74,111,75,0.16)' : i % 3 === 0 ? 'rgba(133,115,76,0.11)' : 'rgba(237,220,166,0.12)';
        context.fillStyle = tint;
        context.beginPath();
        context.ellipse(this.seededNoise(i * 3 + 1) * 256, this.seededNoise(i * 3 + 2) * 256, 1 + this.seededNoise(i * 3 + 3) * 3, 1 + this.seededNoise(i * 3 + 4) * 2, this.seededNoise(i * 3 + 5) * Math.PI, 0, Math.PI * 2);
        context.fill();
      }
    }
    const texture = new THREE.CanvasTexture(source);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(7, 7);
    return texture;
  }

  private createBadge(): { sprite: THREE.Sprite; texture: THREE.CanvasTexture } {
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    if (context) {
      context.fillStyle = 'rgba(41,55,48,0.84)';
      context.beginPath();
      context.roundRect(5, 5, 182, 54, 20);
      context.fill();
      context.fillStyle = '#f3edda';
      context.font = '600 21px system-ui, sans-serif';
      context.textAlign = 'center';
      context.fillText('CHOPPING', 96, 42);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false }));
    sprite.scale.set(1.72, 0.58, 1);
    sprite.position.set(0, 1.92, 0);
    sprite.renderOrder = 2;
    return { sprite, texture };
  }

  sync(state: Readonly<WorldState>): void {
    const worker = state.entities['worker-01'];
    const target = worker?.kind === 'worker' && worker.targetId ? state.entities[worker.targetId] : undefined;
    this.targetMarker.visible = Boolean(target && (target.kind === 'tree' && target.state !== 'sapling' || target.kind === 'berry-patch' && target.state === 'available' || target.kind === 'well'));
    if (this.targetMarker.visible && target) this.targetMarker.position.set(target.position.x, 0.035, target.position.z);
    for (const entity of Object.values(state.entities)) {
      let view = this.entityViews.get(entity.id);
      if (!view) {
        view = this.createEntityView(entity);
        this.entityViews.set(entity.id, view);
        this.worldRoot.add(view);
      }
      view.visible = true;
      view.position.set(entity.position.x, 0, entity.position.z);
      if (entity.kind === 'tree') {
        const depleted = entity.state === 'depleted';
        const sapling = entity.state === 'sapling';
        const damaged = !sapling && !depleted && entity.health < entity.maxHealth;
        const parts = this.treeAssetParts.get(entity.id);
        if (parts) {
          view.userData['treeDepleted'] = depleted;
          parts.model.visible = !depleted && parts.model.children.length > 0;
          parts.model.scale.setScalar(sapling ? 0.38 : damaged ? 0.88 : 1);
          parts.model.rotation.z = 0;
          parts.fallback.visible = !depleted && parts.model.children.length === 0;
          parts.stump.visible = depleted || sapling;
          parts.fallback.traverse((part) => {
            if (part.userData['part'] === 'canopy') {
              part.visible = !depleted && !(damaged && part.userData['secondaryCanopy']);
              if (!depleted) {
                const originalScale = part.userData['originalScale'] as THREE.Vector3 | undefined;
                part.scale.copy(originalScale ?? new THREE.Vector3(1, 1, 1)).multiplyScalar(sapling ? 0.38 : damaged ? 0.78 : 1);
              }
            }
            if (part.userData['part'] === 'trunk') {
              part.scale.y = depleted ? 0.38 : 1;
              part.position.y = depleted ? 0.36 : 0.85;
            }
          });
        }
        view.scale.setScalar(1);
        view.rotation.z = damaged ? 0.11 : 0;
        // Per-specimen variation from the stable id: no two trees match.
        // Presentation only — authoritative positions and states are untouched.
        const idHash = [...entity.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
        view.scale.setScalar(0.9 + (idHash % 7) * 0.05);
        const shadow = this.treeShadows.get(entity.id);
        if (shadow) (shadow.material as THREE.MeshBasicMaterial).opacity = depleted ? 0.08 : sapling ? 0.12 : 0.2;
      }
      if (entity.kind === 'worker') {
        // Face travel: yaw toward the current target while moving, eased so
        // the inhabitant turns instead of snapping. Presentation only.
        const facing = entity.targetId ? state.entities[entity.targetId] : undefined;
        if (facing && 'position' in facing && (entity.activity === 'moving' || entity.activity === 'carrying')) {
          const want = Math.atan2(facing.position.x - entity.position.x, facing.position.z - entity.position.z);
          let delta = want - view.rotation.y;
          while (delta > Math.PI) delta -= Math.PI * 2;
          while (delta < -Math.PI) delta += Math.PI * 2;
          view.rotation.y += delta * 0.25;
        } else {
          view.rotation.y = Math.sin(state.tick * 0.09) * 0.05;
        }
        view.traverse((part) => {
          if (part.userData['part'] === 'axe-arm') part.rotation.z = entity.activity === 'chopping' ? Math.sin(state.tick * 0.8) * 0.9 - 0.35 : entity.activity === 'building' || entity.activity === 'crafting' ? Math.sin(state.tick * 0.6) * 0.5 - 0.3 : 0;
          // The upgraded tool is visible on the worker: a stone axe head
          // reads darker and rougher than the basic iron one.
          if (part.userData['part'] === 'axe-head' && part instanceof THREE.Mesh) {
            const head = part.material as THREE.MeshStandardMaterial;
            const stone = entity.equipment.axe === 'stone-axe';
            head.color.set(stone ? '#6b6f66' : '#aeb1a0');
            head.metalness = stone ? 0 : 0.35;
            head.roughness = stone ? 1 : 0.7;
          }
        });
        const badgeText = entity.activity === 'chopping' ? 'CHOPPING' : entity.activity === 'gathering' ? 'GATHERING' : entity.activity === 'building' ? 'BUILDING' : entity.activity === 'crafting' ? 'CRAFTING' : entity.activity === 'resting' ? 'RESTING' : entity.activity === 'carrying' ? 'HAULING' : '';
        let badge = this.workerBadges.get(entity.id);
        if (!badge) {
          const created = this.createBadge();
          badge = { sprite: created.sprite, texture: created.texture, label: '' };
          this.workerBadges.set(entity.id, badge);
          this.worldRoot.add(created.sprite);
        }
        badge.sprite.visible = badgeText.length > 0;
        if (badgeText && badge.label !== badgeText) {
          badge.label = badgeText;
          this.updateWorkerBadge(badge.texture, badgeText);
        }
        badge.sprite.position.set(entity.position.x, entity.activity === 'gathering' ? 1.78 : 3.05, entity.position.z);
        const carried = entity.carrying ? state.entities[entity.carrying] : undefined;
        if (carried && (carried.kind === 'log' || carried.kind === 'food')) {
          const resourceView = this.entityViews.get(carried.id);
          if (resourceView) resourceView.position.set(entity.position.x, 0.92, entity.position.z + 0.15);
        }
      }
      if (entity.kind === 'berry-patch') {
        const harvested = entity.state === 'harvested';
        view.traverse((part) => {
          if (part.userData['part'] === 'patch-fruit') part.visible = !harvested;
          if (part.userData['part'] === 'patch-leaves') part.scale.setScalar(harvested ? 0.55 : 1);
        });
      }
      if (entity.kind === 'log' || entity.kind === 'food' || entity.kind === 'water') {
        view.rotation.y = entity.state === 'carried' ? Math.PI / 2 : 0.35;
        if (entity.state === 'delivered') {
          const offsetX = entity.kind === 'food' ? -1.72 : entity.kind === 'water' ? -1.15 : 1.62;
          view.position.set(entity.position.x + offsetX, 0.12, entity.position.z + 1.12);
        } else {
          view.position.y = entity.state === 'carried' ? 1.24 : 0;
        }
      }
      if (entity.kind === 'house') {
        const complete = entity.state === 'complete';
        view.traverse((part) => {
          if (part.userData['part'] === 'house-frame') part.visible = !complete;
          if (part.userData['part'] === 'house-body') {
            part.visible = complete || entity.progress > 0.35;
            if (!complete) part.scale.setScalar(0.4 + entity.progress * 0.6);
            else part.scale.setScalar(1);
          }
        });
        this.syncSmoke(entity.id, complete, entity.position.x + 0.62, 2.35, entity.position.z - 0.3);
      }
      if (entity.kind === 'settlement') {
        this.syncSmoke(entity.id, true, entity.position.x, 1.1, entity.position.z);
      }
      if (entity.kind === 'villager') {
        view.rotation.y = Math.sin(state.tick * 0.05 + entity.position.x) * 0.9;
      }
      if (entity.kind === 'branch' || entity.kind === 'stone') {
        view.visible = entity.state === 'ground';
      }
      if (entity.kind === 'animal') {
        view.rotation.y = Math.sin(state.tick * 0.05 + entity.position.x * 2) * 0.9;
        // Deer read smaller than the inhabitant: coherent shared scale.
        view.scale.setScalar(0.8);
      }
      if (entity.kind === 'shelter') {
        // Construction stages mirror authoritative progress: frame, then
        // roof past a third, then bedding past two thirds. A finished
        // shelter shows everything; nothing here decides completion.
        view.traverse((part) => {
          if (part.userData['part'] === 'shelter-frame') part.visible = true;
          if (part.userData['part'] === 'shelter-roof') part.visible = entity.progress > 1 / 3 || entity.state === 'complete';
          if (part.userData['part'] === 'shelter-body') part.visible = entity.progress > 2 / 3 || entity.state === 'complete';
        });
      }
      if (entity.kind === 'farm') {
        const ready = entity.state === 'ready';
        view.traverse((part) => {
          if (part.userData['part'] === 'farm-plant' && part instanceof THREE.Mesh) {
            part.scale.setScalar(0.35 + entity.progress * 0.65);
            const crops = part.parent;
            const ripe = crops?.userData['ripeMaterial'] as THREE.Material | undefined;
            if (ready && ripe) part.material = ripe;
          }
        });
      }
    }
    // Plot fences follow farm existence: farms occupy slots in order, so
    // fence i is visible exactly while at least i+1 farms exist.
    const farmCount = Object.values(state.entities).filter((entity) => entity.kind === 'farm').length;
    for (const [index, fences] of this.farmFences) fences.visible = farmCount > index;
  }

  /** Hearth/campfire smoke. Tick-driven, presentation-only. */
  private syncSmoke(id: string, lit: boolean, x: number, y: number, z: number): void {
    let sprite = this.smokePuffs.get(id);
    if (!lit) {
      if (sprite) sprite.visible = false;
      return;
    }
    if (!sprite) {
      if (!this.smokeTexture) this.smokeTexture = this.makeSmokeTexture();
      const material = new THREE.SpriteMaterial({ map: this.smokeTexture, transparent: true, opacity: 0.3, depthWrite: false });
      sprite = new THREE.Sprite(material);
      sprite.scale.set(0.55, 0.55, 1);
      sprite.renderOrder = 3;
      sprite.userData['seed'] = this.smokePuffs.size * 1.7;
      sprite.userData['baseY'] = y;
      this.smokePuffs.set(id, sprite);
      this.worldRoot.add(sprite);
    }
    sprite.visible = true;
    sprite.userData['baseY'] = y;
    sprite.position.set(x, y, z);
  }

  private makeSmokeTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    if (context) {
      const gradient = context.createRadialGradient(32, 32, 4, 32, 32, 30);
      gradient.addColorStop(0, 'rgba(235,230,220,0.85)');
      gradient.addColorStop(0.6, 'rgba(235,230,220,0.35)');
      gradient.addColorStop(1, 'rgba(235,230,220,0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 64, 64);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private updateWorkerBadge(texture: THREE.CanvasTexture, text: string): void {
    const context = texture.image.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, 192, 64);
    context.fillStyle = 'rgba(41,55,48,0.9)';
    context.beginPath();
    context.roundRect(5, 5, 182, 54, 20);
    context.fill();
    context.fillStyle = '#f3edda';
    context.font = '600 18px system-ui, sans-serif';
    context.textAlign = 'center';
    context.fillText(text, 96, 41, 172);
    texture.needsUpdate = true;
  }

  private createEntityView(entity: { kind: string; id: string; blueprint?: string }): THREE.Group {
    const { kind, id } = entity;
    let group: THREE.Group;
    if (kind === 'tree') {
      group = this.assetCatalog.createTree(Number(id.slice(-2)) || 0);
      const model = group.children.find((child) => child.userData['part'] === 'tree-model');
      const fallback = group.children.find((child) => child.userData['part'] === 'tree-fallback');
      const stump = group.children.find((child) => child.userData['part'] === 'tree-stump');
      if (model && fallback && stump) this.treeAssetParts.set(id, { model: model as THREE.Group, fallback: fallback as THREE.Group, stump: stump as THREE.Group });
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.94, 20), new THREE.MeshBasicMaterial({ color: '#435744', transparent: true, opacity: 0.2 }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.015;
      this.treeShadows.set(id, shadow);
      group.add(shadow);
    } else if (kind === 'worker') {
      const variant = [...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 4;
      group = this.assetCatalog.createWorker(variant);
    } else if (kind === 'settlement') {
      group = this.assetCatalog.createSettlement();
    } else if (kind === 'berry-patch') {
      group = this.assetCatalog.createBerryPatch();
    } else if (kind === 'house') {
      // Blueprint selects the silhouette; legacy houses carry no tag and
      // render as the original homestead. Identity survives save/replay.
      const asset = entity.blueprint === 'timber-cabin' ? 'cabin' : entity.blueprint === 'thatched-cottage' ? 'cottage' : 'homestead';
      group = asset === 'cabin' ? this.assetCatalog.createCabin() : asset === 'cottage' ? this.assetCatalog.createCottage() : this.assetCatalog.createHouse();
      group.userData['blueprint'] = entity.blueprint ?? 'homestead';
    } else if (kind === 'well') {
      group = this.assetCatalog.createWell();
    } else if (kind === 'farm') {
      group = this.assetCatalog.createFarm();
    } else if (kind === 'villager') {
      group = this.assetCatalog.createVillager(Number(id.slice(-2)) || 0);
    } else if (kind === 'food') {
      group = this.assetCatalog.createFood();
    } else if (kind === 'branch') {
      group = this.assetCatalog.createBranch();
    } else if (kind === 'stone') {
      group = this.assetCatalog.createStone();
    } else if (kind === 'pond') {
      group = this.assetCatalog.createPond();
    } else if (kind === 'animal') {
      group = this.assetCatalog.createAnimal(Number(id.slice(-2)) || 0);
    } else if (kind === 'shelter') {
      group = this.assetCatalog.createShelter();
    } else if (kind === 'water') {
      group = this.assetCatalog.createWater();
    } else {
      group = this.assetCatalog.createLog();
    }
    group.userData['entityId'] = id;
    return group;
  }

  private resize(): void {
    const bounds = (this.canvas.parentElement ?? this.canvas).getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    const aspect = bounds.width / bounds.height;
    const height = 20;
    this.camera.left = -height * aspect / 2;
    this.camera.right = height * aspect / 2;
    this.camera.top = height / 2;
    this.camera.bottom = -height / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(bounds.width, bounds.height, false);
  }

  updatePresentation(state: Readonly<WorldState>): void {
    // Ambient life runs on sim ticks, never wall-clock: hearth smoke drifts
    // and pond water shimmers deterministically with the world.
    for (const sprite of this.smokePuffs.values()) {
      if (!sprite.visible) continue;
      const seed = Number(sprite.userData['seed'] ?? 0);
      const baseY = Number(sprite.userData['baseY'] ?? 2.5);
      const cycle = (state.tick * 0.06 + seed) % 1;
      sprite.position.y = baseY + cycle * 0.55;
      const material = sprite.material as THREE.SpriteMaterial;
      material.opacity = 0.3 * (1 - cycle);
      const scale = 0.45 + cycle * 0.5;
      sprite.scale.set(scale, scale, 1);
    }
    if (this.pondWater) {
      this.pondWater.opacity = 0.9 + 0.06 * Math.sin(state.tick * 0.5);
    }
    const worker = state.entities['worker-01'];
    if (!worker || worker.kind !== 'worker') return;
    const view = this.entityViews.get(worker.id);
    if (!view) return;
    view.traverse((part) => {
      if (part.userData['part'] === 'axe-arm') part.rotation.z = worker.activity === 'chopping' ? Math.sin(state.tick * 0.8) * 0.9 - 0.35 : worker.activity === 'gathering' ? Math.sin(state.tick * 0.32) * 0.28 - 0.2 : 0;
      if (part.userData['part'] === 'legs') part.rotation.x = worker.activity === 'moving' || worker.activity === 'carrying' ? Math.sin(state.tick * 0.55) * 0.32 : 0;
    });
  }

  private animate = (now = 0): void => {
    this.frame = requestAnimationFrame(this.animate);
    if (now - this.lastFrameAt < 1000 / 30) return;
    this.lastFrameAt = now;
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    for (const badge of this.workerBadges.values()) {
      badge.sprite.material.map?.dispose();
      badge.sprite.material.dispose();
      badge.texture.dispose();
    }
    this.workerBadges.clear();
    for (const sprite of this.smokePuffs.values()) {
      sprite.material.dispose();
    }
    this.smokePuffs.clear();
    this.smokeTexture?.dispose();
    this.smokeTexture = null;
    this.targetMarker.geometry.dispose();
    (this.targetMarker.material as THREE.Material).dispose();
    this.renderer.dispose();
  }
}
