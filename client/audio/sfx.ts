/**
 * Tiny synthesized sound effects (Web Audio). No audio files, no licences,
 * nothing to download. Shared by the big screen and the phone controller.
 */
let ctx: AudioContext | undefined;
function audio(): AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return undefined;
  ctx ??= new Ctor();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Call from a click/tap handler once so later sounds are allowed (iOS needs this). */
export function unlockAudio(): void {
  const a = audio();
  if (!a) return;
  const b = a.createBuffer(1, 1, 22050);
  const s = a.createBufferSource(); s.buffer = b; s.connect(a.destination); s.start(0);
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'square', gain = 0.12, slideTo?: number) {
  const a = audio(); if (!a) return;
  const t = a.currentTime + start;
  const o = a.createOscillator(); const g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

export const sfx = {
  pickup: () => { tone(660, 0, 0.09, 'triangle', 0.16); tone(990, 0.08, 0.14, 'triangle', 0.16); },
  steal: () => { tone(880, 0, 0.08, 'sawtooth', 0.1); tone(440, 0.07, 0.18, 'sawtooth', 0.1, 220); },
  drop: () => tone(520, 0, 0.3, 'triangle', 0.12, 180),
  duel: () => { tone(196, 0, 0.18, 'square', 0.1); tone(233, 0.2, 0.22, 'square', 0.1); },
  draw: () => { tone(1320, 0, 0.12, 'square', 0.18); tone(1760, 0.05, 0.16, 'square', 0.14); },
  foul: () => tone(150, 0, 0.35, 'sawtooth', 0.14, 90),
  win: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.08, 0.14, 'triangle', 0.14)); },
  lose: () => { tone(392, 0, 0.16, 'triangle', 0.12); tone(311, 0.15, 0.26, 'triangle', 0.12); },
  countdown: () => { [0, 0.7, 1.4].forEach(t => tone(440, t, 0.12, 'square', 0.1)); },
  start: () => tone(880, 0, 0.35, 'square', 0.14),
  tick: () => tone(1000, 0, 0.05, 'square', 0.08),
  end: () => { [784, 659, 523, 784, 1047].forEach((f, i) => tone(f, i * 0.1, 0.16, 'triangle', 0.14)); },
};
