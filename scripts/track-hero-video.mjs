/**
 * Measures where the paramotor sits in the hero video, twice a second, and
 * writes the result to `src/flight/hero-track.ts`.
 *
 * The flyable hero takes over from the footage mid-playback. For that handoff
 * to read as "the video came alive" rather than a cut to a different scene,
 * the live paramotor has to appear where the filmed one is, at the same size,
 * facing the same way, under a sky of about the same brightness. This script
 * supplies those facts per sample so the browser never has to analyse video.
 *
 * The footage makes this easy: the paramotor is a pure black silhouette on a
 * bright sky, so a luma threshold isolates it. The one complication is a heavy
 * cloud bank that crushes to black at the right edge around the 12 s mark,
 * which is why each frame is searched only near the previous frame's box.
 *
 * No dependencies beyond ffmpeg on PATH. Re-run only if the video changes:
 *   node scripts/track-hero-video.mjs
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VIDEO = fileURLToPath(new URL('../public/video/hero.webm', import.meta.url));
const OUT = fileURLToPath(new URL('../src/flight/hero-track.ts', import.meta.url));

const W = 480;
const H = 270;
const DECODE_FPS = 4;
/** Emit every Nth decoded frame. 2 Hz is plenty: the subject drifts slowly. */
const KEEP_EVERY = 2;
const DARK = 16; // luma below this is silhouette
const BURNT = 250; // luma at or above this is glare
const SEARCH_PAD = 24; // px the box may grow per decoded frame

// How the scene frames its takeover, from src/flight: the rig's height in
// metres, and the range and elevation it is placed at. Only used to turn the
// glare's position in the frame into an angle.
const RIG_HEIGHT = 8.8;
const TAKEOVER_RANGE = 90;
const TAKEOVER_ELEVATION = (16 * Math.PI) / 180;

const decoded = spawnSync(
  'ffmpeg',
  ['-v', 'error', '-i', VIDEO, '-vf', `fps=${DECODE_FPS},scale=${W}:${H}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
  { maxBuffer: 256 * 1024 * 1024 }
);
if (decoded.status !== 0) {
  console.error(decoded.stderr?.toString() || 'ffmpeg failed. Is it installed?');
  process.exit(1);
}

const frames = Math.floor(decoded.stdout.length / (W * H));
const samples = [];
let box = null;

for (let i = 0; i < frames; i++) {
  const px = decoded.stdout.subarray(i * W * H, (i + 1) * W * H);

  const x0 = box ? Math.max(0, box.x0 - SEARCH_PAD) : 0;
  const x1 = box ? Math.min(W - 1, box.x1 + SEARCH_PAD) : W - 1;
  const y0 = box ? Math.max(0, box.y0 - SEARCH_PAD) : 0;
  const y1 = box ? Math.min(H - 1, box.y1 + SEARCH_PAD) : H - 1;

  const next = { x0: W, x1: -1, y0: H, y1: -1 };
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (px[y * W + x] >= DARK) continue;
      if (x < next.x0) next.x0 = x;
      if (x > next.x1) next.x1 = x;
      if (y < next.y0) next.y0 = y;
      if (y > next.y1) next.y1 = y;
    }
  }
  if (next.x1 < 0) {
    console.error(`Lost the silhouette at ${(i / DECODE_FPS).toFixed(2)}s.`);
    process.exit(1);
  }
  box = next;

  if (i % KEEP_EVERY !== 0) continue;

  // Where is the sun? Measure the sky: its brightness per half, and where
  // any burnt-out glare sits.
  let left = 0;
  let right = 0;
  let glare = 0;
  let glareX = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = px[y * W + x];
      if (x < W / 2) left += v;
      else right += v;
      if (v >= BURNT) {
        glare += 1;
        glareX += x;
      }
    }
  }
  const half = (W / 2) * H * 255;
  left /= half;
  right /= half;
  const centre = (box.x0 + box.x1 + 1) / 2 / W;
  const tall = (box.y1 - box.y0 + 1) / H;

  let sunOffset;
  if (glare > 0.015 * W * H) {
    // The glare is in frame, so the sun is where it is. Its distance from the
    // subject across the frame becomes an angle through the field of view the
    // scene takes over with, which is set by the subject's size.
    const fieldOfView = 2 * Math.atan(((RIG_HEIGHT / 2 / (TAKEOVER_RANGE * tall)) * 16) / 9);
    sunOffset = ((centre - glareX / glare / W) * fieldOfView * (180 / Math.PI)) / Math.cos(TAKEOVER_ELEVATION);
  } else {
    // No glare: the camera has panned away from the sun. The dimmer the
    // brighter half of the sky, the further it has gone, and that half says
    // which way. Squared, because the first of that dimming is the cloud
    // bank beside the sun filling the frame, not distance from the sun: the
    // glare has only just left.
    const dim = Math.min(1, Math.max(0, (0.85 - Math.max(left, right)) / 0.45));
    sunOffset = (right > left ? -1 : 1) * (12 + 115 * dim * dim);
  }

  // The wing is the first solid thing down from the top of the box; below it
  // the lines are too faint to count, until the pilot. How much of the
  // silhouette's height it takes up says how steeply the camera looks up,
  // and how wide it is says which way it is flying. The wing's own width,
  // not the whole box's: the pilot hangs off to one side of it as often as
  // not, and a box stretched to take him in would call for a wider wing.
  let wingRows = 0;
  let wingLeft = W;
  let wingRight = -1;
  for (let y = box.y0, gap = 0; y <= box.y1 && gap < 3; y++) {
    let dark = 0;
    for (let x = box.x0; x <= box.x1; x++) {
      if (px[y * W + x] >= DARK) continue;
      dark += 1;
      if (x < wingLeft) wingLeft = x;
      if (x > wingRight) wingRight = x;
    }
    if (dark > 0) {
      wingRows = y - box.y0 + 1;
      gap = 0;
    } else {
      gap += 1;
    }
  }

  samples.push([
    centre,
    (box.y0 + box.y1 + 1) / 2 / H,
    tall,
    sunOffset,
    // The frame is decoded with square pixels, so this is its true shape:
    // narrow side-on, wide from behind.
    (wingRight - wingLeft + 1) / (box.y1 - box.y0 + 1),
    wingRows / (box.y1 - box.y0 + 1),
  ]);
}

// The two ways of finding the sun disagree at the moment the glare leaves the
// frame, though the camera panned smoothly through it. Hold the change
// between samples to what a hand-held pan could do, which turns that jump
// into a ramp.
const MAX_PAN = 6; // degrees per sample
for (let i = 1; i < samples.length; i++) {
  const before = samples[i - 1][3];
  samples[i][3] = Math.min(before + MAX_PAN, Math.max(before - MAX_PAN, samples[i][3]));
}

const step = KEEP_EVERY / DECODE_FPS;
const rows = samples
  .map(
    ([cx, cy, h, sun, shape, wing]) =>
      `  [${cx.toFixed(3)}, ${cy.toFixed(3)}, ${h.toFixed(3)}, ${Math.round(sun)}, ${shape.toFixed(2)}, ${wing.toFixed(2)}],`
  )
  .join('\n');

writeFileSync(
  OUT,
  `// Generated by scripts/track-hero-video.mjs from public/video/hero.webm.
// Do not edit by hand: re-run the script if the video changes.

/** Seconds between samples. */
export const HERO_TRACK_STEP = ${step};

/**
 * Where the paramotor is in the hero footage, one row per sample:
 * [centre x, centre y, height, sun offset, shape, wing].
 *
 * The first three are fractions of the video frame. Sun offset is how far the
 * subject sits from the sun in degrees of azimuth (negative: sun to its right),
 * measured from the glare when it is in frame and estimated from how dim the
 * sky is when it is not. Shape is the canopy's width over the height of the
 * whole silhouette and wing is the share of that height the canopy takes up;
 * between them they say which way the paramotor is facing and how steeply it
 * is being looked up at.
 */
export const HERO_TRACK: readonly (readonly [number, number, number, number, number, number])[] = [
${rows}
];
`
);

console.log(`Wrote ${samples.length} samples (${step}s apart) to ${OUT}`);
