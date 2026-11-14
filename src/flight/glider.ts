/**
 * Draws the paramotor as a silhouette.
 *
 * The footage shows it backlit, as pure black against the sky, and that is a
 * gift: a silhouette has no lighting, no texture and no hidden surfaces. The
 * rig is modelled in three dimensions so its outline changes correctly as it
 * turns (a crescent from below, a blade edge-on), then every part is projected
 * to the screen and filled with the same black. Overlap is invisible, so
 * nothing needs sorting.
 *
 * Dimensions are those of a real rig, in metres from the pilot's seat: a wing
 * of about 25 m² on seven-metre lines, a 1.4 m cage.
 */

import { type Camera, type Projected, type Viewport, project } from './camera.ts';
import { type Craft, bodyAxes } from './sim.ts';
import type { Ink } from './sky.ts';
import { smoothstep } from './vec.ts';

/** Boots to canopy top, and tip to tip. The camera frames the rig with these. */
export const RIG_HEIGHT = 8.8;
export const RIG_SPAN = 9.3;
/** Height of the rig's visual middle above the seat. */
export const RIG_CENTRE = 3.9;

/* ----------------------------------------------------------------- canopy */

const STATIONS = 24; // slices across the span
const MID = STATIONS / 2;
const HALF_SPAN = 4.7;
const ARC_DROP = 2.6; // how far the arc would fall if it ran to vertical
const ARC_LIMIT = (80 * Math.PI) / 180; // where along that arc the tips stop
const ROOT_CHORD = 2.9;
const CANOPY_Y = 8; // underside of the centre cell, above the seat

/**
 * Aerofoil outline as [distance back from the leading edge, offset from the
 * chord line], both in chords. It runs over the top surface to the trailing
 * edge and back underneath.
 */
const PROFILE: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.03, 0.055],
  [0.12, 0.1],
  [0.3, 0.115],
  [0.6, 0.075],
  [1, 0],
  [0.6, -0.02],
  [0.3, -0.045],
  [0.08, -0.04],
];
const RING = PROFILE.length;
const TRAILING = 5; // PROFILE index of the trailing edge

/**
 * One slice of the wing: where it sits on the arc, which way is "out" from
 * the arc there, how long its chord is and how far forward its nose is.
 */
const stations = Array.from({ length: STATIONS + 1 }, (_, i) => {
  // Slices crowd toward the tips, where the outline curves most, so the tips
  // come out round rather than cut off.
  const t = Math.sin((((i / STATIONS) * 2 - 1) * Math.PI) / 2);
  const angle = t * ARC_LIMIT;
  const nx = Math.sin(angle) / HALF_SPAN;
  const ny = Math.cos(angle) / ARC_DROP;
  const n = Math.hypot(nx, ny);
  // Tapering toward the tips, then closing to a point over the last cell.
  const chord = ROOT_CHORD * (1 - 0.72 * Math.pow(Math.abs(t), 2.6)) * Math.sqrt(1 - Math.pow(Math.abs(t), 8));
  return {
    t,
    x: HALF_SPAN * Math.sin(angle),
    y: CANOPY_Y - ARC_DROP * (1 - Math.cos(angle)),
    nx: nx / n,
    ny: ny / n,
    chord,
    lead: 0.3 * chord - 0.45 * t * t,
  };
});

/* ------------------------------------------------------------------ lines */

const RISER_TOP = [0.3, 0.98, 0.02] as const; // right-hand side; mirrored for the left
// Slices out from the centre that carry a line, in the groups that share one.
const LINE_GROUPS = [
  [1, 3],
  [5, 7],
  [9, 10],
];
const LINE_ROWS = [0.14, 0.5]; // chordwise attachment rows, front and rear
const BRAKE_STATIONS = [4, 7, 9, 10];

/**
 * Suspension lines as flat [x, y, z, x, y, z] segments in rig space. Real
 * lines cascade: a few leave each riser, and each splits partway up into a
 * fan that spreads the load across a stretch of wing.
 */
const LINES: number[] = [];
for (const side of [-1, 1]) {
  const riser = [side * RISER_TOP[0], RISER_TOP[1], RISER_TOP[2]];
  for (const row of LINE_ROWS) {
    for (const group of LINE_GROUPS) {
      const tops = group.map((m) => {
        const s = stations[MID + side * m];
        return [s.x - s.nx * 0.035 * s.chord, s.y - s.ny * 0.035 * s.chord, s.lead - row * s.chord];
      });
      const split = [0, 1, 2].map((axis) => {
        const mean = tops.reduce((sum, top) => sum + top[axis], 0) / tops.length;
        return riser[axis] + (mean - riser[axis]) * 0.42;
      });
      LINES.push(...riser, ...split);
      for (const top of tops) LINES.push(...split, ...top);
    }
  }
}

/* ------------------------------------------------------------------ pilot */

// Seated and reclined, legs out in front, with the motor on their back: from
// behind, most of what shows is engine, tank and frame, with a helmet above
// and arms reaching up to the brakes. Index order matters: LIMBS below refers
// to these by position.
const FIGURE: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], // 0 hip
  [0, 0.5, -0.13], // 1 chest
  [0, 0.78, -0.08], // 2 head
  [-0.15, 0.1, 0.48], // 3 knees
  [0.15, 0.1, 0.48],
  [-0.14, -0.2, 0.8], // 5 ankles
  [0.14, -0.2, 0.8],
  [-0.14, -0.17, 0.97], // 7 toes
  [0.14, -0.17, 0.97],
  [-0.22, 0.52, -0.12], // 9 shoulders
  [0.22, 0.52, -0.12],
  [0, -0.06, -0.22], // 11 seat, back to front
  [0, -0.02, 0.3],
  [-0.26, 0.42, 0.04], // 13 carabiners
  [0.26, 0.42, 0.04],
  [-RISER_TOP[0], RISER_TOP[1], RISER_TOP[2]], // 15 riser tops
  [RISER_TOP[0], RISER_TOP[1], RISER_TOP[2]],
  [0, 0.1, -0.32], // 17 engine, bottom to top
  [0, 0.52, -0.32],
  [-0.11, -0.16, -0.34], // 19 fuel tank, side to side
  [0.11, -0.16, -0.34],
  [-0.2, -0.03, -0.02], // 21 seat board, side to side
  [0.2, -0.03, -0.02],
  [-0.2, -0.4, -0.36], // 23 frame uprights, feet
  [0.2, -0.4, -0.36],
  [-0.2, 0.92, -0.36], // 25 frame uprights, heads
  [0.2, 0.92, -0.36],
];
const ELBOW_L = FIGURE.length;
const ELBOW_R = ELBOW_L + 1;
const HAND_L = ELBOW_L + 2;
const HAND_R = ELBOW_L + 3;

/** [from, to, radius in metres]: each part is a round-ended stroke. */
const LIMBS: readonly (readonly [number, number, number])[] = [
  [0, 1, 0.18], // torso
  [9, 10, 0.09], // shoulders
  [0, 3, 0.09], // thighs
  [0, 4, 0.09],
  [3, 5, 0.065], // shins
  [4, 6, 0.065],
  [5, 7, 0.05], // feet
  [6, 8, 0.05],
  [11, 12, 0.11], // seat
  [21, 22, 0.14],
  [17, 18, 0.19], // engine
  [19, 20, 0.14], // tank
  [23, 25, 0.022], // frame uprights
  [24, 26, 0.022],
  [13, 15, 0.02], // risers
  [14, 16, 0.02],
  [9, ELBOW_L, 0.05], // arms
  [10, ELBOW_R, 0.05],
  [ELBOW_L, HAND_L, 0.045],
  [ELBOW_R, HAND_R, 0.045],
];

const HAND_UP = [0.33, 0.9, 0.1] as const; // on the toggles, brakes released
const HAND_DOWN = [0.3, 0.3, 0.2] as const; // full brake, hand at the hip
const HELMET = 0.14;

const CAGE_Y = 0.3;
const CAGE_RADIUS = 0.72;
const CAGE_HOOPS = [-0.31, -0.45]; // the hoop has depth; two rings read as one band
const CAGE_STEPS = 28;
/** Strands of the net that keeps lines out of the propeller. */
const NET_STRANDS = 16;

/* ---------------------------------------------------------------- drawing */

// Scratch buffers of screen positions, reused every frame.
const mesh = new Float32Array((STATIONS + 1) * RING * 2);
const lines = new Float32Array((LINES.length / 3) * 2);
const figure = new Float32Array((FIGURE.length + 4) * 2);
const hoop = new Float32Array(CAGE_STEPS * 2);
const ring = new Int32Array(RING); // mesh offsets of the panel being added
const spot: Projected = { x: 0, y: 0, scale: 0 };

/**
 * The few things `drawGlider` asks of whatever it draws on. A 2D canvas
 * context is one; the WebGPU renderer supplies another that takes the same
 * dictation and draws it its own way.
 */
export interface Pen {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
  lineWidth: number;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  stroke(): void;
  fill(): void;
}

/** The rig on a 2D canvas, for where there is no WebGPU. Null if the canvas has no 2D context to give. */
export function canvasInk(canvas: HTMLCanvasElement): Ink | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  let ratio = 1;
  return {
    resize(width, height, pixelRatio) {
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      ratio = pixelRatio;
    },
    draw(cam, view, craft, lineInk) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, view.width, view.height);
      drawGlider(ctx, cam, view, craft, lineInk);
    },
  };
}

/**
 * Draw the rig with a pen working in CSS pixels. `lineInk` is how strongly
 * the suspension lines are drawn, from 0 to 1.
 */
export function drawGlider(
  ctx: Pen,
  cam: Camera,
  view: Viewport,
  craft: Craft,
  lineInk = 0.2
): void {
  const [ox, oy, oz] = craft.pos;
  if (!project(cam, view, ox, oy, oz, spot)) return;
  const k = spot.scale; // pixels per metre at the pilot

  const { right, up, fwd } = bodyAxes(craft);
  /** Project a point given in the rig's own right / up / forward metres. */
  const place = (x: number, y: number, z: number, into: Float32Array, at: number) => {
    project(
      cam,
      view,
      ox + right[0] * x + up[0] * y + fwd[0] * z,
      oy + right[1] * x + up[1] * y + fwd[1] * z,
      oz + right[2] * x + up[2] * y + fwd[2] * z,
      spot
    );
    into[at] = spot.x;
    into[at + 1] = spot.y;
  };

  const brakeL = Math.max(0, -craft.steer);
  const brakeR = Math.max(0, craft.steer);

  // Canopy. A pulled brake drags that side's trailing edge down, and it shows.
  for (let i = 0; i <= STATIONS; i++) {
    const s = stations[i];
    const pull = (s.t < 0 ? brakeL : brakeR) * smoothstep(0.05, 0.45, Math.abs(s.t));
    for (let j = 0; j < RING; j++) {
      const off = (PROFILE[j][1] - (j === TRAILING ? 0.14 * pull : 0)) * s.chord;
      place(s.x + s.nx * off, s.y + s.ny * off, s.lead - PROFILE[j][0] * s.chord, mesh, (i * RING + j) * 2);
    }
  }

  for (let i = 0; i < LINES.length; i += 3) place(LINES[i], LINES[i + 1], LINES[i + 2], lines, (i / 3) * 2);

  for (let i = 0; i < FIGURE.length; i++) place(FIGURE[i][0], FIGURE[i][1], FIGURE[i][2], figure, i * 2);
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    const brake = i === 0 ? brakeL : brakeR;
    const hx = side * (HAND_UP[0] + (HAND_DOWN[0] - HAND_UP[0]) * brake);
    const hy = HAND_UP[1] + (HAND_DOWN[1] - HAND_UP[1]) * brake;
    const hz = HAND_UP[2] + (HAND_DOWN[2] - HAND_UP[2]) * brake;
    const shoulder = FIGURE[9 + i];
    place(hx, hy, hz, figure, (HAND_L + i) * 2);
    // The elbow sits out to the side of the straight line from shoulder to
    // hand, and drops as the brake comes down.
    place(
      (shoulder[0] + hx) / 2 + side * 0.12,
      (shoulder[1] + hy) / 2 - 0.02 - 0.08 * brake,
      (shoulder[2] + hz) / 2 + 0.06,
      figure,
      (ELBOW_L + i) * 2
    );
  }

  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Lines first, faint: in the footage they are a grey haze, not ink. Never
  // thinner than a pixel, or neighbours beat against each other in bands.
  ctx.globalAlpha = lineInk;
  ctx.lineWidth = Math.max(1, 0.02 * k);
  ctx.beginPath();
  for (let i = 0; i < lines.length; i += 4) {
    ctx.moveTo(lines[i], lines[i + 1]);
    ctx.lineTo(lines[i + 2], lines[i + 3]);
  }
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    const hand = (HAND_L + i) * 2;
    // Brake lines gather partway up, then fan to the trailing edge.
    let gx = 0;
    let gy = 0;
    for (const m of BRAKE_STATIONS) {
      const tip = trailingEdge(MID + side * m);
      gx += mesh[tip] / BRAKE_STATIONS.length;
      gy += mesh[tip + 1] / BRAKE_STATIONS.length;
    }
    gx = figure[hand] + (gx - figure[hand]) * 0.55;
    gy = figure[hand + 1] + (gy - figure[hand + 1]) * 0.55;
    ctx.moveTo(figure[hand], figure[hand + 1]);
    ctx.lineTo(gx, gy);
    for (const m of BRAKE_STATIONS) {
      const tip = trailingEdge(MID + side * m);
      ctx.moveTo(gx, gy);
      ctx.lineTo(mesh[tip], mesh[tip + 1]);
    }
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Canopy skin, as one path. Panels facing the camera and panels facing away
  // wind in opposite directions on screen; left that way the fill rule would
  // cancel them where they overlap, so each is turned to wind the same way.
  ctx.beginPath();
  for (let i = 0; i < STATIONS; i++) {
    for (let j = 0; j < RING; j++) {
      const next = (j + 1) % RING;
      ring[0] = (i * RING + j) * 2;
      ring[1] = ((i + 1) * RING + j) * 2;
      ring[2] = ((i + 1) * RING + next) * 2;
      ring[3] = (i * RING + next) * 2;
      panel(ctx, 4);
    }
  }
  // Close the open ends at the wingtips.
  for (const end of [0, STATIONS]) {
    for (let j = 0; j < RING; j++) ring[j] = (end * RING + j) * 2;
    panel(ctx, RING);
  }
  ctx.fill();

  // Cage: two thin hoops, and the net stretched across them. A propeller at
  // speed is invisible, so none is drawn.
  ctx.lineWidth = Math.max(0.8, 0.02 * k);
  ctx.beginPath();
  for (const z of CAGE_HOOPS) {
    for (let i = 0; i < CAGE_STEPS; i++) {
      const a = (i / CAGE_STEPS) * Math.PI * 2;
      place(Math.cos(a) * CAGE_RADIUS, CAGE_Y + Math.sin(a) * CAGE_RADIUS, z, hoop, i * 2);
    }
    ctx.moveTo(hoop[0], hoop[1]);
    for (let i = 1; i < CAGE_STEPS; i++) ctx.lineTo(hoop[i * 2], hoop[i * 2 + 1]);
    ctx.closePath();
  }
  ctx.stroke();

  ctx.globalAlpha = 0.3;
  ctx.lineWidth = Math.max(0.5, 0.012 * k);
  ctx.beginPath();
  place(0, CAGE_Y, CAGE_HOOPS[0], hoop, 0);
  for (let i = 0; i < NET_STRANDS; i++) {
    const a = ((i + 0.5) / NET_STRANDS) * Math.PI * 2;
    place(Math.cos(a) * CAGE_RADIUS, CAGE_Y + Math.sin(a) * CAGE_RADIUS, CAGE_HOOPS[0], hoop, 2);
    ctx.moveTo(hoop[0], hoop[1]);
    ctx.lineTo(hoop[2], hoop[3]);
  }
  for (let i = 0; i <= CAGE_STEPS; i++) {
    const a = (i / CAGE_STEPS) * Math.PI * 2;
    place(Math.cos(a) * CAGE_RADIUS * 0.55, CAGE_Y + Math.sin(a) * CAGE_RADIUS * 0.55, CAGE_HOOPS[0], hoop, 2);
    if (i === 0) ctx.moveTo(hoop[2], hoop[3]);
    else ctx.lineTo(hoop[2], hoop[3]);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Pilot, motor and frame.
  for (const [from, to, radius] of LIMBS) {
    ctx.lineWidth = Math.max(1, 2 * radius * k);
    ctx.beginPath();
    ctx.moveTo(figure[from * 2], figure[from * 2 + 1]);
    ctx.lineTo(figure[to * 2], figure[to * 2 + 1]);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(figure[4], figure[5], Math.max(0.8, HELMET * k), 0, Math.PI * 2);
  ctx.fill();
}

/** How the rig's silhouette sits on screen, measured the way the footage's is. */
export interface RigOutline {
  /** Height in CSS pixels. */
  tall: number;
  /** The canopy's width over the whole height: narrow side-on, wide from in front or behind. */
  shape: number;
  /** Share of the height the canopy takes up: more, the steeper the view from below. */
  wing: number;
}

/**
 * Measure the rig's silhouette as the camera sees it, from a few points on
 * its outline. Used to stand the rig the way the filmed one is standing.
 */
export function rigOutline(cam: Camera, view: Viewport, craft: Craft): RigOutline {
  const { right, up, fwd } = bodyAxes(craft);
  let left = Infinity;
  let top = Infinity;
  let rightmost = -Infinity;
  let bottom = -Infinity;
  const include = (x: number, y: number, z: number) => {
    const visible = project(
      cam,
      view,
      craft.pos[0] + right[0] * x + up[0] * y + fwd[0] * z,
      craft.pos[1] + right[1] * x + up[1] * y + fwd[1] * z,
      craft.pos[2] + right[2] * x + up[2] * y + fwd[2] * z,
      spot
    );
    if (!visible) return;
    left = Math.min(left, spot.x);
    rightmost = Math.max(rightmost, spot.x);
    top = Math.min(top, spot.y);
    bottom = Math.max(bottom, spot.y);
  };
  // The canopy: leading and trailing edge, top and bottom skin, at nine
  // places from tip to tip.
  for (let i = 0; i <= STATIONS; i += STATIONS / 8) {
    const s = stations[i];
    include(s.x, s.y, s.lead);
    include(s.x, s.y, s.lead - s.chord);
    include(s.x + s.nx * 0.115 * s.chord, s.y + s.ny * 0.115 * s.chord, s.lead - 0.3 * s.chord);
  }
  const wingBottom = bottom;
  const wingWide = rightmost - left;
  // The pilot's toes, and the bottom of the cage.
  include(FIGURE[7][0], FIGURE[7][1], FIGURE[7][2]);
  include(0, CAGE_Y - CAGE_RADIUS, CAGE_HOOPS[1]);
  const tall = Math.max(1, bottom - top);
  return { tall, shape: wingWide / tall, wing: (wingBottom - top) / tall };
}

/** Offset into the mesh buffer of a slice's trailing-edge point. */
const trailingEdge = (station: number): number => (station * RING + TRAILING) * 2;

/**
 * Add the polygon whose mesh offsets are the first `count` entries of `ring`
 * to the current path, always winding the same way on screen.
 */
function panel(ctx: Pen, count: number): void {
  let area = 0;
  for (let i = 0; i < count; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % count];
    area += mesh[a] * mesh[b + 1] - mesh[b] * mesh[a + 1];
  }
  const flip = area > 0;
  for (let i = 0; i < count; i++) {
    const at = ring[flip ? count - 1 - i : i];
    if (i === 0) ctx.moveTo(mesh[at], mesh[at + 1]);
    else ctx.lineTo(mesh[at], mesh[at + 1]);
  }
  ctx.closePath();
}
