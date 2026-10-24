import type { Orientation } from './sensors.js';

export interface Calibration { beta: number; gamma: number }

export interface TiltConfig {
  /** Degrees of tilt from the calibrated pose that map to full speed. */
  maxTilt: number;
  /** Fraction of maxTilt ignored around the calibrated pose. */
  deadZone: number;
}

export const DEFAULT_TILT: TiltConfig = { maxTilt: 25, deadZone: 0.12 };

/** Average a batch of orientation samples captured while the phone is held still. */
export function calibrate(samples: Orientation[]): Calibration {
  const n = samples.length || 1;
  return {
    beta: samples.reduce((s, o) => s + o.beta, 0) / n,
    gamma: samples.reduce((s, o) => s + o.gamma, 0) / n,
  };
}

function axis(delta: number, cfg: TiltConfig): number {
  const v = Math.max(-1, Math.min(1, delta / cfg.maxTilt));
  const mag = Math.abs(v);
  if (mag < cfg.deadZone) return 0;
  // Rescale so output ramps from 0 right at the dead-zone edge.
  return Math.sign(v) * (mag - cfg.deadZone) / (1 - cfg.deadZone);
}

/** Map orientation to a desired direction in -1..1. x = right, y = down (screen coords). */
export function tiltToMove(o: Orientation, cal: Calibration, cfg: TiltConfig = DEFAULT_TILT): { x: number; y: number } {
  return { x: axis(o.gamma - cal.gamma, cfg), y: axis(o.beta - cal.beta, cfg) };
}
