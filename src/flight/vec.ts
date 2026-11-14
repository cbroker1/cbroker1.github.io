/**
 * The handful of vector and easing helpers the flight scene needs.
 *
 * World space is metres: +x east, +y up, +z north. Headings are measured
 * clockwise from north, so "forward" at heading h is (sin h, 0, cos h). In
 * this layout the camera's right-hand side is `cross(up, forward)`.
 *
 * Every function here that makes a vector takes somewhere to put it as its
 * last argument. Left out, a new one is made, which is fine while setting
 * things up. Anything that runs every frame hands over a vector it keeps, so
 * that a frame makes no garbage. That vector may be one of the inputs.
 */

export type Vec3 = [number, number, number];

export function sub(a: Vec3, b: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  out[2] = a[2] - b[2];
  return out;
}

export function scale(a: Vec3, s: number, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = a[0] * s;
  out[1] = a[1] * s;
  out[2] = a[2] * s;
  return out;
}

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Not Math.hypot: that one builds a list of its arguments every time it is called.
export const length = (a: Vec3): number => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);

export function distance(a: Vec3, b: Vec3): number {
  const x = a[0] - b[0];
  const y = a[1] - b[1];
  const z = a[2] - b[2];
  return Math.sqrt(x * x + y * y + z * z);
}

export function normalize(a: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  return scale(a, 1 / (length(a) || 1), out);
}

export function cross(a: Vec3, b: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

/** a + b * s */
export function addScaled(a: Vec3, b: Vec3, s: number, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = a[0] + b[0] * s;
  out[1] = a[1] + b[1] * s;
  out[2] = a[2] + b[2] * s;
  return out;
}

export function mix(a: Vec3, b: Vec3, t: number, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

/** Rotate `v` about the unit vector `axis`. */
export function rotateAbout(v: Vec3, axis: Vec3, angle: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = dot(axis, v) * (1 - c);
  const x = axis[1] * v[2] - axis[2] * v[1];
  const y = axis[2] * v[0] - axis[0] * v[2];
  const z = axis[0] * v[1] - axis[1] * v[0];
  const vx = v[0];
  const vy = v[1];
  out[0] = vx * c + x * s + axis[0] * k;
  out[1] = vy * c + y * s + axis[1] * k;
  out[2] = v[2] * c + z * s + axis[2] * k;
  return out;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function smoothstep(from: number, to: number, v: number): number {
  const t = clamp((v - from) / (to - from), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Wrap an angle into (-π, π]. */
export const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * How far toward its target a value should move this frame so that it closes
 * the gap with time constant `tau`, whatever the frame rate.
 */
export const ease = (dt: number, tau: number): number => 1 - Math.exp(-dt / tau);
