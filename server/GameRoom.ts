import { RULES } from '../shared/constants.js';
import type { ActionError, Phase, PlayerState, Snapshot } from '../shared/events.js';
import { exact, finite, RateLimit } from './validation.js';

export const INPUT_TIMEOUT_MS = 250;
export const AVATAR_RADIUS = 18;
const STEP_MS = 1000 / RULES.simulationHz;
interface Movement { seq: number; x: number; y: number; receivedAt: number; expiresAt: number; limit: RateLimit }
const rejected = (code: ActionError['error']['code'], message: string): ActionError => ({ error: { code, message } });

/** Fixed-step simulation, driven externally with a monotonic clock. No timers or rendering dependencies. */
export class GameRoom {
  phase: Phase = 'lobby';
  tick = 0;
  countdownEndsAt = 0;
  private lastAdvanceAt: number;
  private accumulator = 0;
  private movement = new Map<string, Movement>();
  constructor(readonly players: Map<string, PlayerState>, now = performance.now()) { this.lastAdvanceAt = now; }
  start(now: number): void {
    this.phase = 'countdown'; this.countdownEndsAt = now + RULES.countdownMs;
    // Do not carry tutorial movement through the countdown.
    for (const input of this.movement.values()) { input.x = 0; input.y = 0; input.expiresAt = now; }
  }
  move(id: string, payload: unknown, now = performance.now()): { ok: true } | ActionError {
    const player = this.players.get(id);
    if (!player?.connected) return rejected('UNAUTHORIZED', 'A connected player is required.');
    if (!exact(payload, ['seq', 'x', 'y']) || !Number.isSafeInteger(payload.seq) || (payload.seq as number) < 0 || !finite(payload.x) || !finite(payload.y))
      return rejected('INVALID_PAYLOAD', 'Expected {seq: nonnegative safe integer, x: finite number, y: finite number}.');
    if (this.phase !== 'lobby' && this.phase !== 'playing') return rejected('INVALID_PHASE', 'Movement is paused during countdown.');
    const previous = this.movement.get(id);
    if (previous && (payload.seq as number) <= previous.seq) return rejected('STALE_INPUT', 'Movement sequence must increase.');
    const limit = previous?.limit ?? new RateLimit(RULES.inputHz * 1.5, 8, now);
    if (!limit.take(now)) return rejected('RATE_LIMITED', 'Send movement at approximately 20 Hz.');
    const x = Math.max(-1, Math.min(1, payload.x));
    const y = Math.max(-1, Math.min(1, payload.y));
    const magnitude = Math.max(1, Math.hypot(x, y));
    this.movement.set(id, { seq: payload.seq as number, x: x / magnitude, y: y / magnitude,
      receivedAt: now, expiresAt: now + INPUT_TIMEOUT_MS, limit });
    return { ok: true };
  }
  disconnect(id: string): void {
    const input = this.movement.get(id);
    if (input) { input.x = 0; input.y = 0; input.expiresAt = 0; }
  }
  advance(now: number): void {
    // Bound catch-up work to prevent a stalled process from teleporting players or monopolizing the event loop.
    this.accumulator += Math.min(250, Math.max(0, now - this.lastAdvanceAt));
    this.lastAdvanceAt = now;
    while (this.accumulator + 1e-8 >= STEP_MS) {
      const stepAt = now - this.accumulator + STEP_MS;
      this.accumulator -= STEP_MS; this.tick++;
      if (this.phase === 'countdown' && stepAt >= this.countdownEndsAt) this.phase = 'playing';
      if (this.phase === 'lobby' || this.phase === 'playing') this.step(stepAt);
    }
    // Countdown follows real elapsed time even after a long event-loop stall.
    if (this.phase === 'countdown' && now >= this.countdownEndsAt) this.phase = 'playing';
  }
  private step(now: number): void {
    for (const player of this.players.values()) {
      const input = this.movement.get(player.id);
      if (!player.connected || player.inDuel || !input) continue;
      const duration = Math.max(0, Math.min(now, input.expiresAt) - Math.max(now - STEP_MS, input.receivedAt)) / 1000;
      player.x = Math.max(AVATAR_RADIUS, Math.min(RULES.arenaWidth - AVATAR_RADIUS, player.x + input.x * RULES.playerSpeed * duration));
      player.y = Math.max(AVATAR_RADIUS, Math.min(RULES.arenaHeight - AVATAR_RADIUS, player.y + input.y * RULES.playerSpeed * duration));
    }
  }
  snapshot(now = performance.now()): Snapshot {
    return { tick: this.tick, phase: this.phase,
      remainingMs: this.phase === 'countdown' ? Math.max(0, this.countdownEndsAt - now) : RULES.roundMs,
      lastStand: false, arenaScale: 1,
      crown: { x: RULES.arenaWidth / 2, y: RULES.arenaHeight / 2, heldBy: null, heldMs: 0 },
      gem: null, duel: null, players: [...this.players.values()].map(player => ({ ...player })) };
  }
  dispose(): void { this.movement.clear(); }
}
