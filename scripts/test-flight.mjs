/**
 * Checks the flyable hero's maths with no browser: the flight model, the
 * autopilots, the tracking camera, the silhouette's fill geometry, the
 * controller that trades resolution for frame rate, and the shader minifier
 * the single-file build uses.
 *
 * These are the parts where a sign error is invisible until it is on screen
 * as a paramotor that turns the wrong way, a camera that flips as the wing
 * passes overhead, or a canopy with holes in it. Each check below pins one of
 * those down. The sky shader and the input wiring need a real browser and are
 * not covered here.
 *
 *   npm run flight:test
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) => import(resolve(here, '../src/flight', name));

const { cross, dot, length, sub } = await load('vec.ts');
const { bodyAxes, createCraft, flyOrbit, flyToward, stepCraft } = await load('sim.ts');
const { CHASE_TAN, GROUND_EYE, chasePoint, createCamera, project, rayThrough, trackCamera, zoomFor } =
  await load('camera.ts');
const { RIG_CENTRE, RIG_HEIGHT, RIG_SPAN, drawGlider } = await load('glider.ts');
const { createPacer } = await load('pace.ts');
const { minifyWgsl } = await import(resolve(here, 'build-flight-html.mjs'));
const { readFileSync } = await import('node:fs');

let failed = 0;
const check = (name, condition, detail = '') => {
  console.log(`${condition ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failed += 1;
};

const DT = 1 / 60;
const VIEW = { width: 1440, height: 900 };
const ASPECT = VIEW.width / VIEW.height;
const HANDS_OFF = { steer: 0, power: 0 };
const fmt = (n) => n.toFixed(2);

/** Fly `craft` for `seconds`, asking `pilot(craft, time)` for controls each step. */
function fly(craft, seconds, pilot, eachStep = () => {}) {
  for (let t = 0; t < seconds; t += DT) {
    stepCraft(craft, pilot(craft, t), DT, t);
    eachStep(t);
  }
  return craft;
}

const rigCentre = (craft) => {
  const { up } = bodyAxes(craft);
  return [craft.pos[0] + up[0] * RIG_CENTRE, craft.pos[1] + up[1] * RIG_CENTRE, craft.pos[2] + up[2] * RIG_CENTRE];
};

/* ------------------------------------------------------------------------ */
console.log('\nConventions — which way is which');

{
  const north = fly(createCraft([0, 60, 0], 0), 1, () => HANDS_OFF);
  const east = fly(createCraft([0, 60, 0], Math.PI / 2), 1, () => HANDS_OFF);
  check(
    'heading 0 flies north (+z)',
    north.pos[2] > 10 && Math.abs(north.pos[0]) < 1, north.pos.map(fmt).join(', ')
  );
  check(
    'heading 90° flies east (+x)',
    east.pos[0] > 10 && Math.abs(east.pos[2]) < 1, east.pos.map(fmt).join(', ')
  );

  const turning = fly(createCraft([0, 60, 0], 0), 2, () => ({ steer: 1, power: 0 }));
  check(
    'right brake banks right and turns right',
    turning.bank > 0.4 && turning.heading > 0.5,
    `bank ${fmt(turning.bank)}, heading ${fmt(turning.heading)}`
  );

  const banked = createCraft([0, 60, 0], 0);
  banked.bank = 0.5;
  const axes = bodyAxes(banked);
  check('a right bank lowers the right wingtip', axes.right[1] < -0.4, `right.y ${fmt(axes.right[1])}`);
  check('and swings the wing toward the inside of the turn', axes.up[0] > 0.4, `up.x ${fmt(axes.up[0])}`);

  const climbing = fly(createCraft([0, 60, 0], 0), 5, () => ({ steer: 0, power: 1 }));
  const sinking = fly(createCraft([0, 60, 0], 0), 5, () => ({ steer: 0, power: -1 }));
  check('throttle climbs', climbing.pos[1] > 68 && climbing.pitch > 0, `altitude ${fmt(climbing.pos[1])}`);
  check('idle sinks', sinking.pos[1] < 54, `altitude ${fmt(sinking.pos[1])}`);

  const spiral = fly(createCraft([0, 120, 0], 0), 6, () => ({ steer: 1, power: 0 }));
  check(
    'a hard turn with no extra power loses height',
    spiral.pos[1] < 117,
    `altitude ${fmt(spiral.pos[1])}`
  );

  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const c = createCraft([0, 60, 0], i * 0.37);
    c.bank = Math.sin(i * 1.3) * 0.9;
    c.pitch = Math.cos(i * 0.7) * 0.4;
    const { right, up, fwd } = bodyAxes(c);
    const handed = sub(cross(up, fwd), right);
    worst = Math.max(
      worst,
      Math.abs(length(right) - 1),
      Math.abs(length(up) - 1),
      Math.abs(length(fwd) - 1),
      Math.abs(dot(right, up)),
      Math.abs(dot(up, fwd)),
      length(handed)
    );
  }
  check(
    'body axes stay square and right-handed at any attitude',
    worst < 1e-9,
    `worst error ${worst.toExponential(1)}`
  );
}

/* ------------------------------------------------------------------------ */
console.log('\nLimits — the scene has no ground and no edge, so these are soft');

{
  let lowest = Infinity;
  let sinkNearFloor = 0;
  const diver = createCraft([0, 60, 0], 0);
  fly(diver, 120, () => ({ steer: 1, power: -1 }), () => {
    lowest = Math.min(lowest, diver.pos[1]);
    if (diver.pos[1] < 12) sinkNearFloor = Math.max(sinkNearFloor, -diver.climb);
  });
  // The cloud tops reach to 2.5 m below the field; the floor keeps the rig clear of them.
  check('a full-brake, idle spiral never reaches the cloud tops', lowest > 6, `lowest ${fmt(lowest)} m`);
  check(
    'and eases onto the floor instead of hitting it',
    sinkNearFloor < 1.5,
    `sinking ${fmt(sinkNearFloor)} m/s at most below 12 m`
  );

  let highest = 0;
  const climber = createCraft([0, 60, 0], 0);
  fly(climber, 300, () => ({ steer: 0, power: 1 }), () => (highest = Math.max(highest, climber.pos[1])));
  check(
    'full throttle tops out under the ceiling',
    highest < 245 && highest > 200,
    `highest ${fmt(highest)} m`
  );

  const runaway = fly(createCraft([0, 60, 50], 0.4), 300, () => HANDS_OFF);
  const range = Math.hypot(runaway.pos[0], runaway.pos[2]);
  check('flying straight out for five minutes stays within sight', range < 445, `range ${fmt(range)} m`);

  // Past the fence it should still be free to turn round and come home.
  const back = fly(runaway, 60, (c) => flyToward(c, [0, 60, 0]));
  check(
    'and can still fly back from the fence',
    Math.hypot(back.pos[0], back.pos[2]) < 300,
    `range ${fmt(Math.hypot(back.pos[0], back.pos[2]))} m`
  );
}

/* ------------------------------------------------------------------------ */
console.log('\nAutopilots');

for (const dir of [1, -1]) {
  const orbit = { cx: 20, cz: 90, radius: 30, altitude: 55, dir };
  const craft = createCraft([-90, 80, 10], 2.5);
  fly(craft, 90, (c, t) => flyOrbit(c, orbit, t));

  let offCircle = 0;
  let offHeight = 0;
  let swept = 0;
  let before = Math.atan2(craft.pos[0] - orbit.cx, craft.pos[2] - orbit.cz);
  fly(craft, 60, (c, t) => flyOrbit(c, orbit, 90 + t), () => {
    const rx = craft.pos[0] - orbit.cx;
    const rz = craft.pos[2] - orbit.cz;
    offCircle = Math.max(offCircle, Math.abs(Math.hypot(rx, rz) - orbit.radius));
    offHeight = Math.max(offHeight, Math.abs(craft.pos[1] - orbit.altitude));
    const now = Math.atan2(rx, rz);
    swept += Math.atan2(Math.sin(now - before), Math.cos(now - before));
    before = now;
  });
  const way = dir === 1 ? 'clockwise' : 'anticlockwise';
  check(
    `orbit (${way}): arrives from far off and holds the circle`,
    offCircle < 6,
    `worst ${fmt(offCircle)} m off`
  );
  check(`orbit (${way}): holds its height`, offHeight < 9, `worst ${fmt(offHeight)} m off`);
  check(
    `orbit (${way}): goes round the way it was asked`,
    Math.sign(swept) === dir && Math.abs(swept) > 6,
    `${fmt(swept)} rad swept`
  );
}

{
  const target = [140, 95, -60];
  const craft = createCraft([0, 60, 80], 0);
  let nearest = Infinity;
  let heightAtNearest = 0;
  fly(craft, 60, (c) => flyToward(c, target), () => {
    const gap = Math.hypot(craft.pos[0] - target[0], craft.pos[2] - target[2]);
    if (gap < nearest) {
      nearest = gap;
      heightAtNearest = craft.pos[1];
    }
  });
  check('pointer steering reaches the point asked for', nearest < 12, `nearest ${fmt(nearest)} m`);
  check(
    'and climbs to it on the way',
    Math.abs(heightAtNearest - target[1]) < 8,
    `height ${fmt(heightAtNearest)} m`
  );
}

/* ------------------------------------------------------------------------ */
console.log('\nCamera');

{
  const target = [10, 60, 80];
  const frame = { x: -0.3, y: 0.06 };
  const cam = createCamera(target, frame, 0.14, ASPECT);
  const at = { x: 0, y: 0, scale: 0 };
  project(cam, VIEW, ...target, at);
  const wantX = ((frame.x + 1) / 2) * VIEW.width;
  const wantY = ((1 - frame.y) / 2) * VIEW.height;
  check(
    'a new camera frames its subject where it was told to',
    Math.hypot(at.x - wantX, at.y - wantY) < 1,
    `${fmt(at.x)}, ${fmt(at.y)} vs ${fmt(wantX)}, ${fmt(wantY)}`
  );

  const east = { x: 0, y: 0, scale: 0 };
  const higher = { x: 0, y: 0, scale: 0 };
  project(cam, VIEW, target[0] + 5, target[1], target[2], east);
  project(cam, VIEW, target[0], target[1] + 5, target[2], higher);
  check(
    'looking north, east is to the right of the picture',
    east.x > at.x + 20,
    `${fmt(east.x)} vs ${fmt(at.x)}`
  );
  check('and up is toward the top', higher.y < at.y - 20, `${fmt(higher.y)} vs ${fmt(at.y)}`);

  const ray = rayThrough(cam, VIEW, at.x, at.y);
  const toTarget = sub(target, cam.pos);
  check(
    'a ray through a projected point leads back to it',
    length(cross(ray, toTarget)) / length(toTarget) < 1e-6
  );

  const near = zoomFor(60, RIG_HEIGHT, RIG_SPAN, ASPECT);
  const far = zoomFor(300, RIG_HEIGHT, RIG_SPAN, ASPECT);
  check('the camera zooms in as the rig flies away', far < near, `tan ${fmt(far)} vs ${fmt(near)}`);
  check(
    'but not so far that distance disappears',
    1 / (300 * far) < 1 / (60 * near), 'the rig still gets smaller'
  );
  const tall = zoomFor(90, RIG_HEIGHT, RIG_SPAN, 390 / 844);
  check(
    'on a phone the whole wingspan fits across the screen',
    RIG_SPAN / 2 / (90 * tall * (390 / 844)) < 0.5,
    `half-span at ${fmt(RIG_SPAN / 2 / (90 * tall * (390 / 844)))} of half-width`
  );
}

/** Follow `craft` with a camera for `seconds` and report how the camera behaved. */
function film(craft, seconds, pilot) {
  const frame = { x: -0.3, y: 0.06 };
  const cam = createCamera(rigCentre(craft), frame, 0.14, ASPECT);
  const at = { x: 0, y: 0, scale: 0 };
  const report = { strayed: 0, edge: 0, jerk: 0, skew: 0, steepest: 0, finite: true };
  fly(craft, seconds, pilot, () => {
    const centre = rigCentre(craft);
    const before = cam.right;
    const zoom = zoomFor(length(sub(centre, cam.pos)), RIG_HEIGHT, RIG_SPAN, ASPECT);
    trackCamera(cam, centre, frame, zoom, 1.6, 0.5, ASPECT, DT);

    report.finite &&= project(cam, VIEW, ...centre, at) && Number.isFinite(at.x + at.y);
    // Position in the picture, -1 to 1 on each axis.
    const x = (at.x / VIEW.width) * 2 - 1;
    const y = 1 - (at.y / VIEW.height) * 2;
    report.strayed = Math.max(report.strayed, Math.abs(x - frame.x), Math.abs(y - frame.y));
    report.edge = Math.max(report.edge, Math.abs(x), Math.abs(y));
    // How far the picture rolled or swung in one frame, in degrees.
    report.jerk = Math.max(report.jerk, (Math.acos(Math.min(1, dot(before, cam.right))) * 180) / Math.PI);
    report.skew = Math.max(
      report.skew,
      Math.abs(dot(cam.right, cam.up)),
      Math.abs(dot(cam.up, cam.fwd)),
      Math.abs(length(cam.fwd) - 1),
      length(sub(cross(cam.up, cam.fwd), cam.right))
    );
    report.steepest = Math.max(report.steepest, (Math.asin(cam.fwd[1]) * 180) / Math.PI);
  });
  return report;
}

{
  const orbit = { cx: 0, cz: 100, radius: 30, altitude: 50, dir: -1 };
  const shot = film(createCraft([0, 50, 70], Math.PI / 2), 90, (c, t) => flyOrbit(c, orbit, t));
  check(
    'following an orbit, the rig stays near where the camera holds it',
    shot.strayed < 0.35,
    `strays ${fmt(shot.strayed)} of a half-frame at most`
  );
  check('and the picture never jolts', shot.jerk < 0.5, `${fmt(shot.jerk)}° in one frame at most`);

  // The hard case: straight over the top of the camera, low and fast. A
  // look-at camera spins half a turn at the zenith; this one must not.
  const overhead = film(createCraft([0, 26, -140], 0), 26, () => HANDS_OFF);
  check(
    'a low pass directly overhead tips the camera right back',
    overhead.steepest > 80,
    `looks up to ${fmt(overhead.steepest)}°`
  );
  check('without the picture spinning', overhead.jerk < 3, `${fmt(overhead.jerk)}° in one frame at most`);
  check(
    'or the rig leaving it',
    overhead.finite && overhead.edge < 0.95,
    `gets ${fmt(overhead.edge)} of the way to the edge at most`
  );
  check(
    'and the camera axes stay square throughout',
    Math.max(shot.skew, overhead.skew) < 1e-9,
    `worst error ${Math.max(shot.skew, overhead.skew).toExponential(1)}`
  );
}

{
  // The chase camera: behind the wing, below the pilot, and reachable from
  // the ground without the picture jumping at either end of the move.
  const craft = createCraft([120, 60, -40], 0.9);
  const { fwd } = bodyAxes(craft);
  const chase = chasePoint(craft.pos, craft.heading, ASPECT);
  const behind = dot(sub(craft.pos, chase), [fwd[0], 0, fwd[2]]);
  check(
    'the chase camera sits behind the rig on its line of flight',
    behind > 20 && behind < 30,
    `${fmt(behind)} m back`
  );
  check(
    'and a little below the pilot, to look up at the wing',
    chase[1] < craft.pos[1] && chase[1] > craft.pos[1] - 3,
    `${fmt(craft.pos[1] - chase[1])} m below`
  );
  const phone = chasePoint(craft.pos, craft.heading, 390 / 844);
  const fits = RIG_SPAN / 2 / (length(sub(craft.pos, phone)) * CHASE_TAN * (390 / 844));
  check(
    'on a phone it drops back far enough to fit the wingspan',
    fits < 0.6,
    `half-span at ${fmt(fits)} of half-width`
  );

  // Fly an orbit while the camera travels up and back, as flight.ts moves it.
  const orbit = { cx: 0, cz: 100, radius: 30, altitude: 50, dir: -1 };
  const pilot = createCraft([0, 50, 70], Math.PI / 2);
  const frame = { x: -0.2, y: -0.05 };
  const cam = createCamera(rigCentre(pilot), frame, 0.14, ASPECT);
  const at = { x: 0, y: 0, scale: 0 };
  let heading = pilot.heading;
  let edge = 0;
  let jerk = 0;
  let leap = 0;
  let closest = Infinity;
  fly(pilot, 16, (c, t) => flyOrbit(c, orbit, t), (t) => {
    const lift = Math.min(1, Math.max(0, t < 8 ? (t - 1) / 3.6 : (11.6 - t) / 3.6));
    const ride = lift * lift * (3 - 2 * lift);
    heading += Math.atan2(Math.sin(pilot.heading - heading), Math.cos(pilot.heading - heading)) * (1 - Math.exp(-DT / 0.9));
    const want = chasePoint(pilot.pos, heading, ASPECT);
    const was = [...cam.pos];
    const right = cam.right;
    for (let i = 0; i < 3; i++) cam.pos[i] = GROUND_EYE[i] + (want[i] - GROUND_EYE[i]) * ride;
    const centre = rigCentre(pilot);
    const groundZoom = zoomFor(length(sub(centre, GROUND_EYE)), RIG_HEIGHT, RIG_SPAN, ASPECT);
    trackCamera(cam, centre, frame, groundZoom * Math.pow(CHASE_TAN / groundZoom, ride), 0.3, 0.5 - 0.3 * ride, ASPECT, DT);
    project(cam, VIEW, ...centre, at);
    edge = Math.max(edge, Math.abs((at.x / VIEW.width) * 2 - 1), Math.abs(1 - (at.y / VIEW.height) * 2));
    jerk = Math.max(jerk, (Math.acos(Math.min(1, dot(right, cam.right))) * 180) / Math.PI);
    leap = Math.max(leap, length(sub(cam.pos, was)));
    closest = Math.min(closest, length(sub(centre, cam.pos)));
  });
  check(
    'lifting off and coming back down keeps the rig in the picture',
    edge < 0.9,
    `gets ${fmt(edge)} of the way to the edge at most`
  );
  check(
    'the camera travels without a jump',
    leap < 1.2 && jerk < 2.5,
    `${fmt(leap)} m and ${fmt(jerk)}° in one frame at most`
  );
  check('and never flies through the rig', closest > 15, `closest ${fmt(closest)} m`);
}

/* ------------------------------------------------------------------------ */
console.log('\nSilhouette');

{
  // A stand-in for the 2D context that records the canopy's fill: the first
  // fill() the renderer makes. Each closed sub-path's signed area says which
  // way it winds on screen.
  const recorder = () => {
    const state = { paths: [], canopy: null, fills: 0, finite: true };
    let current = null;
    const point = (x, y) => {
      state.finite &&= Number.isFinite(x) && Number.isFinite(y);
      return [x, y];
    };
    const ctx = {
      beginPath: () => (state.paths = []),
      moveTo: (x, y) => state.paths.push((current = [point(x, y)])),
      lineTo: (x, y) => (current ? current.push(point(x, y)) : state.paths.push((current = [point(x, y)]))),
      closePath: () => {},
      arc: (x, y) => point(x, y),
      stroke: () => {},
      fill: () => {
        state.fills += 1;
        if (state.fills === 1) state.canopy = state.paths;
        current = null;
      },
    };
    return { ctx, state };
  };
  const area = (path) => path.reduce((sum, [x, y], i) => {
    const [nx, ny] = path[(i + 1) % path.length];
    return sum + x * ny - nx * y;
  }, 0);

  let panels = 0;
  let mixed = 0;
  let finite = true;
  for (let i = 0; i < 60; i++) {
    const elevation = 0.15 + (i % 6) * 0.25;
    const craft = createCraft([0, Math.sin(elevation) * 80, Math.cos(elevation) * 80], i * 0.61);
    craft.bank = Math.sin(i * 0.9) * 0.7;
    craft.pitch = Math.cos(i * 1.7) * 0.3;
    craft.steer = Math.sin(i * 0.9);
    const cam = createCamera(rigCentre(craft), { x: 0, y: 0 }, 0.14, ASPECT);
    const { ctx, state } = recorder();
    drawGlider(ctx, cam, VIEW, craft);

    const signs = state.canopy.map(area).filter((a) => Math.abs(a) > 1e-6).map(Math.sign);
    panels += signs.length;
    if (new Set(signs).size > 1) mixed += 1;
    finite &&= state.finite;
  }
  check(
    'every canopy panel winds the same way on screen, from any angle',
    mixed === 0 && panels > 10000,
    `${panels} panels over 60 views, ${mixed} views mixed`
  );
  check('nothing is drawn at a broken coordinate', finite);
}

/* ------------------------------------------------------------------------ */
console.log('\nPace — resolution is traded for frame rate only where that works');

{
  const BEAT = 1 / 60;
  const FLOOR = 0.4;
  const ms = (seconds) => `${(seconds * 1000).toFixed(1)} ms`;

  /**
   * Fly a simulated device for `seconds` and report how its frames went.
   *
   * `cost` is the GPU time of a full-resolution frame; it follows the number
   * of pixels drawn, and `load(t)` scales it as the view changes. A frame is
   * shown on the next beat of the screen after it is ready, and never sooner
   * than a browser's `cap(t)`. `deliver`, if given, replaces that rule.
   */
  function device({ cost, beat = BEAT, cap = () => 0, seconds = 60, load = () => 1, deliver = null }) {
    const pacer = createPacer(FLOOR);
    pacer.settle(1.2);
    const log = { cuts: 0, restores: 0, soft: 0, lastChange: 0, lowest: 1, highest: 1, tail: 0, tailFrames: 0 };
    let t = 0;
    for (let n = 0; t < seconds; n++) {
      const gpu = cost * pacer.scale ** 2 * load(t);
      const frame = deliver ? deliver(gpu, n) : Math.max(Math.ceil(gpu / beat - 1e-6) * beat, cap(t), beat);
      const before = pacer.scale;
      if (pacer.frame(frame)) {
        if (pacer.scale < before) log.cuts += 1;
        else log.restores += 1;
        log.lastChange = t;
      }
      if (pacer.scale < 1) log.soft += frame;
      log.lowest = Math.min(log.lowest, pacer.scale);
      log.highest = Math.max(log.highest, pacer.scale);
      t += frame;
      // How the last ten seconds ran is how the flight ended up.
      if (t > seconds - 10) {
        log.tail += frame;
        log.tailFrames += 1;
      }
    }
    return { ...log, scale: pacer.scale, pace: log.tail / log.tailFrames };
  }

  const fast = device({ cost: 0.006 });
  check('a GPU with time to spare is left at full resolution', fast.scale === 1 && fast.cuts === 0);

  const twoBeats = device({ cost: 0.03 });
  check(
    'one that needs two beats a frame is brought back to one',
    twoBeats.pace < BEAT * 1.01 && twoBeats.scale > FLOOR && twoBeats.lastChange < 5,
    `${ms(twoBeats.pace)} at ${twoBeats.scale.toFixed(2)} of full size, settled in ${twoBeats.lastChange.toFixed(1)} s`
  );

  // A cut of one fixed step would leave this one a shade too slow for the
  // next beat, see no change at all, and give up.
  const justOver = device({ cost: 0.033 });
  check('the cut is deep enough to reach the next beat', justOver.pace < BEAT * 1.01, ms(justOver.pace));

  const slow = device({ cost: 0.1 });
  check(
    'a slow one gets there in a few seconds',
    slow.pace < BEAT * 1.01 && slow.lastChange < 6,
    `${ms(slow.pace)} at ${slow.scale.toFixed(2)}, settled in ${slow.lastChange.toFixed(1)} s`
  );

  const hopeless = device({ cost: 0.4 });
  check(
    'a hopeless one goes to the floor and no further',
    hopeless.scale === FLOOR && hopeless.lowest === FLOOR && hopeless.lastChange < 8,
    `${ms(hopeless.pace)} at ${hopeless.scale.toFixed(2)}, settled in ${hopeless.lastChange.toFixed(1)} s`
  );

  // A browser saving power draws 30 frames a second however little there is to draw.
  const capped = device({ cost: 0.006, cap: () => 1 / 30, seconds: 180 });
  check(
    'a browser capped at 30 fps gets its detail back, and is then left alone',
    capped.scale === 1 && capped.cuts === 3 && capped.restores === 3 && capped.lastChange < 30 && capped.soft < 8,
    `${capped.cuts} cuts, all restored; ${capped.soft.toFixed(1)} s spent soft, the last of it at ${capped.lastChange.toFixed(1)} s`
  );

  // The cap tightens while the first cut is on trial. That looks like a view
  // getting costlier, so the cut is deepened; when that changes nothing
  // either, all of the detail has to come back, not just the last step of it.
  const tightened = device({ cost: 0.006, cap: (t) => (t < 2.8 ? 1 / 30 : 1 / 20), seconds: 180 });
  check(
    'and gets all of it back if the cap changed along the way',
    tightened.scale === 1 && tightened.restores === 3,
    `${tightened.cuts} cuts, ${tightened.restores} restored, ending at ${tightened.scale.toFixed(2)}`
  );

  const fifty = device({ cost: 0.006, beat: 1 / 50 });
  check('a 50 Hz screen keeping time is left alone', fifty.scale === 1 && fifty.cuts === 0);

  // A backed-up pipeline does not slow every frame alike. Two arrive on the
  // beat and the third carries the wait: 17, 17, 108 ms. Averaged with long
  // frames clamped, that looks the same before and after a cut.
  const backedUp = device({
    cost: 0.047,
    deliver: (gpu, n) => (gpu <= BEAT ? BEAT : n % 3 === 2 ? 3 * gpu - 2 * BEAT : BEAT),
  });
  check(
    'a backed-up pipeline is measured by what it delivers, not by its typical frame',
    backedUp.pace < BEAT * 1.1 && backedUp.scale < 1,
    `${ms(backedUp.pace)} a frame on average at ${backedUp.scale.toFixed(2)}, from ${ms(0.047)}`
  );

  // The same thing when it is only a little behind, as timed on a laptop's
  // integrated GPU: 19 ms of work a frame shows up as a 65 ms frame twice a
  // second among frames that are on the beat.
  const littleBehind = device({
    cost: 0.0189,
    deliver: (gpu, n) => (gpu <= BEAT ? BEAT : n % 22 === 21 ? BEAT + 22 * (gpu - BEAT) : BEAT),
  });
  check(
    'so is one that is only a little behind',
    littleBehind.pace < BEAT * 1.01 && littleBehind.scale < 1 && littleBehind.lastChange < 4,
    `${ms(littleBehind.pace)} at ${littleBehind.scale.toFixed(2)}, settled in ${littleBehind.lastChange.toFixed(1)} s`
  );

  // Three beats of a 144 Hz screen is 48 frames a second, and steady.
  const quick = device({ cost: 0.02, beat: 1 / 144 });
  check('a fast screen held to a steady 48 fps is left alone', quick.scale === 1 && quick.cuts === 0, ms(quick.pace));

  const hitches = device({ cost: 0.006, deliver: (gpu, n) => (n % 200 === 100 ? 0.4 : BEAT) });
  check('a hitch every few seconds changes nothing', hitches.scale === 1 && hitches.cuts === 0);

  // The view more than doubles in cost just as the first cut is being timed,
  // which is what lift-off does. Frames get slower in spite of the cut, and
  // giving the detail back would be exactly the wrong answer.
  const liftOff = device({ cost: 0.03, load: (t) => (t < 2.8 ? 1 : 2.6) });
  check(
    'a view that gets costlier while a cut is on trial gets a deeper cut, not its detail back',
    liftOff.restores === 0 && liftOff.cuts >= 2 && liftOff.pace < BEAT * 1.01 && liftOff.lastChange < 7,
    `${liftOff.cuts} cuts, ${liftOff.restores} taken back; ${ms(liftOff.pace)} at ${liftOff.scale.toFixed(2)}, settled in ${liftOff.lastChange.toFixed(1)} s`
  );

  // The unlucky version: it gets costlier by just what the cut saved, so the
  // frames come out the same and the cut looks useless. That one costs a
  // wrong turn, and is put right on the next try.
  const offset = device({ cost: 0.024, load: (t) => (t < 2.8 ? 1 : 2.4) });
  check(
    'one whose rising cost hides the gain is put right on the next try',
    offset.restores === 1 && offset.pace < BEAT * 1.01 && offset.lastChange < 12,
    `${offset.cuts} cuts, ${offset.restores} taken back; ${ms(offset.pace)} at ${offset.scale.toFixed(2)}, settled in ${offset.lastChange.toFixed(1)} s`
  );

  // Capped at first, as a laptop is until it is plugged in: no cut can show
  // a gain, and the detail goes back. Then the cap lifts and the GPU is the
  // limit after all.
  const uncapped = device({ cost: 0.03, cap: (t) => (t < 6 ? 1 / 30 : 0) });
  check(
    'a cut that could not help at first is tried again later',
    uncapped.restores >= 1 && uncapped.pace < BEAT * 1.01 && uncapped.scale < 1,
    `${uncapped.restores} taken back, then ${ms(uncapped.pace)} at ${uncapped.scale.toFixed(2)}`
  );

  const all = [fast, twoBeats, justOver, slow, hopeless, capped, fifty, backedUp, littleBehind, quick, hitches, liftOff, offset, uncapped, tightened];
  check(
    'the scale never leaves the range it was given',
    all.every((d) => d.lowest >= FLOOR && d.highest <= 1)
  );
}

/* ------------------------------------------------------------------------ */
console.log('\nPacking — the single-file build minifies the shaders itself');

{
  check('comments go', minifyWgsl('let a = 1; // one\n/* two\n lines */ let b = 2;') === 'let a=1;let b=2;');
  check(
    'words keep the space between them, punctuation loses it',
    minifyWgsl('fn  wrap ( x : f32 ) -> f32 { return x ; }') === 'fn wrap(x:f32)->f32{return x;}'
  );
  check(
    'numbers are written short, and stay the numbers they were',
    minifyWgsl('vec4f(1.0, 0.5, 10.0, 0.0) * 289.0 + 1e-4 + 2u + 6.2831853 + 100') === 'vec4f(1.,.5,10.,0.)*289.+1e-4+2u+6.2831853+100',
    minifyWgsl('vec4f(1.0, 0.5, 10.0, 0.0) * 289.0 + 1e-4 + 2u + 6.2831853 + 100')
  );
  check(
    'operators that would run together into another one are kept apart',
    minifyWgsl('a - -b; c / *d; e < -f; i++; j -= 1; k = -m;') === 'a- -b;c/ *d;e< -f;i++;j-=1;k= -m;',
    minifyWgsl('a - -b; c / *d; e < -f; i++; j -= 1; k = -m;')
  );
  check('a number after a word keeps its space', minifyWgsl('return 0.5; return 1.0;') === 'return .5;return 1.;');

  // The real shaders: nothing but spacing, comments and the spelling of
  // numbers may change, so the words in them must come through untouched.
  const words = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').match(/[A-Za-z_][A-Za-z0-9_]*/g).join(' ');
  for (const file of ['sky-gpu.ts', 'ink-gpu.ts']) {
    const source = readFileSync(resolve(here, '../src/flight', file), 'utf8').match(/\/\* wgsl \*\/ `([^`]*)`/)[1];
    const small = minifyWgsl(source);
    check(
      `${file}: every word survives, in order, and only code is left`,
      words(small) === words(source) && small.length < source.length && !small.includes('//') && !small.includes('\n'),
      `${source.length} characters to ${small.length}`
    );
  }
}

console.log(failed ? `\n${failed} check(s) failed\n` : '\nAll checks passed\n');
process.exit(failed ? 1 : 0);
