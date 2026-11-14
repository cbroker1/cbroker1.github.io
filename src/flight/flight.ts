/**
 * The flyable hero.
 *
 * The homepage opens on footage of a paramotor against the sky. This module
 * lets a visitor take that paramotor over: it builds a live scene that looks
 * like the footage, starts it from wherever the footage currently is, then
 * lifts the camera off the ground to ride behind the wing and hands the
 * brakes and throttle to the keyboard or a held pointer.
 *
 * Nothing here loads until someone asks to fly. `Hero.astro` imports this file
 * on demand and owns the button, the fade and the video; this file owns the
 * scene, the input and the frame loop.
 */

import {
  type Camera,
  type FramePoint,
  type Projected,
  CHASE_TAN,
  GROUND_EYE,
  chasePoint,
  createCamera,
  project,
  rayThrough,
  trackCamera,
  zoomFor,
} from './camera.ts';
import { RIG_CENTRE, RIG_HEIGHT, RIG_SPAN, rigOutline } from './glider.ts';
import { HERO_TRACK, HERO_TRACK_STEP } from './hero-track.ts';
import { createPacer } from './pace.ts';
import {
  type Controls,
  type Craft,
  type Orbit,
  bodyAxes,
  createCraft,
  flyOrbit,
  flyToward,
  stepCraft,
} from './sim.ts';
import type { Ink, Sky, SkyFactory } from './sky.ts';
import { type Vec3, addScaled, clamp, ease, length, smoothstep, sub, wrapAngle } from './vec.ts';

const RADIANS = Math.PI / 180;

/**
 * A low sun, due north. The footage was shot into one, and its glare sits
 * level with the paramotor, which it looks up at by about this much.
 */
const SUN_ELEVATION = 16 * RADIANS;
const SUN: Vec3 = [0, Math.sin(SUN_ELEVATION), Math.cos(SUN_ELEVATION)];

// How far from the camera the paramotor is at the moment of takeover, and
// the lowest the circle it then flies is allowed to be.
const START_RANGE = 90;
const ORBIT_RADIUS = 30;
const ORBIT_FLOOR = 28;

/** Hands off the controls for this long and the autopilot starts circling. */
const IDLE_SECONDS = 5;
/**
 * The autopilot takes this long to lean into its turn, starting this long
 * after it takes the controls. At takeover that keeps the rig the shape the
 * footage left it in until the footage has faded out from under it.
 */
const EASE_IN: [number, number] = [0.9, 3];

/**
 * Where in the frame the ground camera holds the paramotor once it has
 * settled. The page's name block is still showing then: left of centre on a
 * wide screen keeps clear of it on the right, and high and central does on a
 * narrow one, where that block sits at the bottom.
 */
const GROUND_WIDE: FramePoint = { x: -0.3, y: 0.06 };
const GROUND_NARROW: FramePoint = { x: 0, y: 0.3 };
/**
 * The same for the chase camera. The name block steps aside while it is up,
 * so it has the frame to itself: a little off centre, which sits better than
 * dead centre, and to the right, clear of the instrument panel at lower
 * left; low enough to keep the horizon low in the picture.
 */
const CHASE_WIDE: FramePoint = { x: 0.1, y: -0.05 };
const CHASE_NARROW: FramePoint = { x: 0, y: -0.02 };

/**
 * How strongly the suspension lines are drawn from the ground and from
 * behind the wing. Filmed from the ground into the light they all but
 * vanish, and the takeover has to match that; from a few metres behind they
 * are part of the picture.
 */
const LINE_INK_GROUND = 0.05;
const LINE_INK_CHASE = 0.2;

/**
 * For this long after takeover the camera holds the paramotor exactly where
 * and as big as the footage had it. The footage is still fading out
 * underneath, and two paramotors drifting apart is the one thing a handoff
 * must not show. Only after that does the camera go back to trailing its
 * subject the way a hand-held one does.
 */
const TAKEOVER_HOLD = 0.9;

/** How long after takeover the camera stays on the ground before lifting off. */
const LIFTOFF_DELAY = 1.2;
/** Seconds the camera takes to travel between the ground and the wing. */
const LIFT_SECONDS = 3.6;

/** The world is drawn at up to this many pixels: full resolution on a 1080p screen. */
const SKY_PIXELS = 2.4e6;
/** It is never drawn smaller than this share of that each way, however slow the frames. */
const SKY_FLOOR = 0.4;
/**
 * Frame times are not judged for this long after a start. The first second
 * carries the shader's compile time and the footage still playing underneath,
 * neither of which will last.
 */
const START_SETTLE = 1.2;

type Action = 'left' | 'right' | 'up' | 'down';
// Physical key positions, so W A S D works on any keyboard layout.
const KEYS: Record<string, Action> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  KeyA: 'left',
  KeyD: 'right',
  KeyW: 'up',
  KeyS: 'down',
};

export interface FlightElements {
  hero: HTMLElement;
  video: HTMLVideoElement | null;
  sky: HTMLCanvasElement;
  ink: HTMLCanvasElement;
  /** Holds one element per gauge, marked data-readout="altitude | speed | heading | pilot". */
  readout: HTMLElement;
  /** Switches between the ground and chase cameras. Its label is kept current here. */
  view: HTMLButtonElement;
}

export interface Flight {
  /** Take over from the video. Returns false if the scene cannot draw right now. */
  start(): boolean;
  /**
   * Stop. Returns the playback time at which the footage looks most like the
   * scene did, so the video can resume there. Null when no moment would: the
   * camera was off the ground, or nothing was flying.
   */
  stop(): number | null;
}

type Gauges = Record<'altitude' | 'speed' | 'heading' | 'pilot', HTMLElement>;

/**
 * Build the scene, drawn by whatever `makeSky` makes. Resolves to null when
 * the browser cannot draw it. `requestExit` is called when the visitor asks
 * to stop from inside the scene, and when the browser takes the GPU away in
 * the middle of a flight.
 */
export async function createFlight(
  els: FlightElements,
  requestExit: () => void,
  makeSky: SkyFactory
): Promise<Flight | null> {
  const sky = await makeSky(els.sky, SUN, requestExit);
  const ink = sky?.ink(els.ink);
  const gauge = (name: string) => els.readout.querySelector<HTMLElement>(`[data-readout="${name}"]`);
  const altitude = gauge('altitude');
  const speed = gauge('speed');
  const heading = gauge('heading');
  const pilot = gauge('pilot');
  if (!sky || !ink || !altitude || !speed || !heading || !pilot) return null;
  return buildFlight(els, sky, ink, { altitude, speed, heading, pilot }, requestExit);
}

function buildFlight(
  els: FlightElements,
  sky: Sky,
  ink: Ink,
  gauges: Gauges,
  requestExit: () => void
): Flight {
  const view = { width: 1, height: 1 };
  const narrow = window.matchMedia('(max-width: 768px)');
  const stillness = window.matchMedia('(prefers-reduced-motion: reduce)');
  const held = new Set<Action>();
  const spot: Projected = { x: 0, y: 0, scale: 0 };

  let pixelRatio = 1;
  let craft: Craft;
  let cam: Camera;
  let home: Orbit;
  let orbit: Orbit;
  let frameAtTakeover: FramePoint;
  /** The zoom at takeover times the paramotor's distance then: its size on screen, to be held. */
  let sizeAtTakeover = 0;

  let flying = false;
  let inView = true;
  let raf = 0;
  let last = 0;
  let clock = 0; // seconds of flight since takeover
  let lastInput = -Infinity;
  let autopilot = true;
  /** When the autopilot last took the controls, on the flight clock. */
  let engaged = 0;
  let pointer: { x: number; y: number } | null = null;
  let readoutDue = 0;
  /** Draws the world smaller when frames run long. It outlives a flight, so the next one starts where this one settled. */
  const pacer = createPacer(SKY_FLOOR);
  /** Which camera is wanted, and how far the camera has got toward it: 0 on the ground, 1 behind the wing. */
  let aloft = false;
  let lift = 0;
  let liftedOff = false;
  /** The heading the chase camera sits behind, which trails the rig's own. */
  let chaseHeading = 0;

  /* ------------------------------------------------------------- layout */

  function measure(): void {
    const rect = els.hero.getBoundingClientRect();
    view.width = Math.max(1, rect.width);
    view.height = Math.max(1, rect.height);
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    ink.resize(view.width, view.height, pixelRatio);
    const soften = pacer.scale * Math.min(1, Math.sqrt(SKY_PIXELS / (view.width * view.height)));
    sky.resize(Math.max(2, Math.round(view.width * soften)), Math.max(2, Math.round(view.height * soften)));
  }

  /* ----------------------------------------------------------- takeover */

  /**
   * Start the scene from the frame the video is showing: the paramotor at the
   * same place and size on screen and facing the same way, the camera facing
   * a sky about as bright.
   */
  function takeOver(): void {
    const [x, y, tall, sunOffset, shape, wing] = trackAt(els.video?.currentTime ?? 0);
    const footage = footageBox();
    const screenX = footage.left + x * footage.width;
    const screenY = footage.top + y * footage.height;
    const height = tall * footage.height;

    // On a narrow screen the footage crops the paramotor out of frame, so the
    // live one starts just off the edge and the camera swings round to find it.
    frameAtTakeover = {
      x: clamp((screenX / view.width) * 2 - 1, -1.35, 1.35),
      y: clamp(1 - (screenY / view.height) * 2, -1.2, 1.2),
    };
    const aspect = view.width / view.height;
    const azimuth = sunOffset * RADIANS;
    /** Put the rig at an elevation and heading, with a camera framing it as the footage does. */
    const stand = (elevation: number, heading: number, tanY: number) => {
      const ground = Math.cos(elevation) * START_RANGE;
      const seat: Vec3 = [
        Math.sin(azimuth) * ground,
        Math.sin(elevation) * START_RANGE - RIG_CENTRE,
        Math.cos(azimuth) * ground,
      ];
      craft = createCraft(seat, heading);
      cam = createCamera(rigCentre(), frameAtTakeover, tanY, aspect);
    };

    // Stand the rig the way the filmed one is standing. Two things about a
    // silhouette say how: how wide its canopy is against its height, which is
    // which way it faces, and how much of its height is canopy, which is how
    // steeply it is seen from below. Try each combination and keep the closest. It is
    // always flying away and to the right, on a left-hand circle, so that the
    // turn that follows brings the whole arc of the wing into view; and never
    // so low that the horizon would come into a frame the footage fills with sky.
    const zoom = RIG_HEIGHT / 2 / (START_RANGE * (height / view.height));
    let best = { miss: Infinity, elevation: 0, heading: 0, tall: height };
    for (let elevation = 16; elevation <= 46; elevation += 3) {
      for (let turn = 20; turn <= 90; turn += 5) {
        stand(elevation * RADIANS, azimuth + turn * RADIANS, zoom);
        const seen = rigOutline(cam, view, craft);
        const miss = (seen.shape - shape) ** 2 + (seen.wing - wing) ** 2;
        if (miss < best.miss) best = { miss, elevation: elevation * RADIANS, heading: craft.heading, tall: seen.tall };
      }
    }
    // Then set the zoom so that it is exactly as tall on screen as well.
    stand(best.elevation, best.heading, (zoom * best.tall) / height);
    sizeAtTakeover = cam.tanY * length(sub(rigCentre(), GROUND_EYE));

    const heading = best.heading;
    home = orbit = {
      cx: craft.pos[0] - Math.cos(heading) * ORBIT_RADIUS,
      cz: craft.pos[2] + Math.sin(heading) * ORBIT_RADIUS,
      radius: ORBIT_RADIUS,
      altitude: Math.max(craft.pos[1], ORBIT_FLOOR),
      dir: -1,
    };

    clock = 0;
    lastInput = -Infinity;
    autopilot = true;
    engaged = 0;
    readoutDue = 0;
    lift = 0;
    liftedOff = false;
    chaseHeading = heading;
    setView(false);
    pacer.settle(START_SETTLE);
  }

  function setView(up: boolean): void {
    aloft = up;
    // The page's name block bridges the takeover, then steps aside the first
    // time the camera leaves the ground and stays aside until the flight ends.
    if (up) els.hero.classList.add('hero--aloft');
    // The button names where it will take you, not where you are.
    els.view.textContent = up ? 'Ground view' : 'Chase view';
  }

  function switchView(): void {
    liftedOff = true;
    setView(!aloft);
    // With reduced motion the camera cuts between its two places.
    if (stillness.matches) lift = aloft ? 1 : 0;
  }

  /** Where the footage lands in the hero: 16:9, scaled to cover, centred. */
  function footageBox(): { left: number; top: number; width: number; height: number } {
    const width = els.video?.videoWidth || 1920;
    const height = els.video?.videoHeight || 1080;
    const cover = Math.max(view.width / width, view.height / height);
    return {
      left: (view.width - width * cover) / 2,
      top: (view.height - height * cover) / 2,
      width: width * cover,
      height: height * cover,
    };
  }

  /**
   * The takeover in reverse: the moment in the footage whose paramotor is
   * nearest the live one in place and size, under a sky about as bright.
   * Resuming the video there makes handing back as quiet as taking over.
   */
  function matchingFootage(): number {
    const centre = rigCentre();
    if (!project(cam, view, centre[0], centre[1], centre[2], spot)) return 0;
    const footage = footageBox();
    const x = (spot.x - footage.left) / footage.width;
    const y = (spot.y - footage.top) / footage.height;
    const tall = (RIG_HEIGHT * spot.scale) / footage.height;
    const sunOffset = Math.abs(Math.atan2(craft.pos[0], craft.pos[2])) / RADIANS;

    let best = 0;
    let bestCost = Infinity;
    HERO_TRACK.forEach(([tx, ty, tTall, tSun], i) => {
      const cost =
        (tx - x) ** 2 + (ty - y) ** 2 + 0.6 * (tTall - tall) ** 2 + 0.15 * ((Math.abs(tSun) - sunOffset) / 180) ** 2;
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    });
    return best * HERO_TRACK_STEP;
  }

  /** The point the camera follows: the middle of the rig, not the pilot. */
  function rigCentre(): Vec3 {
    return addScaled(craft.pos, bodyAxes(craft).up, RIG_CENTRE);
  }

  /* -------------------------------------------------------------- input */

  /** Who is flying this frame, and what they are asking for. */
  function readControls(): Controls {
    const steer = Number(held.has('right')) - Number(held.has('left'));
    const power = Number(held.has('up')) - Number(held.has('down'));
    if (steer !== 0 || power !== 0) {
      handsOn();
      return { steer, power };
    }

    if (pointer) {
      handsOn();
      // "Fly over there": the point under the pointer, at the paramotor's own
      // range. A press on the paramotor itself asks for nothing.
      const centre = rigCentre();
      project(cam, view, centre[0], centre[1], centre[2], spot);
      const reach = Math.hypot(pointer.x - spot.x, pointer.y - spot.y);
      if (reach < 0.06 * Math.min(view.width, view.height)) return { steer: 0, power: 0 };
      const ray = rayThrough(cam, view, pointer.x, pointer.y);
      const there = addScaled(cam.pos, ray, length(sub(centre, cam.pos)));
      there[1] -= RIG_CENTRE;
      return flyToward(craft, there);
    }

    // Hands off: a paramotor flies straight on its own. Only after a while
    // does the autopilot step in and circle, so the scene never empties out.
    if (clock - lastInput < IDLE_SECONDS) return { steer: 0, power: 0 };
    if (!autopilot) {
      autopilot = true;
      engaged = clock;
      orbit = orbitFor();
    }
    const asked = flyOrbit(craft, orbit, clock);
    asked.steer *= smoothstep(EASE_IN[0], EASE_IN[1], clock - engaged);
    return asked;
  }

  function handsOn(): void {
    lastInput = clock;
    autopilot = false;
  }

  /**
   * Where the autopilot should circle when it takes over. If the visitor left
   * the paramotor somewhere it frames well, it circles right there, turning
   * the way it was already leaning. Otherwise it flies back to where it began.
   */
  function orbitFor(): Orbit {
    const range = Math.hypot(craft.pos[0], craft.pos[2]);
    const altitude = craft.pos[1];
    if (range < 45 || range > 170 || altitude < 35 || altitude > 150) return home;
    const dir = craft.bank < 0 ? -1 : 1;
    return {
      cx: craft.pos[0] + dir * Math.cos(craft.heading) * ORBIT_RADIUS,
      cz: craft.pos[2] - dir * Math.sin(craft.heading) * ORBIT_RADIUS,
      radius: ORBIT_RADIUS,
      altitude,
      dir,
    };
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!raf || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
    if (event.code === 'Escape') {
      requestExit();
      return;
    }
    if (event.code === 'KeyC' && !event.repeat) switchView();
    const action = KEYS[event.code];
    if (action) held.add(action);
    // Arrows and Space would otherwise scroll the page out from under the flight.
    if (action || (event.code === 'Space' && !isButton(event.target))) event.preventDefault();
  }

  function onKeyUp(event: KeyboardEvent): void {
    const action = KEYS[event.code];
    if (action) held.delete(action);
  }

  function release(): void {
    held.clear();
    pointer = null;
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    els.ink.setPointerCapture(event.pointerId);
    onPointerMove(event, true);
  }

  function onPointerMove(event: PointerEvent, pressed = false): void {
    if (!pointer && !pressed) return;
    const rect = els.ink.getBoundingClientRect();
    pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onPointerUp(): void {
    pointer = null;
  }

  /* --------------------------------------------------------------- loop */

  function tick(now: number): void {
    raf = requestAnimationFrame(tick);
    // A frame's timestamp can fall a hair before the moment the loop was started.
    const elapsed = Math.max(0, (now - last) / 1000);
    // A stalled tab resumes with one normal step, not a lurch.
    const dt = Math.min(0.05, elapsed);
    last = now;
    clock += dt;

    if (pacer.frame(elapsed)) measure();

    stepCraft(craft, readControls(), dt, clock);

    // Once the takeover has had a moment to land, the camera leaves the
    // ground of its own accord. With reduced motion it waits to be asked.
    if (!liftedOff && clock > LIFTOFF_DELAY) {
      liftedOff = true;
      if (!stillness.matches) setView(true);
    }
    lift = clamp(lift + (aloft ? dt : -dt) / LIFT_SECONDS, 0, 1);
    const ride = smoothstep(0, 1, lift);
    const aspect = view.width / view.height;
    chaseHeading += wrapAngle(craft.heading - chaseHeading) * ease(dt, 0.9);
    const chase = chasePoint(craft.pos, chaseHeading, aspect);
    for (let i = 0; i < 3; i++) cam.pos[i] = GROUND_EYE[i] + (chase[i] - GROUND_EYE[i]) * ride;

    // On the ground: the camera first holds the video's framing and zoom,
    // then over a few seconds eases to its own, so the takeover does not snap.
    const held = 1 - smoothstep(TAKEOVER_HOLD, TAKEOVER_HOLD + 1.2, clock);
    const settled = smoothstep(TAKEOVER_HOLD, TAKEOVER_HOLD + 3, clock);
    const ground = narrow.matches ? GROUND_NARROW : GROUND_WIDE;
    const air = narrow.matches ? CHASE_NARROW : CHASE_WIDE;
    const groundX = frameAtTakeover.x + (ground.x - frameAtTakeover.x) * settled;
    const groundY = frameAtTakeover.y + (ground.y - frameAtTakeover.y) * settled;
    // A hand-held camera is never perfectly steady; one flying in formation is steadier.
    const sway = stillness.matches ? 0 : (1 - 0.7 * ride) * (1 - held);
    const swayX = sway * (0.012 * Math.sin(clock * 0.9) + 0.007 * Math.sin(clock * 2.3 + 1));
    const swayY = sway * (0.014 * Math.sin(clock * 0.7 + 2) + 0.006 * Math.sin(clock * 1.9));
    const frame = {
      x: groundX + (air.x - groundX) * ride + swayX,
      y: groundY + (air.y - groundY) * ride + swayY,
    };
    const centre = rigCentre();
    const range = length(sub(centre, GROUND_EYE));
    const groundZoom = zoomFor(range, RIG_HEIGHT, RIG_SPAN, aspect);
    // Zoom blends between the two as a ratio, the way a zoom ring turns.
    const ownZoom = groundZoom * Math.pow(CHASE_TAN / groundZoom, ride);
    // While holding, the zoom follows the paramotor's distance instead, which
    // keeps it the size the footage left it.
    const zoom = ownZoom + (sizeAtTakeover / range - ownZoom) * held * (1 - ride);
    const moving = smoothstep(0, 0.25, lift);
    const zoomTau = ((6 - 4.4 * settled) * (1 - moving) + 0.3 * moving) * (1 - held) + 0.05 * held;
    // From behind, a turn swings the rig sideways in the picture. A narrow
    // screen has little room for that, so there the aim keeps up more closely.
    const chaseFollow = 0.2 * clamp(aspect / 1.25, 0.35, 1);
    const groundFollow = 0.5 + (0.02 - 0.5) * held;
    trackCamera(cam, centre, frame, zoom, zoomTau, groundFollow + (chaseFollow - groundFollow) * ride, aspect, dt);

    sky.render(cam, clock);
    ink.draw(cam, view, craft, LINE_INK_GROUND + (LINE_INK_CHASE - LINE_INK_GROUND) * ride);

    if (clock >= readoutDue) {
      readoutDue = clock + 0.12;
      gauges.altitude.textContent = `${Math.round((craft.pos[1] * 3.281) / 5) * 5} ft`;
      gauges.speed.textContent = `${Math.round(craft.speed * 2.237)} mph`;
      gauges.heading.textContent = `${String(Math.round(craft.heading / RADIANS + 360) % 360).padStart(3, '0')}°`;
      gauges.pilot.textContent = autopilot ? 'Auto' : 'You';
    }
  }

  /** Run the loop only while flying, on screen, in a visible tab. */
  function sync(): void {
    const run = flying && inView && !document.hidden;
    if (run && !raf) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    } else if (!run && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
      release();
    }
  }

  /* ---------------------------------------------------------- lifecycle */

  const resizes = new ResizeObserver(() => {
    if (flying) measure();
  });
  // Mostly scrolled away: stop drawing, and give the arrow keys back to the page.
  const sightings = new IntersectionObserver(
    ([entry]) => {
      inView = entry.intersectionRatio >= 0.35;
      sync();
    },
    { threshold: [0.35] }
  );

  return {
    start() {
      // The browser can take the GPU away for a while. Until it is back
      // there is nothing to draw with.
      if (!sky.ready()) return false;
      if (flying) return true;
      measure();
      takeOver();
      flying = true;
      resizes.observe(els.hero);
      sightings.observe(els.hero);
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', release);
      document.addEventListener('visibilitychange', sync);
      els.view.addEventListener('click', switchView);
      els.ink.addEventListener('pointerdown', onPointerDown);
      els.ink.addEventListener('pointermove', onPointerMove);
      els.ink.addEventListener('pointerup', onPointerUp);
      els.ink.addEventListener('pointercancel', onPointerUp);
      sync();
      return true;
    },
    stop() {
      if (!flying) return null;
      // Only the ground camera sees anything the footage could be matched to.
      const resumeAt = lift < 0.02 ? matchingFootage() : null;
      els.hero.classList.remove('hero--aloft');
      flying = false;
      sync();
      resizes.disconnect();
      sightings.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', sync);
      els.view.removeEventListener('click', switchView);
      els.ink.removeEventListener('pointerdown', onPointerDown);
      els.ink.removeEventListener('pointermove', onPointerMove);
      els.ink.removeEventListener('pointerup', onPointerUp);
      els.ink.removeEventListener('pointercancel', onPointerUp);
      return resumeAt;
    },
  };
}

/** The tracked position of the paramotor in the video at a playback time. */
function trackAt(seconds: number): [number, number, number, number, number, number] {
  const at = clamp(seconds / HERO_TRACK_STEP, 0, HERO_TRACK.length - 1);
  const i = Math.min(Math.floor(at), HERO_TRACK.length - 2);
  const a = HERO_TRACK[i];
  const b = HERO_TRACK[i + 1];
  const blend = (n: 0 | 1 | 2 | 3 | 4 | 5) => a[n] + (b[n] - a[n]) * (at - i);
  return [blend(0), blend(1), blend(2), blend(3), blend(4), blend(5)];
}

/** True when Space is about to press a focused button or follow a link. */
function isButton(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && /^(BUTTON|A|SUMMARY)$/.test(target.tagName);
}

/** True when a key press belongs to a text field, such as the assistant's. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}
