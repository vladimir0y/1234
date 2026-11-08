import * as THREE from "three";

/**
 * Procedural body-part models in real-world metres, so the editor works
 * without a scan. Built as lathes with elliptic cross-sections.
 */

type Profile = Array<[number, number]>; // [height, radius]

function smoothProfile(points: Profile, steps: number): THREE.Vector2[] {
  const curve = new THREE.SplineCurve(points.map(([y, r]) => new THREE.Vector2(r, y)));
  return curve.getPoints(steps).map((p) => new THREE.Vector2(Math.max(0, p.x), p.y));
}

function lathe(points: Profile, depthScale: number, radial = 96, steps = 120): THREE.BufferGeometry {
  const profile = smoothProfile(points, steps);
  // Close the ends exactly on the axis.
  profile[0].x = 0;
  profile[profile.length - 1].x = 0;
  const g = new THREE.LatheGeometry(profile, radial);
  g.scale(1, 1, depthScale);
  return g;
}

export const DEMO_MODELS = {
  forearm: {
    label: "Передпліччя",
    build: () =>
      lathe(
        [
          [0, 0.0],
          [0.004, 0.024],
          [0.03, 0.029],
          [0.08, 0.031],
          [0.15, 0.038],
          [0.21, 0.045],
          [0.25, 0.046],
          [0.275, 0.042],
          [0.28, 0.0],
        ],
        0.78,
      ),
  },
  torso: {
    label: "Торс",
    build: () =>
      lathe(
        [
          [0, 0.0],
          [0.01, 0.15],
          [0.08, 0.175],
          [0.2, 0.15],
          [0.3, 0.14],
          [0.42, 0.165],
          [0.52, 0.18],
          [0.6, 0.19],
          [0.64, 0.15],
          [0.66, 0.07],
          [0.72, 0.06],
          [0.73, 0.0],
        ],
        0.62,
        128,
        160,
      ),
  },
  calf: {
    label: "Гомілка",
    build: () =>
      lathe(
        [
          [0, 0.0],
          [0.005, 0.032],
          [0.05, 0.036],
          [0.15, 0.045],
          [0.27, 0.058],
          [0.33, 0.056],
          [0.4, 0.05],
          [0.405, 0.0],
        ],
        0.85,
      ),
  },
} as const;

export type DemoModelId = keyof typeof DEMO_MODELS;
