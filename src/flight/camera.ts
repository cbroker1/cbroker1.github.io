/**
 * One camera, two places to put it.
 *
 * On the ground it is a person standing in a field, filming upward. That is
 * how the original footage was shot: the frame is sky from edge to edge and
 * the paramotor is a silhouette against it. From there the camera only pans,
 * tilts and zooms, a beat behind its subject the way a hand-held operator is,
 * and that lag is what makes a turn visible.
 *
 * In the air it rides behind the wing, which is the view to fly from. Moving
 * between the two is a matter of sliding the camera's position; aiming works
 * the same in both.
 */

import {
  type Vec3,
  addScaled,
  clamp,
  cross,
  dot,
  ease,
  length,
  mix,
  normalize,
  rotateAbout,
  scale,
  sub,
} from './vec.ts';

// Working vectors for the sums below, kept from frame to frame so that
// following the paramotor makes no garbage. Nothing here calls itself, so
// one set is enough.
const wanted: Vec3 = [0, 0, 0];
const axis: Vec3 = [0, 0, 0];
const carried: Vec3 = [0, 0, 0];
const level: Vec3 = [0, 0, 0];

export interface Camera {
  pos: Vec3;
  right: Vec3;
  up: Vec3;
  fwd: Vec3;
  /** Tangent of half the vertical field of view. Smaller is more zoomed in. */
  tanY: number;
}

/** Size of the hero in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
}

/** A position in the frame from -1 to 1 on each axis, y up. */
export interface FramePoint {
  x: number;
  y: number;
}

const WORLD_UP: Vec3 = [0, 1, 0];
/** Where the person filming stands, at eye height. */
export const GROUND_EYE: Vec3 = [0, 1.7, 0];

const LEVEL_TAU = 0.45; // seconds to roll the horizon back to level

// The chase camera hangs this far behind the pilot's seat and this far above
// it. Slightly below is deliberate: looking up puts the wing against the sky
// and the pilot against the bright horizon, where a silhouette reads best.
const CHASE_BACK = 26;
const CHASE_RISE = -1;
/** Field of view from behind the wing: 48 degrees top to bottom. */
export const CHASE_TAN = Math.tan((48 * Math.PI) / 360);

const TAN_WIDE = Math.tan((54 * Math.PI) / 360);
const TAN_TELE = Math.tan((7 * Math.PI) / 360);

/** A camera on the ground, already framing `target` at `frame`. */
export function createCamera(target: Vec3, frame: FramePoint, tanY: number, aspect: number): Camera {
  const pos: Vec3 = [GROUND_EYE[0], GROUND_EYE[1], GROUND_EYE[2]];
  const fwd = normalize(sub(target, pos));
  const right = normalize(cross(WORLD_UP, fwd));
  const cam: Camera = { pos, fwd, right, up: cross(fwd, right), tanY: clamp(tanY, TAN_TELE, TAN_WIDE) };
  // The aim is solved against the current axes, so settle it before first use.
  for (let i = 0; i < 4; i++) turnTo(cam, aim(cam, target, frame, aspect, wanted), 1);
  return cam;
}

/**
 * Follow `target`, holding it near `frame`. The aim trails the subject by
 * `followTau` seconds and the zoom closes on `tanY` over `zoomTau`.
 */
export function trackCamera(
  cam: Camera,
  target: Vec3,
  frame: FramePoint,
  tanY: number,
  zoomTau: number,
  followTau: number,
  aspect: number,
  dt: number
): void {
  cam.tanY += (tanY - cam.tanY) * ease(dt, zoomTau);
  aim(cam, target, frame, aspect, wanted);
  turnTo(cam, normalize(mix(cam.fwd, wanted, ease(dt, followTau), wanted), wanted), dt);
}

/**
 * Where the chase camera rides for a rig at `seat` flying on `heading`. On a
 * tall, narrow screen it drops further back so the wingspan still fits.
 */
export function chasePoint(seat: Vec3, heading: number, aspect: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const back = CHASE_BACK * clamp(1.25 / aspect, 1, 1.7);
  out[0] = seat[0] - Math.sin(heading) * back;
  out[1] = seat[1] + CHASE_RISE;
  out[2] = seat[2] - Math.cos(heading) * back;
  return out;
}

/** The view direction that would put `target` at `frame`, written into `out`. */
function aim(cam: Camera, target: Vec3, frame: FramePoint, aspect: number, out: Vec3): Vec3 {
  normalize(sub(target, cam.pos, out), out);
  addScaled(out, cam.right, -frame.x * cam.tanY * aspect, out);
  return normalize(addScaled(out, cam.up, -frame.y * cam.tanY, out), out);
}

/**
 * Re-point the camera without ever computing "up" from scratch.
 *
 * The obvious look-at breaks when the paramotor passes overhead: straight up
 * has no sideways, so the image would spin. Instead `up` is carried along the
 * shortest rotation between the old and new directions, then rolled gently
 * back toward level at a rate that fades to nothing near vertical. Flying
 * over the top of the camera tips it back and over, as it would a person.
 */
function turnTo(cam: Camera, fwd: Vec3, dt: number): void {
  cross(cam.fwd, fwd, axis);
  const sin = length(axis);
  const up = carried;
  up[0] = cam.up[0];
  up[1] = cam.up[1];
  up[2] = cam.up[2];
  if (sin > 1e-9) rotateAbout(up, scale(axis, 1 / sin, axis), Math.atan2(sin, dot(cam.fwd, fwd)), up);

  addScaled(WORLD_UP, fwd, -dot(WORLD_UP, fwd), level);
  const tilt = length(level);
  if (tilt > 1e-4) mix(up, scale(level, 1 / tilt, level), ease(dt * tilt, LEVEL_TAU), up);

  // The camera keeps its own three vectors and is written into, never handed new ones.
  cam.fwd[0] = fwd[0];
  cam.fwd[1] = fwd[1];
  cam.fwd[2] = fwd[2];
  normalize(cross(up, cam.fwd, cam.right), cam.right);
  cross(cam.fwd, cam.right, cam.up);
}

/**
 * How tight to frame a rig of the given size at the given distance.
 *
 * A fixed zoom makes the paramotor a speck as soon as it flies off; a zoom
 * that fully compensates makes distance invisible. This goes part of the way,
 * so flying away still reads as shrinking, just slowly. On a tall, narrow
 * screen the wingspan is the limit instead of the rig's height.
 */
export function zoomFor(distance: number, rigHeight: number, rigSpan: number, aspect: number): number {
  const fill = clamp(0.3 * Math.pow(90 / distance, 0.55), 0.09, 0.42);
  const forHeight = rigHeight / 2 / (distance * fill);
  const forSpan = rigSpan / 2 / (distance * 0.42 * aspect);
  return clamp(Math.max(forHeight, forSpan), TAN_TELE, TAN_WIDE);
}

/** Screen position, in CSS pixels, and the pixels-per-metre scale at that depth. */
export interface Projected {
  x: number;
  y: number;
  scale: number;
}

/** Returns false, leaving `out` untouched, for a point behind the camera. */
export function project(cam: Camera, view: Viewport, x: number, y: number, z: number, out: Projected): boolean {
  const dx = x - cam.pos[0];
  const dy = y - cam.pos[1];
  const dz = z - cam.pos[2];
  const depth = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
  if (depth < 0.5) return false;
  const k = view.height / (2 * cam.tanY * depth);
  out.x = view.width / 2 + (dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2]) * k;
  out.y = view.height / 2 - (dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2]) * k;
  out.scale = k;
  return true;
}

/** The world direction a screen position looks along. */
export function rayThrough(cam: Camera, view: Viewport, x: number, y: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const k = (2 * cam.tanY) / view.height;
  addScaled(cam.fwd, cam.right, (x - view.width / 2) * k, out);
  return normalize(addScaled(out, cam.up, -(y - view.height / 2) * k, out), out);
}
