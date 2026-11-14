/**
 * The world, drawn with WebGL, for browsers that have no WebGPU.
 *
 * This is `sky-gpu.ts` over again in the older shading language: the same
 * functions in the same order doing the same sums, so the two can be read
 * side by side. What each part is for is explained there and not repeated
 * here. A change to the look has to be made in both.
 */

import { canvasInk } from './glider.ts';
import type { Sky } from './sky.ts';
import type { Vec3 } from './vec.ts';

const VERTEX = `
attribute vec2 corner;
void main() {
  gl_Position = vec4(corner, 0.0, 1.0);
}`;

const FRAGMENT = `
precision highp float;

uniform vec2 uRes;
uniform vec3 uCam;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uFwd;
uniform vec2 uTan;
uniform vec3 uSun;
uniform float uTime;

const mat2 TURN = mat2(0.8, 0.6, -0.6, 0.8);

const float SEA = -39.5;
const float SEA_HIGH = -8.5;
const float SEA_LOW = -52.5;
const float SEA_VEIL = 10.0;
const float SEA_FAR = 1500.0;

float wrap(float x) {
  return x - 251.0 * floor((x + 0.5) * 0.00398406374);
}

float shuffle(float x) {
  return wrap((7.0 * x + 1.0) * x);
}

float hash(vec2 p) {
  return shuffle(shuffle(wrap(p.x)) + wrap(p.y)) * 0.00398406374;
}

float speck(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x);
  float b = mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x);
  return mix(a, b, f.y) - 0.5;
}

float hash3(vec3 p) {
  return shuffle(shuffle(shuffle(wrap(p.x)) + wrap(p.y)) + wrap(p.z)) * 0.00398406374;
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec2 o = vec2(0.0, 1.0);
  float a = mix(hash3(i), hash3(i + o.yxx), f.x);
  float b = mix(hash3(i + o.xyx), hash3(i + o.yyx), f.x);
  float c = mix(hash3(i + o.xxy), hash3(i + o.yxy), f.x);
  float d = mix(hash3(i + o.xyy), hash3(i + o.yyy), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z) - 0.5;
}

float swirl(vec2 p) {
  return 0.5 * noise(p) + 0.25 * noise(TURN * p * 2.03 + 11.7);
}

float billow(vec2 p) {
  float n = noise(p);
  return sqrt(n * n + 0.0015) * 2.0;
}

/* -------------------------------------------------------------------- sky */

float layers(vec3 dir, int octaves) {
  vec3 q = vec3(dir.x, dir.y * 4.5, dir.z) * 2.2 + vec3(5.4 + uTime * 0.002, 0.0, 0.0);
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    if (i >= octaves) break;
    sum += amp * noise3(q);
    q = q * 2.07 + 5.3;
    amp *= 0.5;
  }
  return sum;
}

float sky(vec3 dir, float facing, float toward, float pixel) {
  float strata = layers(dir, 4);

  float lift = max(dir.y + 0.03, 0.02);
  vec2 deck = dir.xz / lift + uCam.xz / 1400.0;
  float px = 3.4 * pixel / (lift * lift);
  vec2 p = deck * 3.4 + vec2(27.0, 8.1) + uTime * vec2(0.01, 0.003);
  p += 0.24 * vec2(swirl(p * 0.9 + 4.1), swirl(p * 0.9 - 7.3));
  vec2 b = p + 0.16 * normalize(uSun.xz / max(uSun.y + 0.03, 0.02) - dir.xz / lift + 1e-4);
  float broad = 0.0;
  float shifted = 0.0;
  float coarse = 0.0;
  float fine = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 9; i++) {
    if (px > 0.5) break;
    float n = amp * (1.0 - smoothstep(0.18, 0.5, px));
    float here = n * noise(p);
    if (i < 2) {
      broad += here;
      shifted += n * noise(b);
      b = TURN * b * 2.03 + 11.7;
    }
    if (i < 4) coarse += here;
    else fine += here;
    p = TURN * p * 2.03 + 11.7;
    px *= 2.03;
    amp *= 0.63;
  }

  float clear = smoothstep(0.03, 0.22, dir.y);
  fine *= 1.5 - 0.5 * smoothstep(0.1, 0.3, uTan.y);

  float bearing = atan(dir.x, dir.z) - atan(uSun.x, uSun.z);
  vec2 bank = vec2(bearing - 0.6, dir.y - 0.36) / vec2(0.3, 0.26);
  vec2 grey = vec2(bearing + 0.3, dir.y - 0.45) / vec2(0.34, 0.34);
  float placed = 0.45 * exp(-dot(bank, bank)) + 0.42 * exp(-dot(grey, grey));

  float bulk = 1.15 * strata + 0.9 * mix(0.3, 1.0, clear) * coarse + 0.18 + placed;
  float edge = smoothstep(-0.2, 0.24, bulk);
  float frayed = 4.0 * edge * (1.0 - edge);
  float here = bulk + 0.9 * mix(0.3, 1.0, clear) * fine * (0.4 + 1.7 * frayed);
  float cover = smoothstep(-0.17, 0.2, here);
  float core = smoothstep(0.0, 0.46, here);
  float turn = (broad - shifted) * 5.0;
  float rim = clear * turn / (1.0 + abs(turn));

  float backlit = smoothstep(-0.3, 0.75, facing);
  float frontlit = 1.0 - smoothstep(-0.8, -0.2, facing);
  float thin = mix(mix(1.3, 0.8, backlit), 1.5, frontlit);
  float thick = mix(mix(1.4, 0.46, backlit), 1.95 - 0.45 * smoothstep(0.25, 0.55, here), frontlit);
  float body = mix(thin, thick, core) + 0.16 * rim + 0.5 * clear * fine;
  body += 0.35 * pow(toward, 12.0) * (1.0 - core);
  float tone = mix(1.0 + 0.3 * strata + 0.45 * clear * (coarse + fine), body, cover);

  return mix(tone, 1.0, 0.5 * pow(toward, 60.0));
}

/* -------------------------------------------------------------- cloud sea */

float seaTop(vec2 p, float fine, float lumps) {
  float h = 22.0 * (billow(p / 260.0) - 0.3);
  h += fine * 15.0 * (billow(TURN * p / 87.0 + 3.7) - 0.3);
  h += lumps * 7.0 * (billow(p / 29.0 + 9.2) - 0.3);
  return SEA + h;
}

float seaShade(vec2 at, float fine, float lumps, float t, float foot) {
  float here = seaTop(at, fine, lumps);
  vec2 sunward = normalize(uSun.xz);
  float e = 8.0 + 0.012 * t;
  float tilt = (here - seaTop(at + sunward * e, fine, lumps)) / e;
  float lit = 0.5 + 0.5 * tilt / (0.3 + abs(tilt));

  float climb = uSun.y / length(uSun.xz);
  float shade = 0.0;
  for (int i = 1; i < 4; i++) {
    float d = (10.0 + 0.004 * t) * float(i * i);
    shade += clamp((seaTop(at + sunward * d, fine, lumps) - here - climb * d) * 0.14, 0.0, 1.0);
  }
  lit *= 1.0 - 0.55 * min(shade, 1.0);

  float heaps = 0.5 * (1.0 - smoothstep(4.0, 10.0, foot)) * (billow(at / 23.0 + 5.1) - 0.5);
  heaps += 0.32 * (1.0 - smoothstep(1.5, 4.0, foot)) * (billow(TURN * at / 9.0) - 0.5);
  heaps += 0.2 * (1.0 - smoothstep(0.6, 1.6, foot)) * (billow(at / 3.7 + 1.9) - 0.5);

  return mix(0.6, 1.1, lit) * mix(0.74, 1.0, smoothstep(SEA_LOW, SEA_HIGH, here)) * (1.0 + 0.42 * heaps);
}

float sea(vec3 dir, float pixel, out float reach, out vec3 mist) {
  float drop = -dir.y;
  float top = (uCam.y - SEA_HIGH - SEA_VEIL) / drop;
  mist = vec3(0.0);

  reach = (uCam.y - SEA) / drop;
  float tone = 1.02 + 0.4 * noise((uCam.xz + dir.xz * reach) / 430.0);

  float near = 1.0 - smoothstep(0.4 * SEA_FAR, SEA_FAR, top);
  if (near > 0.0) {
    float fine = 1.0 - smoothstep(500.0, 1000.0, top);
    float pace = 1.3 * length(dir.xz) + drop;
    float t = top;
    float depth = 0.0;
    float along = 0.0;
    float lumps = 1.0;
    for (int i = 0; i < 72; i++) {
      vec3 at = uCam + dir * t;
      lumps = 1.0 - smoothstep(150.0, 700.0, t);
      float gap = at.y - seaTop(at.xz, fine, lumps);
      if (gap < 0.002 * t || depth > 4.0) break;
      float stride = (gap < SEA_VEIL ? min(gap, 2.0 + 0.005 * t) : gap - 0.6 * SEA_VEIL) / pace;
      float thick = clamp(1.0 - gap / SEA_VEIL, 0.0, 1.0);
      float add = 0.15 * thick * thick * stride;
      depth += add;
      along += add * t;
      t += stride;
    }
    float shaped = seaShade(uCam.xz + dir.xz * t, fine, lumps, t, t * pixel / max(drop, 0.05));

    float veiled = depth > 0.0 ? along / depth : t;
    if (depth > 0.0) {
      vec3 w = uCam + dir * veiled;
      float wisp = noise3(vec3(w.x / 26.0, w.y / 5.0, w.z / 26.0) + uTime * 0.02) + 0.5 * noise3(vec3(w.x / 9.0, w.y / 2.2, w.z / 9.0));
      depth *= clamp(1.0 + 2.0 * wisp, 0.55, 2.6);
    }
    float skimmed = shaped;
    float apart = smoothstep(0.02, 0.12, depth) * smoothstep(4.0 + 0.03 * t, 14.0 + 0.07 * t, t - veiled);
    if (apart > 0.0) {
      skimmed = mix(shaped, seaShade(uCam.xz + dir.xz * veiled, fine, 1.0 - smoothstep(150.0, 700.0, veiled), veiled, veiled * pixel / max(drop, 0.05)), apart);
    }

    mist = vec3(near * (1.0 - exp(-depth)), veiled, mix(tone, skimmed, near));
    tone = mix(tone, shaped, near);
    reach = mix(reach, t, near);
  }

  vec2 shadows = (uCam.xz + dir.xz * reach) / 900.0 + uTime * 0.004;
  float dapple = mix(0.72, 1.06, smoothstep(-0.12, 0.14, noise(shadows)));
  mist.z *= dapple;
  return tone * dapple;
}

/* ----------------------------------------------------------------- ridges */

const float TREE = 19.0;
const float RANK = 6.5;

vec3 conifer(float at, float plot, float plots, float seed, float widest, float rise, float light) {
  float own = mod(plot, plots);
  float a = hash(vec2(own, seed + 2.0));
  float b = hash(vec2(own, seed + 9.0));
  float tall = (0.5 + 0.5 * fract(a * 7.3 + b)) * step(0.17, fract(b * 3.3 + a));
  float v = rise / max(tall, 0.01);
  float off = at - (plot + 0.25 + 0.5 * a) - (b - 0.5) * 0.22 * v;
  float side = step(0.0, off);
  float crown = widest * (0.55 + 0.6 * b) * mix(0.75 + 0.5 * a, 1.25 - 0.5 * a, side);
  float tiers = 3.0 + floor(4.0 * fract(b * 5.7));
  float f = fract(v * tiers + 3.1 * a + 0.37 * side);
  float bough = min(f / 0.18, (1.0 - f) / 0.82);
  bough *= 1.0 + 0.5 * noise(vec2(rise * 14.0 + 7.0 * side, own + seed));
  float reach = crown * (pow(max(1.0 - v, 0.0), 0.9) * (0.66 + 0.34 * bough) - 2.0 * max(v - 1.0, 0.0));
  float across = clamp(off / max(reach, 1e-3), -1.0, 1.0);
  float sunned = (0.66 + 0.5 * clamp(v, 0.0, 1.0)) * (1.0 - 0.2 * smoothstep(0.4, 1.0, f)) * (1.0 + 0.3 * light * across);
  return vec3(reach - abs(off), sunned, fract(a * 13.7));
}

vec3 wood(float lap, float girth, float seed, float rise, float light) {
  float plots = floor(girth / 5.6);
  float big = lap * plots;
  float plot = floor(big);
  vec3 tree = conifer(big, plot, plots, seed, 0.6, rise, light);
  vec3 other = conifer(big, plot - 1.0, plots, seed, 0.6, rise, light);
  if (other.x > tree.x) tree = other;
  other = conifer(big, plot + 1.0, plots, seed, 0.6, rise, light);
  if (other.x > tree.x) tree = other;
  tree.x *= girth / plots;
  float starts = floor(girth / 3.7);
  float young = lap * starts;
  other = conifer(young, floor(young), starts, seed + 4.0, 0.42, rise / 0.55, light);
  if (other.x * girth / starts > tree.x) tree = vec3(other.x * girth / starts, other.yz);
  return tree;
}

vec2 ridge(float lum, vec3 dir, float far, float low, float high, float seed, float pixel, float haze, float lit, float reach, float cloud, float vapour) {
  float a = dot(dir.xz, dir.xz);
  if (a < 1e-4) return vec2(lum, 0.0);
  float b = dot(uCam.xz, dir.xz);
  float t = (sqrt(b * b - a * (dot(uCam.xz, uCam.xz) - far * far)) - b) / a;
  if (t > reach) return vec2(lum, 0.0);
  vec3 p = uCam + dir * t;
  if (p.y > high + TREE + 3.0 || p.y < SEA_LOW) return vec2(lum, 0.0);

  vec2 q = p.xz / far;
  float crest = mix(low, high, 0.5 + noise(q * 2.3 + seed) + 0.45 * noise(q * 6.1 - seed));
  if (p.y > crest + TREE + 3.0) return vec2(lum, 0.0);
  float lap = atan(p.x, p.z) / 6.2831853 + 0.5;
  float girth = 6.2831853 * far;
  float small = t * pixel;
  float soft = 0.7 * small + 0.00015 * t;
  float air = 1.0 - exp(-t / 3000.0);
  float dark = mix(mix(0.02 + 0.13 * haze, 0.3, lit), min(haze, lum + 0.06), air);
  dark *= 1.0 + 0.2 * noise3(vec3(q * (far / 140.0) + seed, p.y / 55.0));
  float clear = smoothstep(SEA_HIGH, SEA_HIGH + SEA_VEIL + 16.0, p.y);
  float shore = seaTop(p.xz, 1.0 - smoothstep(500.0, 1000.0, t), 1.0 - smoothstep(150.0, 700.0, t));
  float above = smoothstep(SEA_HIGH - 12.0, SEA_HIGH, p.y) * smoothstep(0.0, 5.0, p.y - shore);
  float light = dot(normalize(uSun.xz), vec2(dir.z, -dir.x)) / sqrt(a);
  float drawn = 1.0 - smoothstep(0.25, 0.7, small / 3.9);
  float detail = 1.0 - smoothstep(0.07, 0.26, small / RANK);
  float grove = mix(0.6, 1.0, smoothstep(-0.2, 0.06, noise(q * (far / 75.0) + 3.0 * seed)));

  float top = crest - RANK * 0.9 * noise(q * (far / 55.0) + seed);
  float scrub = 0.74 + 0.3 * noise3(vec3(q * (far / 1.9), p.y / 1.3));
  float plain = dark * mix(1.0, 0.85, lit) * (1.0 + 0.45 * (1.0 - air) * noise3(vec3(q * (far / 9.0), p.y / 6.0)));
  float deep = mix(plain, mix(mix(dark, haze, 0.4), 0.6 * dark, lit), detail);
  float seen = above * smoothstep(-soft, soft, top - p.y);
  lum = mix(lum, mix(cloud, deep, clear), seen);
  float nearest = floor((crest - p.y + TREE) / RANK + 0.45);
  for (int j = 0; j < 4; j++) {
    float k = nearest - 3.0 + float(j);
    if (k < 0.0) continue;
    float ground = crest - RANK * (k + 0.9 * noise(q * (far / 55.0) + seed + vec2(7.3, 3.9) * k));
    float stand = TREE * drawn * grove * smoothstep(SEA_HIGH + 4.0, SEA_HIGH + 30.0, ground);
    float rise = p.y - ground;
    vec3 tree = wood(fract(lap + 0.37 * k), girth, seed + k, rise / max(stand, 0.01), light);
    float brush = 0.2 * stand * (0.9 + 1.5 * noise(q * (far / 2.7) + 5.3 * k)) - rise;
    float misted = mix(dark, haze, 0.4 * smoothstep(-0.2, 0.55, 0.72 - rise / max(stand, 0.01)));
    float sunned = dark * (tree.x > brush ? tree.y * (0.84 + 0.32 * tree.z) : scrub);
    float cover = above * smoothstep(-soft, soft, max(tree.x, brush));
    lum = mix(lum, mix(cloud, mix(plain, mix(misted, sunned, lit), detail), clear), cover);
    seen = max(seen, cover);
  }
  return vec2(lum, t < vapour ? seen : 0.0);
}

void main() {
  vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec3 dir = normalize(uFwd + uRight * (ndc.x * uTan.x) + uUp * (ndc.y * uTan.y));
  float pixel = 2.0 * uTan.y / uRes.y;

  float facing = dot(dir, uSun);
  float toward = max(facing, 0.0);
  float light = mix(0.4, 0.82, pow(0.5 + 0.5 * facing, 5.0)) + 0.6 * pow(toward, 60.0);
  float haze = max(light * 1.05, 0.6);
  float lit = 1.0 - smoothstep(-0.75, 0.0, facing);
  float sunlit = mix(0.82, 1.04, 1.0 - smoothstep(-0.5, 0.9, facing)) + 0.4 * pow(toward, 3.0);

  float lum;
  float reach = 1e9;
  vec3 mist = vec3(0.0);
  float level = 0.0;
  if (dir.y >= 0.0) {
    lum = mix(light * sky(dir, facing, toward, pixel), haze, exp(-dir.y * 8.0));
  } else {
    float tone = sea(dir, pixel, reach, mist);
    level = exp(dir.y * 25.0);
    lum = mix(sunlit * tone, haze, max(1.0 - exp(-reach / 1500.0), level));
  }
  float cloud = dir.y >= 0.0 ? haze : lum;

  vec2 hills = ridge(lum, dir, 2400.0, -40.0, 250.0, 9.0, pixel, haze, lit, reach, cloud, mist.y);
  float hidden = hills.y;
  hills = ridge(hills.x, dir, 1300.0, -50.0, 150.0, 5.0, pixel, haze, lit, reach, cloud, mist.y);
  hidden = max(hidden, hills.y);
  hills = ridge(hills.x, dir, 700.0, -60.0, 85.0, 1.0, pixel, haze, lit, reach, cloud, mist.y);
  hidden = max(hidden, hills.y);
  lum = hills.x;

  lum = mix(lum, mix(sunlit * mist.z, haze, max(1.0 - exp(-mist.y / 1500.0), level)), mist.x * (1.0 - hidden));

  float halo = smoothstep(0.1, 0.3, uTan.y) * smoothstep(0.7, 0.93, facing) * (1.0 - pow(toward, 90.0));
  if (halo > 0.0) {
    float through = 0.0;
    for (int i = 1; i < 6; i++) {
      float cloud = 1.15 * layers(normalize(mix(dir, uSun, 0.17 * float(i))), 2) + 0.18;
      through += 1.0 - smoothstep(-0.08, 0.1, cloud);
    }
    lum *= mix(1.0, mix(0.8, 1.22, through / 5.0), halo);
  }

  lum += 1.5 * pow(toward, 64.0);

  lum = lum / pow(1.0 + lum * lum * lum * lum, 0.25);

  lum += (speck(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) * 0.011 * (1.0 - smoothstep(0.9, 0.99, lum));

  gl_FragColor = vec4(vec3(lum), 1.0);
}`;

/**
 * Returns null when WebGL is unavailable, the shader will not build, or the
 * GPU cannot do its sums. `onLost` is called if the context is taken away
 * later.
 */
export function createGlSky(canvas: HTMLCanvasElement, sun: Vec3, onLost: () => void): Sky | null {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false });
  if (!gl) return null;
  // The noise is built on whole-number arithmetic up to about two million,
  // which takes a full-precision float. WebGL only promises a fragment shader half
  // of that, and on the few old phone GPUs that stop there the scene would
  // come out as static. Better not to offer it.
  const floats = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  if (!floats || floats.precision < 23) return null;
  const built = build(gl, sun);
  if (!built) return null;
  let uniforms = built;
  let ready = true;

  // Browsers reclaim GL contexts, most often from a phone tab left in the
  // background. Declining the default asks for it back; until it returns
  // there is nothing to draw with.
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    ready = false;
    onLost();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    const rebuilt = build(gl, sun);
    if (rebuilt) uniforms = rebuilt;
    ready = rebuilt !== null;
  });

  return {
    ready: () => ready,
    ink: canvasInk,
    resize(width, height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.uniform2f(uniforms.uRes, width, height);
    },
    render(cam, time) {
      gl.uniform3fv(uniforms.uCam, cam.pos);
      gl.uniform3fv(uniforms.uRight, cam.right);
      gl.uniform3fv(uniforms.uUp, cam.up);
      gl.uniform3fv(uniforms.uFwd, cam.fwd);
      gl.uniform2f(uniforms.uTan, (cam.tanY * canvas.width) / canvas.height, cam.tanY);
      gl.uniform1f(uniforms.uTime, time);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

type Uniforms = Record<'uRes' | 'uCam' | 'uRight' | 'uUp' | 'uFwd' | 'uTan' | 'uTime', WebGLUniformLocation | null>;

/**
 * Compile the shader and set up its one triangle. Everything made here dies
 * with the GL context, so this is also what a restore has to redo.
 */
function build(gl: WebGLRenderingContext, sun: Vec3): Uniforms | null {
  const program = gl.createProgram();
  if (!program) return null;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, VERTEX],
    [gl.FRAGMENT_SHADER, FRAGMENT],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      // A lost context fails here too, and that is not worth a warning.
      if (!gl.isContextLost()) console.warn('Flight sky shader failed to compile:', gl.getShaderInfoLog(shader));
      return null;
    }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    if (!gl.isContextLost()) console.warn('Flight sky shader failed to link:', gl.getProgramInfoLog(program));
    return null;
  }
  gl.useProgram(program);

  // One triangle that overshoots the viewport covers it without a diagonal seam.
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program, 'corner');
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

  const uniform = (name: string) => gl.getUniformLocation(program, name);
  gl.uniform3fv(uniform('uSun'), sun);
  return {
    uRes: uniform('uRes'),
    uCam: uniform('uCam'),
    uRight: uniform('uRight'),
    uUp: uniform('uUp'),
    uFwd: uniform('uFwd'),
    uTan: uniform('uTan'),
    uTime: uniform('uTime'),
  };
}
