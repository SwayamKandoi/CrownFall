import { RULES } from '../shared/constants.js';
import { randomUUID } from 'node:crypto';
import type { ActionError, GameEvent, Phase, PlayerState, Snapshot } from '../shared/events.js';
import { exact, finite, RateLimit } from './validation.js';
import { holdPoints, holderSpeed } from './scoring.js';

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
  private heldBy: string | null = null;
  private heldMs = 0;
  private crownPosition = { x: RULES.arenaWidth / 2, y: RULES.arenaHeight / 2 };
  private holderDisconnectedAt: number | null = null;
  private accountedAt: number;
  private events: GameEvent[] = [];
  constructor(readonly players: Map<string, PlayerState>, now = performance.now()) {
    this.lastAdvanceAt = now; this.accountedAt = now;
  }
  get hasPendingOutput(): boolean { return this.events.length > 0; }
  drainEvents(): GameEvent[] { return this.events.splice(0); }
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
  disconnect(id: string, now = this.lastAdvanceAt): void {
    this.advance(now);
    const player = this.players.get(id);
    if (player) { player.connected = false; player.ready = false; }
    if (this.heldBy === id && this.holderDisconnectedAt === null) this.holderDisconnectedAt = now;
    const input = this.movement.get(id);
    if (input) { input.x = 0; input.y = 0; input.expiresAt = 0; }
  }
  removePlayer(id: string): void {
    this.movement.delete(id);
    this.players.delete(id);
  }
  advance(now: number): void {
    now = Math.max(now, this.lastAdvanceAt);
    // Bound catch-up work to prevent a stalled process from teleporting players or monopolizing the event loop.
    this.accumulator += Math.min(250, Math.max(0, now - this.lastAdvanceAt));
    this.lastAdvanceAt = now;
    while (this.accumulator + 1e-8 >= STEP_MS) {
      const stepAt = now - this.accumulator + STEP_MS;
      this.accumulator -= STEP_MS; this.tick++;
      this.advanceClock(stepAt);
      if (this.phase === 'lobby' || this.phase === 'playing') this.step(stepAt);
      if (this.phase === 'playing') this.updateCrown(stepAt);
    }
    // Countdown follows real elapsed time even after a long event-loop stall.
    this.advanceClock(now);
    if (this.phase === 'playing') this.updateCrown(now);
  }
  private advanceClock(now: number): void {
    if (this.phase === 'countdown' && now >= this.countdownEndsAt) {
      this.phase = 'playing'; this.accountedAt = this.countdownEndsAt;
      this.updateCrown(this.countdownEndsAt);
    }
    if (this.phase !== 'playing') return;
    const holder = this.heldBy ? this.players.get(this.heldBy) : undefined;
    if (holder?.connected) {
      const previousPoints = holdPoints(this.heldMs);
      this.heldMs += Math.max(0, now - this.accountedAt);
      holder.score += holdPoints(this.heldMs) - previousPoints;
    } else if (holder && this.holderDisconnectedAt !== null && now >= this.holderDisconnectedAt + RULES.disconnectDropMs) {
      holder.holding = false;
      this.events.push({ eventId: randomUUID(), type: 'CROWN_DROPPED', actorId: holder.id });
      this.heldBy = null; this.heldMs = 0; this.holderDisconnectedAt = null;
    }
    this.accountedAt = Math.max(this.accountedAt, now);
  }
  private updateCrown(now: number): void {
    if (!this.heldBy) {
      const distance = (p: PlayerState) => Math.hypot(p.x - this.crownPosition.x, p.y - this.crownPosition.y);
      // Nearest connected player wins; equal distances use a stable player-id ordering.
      const candidates = [...this.players.values()].filter(p => p.connected && distance(p) <= RULES.crownPickupRadius);
      candidates.sort((a, b) => distance(a) - distance(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (candidates[0]) {
        this.giveCrown(candidates[0], now);
        this.events.push({ eventId: randomUUID(), type: 'CROWN_PICKUP', actorId: candidates[0].id });
      }
    }
    const holder = this.heldBy ? this.players.get(this.heldBy) : undefined;
    if (holder) this.crownPosition = { x: holder.x, y: holder.y };
  }
  private giveCrown(player: PlayerState, now: number): void {
    for (const current of this.players.values()) current.holding = current.id === player.id;
    this.heldBy = player.id; this.heldMs = 0; this.holderDisconnectedAt = null;
    this.accountedAt = now; this.crownPosition = { x: player.x, y: player.y };
  }
  private step(now: number): void {
    for (const player of this.players.values()) {
      const input = this.movement.get(player.id);
      if (!player.connected || player.inDuel || !input) continue;
      const duration = Math.max(0, Math.min(now, input.expiresAt) - Math.max(now - STEP_MS, input.receivedAt)) / 1000;
      const speed = player.holding ? holderSpeed(this.heldMs) : RULES.playerSpeed;
      player.x = Math.max(AVATAR_RADIUS, Math.min(RULES.arenaWidth - AVATAR_RADIUS, player.x + input.x * speed * duration));
      player.y = Math.max(AVATAR_RADIUS, Math.min(RULES.arenaHeight - AVATAR_RADIUS, player.y + input.y * speed * duration));
    }
  }
  snapshot(now = performance.now()): Snapshot {
    return { tick: this.tick, phase: this.phase,
      remainingMs: this.phase === 'countdown' ? Math.max(0, this.countdownEndsAt - now) : RULES.roundMs,
      lastStand: false, arenaScale: 1,
      crown: { ...this.crownPosition, heldBy: this.heldBy, heldMs: this.heldMs },
      gem: null, duel: null, players: [...this.players.values()].map(player => ({ ...player })) };
  }
  dispose(): void { this.movement.clear(); this.events = []; }
}
