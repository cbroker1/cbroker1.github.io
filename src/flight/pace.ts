/**
 * Holds the frame rate by trading away resolution, and only where the trade
 * works.
 *
 * The sky shader is nearly all of the GPU's load, and what it costs follows
 * the number of pixels. So when frames run long the world is drawn smaller,
 * by as much as the shortfall calls for, and the next stretch is timed. If
 * that was no faster, the hold-up is somewhere resolution cannot reach, such
 * as a browser capped at 30 frames a second to save power, and the detail
 * goes back.
 *
 * That verdict can be wrong, because the view changes what a frame costs
 * while it is being timed, most of all as the camera lifts off. Two things
 * allow for it. Frames that got slower in spite of a cut say the view got
 * costlier, so the cut is kept and deepened. And a cut that seemed to change
 * nothing is tried again later, twice, before the scene stops adjusting.
 *
 * Nothing here touches the page, so a device can be simulated in a test.
 */

/**
 * Frames are slow when they average longer than this, which is one beat in
 * twenty missed on a 60 Hz screen, and are also one of two things. Uneven:
 * the average is this much longer than the usual frame, because a GPU that
 * is a little behind delivers most frames on the beat and makes up the wait
 * in a few long ones. Or evenly slower than any screen's own beat, 50 Hz
 * included.
 */
const SLOW_FRAME = 1 / 57;
const UNEVEN = 1.04;
const SLOW_BEAT = 1 / 47;
/** What a cut aims for: a 60 Hz beat, with a little in hand. */
const TARGET_FRAME = 0.9 / 60;
/** However small the shortfall, a cut is at least this deep, so that it shows up in the timing. */
const GENTLEST_CUT = 0.8;
/** A cut has to shorten frames by this share to be kept. */
const GAIN = 0.1;
/** Frames this much longer after a cut mean the view got costlier while it was on trial. */
const WORSE = 1.05;
/** Cuts that did not help before the scene stops trying. */
const STRIKES = 3;

/** A decision is made on this many frames, or on this many seconds from a device too slow to deliver them. */
const WINDOW = 45;
const WINDOW_SECONDS = 1.5;
const WINDOW_LEAST = 8;
/** After a change, frames already on their way to the screen are not timed. */
const SETTLE_FRAMES = 3;
const SETTLE_SECONDS = 0.2;
/** No one frame counts for more than this: a paused debugger is not a slow device. */
const LONGEST_FRAME = 0.5;

export interface Pacer {
  /** Share of its full resolution, each way, to draw the world at. */
  scale: number;
  /** Time one frame, in seconds. True when `scale` has just changed. */
  frame(seconds: number): boolean;
  /** Disregard what comes next: this many seconds of it, and never fewer than a few frames. */
  settle(seconds: number): void;
}

/** `floor` is the smallest scale it will ever ask for. */
export function createPacer(floor: number): Pacer {
  const times = new Float32Array(WINDOW);
  let count = 0;
  let span = 0;
  let skipFrames = 0;
  let skipSeconds = 0;
  /** A cut on trial: the scale it was cut from, and the pace it has to beat. */
  let trial: { from: number; pace: number } | null = null;
  let strikes = 0;
  /** Decisions to sit out before trying a cut again. */
  let rest = 0;

  function decide(pace: number, slow: boolean): boolean {
    /** Where a cut that turns out not to help goes back to. */
    let from = pacer.scale;
    if (trial) {
      from = trial.from;
      const helped = !slow || pace <= trial.pace * (1 - GAIN);
      const costlier = pace > trial.pace * WORSE && pacer.scale > floor;
      trial = null;
      if (!helped && !costlier) {
        strikes += 1;
        rest = 2 ** strikes;
        pacer.scale = from;
        pacer.settle(SETTLE_SECONDS);
        return true;
      }
      // Helped: any further cut is a new trial, and this one is kept.
      if (helped) from = pacer.scale;
    }
    if (rest > 0) {
      rest -= 1;
      return false;
    }
    if (!slow || strikes >= STRIKES || pacer.scale <= floor) return false;

    // Frames land on the screen's beat, so a cut that leaves the GPU a shade
    // too slow changes nothing at all. Cost follows area: cut each side by
    // the square root of the shortfall and the next beat is within reach.
    trial = { from, pace };
    pacer.scale = Math.max(floor, pacer.scale * Math.min(GENTLEST_CUT, Math.sqrt(TARGET_FRAME / pace)));
    pacer.settle(SETTLE_SECONDS);
    return true;
  }

  const pacer: Pacer = {
    scale: 1,
    frame(seconds) {
      const time = Math.min(Math.max(seconds, 0), LONGEST_FRAME);
      if (skipFrames > 0 || skipSeconds > 0) {
        skipFrames -= 1;
        skipSeconds -= time;
        return false;
      }
      times[count++] = time;
      span += time;
      if (count < WINDOW && (span < WINDOW_SECONDS || count < WINDOW_LEAST)) return false;

      // One hitch is not a trend, so the slowest frame is set aside. Only
      // that one: two long frames in a window are the GPU falling behind.
      const sorted = times.subarray(0, count).sort();
      const usual = sorted[count >> 1];
      const pace = (span - sorted[count - 1]) / (count - 1);
      count = 0;
      span = 0;
      return decide(pace, pace > SLOW_FRAME && (pace > usual * UNEVEN || usual > SLOW_BEAT));
    },
    settle(seconds) {
      count = 0;
      span = 0;
      skipFrames = SETTLE_FRAMES;
      skipSeconds = seconds;
    },
  };
  return pacer;
}
