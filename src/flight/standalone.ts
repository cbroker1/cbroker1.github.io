/**
 * The flight on a page of its own: no site around it and no footage to take
 * over from, only the scene, drawn with WebGPU.
 *
 * `scripts/build-flight-html.mjs` packs this, everything it imports and
 * `standalone.html` into one self-contained file. The homepage hero is the
 * same flight with the site's footage in front of it and a WebGL fallback.
 */

import { type Flight, createFlight } from './flight.ts';
import { createGpuSky } from './sky-gpu.ts';

const find = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scene = find<HTMLElement>('scene');
const status = find<HTMLElement>('status');

let flight: Flight | null = null;

/** Start flying, or carry on after a pause. */
function fly(): void {
  if (!flight) return;
  status.textContent = flight.start() ? '' : 'Waiting for the browser to hand the GPU back. Click to try again.';
}

// Called for Escape, and when the browser takes the GPU away mid-flight.
function pause(): void {
  flight?.stop();
  status.textContent = 'Paused. Click to carry on.';
}

flight = await createFlight(
  { hero: scene, video: null, sky: find('sky'), ink: find('ink'), readout: find('readout'), view: find('view') },
  pause,
  createGpuSky
);

if (flight) {
  scene.focus();
  scene.addEventListener('pointerdown', fly);
  fly();
} else {
  status.textContent = 'This needs WebGPU, and this browser does not have it, or has it switched off.';
}
