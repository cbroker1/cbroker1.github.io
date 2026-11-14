/**
 * Flight model for the paramotor, plus the two autopilots that fly it when
 * nobody is on the keys.
 *
 * This is a feel model, not an aerodynamic one. It keeps the three things a
 * paramotor visibly does and drops the rest:
 *
 *   - Brakes bank the wing, and bank is what turns it. The pilot hangs seven
 *     metres under the canopy, so roll and pitch are springs that overshoot a
 *     little, the way a pendulum does.
 *   - Throttle is climb, not speed. Power swings the pilot forward of the wing
 *     and the whole rig pitches up; idle is a glide.
 *   - A banked wing gives up lift, so a hard turn with no extra power is a
 *     descending spiral.
 */

import { type Vec3, clamp, ease, smoothstep, wrapAngle } from './vec.ts';

const G = 9.81;

/** Hands-up cruise, m/s. About 25 mph. */
const TRIM_SPEED = 11;
/** Bank at full brake, radians. */
const MAX_BANK = 0.75;
const CLIMB_RATE = 3.2; // m/s at full throttle
const SINK_RATE = 2.4; // m/s at idle
/** Sink added per unit of load factor above 1 g. */
const BANK_SINK = 3;

// Roll and pitch pendulums: stiffness is ω², damping is 2ζω.
const BANK_STIFFNESS = 8.4;
const BANK_DAMPING = 3.7;
const PITCH_STIFFNESS = 2.9;
const PITCH_DAMPING = 1.45;

/**
 * The scene has nothing to hit and no edge to fall off, so the limits are
 * soft. Sink fades out above the floor, which sits just clear of the highest
 * cloud tops; climb fades out under the ceiling; and past the fence the
 * outbound part of the velocity bleeds away, which reads as flying into a
 * headwind that finally matches the wing's airspeed. The fence also keeps the
 * rig well inside the nearest ring of hills.
 */
const FLOOR = 8;
const FLOOR_FADE = 16; // sink starts fading out this far above the floor
const CEILING = 240;
const FENCE_START = 380;
const FENCE_END = 440;

/** What the pilot is asking for: steer right is positive, power up is positive. */
export interface Controls {
  steer: number;
  power: number;
}

export interface Craft {
  /** Pilot's seat. The camera stands at the origin. */
  pos: Vec3;
  heading: number;
  /** Airspeed along the heading, m/s. */
  speed: number;
  /** Vertical speed, m/s. */
  climb: number;
  /** Positive rolls the right wingtip down. */
  bank: number;
  bankRate: number;
  /** Positive swings the pilot ahead of the wing, nose up. */
  pitch: number;
  pitchRate: number;
  /** Eased copies of the inputs: where the hands and the throttle actually are. */
  steer: number;
  power: number;
}

export function createCraft(pos: Vec3, heading: number): Craft {
  return {
    pos,
    heading,
    speed: TRIM_SPEED,
    climb: 0,
    bank: 0,
    bankRate: 0,
    pitch: 0,
    pitchRate: 0,
    steer: 0,
    power: 0,
  };
}

export function stepCraft(c: Craft, input: Controls, dt: number, time: number): void {
  // Keys are instant; hands on brake toggles and a thumb on a throttle are not.
  c.steer += (clamp(input.steer, -1, 1) - c.steer) * ease(dt, 0.16);
  c.power += (clamp(input.power, -1, 1) - c.power) * ease(dt, 0.3);

  // Still air would hold the wing unnaturally rigid. This is a breath of
  // texture, well below anything that would move the flight path.
  const air = 0.035 * Math.sin(time * 0.83 + 1.3) + 0.02 * Math.sin(time * 2.1);

  const bankTarget = c.steer * MAX_BANK + air;
  c.bankRate += ((bankTarget - c.bank) * BANK_STIFFNESS - c.bankRate * BANK_DAMPING) * dt;
  c.bank += c.bankRate * dt;

  // Coordinated turn: the rate that keeps the pilot's weight straight down the lines.
  c.heading = wrapAngle(c.heading + ((G * Math.tan(c.bank)) / c.speed) * dt);

  let climbTarget = c.power > 0 ? c.power * CLIMB_RATE : c.power * SINK_RATE;
  climbTarget -= BANK_SINK * (1 / Math.cos(c.bank) - 1);
  const altitude = c.pos[1];
  if (climbTarget < 0) climbTarget *= smoothstep(FLOOR, FLOOR + FLOOR_FADE, altitude);
  else climbTarget *= 1 - smoothstep(CEILING - 30, CEILING, altitude);
  if (altitude < FLOOR) climbTarget = Math.max(climbTarget, (FLOOR - altitude) * 0.5);
  c.climb += (climbTarget - c.climb) * ease(dt, 0.7);

  // Brakes slow the wing; a descent speeds it up.
  const speedTarget = TRIM_SPEED - 0.3 * c.climb - 1.2 * Math.abs(c.steer);
  c.speed += (speedTarget - c.speed) * ease(dt, 1);

  const pitchTarget = 0.1 * c.power + 0.4 * Math.atan2(c.climb, c.speed) + 0.012 * Math.sin(time * 1.37 + 0.4);
  c.pitchRate += ((pitchTarget - c.pitch) * PITCH_STIFFNESS - c.pitchRate * PITCH_DAMPING) * dt;
  c.pitch += c.pitchRate * dt;

  let vx = Math.sin(c.heading) * c.speed;
  let vz = Math.cos(c.heading) * c.speed;
  const range = Math.sqrt(c.pos[0] * c.pos[0] + c.pos[2] * c.pos[2]);
  if (range > FENCE_START) {
    const ox = c.pos[0] / range;
    const oz = c.pos[2] / range;
    const outbound = vx * ox + vz * oz;
    if (outbound > 0) {
      const hold = smoothstep(FENCE_START, FENCE_END, range);
      vx -= ox * outbound * hold;
      vz -= oz * outbound * hold;
    }
  }
  c.pos[0] += vx * dt;
  c.pos[1] += c.climb * dt;
  c.pos[2] += vz * dt;
}

export interface Axes {
  right: Vec3;
  up: Vec3;
  fwd: Vec3;
}

/**
 * The rig's own axes in world space: yaw, then pitch, then roll. Written into
 * `out` if one is given, so that a caller who asks every frame makes no
 * garbage by it.
 */
export function bodyAxes(c: Craft, out: Axes = { right: [0, 0, 0], up: [0, 0, 0], fwd: [0, 0, 0] }): Axes {
  const sh = Math.sin(c.heading);
  const ch = Math.cos(c.heading);
  const sp = Math.sin(c.pitch);
  const cp = Math.cos(c.pitch);
  const sb = Math.sin(c.bank);
  const cb = Math.cos(c.bank);

  // After yaw the level right-hand side is (ch, 0, -sh). Pitch tips forward
  // and up about it; roll then tips up and right about the pitched forward.
  const upX = -sh * sp;
  const upZ = -ch * sp;
  out.fwd[0] = sh * cp;
  out.fwd[1] = sp;
  out.fwd[2] = ch * cp;
  out.up[0] = upX * cb + ch * sb;
  out.up[1] = cp * cb;
  out.up[2] = upZ * cb - sh * sb;
  out.right[0] = ch * cb - upX * sb;
  out.right[1] = -cp * sb;
  out.right[2] = -sh * cb - upZ * sb;
  return out;
}

/** A circle to hold: which way round, how wide, how high. */
export interface Orbit {
  cx: number;
  cz: number;
  radius: number;
  altitude: number;
  /** 1 circles clockwise seen from above, -1 the other way. */
  dir: 1 | -1;
}

/**
 * Flies a lazy circle, which is also how the footage looks: a paramotor
 * cannot hover, so "staying put" is an orbit.
 *
 * The course is the circle's tangent, bent toward the circle in proportion to
 * how far off it the craft is, so from far away it heads straight in and
 * arrives already turning.
 *
 * Like `flyToward`, it answers in `out` if given one.
 */
export function flyOrbit(c: Craft, o: Orbit, time: number, out: Controls = { steer: 0, power: 0 }): Controls {
  const rx = c.pos[0] - o.cx;
  const rz = c.pos[2] - o.cz;
  const off = (Math.sqrt(rx * rx + rz * rz) - o.radius) / o.radius;
  const course = Math.atan2(rx, rz) + o.dir * (Math.PI / 2 + Math.atan(1.3 * off));

  // On the circle, hold the bank that flies it rather than waiting to drift off.
  const hold = ((o.dir * Math.atan((c.speed * c.speed) / (G * o.radius))) / MAX_BANK) * Math.exp(-off * off);
  const altitude = o.altitude + 6 * Math.sin(time * 0.13);

  out.steer = clamp(hold + 1.3 * wrapAngle(course - c.heading), -0.8, 0.8);
  out.power = clamp((altitude - c.pos[1]) * 0.1 - c.climb * 0.3, -0.7, 0.8);
  return out;
}

/** Steers for a point in the sky: turn to face it, climb or sink to its height. */
export function flyToward(c: Craft, target: Vec3, out: Controls = { steer: 0, power: 0 }): Controls {
  const bearing = Math.atan2(target[0] - c.pos[0], target[2] - c.pos[2]);
  out.steer = clamp(1.6 * wrapAngle(bearing - c.heading), -1, 1);
  out.power = clamp((target[1] - c.pos[1]) * 0.12 - c.climb * 0.2, -1, 1);
  return out;
}
