/**
 * The world, drawn with WebGPU: one fragment shader on a full-screen triangle.
 *
 * Every pixel works out which direction it looks along from where the camera
 * is, then asks what is out there. Looking up, it is sky: layered cloud lit
 * by a low sun. Looking down, it is the top of a sea of cloud, with wooded
 * ridges standing out of it toward the horizon. Nothing is stored; it is all
 * computed from noise, so it costs no download and has no edge to reach.
 *
 * The look is matched to the footage the scene takes over from: black and
 * white, shot into the sun. Thin cloud scatters light forward and glows;
 * thick cloud blocks it and goes dark; near the sun everything burns out.
 *
 * `sky-gl.ts` is the same shader in GLSL for browsers without WebGPU. A
 * change to the look has to be made in both.
 */

import { type InkGear, buildInk, createInk } from './ink-gpu.ts';
import type { Sky } from './sky.ts';
import type { Vec3 } from './vec.ts';

const SHADER = /* wgsl */ `
struct View {
  res: vec2f,
  tan: vec2f,
  cam: vec3f,
  time: f32,
  right: vec3f,
  up: vec3f,
  fwd: vec3f,
  sun: vec3f,
}
@group(0) @binding(0) var<uniform> view: View;

// Rotating between octaves hides the grid that value noise is built on.
const TURN = mat2x2f(0.8, 0.6, -0.6, 0.8);

// The sea of cloud below the field, in metres: the mean height of its solid
// top, the range its billows cover, the depth of thinning vapour above that,
// and the distance past which it is drawn as a flat sheet because haze has
// taken the detail anyway.
const SEA = -39.5;
const SEA_HIGH = -8.5;
const SEA_LOW = -52.5;
const SEA_VEIL = 10.0;
const SEA_FAR = 1500.0;

// One triangle that overshoots the screen covers it without a diagonal seam.
@vertex
fn corner(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0, 0.0, 1.0);
}

// A number from 0 to 1 for each point of a grid, with nothing to connect it
// to its neighbours'.
//
// It is worked out in whole numbers small enough for a float to hold exactly.
// That matters: two neighbouring cells each work out the corner they share,
// by different routes, and a graphics driver is free to round those routes
// differently. With the usual hash built on fract() the two can then disagree
// about the corner, and the disagreement shows as a hard line along the edge
// of the cell: a scratch in the cloud. Whole-number arithmetic has only one
// answer however it is rounded.
//
// The one step that is not whole-number arithmetic is finding how many times
// 251 goes into x, and the half added first is what makes that safe: the
// number being rounded down is then never within a five-hundredth of a whole
// one, which is far more than any GPU's multiply can be out by at this size.
//
// 251 is prime on purpose. Modulo a square, such as the 289 this recipe is
// usually seen with, each value is the one seventeen places along plus a
// constant, and the pattern can be seen repeating.
fn wrap(x: f32) -> f32 {
  return x - 251.0 * floor((x + 0.5) * 0.00398406374);
}

fn shuffle(x: f32) -> f32 {
  return wrap((7.0 * x + 1.0) * x);
}

fn hash(p: vec2f) -> f32 {
  return shuffle(shuffle(wrap(p.x)) + wrap(p.y)) * 0.00398406374;
}

fn hash3(p: vec3f) -> f32 {
  return shuffle(shuffle(shuffle(wrap(p.x)) + wrap(p.y)) + wrap(p.z)) * 0.00398406374;
}

// The usual kind, for grain, where no two cells need to agree about anything.
fn speck(p: vec2f) -> f32 {
  var q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// Smooth noise centred on zero. The blend from one grid point to the next has
// no kink in its slope where cells meet. With a simpler one, comparing two
// samples of it (as the cloud does to find its sunward edges) shows those
// joins as faint ruled lines.
fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = mix(hash(i), hash(i + vec2f(1.0, 0.0)), f.x);
  let b = mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), f.x);
  return mix(a, b, f.y) - 0.5;
}

// The same, in three dimensions, for patterns that wrap the whole sky.
fn noise3(p: vec3f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  let o = vec2f(0.0, 1.0);
  let a = mix(hash3(i), hash3(i + o.yxx), f.x);
  let b = mix(hash3(i + o.xyx), hash3(i + o.yyx), f.x);
  let c = mix(hash3(i + o.xxy), hash3(i + o.yxy), f.x);
  let d = mix(hash3(i + o.xyy), hash3(i + o.yyy), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z) - 0.5;
}

// Two octaves of noise, used to bend the cloud detail out of straight lines.
// It has to stay gentle. Push a pattern further than it stretches and it
// folds back over itself, and each fold shows as a hard little hook in the
// cloud.
fn swirl(p: vec2f) -> f32 {
  return 0.5 * noise(p) + 0.25 * noise(TURN * p * 2.03 + 11.7);
}

// Noise folded at zero: the folds become creases and what is left between
// them is rounded, which is the shape of cloud seen from above. The fold is
// eased a little, because a crease in cloud has no sharp bottom to catch
// the light as a line.
fn billow(p: vec2f) -> f32 {
  let n = noise(p);
  return sqrt(n * n + 0.0015) * 2.0;
}

/* -------------------------------------------------------------------- sky */

// The broad layers of cloud, which from below stack up as bands parallel to
// the horizon. Sampled on the view direction itself, squashed vertically, so
// they wrap the whole sky with no seam. The offset only picks which stretch
// of the pattern is overhead.
fn layers(dir: vec3f, octaves: i32) -> f32 {
  var q = vec3f(dir.x, dir.y * 4.5, dir.z) * 2.2 + vec3f(5.4 + view.time * 0.002, 0.0, 0.0);
  var sum = 0.0;
  var amp = 0.5;
  for (var i = 0; i < 4; i++) {
    if (i >= octaves) { break; }
    sum += amp * noise3(q);
    q = q * 2.07 + 5.3;
    amp *= 0.5;
  }
  return sum;
}

// Cloud overhead, as a tone to multiply the sky's own brightness by.
fn sky(dir: vec3f, facing: f32, toward: f32, pixel: f32) -> f32 {
  let strata = layers(dir, 4);

  // Fine structure: a deck of cloud on a plane 1400 m up, bent down a touch
  // at the rim so it compresses toward the horizon without running to infinity.
  let lift = max(dir.y + 0.03, 0.02);
  let deck = dir.xz / lift + view.cam.xz / 1400.0;
  // Size of one screen pixel on the deck. Octaves finer than a pixel would
  // shimmer as the camera pans, so they fade out instead.
  var px = 3.4 * pixel / (lift * lift);
  var p = deck * 3.4 + vec2f(27.0, 8.1) + view.time * vec2f(0.01, 0.003);
  p += 0.24 * vec2f(swirl(p * 0.9 + 4.1), swirl(p * 0.9 - 7.3));
  // The broadest of that detail one step toward the sun: comparing the two
  // says which way each cloud's edge faces. Only the broadest, or every small
  // wisp gets its own highlight and the sky looks brushed.
  var b = p + 0.16 * normalize(view.sun.xz / max(view.sun.y + 0.03, 0.02) - dir.xz / lift + 1e-4);
  var broad = 0.0;
  var shifted = 0.0;
  var coarse = 0.0;
  var fine = 0.0;
  var amp = 0.5;
  for (var i = 0; i < 9; i++) {
    // Through a long lens there are more octaves to see; through a wide one
    // the last of them are finer than a pixel and not worth working out.
    if (px > 0.5) { break; }
    let n = amp * (1.0 - smoothstep(0.18, 0.5, px));
    let here = n * noise(p);
    if (i < 2) {
      broad += here;
      shifted += n * noise(b);
      b = TURN * b * 2.03 + 11.7;
    }
    if (i < 4) {
      coarse += here;
    } else {
      fine += here;
    }
    p = TURN * p * 2.03 + 11.7;
    px *= 2.03;
    amp *= 0.63;
  }

  // Toward the horizon the deck is seen so nearly edge-on that its detail
  // would draw out into dashes, so there the broad layers take over.
  let clear = smoothstep(0.03, 0.22, dir.y);
  // Through a long lens the finest structure counts for more. The footage
  // is shot through one and its cloud is crisp; a soft sky straight after
  // it reads as a change of camera.
  fine *= 1.5 - 0.5 * smoothstep(0.1, 0.3, view.tan.y);

  // The footage has two features every frame of it is recognisable by: a
  // heavy bank of cloud to the right of the sun and a grey deck to its left.
  // They are put where the footage has them, measured round from the sun.
  let bearing = atan2(dir.x, dir.z) - atan2(view.sun.x, view.sun.z);
  let bank = vec2f(bearing - 0.6, dir.y - 0.36) / vec2f(0.3, 0.26);
  let grey = vec2f(bearing + 0.3, dir.y - 0.45) / vec2f(0.34, 0.34);
  let placed = 0.45 * exp(-dot(bank, bank)) + 0.42 * exp(-dot(grey, grey));

  // Thickness of cloud this way. Positive is cloud. Its finest structure
  // shows where it is thin enough to see through, which is at its edges:
  // there it frays into wisps. Anywhere else, fine detail at full weight
  // throws off specks of cloud a few pixels across, which read as scratches.
  let bulk = 1.15 * strata + 0.9 * mix(0.3, 1.0, clear) * coarse + 0.18 + placed;
  let edge = smoothstep(-0.2, 0.24, bulk);
  let frayed = 4.0 * edge * (1.0 - edge);
  let here = bulk + 0.9 * mix(0.3, 1.0, clear) * fine * (0.4 + 1.7 * frayed);
  // Cloud comes on by degrees and deepens by degrees. A narrow step here
  // draws every cloud as a flat patch with an outline.
  let cover = smoothstep(-0.17, 0.2, here);
  let core = smoothstep(0.0, 0.46, here);
  // An edge that thins toward the sun catches it; one that thickens is in
  // shade. Eased off at both ends, so the highlight has no edge of its own.
  let turn = (broad - shifted) * 5.0;
  let rim = clear * turn / (1.0 + abs(turn));

  // Three ways to see a cloud. Toward the sun, thin cloud glows and thick
  // cloud blocks the light. Across it, cloud is a little brighter than the
  // sky. With the sun behind the camera it is fully lit, the brightest thing
  // there is, shaded only where it is deepest.
  let backlit = smoothstep(-0.3, 0.75, facing);
  let frontlit = 1.0 - smoothstep(-0.8, -0.2, facing);
  let thin = mix(mix(1.3, 0.8, backlit), 1.5, frontlit);
  let thick = mix(mix(1.4, 0.46, backlit), 1.95 - 0.45 * smoothstep(0.25, 0.55, here), frontlit);
  var body = mix(thin, thick, core) + 0.16 * rim + 0.5 * clear * fine;
  // Round the sun, cloud thin enough to let light through is lit from
  // within, well out past the glare itself. Thick cloud stays dark.
  body += 0.35 * pow(toward, 12.0) * (1.0 - core);
  // Clear sky is never even either: high haze follows the layers, and the
  // thinnest of the cloud trails out across it.
  let tone = mix(1.0 + 0.3 * strata + 0.45 * clear * (coarse + fine), body, cover);

  // Close to the sun everything washes out.
  return mix(tone, 1.0, 0.5 * pow(toward, 60.0));
}

/* -------------------------------------------------------------- cloud sea */

// Height of the cloud sea's solid top: billows riding on billows. fine and
// lumps fade the smaller ones out where they are too far away to resolve.
fn seaTop(p: vec2f, fine: f32, lumps: f32) -> f32 {
  var h = 22.0 * (billow(p / 260.0) - 0.3);
  h += fine * 15.0 * (billow(TURN * p / 87.0 + 3.7) - 0.3);
  h += lumps * 7.0 * (billow(p / 29.0 + 9.2) - 0.3);
  return SEA + h;
}

// How bright the cloud sea's surface is under a point at distance t, as a
// tone: which way its broad shapes face the sun, whether higher cloud shades
// it, how deep in a crease it lies, and the small rounded heaps it is made of.
// foot is how much of the surface one pixel covers there, in metres: heaps
// smaller than that are left out.
fn seaShade(at: vec2f, fine: f32, lumps: f32, t: f32, foot: f32) -> f32 {
  let here = seaTop(at, fine, lumps);
  let sunward = normalize(view.sun.xz);
  // Cloud scatters light around inside itself, so the side turned from the
  // sun is never far behind the side turned to it, and neither has an edge.
  let e = 8.0 + 0.012 * t;
  let tilt = (here - seaTop(at + sunward * e, fine, lumps)) / e;
  var lit = 0.5 + 0.5 * tilt / (0.3 + abs(tilt));

  // Is there higher cloud between here and the sun?
  let climb = view.sun.y / length(view.sun.xz);
  var shade = 0.0;
  for (var i = 1; i < 4; i++) {
    let d = (10.0 + 0.004 * t) * f32(i * i);
    shade += clamp((seaTop(at + sunward * d, fine, lumps) - here - climb * d) * 0.14, 0.0, 1.0);
  }
  lit *= 1.0 - 0.55 * min(shade, 1.0);

  // Heaps on heaps: bright where each stands proud, dim in the folds between.
  // They only tint the surface. Tilting it to the sun as well would rule a
  // bright line along every one, and it would read as rippled sand.
  var heaps = 0.5 * (1.0 - smoothstep(4.0, 10.0, foot)) * (billow(at / 23.0 + 5.1) - 0.5);
  heaps += 0.32 * (1.0 - smoothstep(1.5, 4.0, foot)) * (billow(TURN * at / 9.0) - 0.5);
  heaps += 0.2 * (1.0 - smoothstep(0.6, 1.6, foot)) * (billow(at / 3.7 + 1.9) - 0.5);

  // Creases are deeper and dimmer; crests catch everything.
  return mix(0.6, 1.1, lit) * mix(0.74, 1.0, smoothstep(SEA_LOW, SEA_HIGH, here)) * (1.0 + 0.42 * heaps);
}

// What a ray into the cloud sea finds: the tone to multiply the sea's own
// light by, how far away it meets the solid top, in metres, and the soft
// vapour it passed through on the way: how opaque, how far off, what tone.
struct Sea {
  tone: f32,
  reach: f32,
  mist: vec3f,
}

fn sea(dir: vec3f, pixel: f32) -> Sea {
  let drop = -dir.y;
  let top = (view.cam.y - SEA_HIGH - SEA_VEIL) / drop;
  var mist = vec3f(0.0);

  // Far off it is a flat sheet with broad patches of light and shade.
  var reach = (view.cam.y - SEA) / drop;
  var tone = 1.02 + 0.4 * noise((view.cam.xz + dir.xz * reach) / 430.0);

  let near = 1.0 - smoothstep(0.4 * SEA_FAR, SEA_FAR, top);
  if (near > 0.0) {
    // Close to, it has shape. Walk the ray down to the surface from where it
    // enters the slab the billows occupy. The surface seldom climbs faster
    // than about 1.3 m per metre, so from any height above it there is a
    // distance the ray can safely cover; taking that each step closes in on
    // the surface without passing through a crest.
    //
    // Cloud has no hard top, though. The last few metres above the surface
    // are vapour that thickens downward, and the ray adds up how much of it
    // lies in the way. A ray grazing a crest crosses a lot and sees only
    // vapour; one looking straight down crosses little and sees the surface.
    let fine = 1.0 - smoothstep(500.0, 1000.0, top);
    let pace = 1.3 * length(dir.xz) + drop;
    var t = top;
    var depth = 0.0;
    var along = 0.0;
    var lumps = 1.0;
    for (var i = 0; i < 72; i++) {
      let at = view.cam + dir * t;
      lumps = 1.0 - smoothstep(150.0, 700.0, t);
      let gap = at.y - seaTop(at.xz, fine, lumps);
      if (gap < 0.002 * t || depth > 4.0) { break; }
      // Short steps inside the vapour, so its thickness is measured, not guessed.
      let stride = select(gap - 0.6 * SEA_VEIL, min(gap, 2.0 + 0.005 * t), gap < SEA_VEIL) / pace;
      let thick = clamp(1.0 - gap / SEA_VEIL, 0.0, 1.0);
      let add = 0.15 * thick * thick * stride;
      depth += add;
      along += add * t;
      t += stride;
    }
    let shaped = seaShade(view.cam.xz + dir.xz * t, fine, lumps, t, t * pixel / max(drop, 0.05));

    // The vapour takes the tone of the cloud it lies over. Where the ray
    // skimmed a crest and went on to land much further off, that is the
    // crest's tone, not the landing place's: shade it separately, so the
    // crest keeps a soft edge of its own colour and not a bright outline.
    var veiled = t;
    if (depth > 0.0) {
      veiled = along / depth;
      // Vapour is never even. It trails off the crests in wisps, thick here
      // and gone there, and they are tall and thin, so they are looked up by
      // height as well as by place and do not smear along the line of sight.
      let w = view.cam + dir * veiled;
      let wisp = noise3(vec3f(w.x / 26.0, w.y / 5.0, w.z / 26.0) + view.time * 0.02) + 0.5 * noise3(vec3f(w.x / 9.0, w.y / 2.2, w.z / 9.0));
      depth *= clamp(1.0 + 2.0 * wisp, 0.55, 2.6);
    }
    var skimmed = shaped;
    let apart = smoothstep(0.02, 0.12, depth) * smoothstep(4.0 + 0.03 * t, 14.0 + 0.07 * t, t - veiled);
    if (apart > 0.0) {
      skimmed = mix(shaped, seaShade(view.cam.xz + dir.xz * veiled, fine, 1.0 - smoothstep(150.0, 700.0, veiled), veiled, veiled * pixel / max(drop, 0.05)), apart);
    }

    mist = vec3f(near * (1.0 - exp(-depth)), veiled, mix(tone, skimmed, near));
    tone = mix(tone, shaped, near);
    reach = mix(reach, t, near);
  }

  // Shadows of the cloud overhead drift across it, in broad patches.
  let shadows = (view.cam.xz + dir.xz * reach) / 900.0 + view.time * 0.004;
  let dapple = mix(0.72, 1.06, smoothstep(-0.12, 0.14, noise(shadows)));
  mist.z *= dapple;
  return Sea(tone * dapple, reach, mist);
}

/* ----------------------------------------------------------------- ridges */

// Height of the tallest trees, and how far down the slope one rank of them
// stands from the next, in metres.
const TREE = 19.0;
const RANK = 6.5;

// One conifer rooted in a given plot. at is a place along the slope, counted
// in plots; rise is a height above the ground, as a share of the tallest
// tree; light says which side the sun is on, from -1 to 1. The tree stands
// where it happens to in its plot, as tall and as broad as it happens to be.
// plots is how many there are round the whole ring: they are numbered round
// it, so that the last is a neighbour of the first like any other two.
//   x  how far inside its outline that point is, in plots across, negative outside
//   y  how brightly the sun lights it there
//   z  a number of its own, for telling it from its neighbours
fn conifer(at: f32, plot: f32, plots: f32, seed: f32, widest: f32, rise: f32, light: f32) -> vec3f {
  let own = plot - plots * floor(plot / plots);
  let a = hash(vec2f(own, seed + 2.0));
  let b = hash(vec2f(own, seed + 9.0));
  // One plot in six stands empty.
  let tall = (0.5 + 0.5 * fract(a * 7.3 + b)) * step(0.17, fract(b * 3.3 + a));
  // 0 at its foot, 1 at its tip.
  let v = rise / max(tall, 0.01);
  // Few stand quite straight.
  let off = at - (plot + 0.25 + 0.5 * a) - (b - 0.5) * 0.22 * v;
  // Boughs reach further on one side than the other.
  let side = step(0.0, off);
  let crown = widest * (0.55 + 0.6 * b) * mix(0.75 + 0.5 * a, 1.25 - 0.5 * a, side);
  // They come in tiers. Each is widest near its foot, tapers up to the next,
  // and is cut back underneath, so the outline is a row of drooping tips and
  // never a ruled line.
  let tiers = 3.0 + floor(4.0 * fract(b * 5.7));
  let f = fract(v * tiers + 3.1 * a + 0.37 * side);
  var bough = min(f / 0.18, (1.0 - f) / 0.82);
  // No two boughs are the same length.
  bough *= 1.0 + 0.5 * noise(vec2f(rise * 14.0 + 7.0 * side, own + seed));
  let reach = crown * (pow(max(1.0 - v, 0.0), 0.9) * (0.66 + 0.34 * bough) - 2.0 * max(v - 1.0, 0.0));
  // Lit from one side, dark under each bough, darker toward the foot.
  let across = clamp(off / max(reach, 1e-3), -1.0, 1.0);
  let sunned = (0.66 + 0.5 * clamp(v, 0.0, 1.0)) * (1.0 - 0.2 * smoothstep(0.4, 1.0, f)) * (1.0 + 0.3 * light * across);
  return vec3f(reach - abs(off), sunned, fract(a * 13.7));
}

// The same for a whole stand, with the first now in metres. lap is how far
// round the ring this is, from 0 to 1, and girth how long the ring is. A row
// of big trees about 5.6 m apart, each allowed to spread into its neighbours'
// plots, with younger ones between them, so no stretch repeats. Both rows are
// spaced to go round the ring a whole number of times.
fn wood(lap: f32, girth: f32, seed: f32, rise: f32, light: f32) -> vec3f {
  let plots = floor(girth / 5.6);
  let big = lap * plots;
  let plot = floor(big);
  var tree = conifer(big, plot, plots, seed, 0.6, rise, light);
  var other = conifer(big, plot - 1.0, plots, seed, 0.6, rise, light);
  if (other.x > tree.x) { tree = other; }
  other = conifer(big, plot + 1.0, plots, seed, 0.6, rise, light);
  if (other.x > tree.x) { tree = other; }
  tree.x *= girth / plots;
  let starts = floor(girth / 3.7);
  let young = lap * starts;
  other = conifer(young, floor(young), starts, seed + 4.0, 0.42, rise / 0.55, light);
  if (other.x * girth / starts > tree.x) { tree = vec3f(other.x * girth / starts, other.yz); }
  return tree;
}

// A ring of wooded hills a given distance from the field, standing out of
// the cloud sea. lit runs from 0, seen against the light, to 1, seen with
// the sun on it; cloud is the tone of the cloud sea this way, and vapour how
// far off its soft top lies. Returns lum with the hills painted over it in x,
// and in y how much of this pixel they cover if they stand nearer than that
// vapour, which is then behind them and must not be drawn over them.
fn ridge(base: f32, dir: vec3f, far: f32, low: f32, high: f32, seed: f32, pixel: f32, haze: f32, lit: f32, reach: f32, cloud: f32, vapour: f32) -> vec2f {
  var lum = base;
  let a = dot(dir.xz, dir.xz);
  if (a < 1e-4) { return vec2f(lum, 0.0); }
  let b = dot(view.cam.xz, dir.xz);
  let t = (sqrt(b * b - a * (dot(view.cam.xz, view.cam.xz) - far * far)) - b) / a;
  // The cloud sea is in front of it.
  if (t > reach) { return vec2f(lum, 0.0); }
  let p = view.cam + dir * t;
  // Nothing on this ring stands higher than this, or shows under the cloud.
  if (p.y > high + TREE + 3.0 || p.y < SEA_LOW) { return vec2f(lum, 0.0); }

  // Skyline: taken round a circle, so it meets itself with no seam.
  let q = p.xz / far;
  let crest = mix(low, high, 0.5 + noise(q * 2.3 + seed) + 0.45 * noise(q * 6.1 - seed));
  if (p.y > crest + TREE + 3.0) { return vec2f(lum, 0.0); }
  // Trees are counted off round the ring, and that count has to start
  // somewhere: due south, behind the camera when it faces the sun. Whatever
  // else varies round the ring is read off the circle itself, like the
  // skyline, so that nothing but the numbering knows where the start is.
  let lap = atan2(p.x, p.z) / 6.2831853 + 0.5;
  let girth = 6.2831853 * far;
  let small = t * pixel;
  // An edge is as soft as a pixel, and a little softer through a lot of air.
  let soft = 0.7 * small + 0.00015 * t;
  // Woodland is near-black against the light and mid-grey with the sun on
  // it, and far hills have gone most of the way to the tone of the air
  // behind them. Never much paler than that, or the gaps between pale trees
  // show the darker sky and read as trees hanging upside down.
  let air = 1.0 - exp(-t / 3000.0);
  var dark = mix(mix(0.02 + 0.13 * haze, 0.3, lit), min(haze, lum + 0.06), air);
  // Stands differ: older here, thinner there.
  dark *= 1.0 + 0.2 * noise3(vec3f(q * (far / 140.0) + seed, p.y / 55.0));
  // The hill goes down into cloud. Approaching the tops of the billows it
  // takes on the cloud's own tone, rather than turning transparent and
  // letting whatever is behind show through it as a ghost; below them it is
  // gone. That line is drawn at the height of the highest billows, not
  // wherever the cloud happens to stand in front of this spot: followed down
  // into every hollow, the hill shows there as specks of dark in the cloud.
  // Where the cloud does stand higher, the last of the hill above it thins
  // away, so that the two never meet along a hard edge.
  let clear = smoothstep(SEA_HIGH, SEA_HIGH + SEA_VEIL + 16.0, p.y);
  let shore = seaTop(p.xz, 1.0 - smoothstep(500.0, 1000.0, t), 1.0 - smoothstep(150.0, 700.0, t));
  let above = smoothstep(SEA_HIGH - 12.0, SEA_HIGH, p.y) * smoothstep(0.0, 5.0, p.y - shore);
  // Which side of each tree the sun is on, seen from here.
  let light = dot(normalize(view.sun.xz), vec2f(dir.z, -dir.x)) / sqrt(a);
  // Trees shrink away as they get too small to draw, and what tells one from
  // the next goes first: far off it is finer than a pixel and only shimmers.
  let drawn = 1.0 - smoothstep(0.25, 0.7, small / 3.9);
  let detail = 1.0 - smoothstep(0.07, 0.26, small / RANK);
  // Woodland comes in stands, taller here and thinner there, not sown evenly.
  let grove = mix(0.6, 1.0, smoothstep(-0.2, 0.06, noise(q * (far / 75.0) + 3.0 * seed)));

  // Trees stand in ranks all the way down the slope, close enough that each
  // hides the feet of the one behind, and each rank's line wanders so that
  // they never run parallel. Only the four that could show at this height
  // need drawing: anything higher up the slope is behind them. Under those,
  // the hill itself.
  //
  // Against the light it is mist that sets one rank off from the next: each
  // is dark along its tops and pales toward its feet, where the next stands
  // dark in front of it. With the sun on them it is shadow: every tree is lit
  // on one side and it is dark down between them.
  let top = crest - RANK * 0.9 * noise(q * (far / 55.0) + seed);
  // What shows between the trees where the sun reaches: scrub, in patches.
  let scrub = 0.74 + 0.3 * noise3(vec3f(q * (far / 1.9), p.y / 1.3));
  // Too far off to tell one tree from the next, woodland is still not a
  // flat tone: the canopy is mottled, crown by crown.
  let plain = dark * mix(1.0, 0.85, lit) * (1.0 + 0.45 * (1.0 - air) * noise3(vec3f(q * (far / 9.0), p.y / 6.0)));
  let deep = mix(plain, mix(mix(dark, haze, 0.4), 0.6 * dark, lit), detail);
  var seen = above * smoothstep(-soft, soft, top - p.y);
  lum = mix(lum, mix(cloud, deep, clear), seen);
  let nearest = floor((crest - p.y + TREE) / RANK + 0.45);
  for (var j = 0; j < 4; j++) {
    let k = nearest - 3.0 + f32(j);
    if (k < 0.0) { continue; }
    let ground = crest - RANK * (k + 0.9 * noise(q * (far / 55.0) + seed + vec2f(7.3, 3.9) * k));
    // Trees only where this rank's ground stands clear of the cloud.
    let stand = TREE * drawn * grove * smoothstep(SEA_HIGH + 4.0, SEA_HIGH + 30.0, ground);
    let rise = p.y - ground;
    let tree = wood(fract(lap + 0.37 * k), girth, seed + k, rise / max(stand, 0.01), light);
    // Brush fills in under the trees, so no gap between two runs to the ground.
    let brush = 0.2 * stand * (0.9 + 1.5 * noise(q * (far / 2.7) + 5.3 * k)) - rise;
    let misted = mix(dark, haze, 0.4 * smoothstep(-0.2, 0.55, 0.72 - rise / max(stand, 0.01)));
    let sunned = dark * select(scrub, tree.y * (0.84 + 0.32 * tree.z), tree.x > brush);
    let cover = above * smoothstep(-soft, soft, max(tree.x, brush));
    lum = mix(lum, mix(cloud, mix(plain, mix(misted, sunned, lit), detail), clear), cover);
    seen = max(seen, cover);
  }
  return vec2f(lum, select(0.0, seen, t < vapour));
}

@fragment
fn world(@builtin(position) spot: vec4f) -> @location(0) vec4f {
  // Rows are counted from the top of the frame here, and the scene looks up.
  let frag = vec2f(spot.x, view.res.y - spot.y);
  let ndc = frag / view.res * 2.0 - 1.0;
  let dir = normalize(view.fwd + view.right * (ndc.x * view.tan.x) + view.up * (ndc.y * view.tan.y));
  // The angle one pixel covers, for fading out what is too fine to draw.
  let pixel = 2.0 * view.tan.y / view.res.y;

  // How bright the air is this way before anything is in it: a wide glow
  // around the sun, falling to a flat grey with its back to it.
  let facing = dot(dir, view.sun);
  let toward = max(facing, 0.0);
  let light = mix(0.4, 0.82, pow(0.5 + 0.5 * facing, 5.0)) + 0.6 * pow(toward, 60.0);
  // Everything dissolves into this at the horizon, which is pale all the way
  // round however dark the sky above it.
  let haze = max(light * 1.05, 0.6);
  // The top of the cloud sea and the hills are in full sun whichever way
  // they are seen from: brightest with the sun behind the camera, in their
  // own shadow looking into it.
  let lit = 1.0 - smoothstep(-0.75, 0.0, facing);
  // Cloud turned toward a low sun is lit through as well as on, so the sea is
  // at its brightest that way, where a solid would be at its darkest.
  let sunlit = mix(0.82, 1.04, 1.0 - smoothstep(-0.5, 0.9, facing)) + 0.4 * pow(toward, 3.0);

  var lum: f32;
  var reach = 1e9;
  var mist = vec3f(0.0);
  // How much of what lies below the horizon has gone to haze just by being
  // near it. Looking level, the sea runs on for ever, and this is what loses
  // the horizon: it meets the sky's own haze there with no line between.
  var level = 0.0;
  if (dir.y >= 0.0) {
    lum = mix(light * sky(dir, facing, toward, pixel), haze, exp(-dir.y * 8.0));
  } else {
    let below = sea(dir, pixel);
    reach = below.reach;
    mist = below.mist;
    level = exp(dir.y * 25.0);
    lum = mix(sunlit * below.tone, haze, max(1.0 - exp(-reach / 1500.0), level));
  }
  // The tone the foot of a hill fades into: the cloud it stands in.
  let cloud = select(lum, haze, dir.y >= 0.0);

  // Three rings of hills, furthest first.
  var hills = ridge(lum, dir, 2400.0, -40.0, 250.0, 9.0, pixel, haze, lit, reach, cloud, mist.y);
  var hidden = hills.y;
  hills = ridge(hills.x, dir, 1300.0, -50.0, 150.0, 5.0, pixel, haze, lit, reach, cloud, mist.y);
  hidden = max(hidden, hills.y);
  hills = ridge(hills.x, dir, 700.0, -60.0, 85.0, 1.0, pixel, haze, lit, reach, cloud, mist.y);
  hidden = max(hidden, hills.y);
  lum = hills.x;

  // The soft top of the cloud sea lies in front of whatever is beyond it.
  lum = mix(lum, mix(sunlit * mist.z, haze, max(1.0 - exp(-mist.y / 1500.0), level)), mist.x * (1.0 - hidden));

  // Shafts of light. The air this way is lit only if the way from it to the
  // sun is clear, so look at how much cloud lies along that way: where gaps
  // line up, a shaft comes through, and they fan out from the sun because
  // every line of sight is sampled toward it. Kept for the wide view from
  // the air; through a long lens one shaft is just an edge across the frame.
  let halo = smoothstep(0.1, 0.3, view.tan.y) * smoothstep(0.7, 0.93, facing) * (1.0 - pow(toward, 90.0));
  if (halo > 0.0) {
    var through = 0.0;
    for (var i = 1; i < 6; i++) {
      let cloud = 1.15 * layers(normalize(mix(dir, view.sun, 0.17 * f32(i))), 2) + 0.18;
      through += 1.0 - smoothstep(-0.08, 0.1, cloud);
    }
    lum *= mix(1.0, mix(0.8, 1.22, through / 5.0), halo);
  }

  lum += 1.5 * pow(toward, 64.0);

  // A soft shoulder, so highlights burn out the way they do on a sensor.
  lum = lum / pow(1.0 + lum * lum * lum * lum, 0.25);

  // Grain: about what the footage has, which is also enough to keep smooth
  // gradients from banding. Burnt-out white has none.
  lum += (speck(frag + fract(view.time) * 61.0) - 0.5) * 0.011 * (1.0 - smoothstep(0.9, 0.99, lum));

  return vec4f(vec3f(lum), 1.0);
}`;

/** What the shader is told each frame, laid out as its `View` struct is. */
const VIEW_FLOATS = 24;
const RES = 0;
const TAN = 2;
const CAM = 4;
const TIME = 7;
const RIGHT = 8;
const UP = 12;
const FWD = 16;
const SUN = 20;

/** Everything that dies with a GPU device, and so has to be made again if one is lost. */
interface Rig {
  device: GPUDevice;
  pipeline: GPURenderPipeline;
  uniforms: GPUBuffer;
  bindings: GPUBindGroup;
  /** What the paramotor's layer needs of the same device. */
  ink: InkGear;
}

/**
 * Returns null when there is no WebGPU here or the shader will not build, in
 * which case the canvas has not been touched and can still be given to WebGL.
 * `onLost` is called if the GPU is taken away later.
 */
export async function createGpuSky(canvas: HTMLCanvasElement, sun: Vec3, onLost: () => void): Promise<Sky | null> {
  const gpu = navigator.gpu;
  if (!gpu) return null;
  const format = gpu.getPreferredCanvasFormat();
  const first = await build(gpu, format);
  if (!first) return null;
  // Asking a canvas for one kind of context rules out every other kind. This
  // waits until the pipeline is known to build, so that a failure up to here
  // leaves the canvas free.
  const context = canvas.getContext('webgpu');
  if (!context) {
    first.device.destroy();
    return null;
  }

  const view = new Float32Array(VIEW_FLOATS);
  view.set(sun, SUN);
  let rig = first;
  let ready = true;

  /** Draw with this device from now on, and ask for another if it is lost. */
  const adopt = (next: Rig): void => {
    rig = next;
    context.configure({ device: next.device, format, alphaMode: 'opaque' });
    void next.device.lost.then(async () => {
      if (next !== rig) return;
      ready = false;
      onLost();
      // Browsers take the device back from tabs left in the background, and
      // drivers crash. Either way a new one can usually be had straight away.
      const again = await build(gpu, format);
      if (again && next === rig) {
        adopt(again);
        ready = true;
      }
    });
  };
  adopt(first);

  // Made once and reused, so that a frame allocates nothing it does not have to.
  const target: GPURenderPassColorAttachment = {
    view: context.getCurrentTexture().createView(),
    loadOp: 'clear',
    storeOp: 'store',
  };
  const pass: GPURenderPassDescriptor = { colorAttachments: [target] };
  const commands: GPUCommandBuffer[] = [];

  return {
    ready: () => ready,
    ink: (layer) => createInk(layer, format, () => (ready ? rig : null)),
    resize(width, height) {
      canvas.width = width;
      canvas.height = height;
      view[RES] = width;
      view[RES + 1] = height;
    },
    render(cam, time) {
      if (!ready) return;
      view[TAN] = (cam.tanY * canvas.width) / canvas.height;
      view[TAN + 1] = cam.tanY;
      view.set(cam.pos, CAM);
      view[TIME] = time;
      view.set(cam.right, RIGHT);
      view.set(cam.up, UP);
      view.set(cam.fwd, FWD);
      rig.device.queue.writeBuffer(rig.uniforms, 0, view);

      target.view = context.getCurrentTexture().createView();
      const encoder = rig.device.createCommandEncoder();
      const draw = encoder.beginRenderPass(pass);
      draw.setPipeline(rig.pipeline);
      draw.setBindGroup(0, rig.bindings);
      draw.draw(3);
      draw.end();
      commands[0] = encoder.finish();
      rig.device.queue.submit(commands);
    },
  };
}

/** Get a device and build the pipeline on it. Null if any step fails. */
async function build(gpu: GPU, format: GPUTextureFormat): Promise<Rig | null> {
  let device: GPUDevice | undefined;
  try {
    const adapter = await gpu.requestAdapter();
    device = await adapter?.requestDevice();
    if (!device) return null;

    const module = device.createShaderModule({ code: SHADER });
    const report = await module.getCompilationInfo();
    const errors = report.messages.filter((message) => message.type === 'error');
    if (errors.length > 0) {
      console.warn('Flight sky shader failed to compile:', errors.map((e) => `${e.lineNum}:${e.linePos} ${e.message}`).join('\n'));
      device.destroy();
      return null;
    }

    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'corner' },
      fragment: { module, entryPoint: 'world', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const uniforms = device.createBuffer({
      size: VIEW_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniforms } }],
    });
    return { device, pipeline, uniforms, bindings, ink: await buildInk(device, format) };
  } catch {
    // A device lost part-way through fails here too, and that is not worth a warning.
    device?.destroy();
    return null;
  }
}
