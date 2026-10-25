// Phone sensor layer: permissions, orientation (tilt), motion (yank), haptics.
// Shared by the sensor test page and the controller so tuning carries over.

type PermissionFn = () => Promise<'granted' | 'denied'>;
type WithPermission = { requestPermission?: PermissionFn };

export type MotionPermission = 'granted' | 'denied' | 'unsupported' | 'insecure';

/**
 * Must be called directly inside a user gesture (click/tap handler).
 * iOS needs BOTH orientation and motion permission; both requests are started
 * synchronously so neither loses the gesture's user activation.
 */
export async function requestMotionPermission(): Promise<MotionPermission> {
  if (!window.isSecureContext) return 'insecure';
  if (typeof DeviceOrientationEvent === 'undefined' && typeof DeviceMotionEvent === 'undefined') return 'unsupported';
  const orient = (window.DeviceOrientationEvent as unknown as WithPermission | undefined)?.requestPermission;
  const motion = (window.DeviceMotionEvent as unknown as WithPermission | undefined)?.requestPermission;
  if (!orient && !motion) return 'granted'; // Android / desktop: no prompt needed
  try {
    const results = await Promise.all([
      orient ? orient.call(DeviceOrientationEvent) : Promise.resolve('granted' as const),
      motion ? motion.call(DeviceMotionEvent) : Promise.resolve('granted' as const),
    ]);
    return results.every(r => r === 'granted') ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

export interface Orientation { beta: number; gamma: number }

/** beta = front/back tilt (-180..180), gamma = left/right tilt (-90..90). Portrait assumed. */
export function onOrientation(cb: (o: Orientation) => void): () => void {
  const handler = (e: DeviceOrientationEvent) => {
    if (e.beta == null || e.gamma == null) return;
    cb({ beta: e.beta, gamma: e.gamma });
  };
  window.addEventListener('deviceorientation', handler);
  return () => window.removeEventListener('deviceorientation', handler);
}

export interface MotionSample {
  /** Linear acceleration magnitude in m/s², gravity removed. */
  magnitude: number;
  /** Rotation rate magnitude in deg/s. */
  rotation: number;
  /** True when the browser gave gravity-free acceleration; false = we high-pass filtered. */
  native: boolean;
  t: number;
}

/** Streams gravity-free acceleration magnitude. Falls back to a high-pass filter when `acceleration` is null. */
export function onMotion(cb: (s: MotionSample) => void): () => void {
  const g = { x: 0, y: 0, z: 0 };
  let primed = false;
  const handler = (e: DeviceMotionEvent) => {
    const a = e.acceleration;
    let x: number, y: number, z: number, native = true;
    if (a && a.x != null && a.y != null && a.z != null) {
      x = a.x; y = a.y; z = a.z;
    } else {
      const ag = e.accelerationIncludingGravity;
      if (!ag || ag.x == null || ag.y == null || ag.z == null) return;
      native = false;
      if (!primed) { g.x = ag.x; g.y = ag.y; g.z = ag.z; primed = true; }
      const k = 0.9; // low-pass gravity estimate
      g.x = k * g.x + (1 - k) * ag.x; g.y = k * g.y + (1 - k) * ag.y; g.z = k * g.z + (1 - k) * ag.z;
      x = ag.x - g.x; y = ag.y - g.y; z = ag.z - g.z;
    }
    const r = e.rotationRate;
    const rotation = r ? Math.hypot(r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0) : 0;
    cb({ magnitude: Math.hypot(x, y, z), rotation, native, t: performance.now() });
  };
  window.addEventListener('devicemotion', handler);
  return () => window.removeEventListener('devicemotion', handler);
}

/**
 * Yank = a sharp acceleration spike above `threshold`, with a cooldown so one
 * yank fires once. Normal tilting stays well under ~5 m/s²; a deliberate yank
 * is typically 15–40 m/s². Tune `threshold` on real phones via the test page.
 */
export class YankDetector {
  threshold: number;
  cooldownMs: number;
  private lastFire = -Infinity;
  constructor(threshold = 18, cooldownMs = 500) { this.threshold = threshold; this.cooldownMs = cooldownMs; }
  /** Returns true exactly once per yank. */
  push(s: MotionSample): boolean {
    if (s.magnitude < this.threshold || s.t - this.lastFire < this.cooldownMs) return false;
    this.lastFire = s.t;
    return true;
  }
}

/** Stillness: recent motion magnitudes all stay under `limit`. Used to gate calibration. */
export class StillnessCheck {
  private window: number[] = [];
  constructor(private size = 30, private limit = 1.2) {}
  push(magnitude: number): boolean {
    this.window.push(magnitude);
    if (this.window.length > this.size) this.window.shift();
    return this.window.length === this.size && Math.max(...this.window) < this.limit;
  }
}

/** Android: real vibration. iOS Safari ignores navigator.vibrate. */
export function vibrate(pattern: number | number[] = 40): boolean {
  return typeof navigator.vibrate === 'function' ? navigator.vibrate(pattern) : false;
}

let hapticLabel: HTMLLabelElement | undefined;
/**
 * iOS 18+ Safari trick: toggling a hidden <input type="checkbox" switch> plays a
 * system haptic. Only works inside a user gesture, so it cannot fire from a
 * devicemotion callback; use it for taps (buttons), not for yanks.
 */
export function iosHapticTap(): void {
  if (!hapticLabel) {
    hapticLabel = document.createElement('label');
    hapticLabel.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;overflow:hidden';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    hapticLabel.appendChild(input);
    document.body.appendChild(hapticLabel);
  }
  hapticLabel.click();
}

/** Best available feedback: vibrate on Android, haptic switch on iOS (gesture only). */
export function buzz(ms = 40): void {
  if (!vibrate(ms)) iosHapticTap();
}
