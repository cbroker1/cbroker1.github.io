/**
 * The paramotor, drawn with WebGPU.
 *
 * `drawGlider` describes the rig the way a 2D canvas is asked to draw one:
 * build a path, then stroke it or fill it. The pen here takes that dictation
 * in place of a canvas and turns it into the two things a GPU draws well.
 *
 * Everything stroked becomes capsules: lines, hoops, net and limbs. A line
 * with round ends is the set of points within some distance of a segment, so
 * the fragment shader measures that distance and the edge comes out as smooth
 * as the arithmetic. Everything filled becomes triangles, which is only the
 * canopy's skin, and multisampling smooths those.
 *
 * It is all black ink of one strength or another, and where strokes cross the
 * ink must not add up: a canvas strokes a whole path as one shape. So the
 * blend keeps the strongest ink at each pixel rather than summing it.
 */

import type { Camera, Viewport } from './camera.ts';
import { type Pen, drawGlider } from './glider.ts';
import type { Craft } from './sim.ts';
import type { Ink } from './sky.ts';

const SHADER = /* wgsl */ `
struct Frame {
  size: vec2f,
  ratio: f32,
}
@group(0) @binding(0) var<uniform> frame: Frame;

// From CSS pixels, counted from the top left, to where the GPU wants it.
fn place(at: vec2f) -> vec4f {
  return vec4f(at.x / frame.size.x * 2.0 - 1.0, 1.0 - at.y / frame.size.y * 2.0, 0.0, 1.0);
}

@vertex
fn skin(@location(0) at: vec2f) -> @builtin(position) vec4f {
  return place(at);
}

@fragment
fn solid() -> @location(0) vec4f {
  return vec4f(0.0, 0.0, 0.0, 1.0);
}

struct Stroke {
  @builtin(position) spot: vec4f,
  @location(0) at: vec2f,
  @location(1) @interpolate(flat) ends: vec4f,
  @location(2) @interpolate(flat) look: vec2f,
}

// One capsule: a rectangle laid along the segment, big enough to hold it and
// the pixel its edge fades over. look is its radius and how strong its ink.
@vertex
fn stroke(@builtin(vertex_index) corner: u32, @location(0) ends: vec4f, @location(1) look: vec2f) -> Stroke {
  let span = ends.zw - ends.xy;
  let stretch = length(span);
  var dir = vec2f(1.0, 0.0);
  if (stretch > 1e-4) { dir = span / stretch; }
  let reach = look.x + 1.0;
  let along = mix(-reach, stretch + reach, f32(corner & 1u));
  let across = (f32(corner >> 1u) * 2.0 - 1.0) * reach;
  let at = ends.xy + dir * along + vec2f(-dir.y, dir.x) * across;
  return Stroke(place(at), at, ends, look);
}

@fragment
fn ink(s: Stroke) -> @location(0) vec4f {
  let span = s.ends.zw - s.ends.xy;
  let t = clamp(dot(s.at - s.ends.xy, span) / max(dot(span, span), 1e-8), 0.0, 1.0);
  let away = distance(s.at, s.ends.xy + span * t);
  return vec4f(0.0, 0.0, 0.0, s.look.y * clamp((s.look.x - away) * frame.ratio + 0.5, 0.0, 1.0));
}`;

// Room for a frame's worth of each, with plenty to spare: the rig asks for
// about 350 capsules and 1,500 vertices.
const MAX_CAPSULES = 1024;
const MAX_VERTICES = 4096;
const MAX_POINTS = 2048;
const MAX_PATHS = 512;
const CAPSULE_FLOATS = 6;
const SAMPLES = 4;

/** Everything of the ink's that dies with a GPU device. */
export interface InkGear {
  stroke: GPURenderPipeline;
  skin: GPURenderPipeline;
  frame: GPUBuffer;
  capsules: GPUBuffer;
  vertices: GPUBuffer;
  bindings: GPUBindGroup;
}

export async function buildInk(device: GPUDevice, format: GPUTextureFormat): Promise<InkGear> {
  const module = device.createShaderModule({ code: SHADER });
  const group = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }],
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [group] });
  // Ink stays black, and where two lots of it meet the stronger wins.
  const targets: GPUColorTargetState[] = [
    {
      format,
      blend: {
        color: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
        alpha: { operation: 'max', srcFactor: 'one', dstFactor: 'one' },
      },
    },
  ];
  const [stroke, skin] = await Promise.all([
    device.createRenderPipelineAsync({
      layout,
      vertex: {
        module,
        entryPoint: 'stroke',
        buffers: [
          {
            arrayStride: CAPSULE_FLOATS * 4,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x4' },
              { shaderLocation: 1, offset: 16, format: 'float32x2' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'ink', targets },
      primitive: { topology: 'triangle-strip' },
      multisample: { count: SAMPLES },
    }),
    device.createRenderPipelineAsync({
      layout,
      vertex: {
        module,
        entryPoint: 'skin',
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
      },
      fragment: { module, entryPoint: 'solid', targets },
      primitive: { topology: 'triangle-list' },
      multisample: { count: SAMPLES },
    }),
  ]);
  const frame = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  return {
    stroke,
    skin,
    frame,
    capsules: device.createBuffer({
      size: MAX_CAPSULES * CAPSULE_FLOATS * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    }),
    vertices: device.createBuffer({ size: MAX_VERTICES * 8, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }),
    bindings: device.createBindGroup({ layout: group, entries: [{ binding: 0, resource: { buffer: frame } }] }),
  };
}

/**
 * The rig's layer on `canvas`. `gear` hands over the device in use and the
 * ink's share of it, or null while the browser has taken the GPU away; it is
 * asked every frame because a lost device is replaced by another.
 */
export function createInk(
  canvas: HTMLCanvasElement,
  format: GPUTextureFormat,
  gear: () => { device: GPUDevice; ink: InkGear } | null
): Ink | null {
  const context = canvas.getContext('webgpu');
  if (!context) return null;

  // What the pen has taken down this frame.
  const capsules = new Float32Array(MAX_CAPSULES * CAPSULE_FLOATS);
  const vertices = new Float32Array(MAX_VERTICES * 2);
  let capsuleCount = 0;
  let vertexCount = 0;
  // The path being built: its points, where each stretch of it starts, which
  // stretches are closed, and any full circles.
  const points = new Float32Array(MAX_POINTS * 2);
  const starts = new Int32Array(MAX_PATHS + 1);
  const closed = new Uint8Array(MAX_PATHS);
  const discs = new Float32Array(8 * 3);
  let pointCount = 0;
  let pathCount = 0;
  let discCount = 0;

  const capsule = (ax: number, ay: number, bx: number, by: number, radius: number, strength: number): void => {
    if (capsuleCount === MAX_CAPSULES) return;
    const at = capsuleCount++ * CAPSULE_FLOATS;
    capsules[at] = ax;
    capsules[at + 1] = ay;
    capsules[at + 2] = bx;
    capsules[at + 3] = by;
    capsules[at + 4] = radius;
    capsules[at + 5] = strength;
  };
  const point = (x: number, y: number): void => {
    if (pointCount === MAX_POINTS) return;
    points[pointCount * 2] = x;
    points[pointCount * 2 + 1] = y;
    pointCount++;
  };

  const pen: Pen = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineCap: 'round',
    lineJoin: 'round',
    globalAlpha: 1,
    lineWidth: 1,
    beginPath() {
      pointCount = 0;
      pathCount = 0;
      discCount = 0;
    },
    moveTo(x, y) {
      if (pathCount === MAX_PATHS) return;
      starts[pathCount] = pointCount;
      closed[pathCount++] = 0;
      point(x, y);
    },
    lineTo(x, y) {
      point(x, y);
    },
    closePath() {
      if (pathCount > 0) closed[pathCount - 1] = 1;
    },
    // Only ever asked for whole circles.
    arc(x, y, radius) {
      if (discCount === 8) return;
      const at = discCount++ * 3;
      discs[at] = x;
      discs[at + 1] = y;
      discs[at + 2] = radius;
    },
    stroke() {
      const radius = pen.lineWidth / 2;
      starts[pathCount] = pointCount;
      for (let p = 0; p < pathCount; p++) {
        const first = starts[p];
        const end = starts[p + 1];
        for (let i = first; i + 1 < end; i++) {
          capsule(points[i * 2], points[i * 2 + 1], points[i * 2 + 2], points[i * 2 + 3], radius, pen.globalAlpha);
        }
        if (closed[p] && end - first > 2) {
          const last = end - 1;
          capsule(points[last * 2], points[last * 2 + 1], points[first * 2], points[first * 2 + 1], radius, pen.globalAlpha);
        }
      }
    },
    fill() {
      starts[pathCount] = pointCount;
      for (let p = 0; p < pathCount; p++) {
        const first = starts[p];
        // A fan from the first corner: right for the four-sided panels, and
        // near enough for the two aerofoil sections that close the wingtips.
        for (let i = first + 1; i + 1 < starts[p + 1] && vertexCount + 3 <= MAX_VERTICES; i++) {
          vertices[vertexCount * 2] = points[first * 2];
          vertices[vertexCount * 2 + 1] = points[first * 2 + 1];
          vertices[vertexCount * 2 + 2] = points[i * 2];
          vertices[vertexCount * 2 + 3] = points[i * 2 + 1];
          vertices[vertexCount * 2 + 4] = points[i * 2 + 2];
          vertices[vertexCount * 2 + 5] = points[i * 2 + 3];
          vertexCount += 3;
        }
      }
      for (let d = 0; d < discCount; d++) {
        capsule(discs[d * 3], discs[d * 3 + 1], discs[d * 3], discs[d * 3 + 1], discs[d * 3 + 2], pen.globalAlpha);
      }
    },
  };

  const frame = new Float32Array(4);
  let configured: GPUDevice | null = null;
  // Multisampling needs somewhere of its own to draw, which is then averaged
  // down onto the canvas. It is as big as the canvas and made by one device.
  let smooth: GPUTexture | null = null;
  // Where a frame is drawn and where it is averaged down to. Made along with
  // that texture and reused after, so that a frame allocates nothing it does
  // not have to.
  let target: GPURenderPassColorAttachment | null = null;
  let pass: GPURenderPassDescriptor | null = null;
  const commands: GPUCommandBuffer[] = [];

  return {
    resize(width, height, pixelRatio) {
      canvas.width = Math.max(1, Math.round(width * pixelRatio));
      canvas.height = Math.max(1, Math.round(height * pixelRatio));
      frame[2] = pixelRatio;
    },
    draw(cam: Camera, view: Viewport, craft: Craft, lineInk: number) {
      const now = gear();
      if (!now) return;
      const { device, ink } = now;
      if (configured !== device) {
        context.configure({ device, format, alphaMode: 'premultiplied' });
        configured = device;
        smooth = null;
      }
      if (!smooth || !target || !pass || smooth.width !== canvas.width || smooth.height !== canvas.height) {
        smooth?.destroy();
        smooth = device.createTexture({
          size: [canvas.width, canvas.height],
          sampleCount: SAMPLES,
          format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        target = { view: smooth.createView(), loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 0] };
        pass = { colorAttachments: [target] };
      }

      capsuleCount = 0;
      vertexCount = 0;
      drawGlider(pen, cam, view, craft, lineInk);

      frame[0] = view.width;
      frame[1] = view.height;
      device.queue.writeBuffer(ink.frame, 0, frame);
      device.queue.writeBuffer(ink.capsules, 0, capsules, 0, capsuleCount * CAPSULE_FLOATS);
      device.queue.writeBuffer(ink.vertices, 0, vertices, 0, vertexCount * 2);

      target.resolveTarget = context.getCurrentTexture().createView();
      const encoder = device.createCommandEncoder();
      const draw = encoder.beginRenderPass(pass);
      draw.setBindGroup(0, ink.bindings);
      if (vertexCount > 0) {
        draw.setPipeline(ink.skin);
        draw.setVertexBuffer(0, ink.vertices);
        draw.draw(vertexCount);
      }
      if (capsuleCount > 0) {
        draw.setPipeline(ink.stroke);
        draw.setVertexBuffer(0, ink.capsules);
        draw.draw(4, capsuleCount);
      }
      draw.end();
      commands[0] = encoder.finish();
      device.queue.submit(commands);
    },
  };
}
