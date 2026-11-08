import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export const MESH_EXTENSIONS = ["obj", "glb", "gltf", "ply", "stl"];

export function extensionOf(name: string): string {
  return name.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
}

/** Parse a mesh file into a single world-space geometry (positions only). */
export async function parseMesh(data: ArrayBuffer, ext: string): Promise<THREE.BufferGeometry> {
  switch (ext) {
    case "obj":
      return fromObject(new OBJLoader().parse(new TextDecoder().decode(data)));
    case "ply":
      return new PLYLoader().parse(data);
    case "stl":
      return new STLLoader().parse(data);
    case "glb":
    case "gltf": {
      const gltf = await new GLTFLoader().parseAsync(data, "");
      return fromObject(gltf.scene);
    }
    default:
      throw new Error(`Формат .${ext} не підтримується (OBJ, GLB, GLTF, PLY, STL)`);
  }
}

function fromObject(root: THREE.Object3D): THREE.BufferGeometry {
  root.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", mesh.geometry.getAttribute("position").clone());
    if (mesh.geometry.index) g.setIndex(mesh.geometry.index.clone());
    g.applyMatrix4(mesh.matrixWorld);
    parts.push(g);
  });
  if (!parts.length) throw new Error("У файлі немає мешів");
  const normalized = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  return normalized.length === 1 ? normalized[0] : mergeGeometries(normalized)!;
}

export interface PreparedBody {
  /** Welded, indexed geometry with smooth normals — topology source. */
  merged: THREE.BufferGeometry;
  /** Unit that was detected in the file. */
  unit: "m" | "cm" | "mm";
  /** Size of the bounding box in metres. */
  size: THREE.Vector3;
}

/**
 * Weld vertices, convert to metres, and place the model on the floor centred.
 * Scans from iPhone are in metres; files from DCC tools are often cm or mm.
 */
export function prepareBody(raw: THREE.BufferGeometry): PreparedBody {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", raw.getAttribute("position").clone());
  if (raw.index) g.setIndex(raw.index.clone());

  g.computeBoundingBox();
  const size = g.boundingBox!.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  let unit: PreparedBody["unit"] = "m";
  if (longest > 30) unit = "mm";
  else if (longest > 3.5) unit = "cm";
  const scale = unit === "mm" ? 0.001 : unit === "cm" ? 0.01 : 1;
  g.scale(scale, scale, scale);

  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const center = bb.getCenter(new THREE.Vector3());
  g.translate(-center.x, -bb.min.y, -center.z);

  // 0.1 mm weld: also joins seams between chunks of a LiDAR scan.
  const merged = mergeVertices(g, 1e-4);
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  return { merged, unit, size: merged.boundingBox!.getSize(new THREE.Vector3()) };
}
