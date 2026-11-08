import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import {
  buildFaceAdjacency,
  faceCentroids,
  facesInBrush,
  type FaceAdjacency,
  type MeshData,
} from "./core/topology";
import type { PreparedBody } from "./core/loaders";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export type BrushMode = "orbit" | "add" | "erase";

const SKIN = new THREE.Color("#e7c1a4");
const HIGHLIGHT = new THREE.Color("#3fd0c9");

/** 3D viewport: the body, the region brush and the tattoo overlay patch. */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 50);
  readonly controls: OrbitControls;

  mode: BrushMode = "orbit";
  brushRadius = 0.02; // metres
  showSelection = true;
  readonly selection = new Set<number>();
  onSelectionChange: (() => void) | null = null;
  onStrokeEnd: (() => void) | null = null;

  mesh: MeshData | null = null;
  normals: Float32Array | null = null;
  private body: THREE.Mesh | null = null;
  private adjacency: FaceAdjacency | null = null;
  private centroids: Float32Array | null = null;
  private patch: THREE.Mesh | null = null;
  private cursor: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private painting = false;
  private pointer = new THREE.Vector2();

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = "none";

    this.scene.background = new THREE.Color("#15161b");
    this.scene.add(new THREE.HemisphereLight("#fff6ee", "#30343f", 1.4));
    const key = new THREE.DirectionalLight("#ffffff", 1.6);
    key.position.set(1.5, 2.5, 2);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight("#9fc9ff", 0.8);
    rim.position.set(-2, 1.5, -2);
    this.scene.add(rim);
    const grid = new THREE.GridHelper(2, 20, "#2b2e38", "#22242c");
    this.scene.add(grid);

    this.cursor = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1, 48),
      new THREE.MeshBasicMaterial({ color: HIGHLIGHT, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.cursor.renderOrder = 10;
    this.cursor.visible = false;
    this.scene.add(this.cursor);

    // Our listeners must be registered before OrbitControls so a stroke on the
    // body can stop the event from rotating the camera.
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointerleave", () => (this.cursor.visible = false));

    this.controls = new OrbitControls(this.camera, el);
    this.controls.enableDamping = true;
    this.camera.position.set(0.6, 0.4, 0.8);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private bodySize = new THREE.Vector3(1, 1, 1);

  setBody(prepared: PreparedBody, keepCamera = false) {
    if (this.body) {
      this.scene.remove(this.body);
      this.body.geometry.disposeBoundsTree();
      this.body.geometry.dispose();
    }
    this.clearPatch();
    this.selection.clear();

    const merged = prepared.merged;
    const index = merged.index!.array as Uint32Array;
    const positions = merged.getAttribute("position").array as Float32Array;
    this.mesh = { positions, indices: index };
    this.normals = merged.getAttribute("normal").array as Float32Array;
    this.adjacency = buildFaceAdjacency(this.mesh);
    this.centroids = faceCentroids(this.mesh);

    // Display copy: one vertex per face corner, so faces can be coloured individually.
    const display = merged.toNonIndexed();
    const colors = new Float32Array(display.getAttribute("position").count * 3);
    display.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    display.computeBoundsTree({ indirect: true });
    this.body = new THREE.Mesh(
      display,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0 }),
    );
    this.scene.add(this.body);
    this.refreshColors();
    this.bodySize.copy(prepared.size);
    if (!keepCamera) this.frame(prepared.size);
  }

  frameAll() {
    this.frame(this.bodySize, false);
  }

  /** Look at `target` from `direction`, `distance` metres away. */
  focus(target: THREE.Vector3, direction: THREE.Vector3, distance: number) {
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(direction.clone().normalize(), distance);
    this.camera.near = 0.01;
    this.camera.updateProjectionMatrix();
  }

  private frame(size: THREE.Vector3, resetBrush = true) {
    const radius = Math.max(size.x, size.y, size.z) * 0.6;
    const target = new THREE.Vector3(0, size.y / 2, 0);
    this.controls.target.copy(target);
    const dist = radius / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.1;
    this.camera.position.copy(target).add(new THREE.Vector3(0.35, 0.15, 1).normalize().multiplyScalar(dist));
    this.camera.near = dist / 100;
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    if (resetBrush) this.brushRadius = Math.max(0.005, Math.min(0.03, radius * 0.08));
  }

  setSelection(faces: Iterable<number>) {
    this.selection.clear();
    for (const f of faces) this.selection.add(f);
    this.refreshColors();
    this.onSelectionChange?.();
  }

  clearSelection() {
    this.setSelection([]);
  }

  refreshColors() {
    if (!this.body) return;
    const attr = this.body.geometry.getAttribute("color") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const tint = SKIN.clone().lerp(HIGHLIGHT, 0.55);
    const faces = arr.length / 9;
    for (let f = 0; f < faces; f++) {
      const c = this.showSelection && this.selection.has(f) ? tint : SKIN;
      for (let k = 0; k < 3; k++) {
        arr[9 * f + 3 * k] = c.r;
        arr[9 * f + 3 * k + 1] = c.g;
        arr[9 * f + 3 * k + 2] = c.b;
      }
    }
    attr.needsUpdate = true;
  }

  /** Overlay mesh for the region, textured with the tattoo canvas. */
  setPatch(globalVertices: number[], triangles: Uint32Array, uv: Float32Array, texture: THREE.Texture) {
    this.clearPatch();
    if (!this.mesh || !this.normals) return;
    const n = globalVertices.length;
    const pos = new Float32Array(n * 3);
    const offset = 0.0006; // 0.6 mm above the skin, avoids z-fighting
    globalVertices.forEach((g, i) => {
      for (let c = 0; c < 3; c++) pos[3 * i + c] = this.mesh!.positions[3 * g + c] + this.normals![3 * g + c] * offset;
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geom.setIndex(new THREE.BufferAttribute(triangles, 1));
    geom.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      roughness: 0.8,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
    this.patch = new THREE.Mesh(geom, mat);
    this.patch.renderOrder = 2;
    this.scene.add(this.patch);
  }

  clearPatch() {
    if (!this.patch) return;
    this.scene.remove(this.patch);
    this.patch.geometry.dispose();
    (this.patch.material as THREE.Material).dispose();
    this.patch = null;
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/png");
  }

  // --- brush ---------------------------------------------------------------
  private hit(e: PointerEvent): THREE.Intersection | null {
    if (!this.body) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.raycaster.firstHitOnly = true;
    return this.raycaster.intersectObject(this.body, false)[0] ?? null;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (this.mode === "orbit" || e.button !== 0) return;
    const hit = this.hit(e);
    if (!hit) return; // empty space: let the camera rotate
    e.stopImmediatePropagation();
    this.painting = true;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    this.paint(hit);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.mode === "orbit") {
      this.cursor.visible = false;
      return;
    }
    const hit = this.hit(e);
    this.updateCursor(hit);
    if (this.painting && hit) this.paint(hit);
  };

  private onPointerUp = () => {
    if (!this.painting) return;
    this.painting = false;
    this.onStrokeEnd?.();
  };

  private updateCursor(hit: THREE.Intersection | null) {
    if (!hit || !hit.face) {
      this.cursor.visible = false;
      return;
    }
    this.cursor.visible = true;
    this.cursor.position.copy(hit.point);
    const n = hit.face.normal.clone().transformDirection(this.body!.matrixWorld);
    this.cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    this.cursor.position.addScaledVector(n, 0.001);
    this.cursor.scale.setScalar(this.brushRadius);
    (this.cursor.material as THREE.MeshBasicMaterial).color.set(this.mode === "erase" ? "#ff6b6b" : HIGHLIGHT);
  }

  private paint(hit: THREE.Intersection) {
    if (hit.faceIndex == null || !this.adjacency || !this.centroids) return;
    const faces = facesInBrush(
      this.adjacency,
      this.centroids,
      hit.faceIndex,
      [hit.point.x, hit.point.y, hit.point.z],
      this.brushRadius,
    );
    let changed = false;
    for (const f of faces) {
      if (this.mode === "add" && !this.selection.has(f)) {
        this.selection.add(f);
        changed = true;
      } else if (this.mode === "erase" && this.selection.delete(f)) {
        changed = true;
      }
    }
    if (changed) {
      this.refreshColors();
      this.onSelectionChange?.();
    }
  }
}
