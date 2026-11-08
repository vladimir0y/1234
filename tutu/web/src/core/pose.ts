/**
 * Posing the body with linear blend skinning on the MakeHuman skeleton.
 * Rotations are given in the rest (A-pose) frame of each bone and chained
 * down the hierarchy, so bending the elbow follows a raised arm.
 */
import * as THREE from "three";
import type { BodySkin } from "../api";

export interface PoseParams {
  armsUp: number; // degrees: raise arms sideways from the A-pose (45 = T-pose)
  armsForward: number; // raise arms forward
  elbows: number; // bend elbows
  elbowsUp: boolean; // bend forearms up (biceps) instead of forward
  twist: number; // torso rotation
  bend: number; // torso forward bend
  sideBend: number; // torso side bend
  head: number; // head turn
  hips: number; // both thighs forward (sitting)
  knees: number; // bend knees
  step: number; // left leg forward, right leg back
}

export const REST_POSE: PoseParams = {
  armsUp: 0, armsForward: 0, elbows: 0, elbowsUp: false, twist: 0, bend: 0, sideBend: 0, head: 0, hips: 0, knees: 0, step: 0,
};

export const POSE_PRESETS: Record<string, { label: string; pose: Partial<PoseParams> }> = {
  rest: { label: "А-поза", pose: {} },
  t: { label: "Т-поза (руки в сторони)", pose: { armsUp: 45 } },
  up: { label: "Руки вгору", pose: { armsUp: 150 } },
  forward: { label: "Руки вперед", pose: { armsUp: 10, armsForward: 75 } },
  flex: { label: "Біцепс", pose: { armsUp: 45, elbows: 110, elbowsUp: true } },
  hold: { label: "Зігнуті лікті", pose: { elbows: 90 } },
  step: { label: "Крок", pose: { step: 25, knees: 12, armsForward: 10 } },
  sit: { label: "Сидячи", pose: { hips: 85, knees: 85, elbows: 40 } },
  twist: { label: "Поворот тулуба", pose: { twist: 35, head: 20 } },
  bend: { label: "Нахил уперед", pose: { bend: 35, armsForward: 30 } },
};

const UP = new THREE.Vector3(0, 1, 0);
const FRONT = new THREE.Vector3(0, 0, 1);
const BACK = new THREE.Vector3(0, 0, -1);

export class Poser {
  private index = new Map<string, number>();
  private heads: THREE.Vector3[];
  private children: number[][];

  constructor(private skin: BodySkin) {
    skin.bones.forEach((b, i) => this.index.set(b.name, i));
    this.heads = skin.bones.map((b) => new THREE.Vector3(...b.head));
    this.children = skin.bones.map(() => []);
    skin.bones.forEach((b, i) => b.parent >= 0 && this.children[b.parent].push(i));
  }

  private dir(bone: string): THREE.Vector3 {
    const i = this.index.get(bone)!;
    const c = this.children[i][0];
    return c !== undefined ? this.heads[c].clone().sub(this.heads[i]).normalize() : UP.clone();
  }

  /** Rotation turning the bone's rest direction toward `target` by `deg`. */
  private toward(bone: string, target: THREE.Vector3, deg: number): THREE.Quaternion {
    const d = this.dir(bone);
    const axis = d.clone().cross(target);
    if (axis.lengthSq() < 1e-8 || !deg) return new THREE.Quaternion();
    return new THREE.Quaternion().setFromAxisAngle(axis.normalize(), THREE.MathUtils.degToRad(deg));
  }

  private around(axis: THREE.Vector3, deg: number) {
    return new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(deg));
  }

  rotations(p: PoseParams): Map<number, THREE.Quaternion> {
    const r = new Map<number, THREE.Quaternion>();
    const set = (bone: string, q: THREE.Quaternion) => {
      const i = this.index.get(bone);
      if (i === undefined) return;
      r.set(i, (r.get(i) ?? new THREE.Quaternion()).premultiply(q));
    };
    for (const s of ["l", "r"] as const) {
      if (p.armsUp) set(`upperarm_${s}`, this.toward(`upperarm_${s}`, UP, p.armsUp));
      if (p.armsForward) set(`upperarm_${s}`, this.toward(`upperarm_${s}`, FRONT, p.armsForward));
      // Elbow hinge: fold the forearm toward the shoulder in the arm's own plane.
      if (p.elbows) {
        const target = p.elbowsUp ? UP : this.dir(`upperarm_${s}`).negate();
        set(`lowerarm_${s}`, this.toward(`lowerarm_${s}`, target, p.elbows));
      }
      if (p.hips) set(`thigh_${s}`, this.toward(`thigh_${s}`, FRONT, p.hips));
      if (p.knees) set(`calf_${s}`, this.toward(`calf_${s}`, BACK, p.knees));
    }
    if (p.step) {
      set("thigh_l", this.toward("thigh_l", FRONT, p.step));
      set("thigh_r", this.toward("thigh_r", BACK, p.step * 0.6));
    }
    for (const sp of ["spine_01", "spine_02", "spine_03"]) {
      if (p.twist) set(sp, this.around(UP, p.twist / 3));
      if (p.bend) set(sp, this.around(new THREE.Vector3(1, 0, 0), p.bend / 3));
      if (p.sideBend) set(sp, this.around(new THREE.Vector3(0, 0, 1), p.sideBend / 3));
    }
    if (p.head) set("neck_01", this.around(UP, p.head));
    return r;
  }

  /** World matrix per bone: parent * T(head) * R * T(-head). */
  matrices(p: PoseParams): THREE.Matrix4[] {
    const rot = this.rotations(p);
    const out: THREE.Matrix4[] = [];
    this.skin.bones.forEach((b, i) => {
      const h = this.heads[i];
      const local = new THREE.Matrix4()
        .makeTranslation(h.x, h.y, h.z)
        .multiply(new THREE.Matrix4().makeRotationFromQuaternion(rot.get(i) ?? new THREE.Quaternion()))
        .multiply(new THREE.Matrix4().makeTranslation(-h.x, -h.y, -h.z));
      out[i] = b.parent >= 0 ? out[b.parent].clone().multiply(local) : local;
    });
    return out;
  }

  apply(rest: ArrayLike<number>, p: PoseParams): Float32Array {
    const m = this.matrices(p).map((x) => x.elements);
    const n = rest.length / 3;
    const out = new Float32Array(rest.length);
    const { index, weight } = this.skin;
    for (let v = 0; v < n; v++) {
      const x = rest[3 * v], y = rest[3 * v + 1], z = rest[3 * v + 2];
      let ox = 0, oy = 0, oz = 0;
      for (let k = 0; k < 4; k++) {
        const w = weight[4 * v + k];
        if (!w) continue;
        const e = m[index[4 * v + k]];
        const f = w / 255;
        ox += f * (e[0] * x + e[4] * y + e[8] * z + e[12]);
        oy += f * (e[1] * x + e[5] * y + e[9] * z + e[13]);
        oz += f * (e[2] * x + e[6] * y + e[10] * z + e[14]);
      }
      out[3 * v] = ox;
      out[3 * v + 1] = oy;
      out[3 * v + 2] = oz;
    }
    return out;
  }
}

export function isRest(p: PoseParams): boolean {
  return (Object.keys(REST_POSE) as (keyof PoseParams)[]).every((k) => k === "elbowsUp" || !p[k]);
}
