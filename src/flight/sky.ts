/**
 * What the flight asks of whatever draws it: the world behind the paramotor
 * (sky, a sea of cloud, wooded hills) and the paramotor's own layer over it.
 *
 * There are two renderers. WebGPU is the one the scene is made for; WebGL,
 * with the paramotor on a 2D canvas, is for browsers without it. Each is
 * fetched only if it is the one that will be used.
 */

import type { Camera, Viewport } from './camera.ts';
import type { Craft } from './sim.ts';
import type { Vec3 } from './vec.ts';

/** The paramotor's layer. */
export interface Ink {
  /** Set its size in CSS pixels, and how many device pixels each of those is. */
  resize(width: number, height: number, pixelRatio: number): void;
  /** `lineInk` is how strongly the suspension lines are drawn, from 0 to 1. */
  draw(cam: Camera, view: Viewport, craft: Craft, lineInk: number): void;
}

export interface Sky {
  /** Set the size the world is drawn at, in pixels. */
  resize(width: number, height: number): void;
  render(cam: Camera, time: number): void;
  /** False while the browser has taken the GPU away, which it does to tabs left in the background. */
  ready(): boolean;
  /** The paramotor's layer on another canvas, drawn the same way the world is. Null if it cannot be. */
  ink(canvas: HTMLCanvasElement): Ink | null;
}

/**
 * Builds the world on a canvas. Null when the browser cannot draw it.
 * `onLost` is called if the GPU is taken away later; `ready()` says when it
 * is back.
 */
export type SkyFactory = (
  canvas: HTMLCanvasElement,
  sun: Vec3,
  onLost: () => void
) => Promise<Sky | null> | Sky | null;

/** WebGPU where the browser has it, WebGL where not. */
export const createSky: SkyFactory = async (canvas, sun, onLost) => {
  if ('gpu' in navigator) {
    const { createGpuSky } = await import('./sky-gpu.ts');
    const sky = await createGpuSky(canvas, sun, onLost);
    if (sky) return sky;
  }
  const { createGlSky } = await import('./sky-gl.ts');
  return createGlSky(canvas, sun, onLost);
};
