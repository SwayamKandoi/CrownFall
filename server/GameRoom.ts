import { PLAYER_COLORS, RULES } from '../shared/constants.js';
import { randomUUID } from 'node:crypto';
import type { ActionError, GameEnded, GameEvent, Phase, PhoneState, PlayerState, Snapshot } from '../shared/events.js';
import { exact, finite, RateLimit } from './validation.js';
import { earnedPoints, possessionPoints, holderSpeed, rankPlayers } from './scoring.js';
import { DuelEngine } from './duel.js';
import { Phase6, clampPosition } from './phase6.js';
import { RoundHighlights } from './highlights.js';

export interface GameOptions { duelsEnabled?: boolean; phase6Enabled?: boolean; random?: () => number; epochNow?: () => number }

export const INPUT_TIMEOUT_MS = 250;
export const AVATAR_RADIUS = 18;
export const YANK_MAX_AGE_MS = 1000;
export const YANK_FUTURE_TOLERANCE_MS = 150;
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
  private ended: GameEnded[] = [];
  private yankSequences = new Map<string, number>();
  private cooldowns = new Map<string, number>();
  private tauntSequences = new Map<string, number>();
  private tauntAt = new Map<string, number>();
  private immuneUntil = 0;
  private readonly duel?: DuelEngine;
  private readonly phase6?: Phase6;
  private readonly highlights?: RoundHighlights;
  private readonly epochNow: () => number;
  private foulSequences = new Map<string, number>();
  constructor(readonly players: Map<string, PlayerState>, now = performance.now(), options: GameOptions = {}) {
    this.lastAdvanceAt = now; this.accountedAt = now;
    this.epochNow = options.epochNow ?? (() => Date.now());
    if (options.duelsEnabled === true) this.duel = new DuelEngine(options.random);
    if (options.phase6Enabled === true) {
      this.phase6 = new Phase6(players, options.random ?? Math.random); this.highlights = new RoundHighlights();
    }
  }
  private emit(...events: GameEvent[]): void {
    for (const event of events) {
      if (this.highlights) { event.serverTime ??= this.epochNow(); this.highlights.record(event, this.players.values()); }
      this.events.push(event);
    }
  }
  get hasPendingOutput(): boolean { return this.events.length > 0 || this.ended.length > 0; }
  drainEvents(): GameEvent[] { return this.events.splice(0); }
  drainEnded(): GameEnded[] { return this.ended.splice(0); }
  reset(now: number): void {
    this.duel?.clear();
    this.phase6?.clear(); this.highlights?.clear();
    this.events = this.events.filter(event => !event.type.startsWith('DUEL_'));
    this.phase = 'lobby'; this.countdownEndsAt = 0; this.heldBy = null; this.heldMs = 0;
    this.crownPosition = { x: RULES.arenaWidth / 2, y: RULES.arenaHeight / 2 };
    this.holderDisconnectedAt = null; this.immuneUntil = 0; this.cooldowns.clear(); this.tauntAt.clear();
    this.lastAdvanceAt = now; this.accountedAt = now; this.accumulator = 0;
    for (const player of this.players.values()) {
      const slot = Math.max(0, PLAYER_COLORS.findIndex(color => color === player.color));
      Object.assign(player, { score: 0, holding: false, ready: false, inDuel: false, wantedId: null,
        x: 180 + slot % 4 * 200, y: slot < 4 ? 180 : 360 });
    }
    // Keep sequence history across rounds: delayed old packets must not become new actions.
    for (const input of this.movement.values()) { input.x = 0; input.y = 0; input.expiresAt = now; }
    // Keep queued output until broadcast, even if a reset arrives immediately at the deadline.
  }
  start(now: number): void {
    this.phase = 'countdown'; this.countdownEndsAt = now + RULES.countdownMs;
    // Do not carry tutorial movement through the countdown.
    for (const input of this.movement.values()) { input.x = 0; input.y = 0; input.expiresAt = now; }
  }
  move(id: string, payload: unknown, now = performance.now()): { ok: true } | ActionError {
    this.advance(now);
    const player = this.players.get(id);
    if (!player?.connected) return rejected('UNAUTHORIZED', 'A connected player is required.');
    if (!exact(payload, ['seq', 'x', 'y']) || !Number.isSafeInteger(payload.seq) || (payload.seq as number) < 0 || !finite(payload.x) || !finite(payload.y))
      return rejected('INVALID_PAYLOAD', 'Expected {seq: nonnegative safe integer, x: finite number, y: finite number}.');
    if (this.phase !== 'lobby' && this.phase !== 'playing') return rejected('INVALID_PHASE', 'Movement is only available in lobby and playing phases.');
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
  inRange(id: string, now = this.lastAdvanceAt): boolean {
    const player = this.players.get(id);
    const holder = this.heldBy ? this.players.get(this.heldBy) : undefined;
    return !this.duel?.busy && this.phase === 'playing' && now >= this.countdownEndsAt + RULES.rushMs &&
      now < this.countdownEndsAt + RULES.roundMs &&
      Boolean(player?.connected && !player.inDuel && holder?.connected && !holder.inDuel && holder.id !== id &&
        now >= this.immuneUntil && now >= (this.cooldowns.get(id) ?? 0) &&
        Math.hypot(player.x - holder.x, player.y - holder.y) <= RULES.duelRange);
  }
  phoneDuel(id: string): PhoneState['duel'] { return this.duel?.phone(id) ?? null; }
  wantedName(id: string): string | null {
    const target = this.players.get(id)?.wantedId;
    return target ? this.players.get(target)?.name ?? null : null;
  }
  /** Cosmetic shake-taunt: only outside steal range, never during a duel, at most one per 1.5 s. */
  taunt(id: string, payload: unknown, now = performance.now()): { ok: true } | ActionError {
    const player = this.players.get(id);
    if (!player?.connected) return rejected('UNAUTHORIZED', 'A connected player is required.');
    if (!exact(payload, ['seq']) || !Number.isSafeInteger(payload.seq) || (payload.seq as number) < 0)
      return rejected('INVALID_PAYLOAD', 'Expected {seq: nonnegative safe integer}.');
    const seq = payload.seq as number;
    if (seq <= (this.tauntSequences.get(id) ?? -1)) return rejected('STALE_INPUT', 'Taunt sequence must increase.');
    this.tauntSequences.set(id, seq);
    if (this.phase !== 'lobby' && this.phase !== 'playing') return rejected('INVALID_PHASE', 'Taunts work in the lobby or during play.');
    if (player.inDuel || this.duel?.includes(id)) return rejected('NOT_READY', 'No taunting mid-duel.');
    if (this.phase === 'playing' && this.inRange(id, now)) return rejected('NOT_READY', 'You are in steal range; yank instead.');
    if (now - (this.tauntAt.get(id) ?? -Infinity) < 1500) return rejected('RATE_LIMITED', 'One taunt at a time.');
    this.tauntAt.set(id, now);
    this.emit({ eventId: randomUUID(), type: 'TAUNT', actorId: id });
    return { ok: true };
  }
  yank(id: string, payload: unknown, now = performance.now(), epochNow = this.epochNow()): { ok: true } | ActionError {
    this.advance(now, epochNow);
    const player = this.players.get(id);
    if (!player?.connected) return rejected('UNAUTHORIZED', 'A connected player is required.');
    if (!exact(payload, ['seq', 'ts']) || !Number.isSafeInteger(payload.seq) || (payload.seq as number) < 0 || !finite(payload.ts) || payload.ts < 0)
      return rejected('INVALID_PAYLOAD', 'Expected {seq: nonnegative safe integer, ts: server-epoch milliseconds}.');
    if (this.phase !== 'playing') return rejected('INVALID_PHASE', 'Yanking requires an active round.');
    const seq = payload.seq as number;
    if (seq <= (this.yankSequences.get(id) ?? -1)) return rejected('STALE_INPUT', 'Yank sequence must increase.');
    const roundEpochStart = epochNow - (now - this.countdownEndsAt);
    if (payload.ts < epochNow - YANK_MAX_AGE_MS || payload.ts > epochNow + YANK_FUTURE_TOLERANCE_MS || payload.ts < roundEpochStart)
      return rejected('STALE_INPUT', 'Yank timestamp is stale or outside the synchronized clock window.');
    // The phone shares a counter across events, but delivery may be out of order between streams.
    this.yankSequences.set(id, seq);
    // Rush starts after countdown; rejected attempts consume sequences but not cooldowns.
    if (now < this.countdownEndsAt + RULES.rushMs) return rejected('NOT_READY', 'Stealing unlocks after the opening Rush.');
    if (this.duel?.busy) {
      if (!this.duel.active || !this.duel.includes(id)) return rejected('NOT_READY', 'A duel already occupies the crown.');
      const result = this.duel.reaction(id, payload.ts, now, epochNow);
      this.flushDuelEvents();
      return result;
    }
    const holder = this.heldBy ? this.players.get(this.heldBy) : undefined;
    if (!holder?.connected || holder.id === id || player.inDuel || holder.inDuel ||
        Math.hypot(player.x - holder.x, player.y - holder.y) > RULES.duelRange)
      return rejected('NOT_READY', 'Move within range of the connected crown holder.');
    if (now < (this.cooldowns.get(id) ?? 0)) return rejected('NOT_READY', 'Your yank is cooling down.');
    this.cooldowns.set(id, now + RULES.challengerCooldownMs);
    if (now < this.immuneUntil) return rejected('NOT_READY', 'The crown holder is temporarily immune.');
    if (this.duel) {
      this.highlights?.beginDuel(id, holder.id, now);
      this.duel.start(id, holder.id, now, epochNow);
      player.inDuel = true; holder.inDuel = true;
      this.flushDuelEvents();
      return { ok: true };
    }
    this.stealCrown(player, holder.id, now); this.immuneUntil = now + RULES.immunityMs;
    return { ok: true };
  }
  /** Not bound to Socket.IO: the proposed physical-stillness signal awaits contract approval. */
  reportDuelFoul(id: string, payload: unknown, now = performance.now(), epochNow = this.epochNow()): { ok: true } | ActionError {
    this.advance(now, epochNow);
    if (!this.duel) return rejected('NOT_IMPLEMENTED', 'Duels are disabled.');
    if (!this.players.get(id)?.connected) return rejected('UNAUTHORIZED', 'A connected player is required.');
    if (!exact(payload, ['seq', 'ts']) || !Number.isSafeInteger(payload.seq) || (payload.seq as number) < 0 || !finite(payload.ts) || payload.ts < 0)
      return rejected('INVALID_PAYLOAD', 'Expected {seq: nonnegative safe integer, ts: server-epoch milliseconds}.');
    if (this.phase !== 'playing') return rejected('INVALID_PHASE', 'A duel requires an active round.');
    const seq = payload.seq as number;
    if (seq <= (this.foulSequences.get(id) ?? -1)) return rejected('STALE_INPUT', 'Foul sequence must increase.');
    if (payload.ts < epochNow - YANK_MAX_AGE_MS || payload.ts > epochNow + YANK_FUTURE_TOLERANCE_MS)
      return rejected('STALE_INPUT', 'Foul timestamp is outside the synchronized clock window.');
    this.foulSequences.set(id, seq);
    const result = this.duel.reportFoul(id, payload.ts, now, epochNow);
    this.flushDuelEvents();
    return result;
  }
  private flushDuelEvents(): void { if (this.duel) this.emit(...this.duel.drainEvents()); }
  private releaseDuelists(now: number): void {
    for (const player of this.players.values()) if (player.inDuel) {
      player.inDuel = false;
      const input = this.movement.get(player.id);
      if (input) { input.x = 0; input.y = 0; input.expiresAt = now; }
    }
  }
  private cancelDuel(now: number, epochNow: number): void {
    this.highlights?.cancelDuel(); this.duel?.cancel(epochNow); this.releaseDuelists(now); this.flushDuelEvents();
  }
  disconnect(id: string, now = this.lastAdvanceAt): void {
    this.advance(now);
    if (this.duel?.active && this.duel.includes(id)) this.cancelDuel(now, this.epochNow());
    const player = this.players.get(id);
    if (player) { player.connected = false; player.ready = false; }
    this.phase6?.clearPlayer(id);
    if (this.heldBy === id && this.holderDisconnectedAt === null) this.holderDisconnectedAt = now;
    const input = this.movement.get(id);
    if (input) { input.x = 0; input.y = 0; input.expiresAt = 0; }
  }
  /** A known player's phone came back (refresh / lock screen). Scoring resumes without catch-up. */
  reconnect(id: string, now = this.lastAdvanceAt): void {
    this.advance(now);
    const player = this.players.get(id);
    if (!player) return;
    player.connected = true;
    if (this.heldBy === id) this.holderDisconnectedAt = null;
  }
  removePlayer(id: string): void {
    this.phase6?.clearPlayer(id);
    this.movement.delete(id);
    this.yankSequences.delete(id); this.cooldowns.delete(id);
    this.foulSequences.delete(id); this.tauntSequences.delete(id); this.tauntAt.delete(id);
    this.players.delete(id);
  }
  advance(now: number, epochNow = this.epochNow()): void {
    now = Math.max(now, this.lastAdvanceAt);
    // Bound catch-up work to prevent a stalled process from teleporting players or monopolizing the event loop.
    this.accumulator += Math.min(250, Math.max(0, now - this.lastAdvanceAt));
    this.lastAdvanceAt = now;
    while (this.accumulator + 1e-8 >= STEP_MS) {
      const stepAt = now - this.accumulator + STEP_MS;
      this.accumulator -= STEP_MS; this.tick++;
      this.advanceClock(stepAt);
      if (this.phase === 'lobby' || this.phase === 'playing') this.step(stepAt);
      if (this.phase === 'playing') { this.updateCrown(stepAt); this.collectGem(stepAt); }
    }
    // Countdown follows real elapsed time even after a long event-loop stall.
    this.advanceClock(now);
    if (this.phase === 'playing') this.updateCrown(now);
    if (this.phase === 'playing') this.highlights?.capture(now, this.players.values());
    if (this.phase === 'playing' && this.duel) {
      const outcome = this.duel.advance(now, epochNow);
      this.flushDuelEvents();
      if (outcome) {
        const holder = this.players.get(outcome.holderId)!;
        if (holder.id !== this.heldBy) {
          const previousHolder = this.heldBy!;
          const cleanDraw = outcome.event.reactionMs !== undefined && !this.duel.phone(holder.id)?.foul && !this.duel.phone(previousHolder)?.foul;
          outcome.event.points = this.stealCrown(holder, previousHolder, now, cleanDraw);
        } else if (outcome.winnerId) outcome.event.points = this.award(holder, outcome.points, now);
        this.immuneUntil = now + RULES.immunityMs;
        this.releaseDuelists(now); this.accountedAt = now;
        this.emit(outcome.event);
        const replay = this.highlights?.completed(outcome.event);
        if (replay) this.emit(replay);
      }
    }
  }
  private advanceClock(now: number): void {
    if (this.phase === 'countdown' && now >= this.countdownEndsAt) {
      this.phase = 'playing'; this.accountedAt = this.countdownEndsAt;
      this.updateCrown(this.countdownEndsAt);
    }
    if (this.phase !== 'playing') return;
    const deadline = this.countdownEndsAt + RULES.roundMs;
    now = Math.min(now, deadline);
    this.phase6?.advance(now, this.countdownEndsAt, this.epochNow() - (this.lastAdvanceAt - now), event => this.emit(event));
    if (this.phase6) clampPosition(this.crownPosition, this.phase6.scale);
    const holder = this.heldBy ? this.players.get(this.heldBy) : undefined;
    if (holder?.connected && !this.duel?.active) {
      const elapsed = Math.max(0, now - this.accountedAt);
      holder.score += possessionPoints(this.heldMs, elapsed, this.accountedAt, this.countdownEndsAt, Boolean(this.phase6));
      this.heldMs += elapsed;
    } else if (holder && !holder.connected && this.holderDisconnectedAt !== null && now >= this.holderDisconnectedAt + RULES.disconnectDropMs) {
      holder.holding = false;
      this.emit({ eventId: randomUUID(), type: 'CROWN_DROPPED', actorId: holder.id });
      this.heldBy = null; this.heldMs = 0; this.holderDisconnectedAt = null;
    }
    this.accountedAt = Math.max(this.accountedAt, now);
    if (now >= deadline) {
      this.cancelDuel(now, this.epochNow());
      this.phase = 'ended';
      this.phase6?.finish();
      const play = this.highlights?.playOfGame();
      if (play) this.emit(play);
      this.ended.push(rankPlayers(this.players.values()));
    }
  }
  private updateCrown(now: number): void {
    if (!this.heldBy) {
      const distance = (p: PlayerState) => Math.hypot(p.x - this.crownPosition.x, p.y - this.crownPosition.y);
      // Nearest connected player wins; equal distances use a stable player-id ordering.
      const candidates = [...this.players.values()].filter(p => p.connected && distance(p) <= RULES.crownPickupRadius);
      candidates.sort((a, b) => distance(a) - distance(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (candidates[0]) {
        this.giveCrown(candidates[0], now);
        this.emit({ eventId: randomUUID(), type: 'CROWN_PICKUP', actorId: candidates[0].id });
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
  private award(player: PlayerState, base: number, now: number): number {
    const points = earnedPoints(base, now, this.countdownEndsAt, Boolean(this.phase6));
    player.score += points;
    return points;
  }
  private stealCrown(player: PlayerState, victim: string, now: number, allowRevenge = true): number {
    const revenge = this.phase6?.steal(player.id, victim, now, allowRevenge) ?? false;
    this.giveCrown(player, now);
    const points = this.award(player, revenge ? RULES.revengePoints : RULES.stealPoints, now);
    const event = { eventId: randomUUID(), type: 'CROWN_STOLEN' as const, actorId: player.id, victimId: victim, points,
      serverTime: this.epochNow() - (this.lastAdvanceAt - now) };
    this.emit(event);
    if (revenge) this.emit({ ...event, eventId: randomUUID(), type: 'REVENGE' });
    return points;
  }
  private collectGem(now: number): void {
    const taken = this.phase6?.collect();
    if (!taken) return;
    const points = this.award(taken.player, RULES.gemPoints, now);
    this.emit({ eventId: randomUUID(), type: 'GEM_TAKEN', actorId: taken.player.id, points, x: taken.x, y: taken.y,
      serverTime: this.epochNow() - (this.lastAdvanceAt - now) });
  }
  private step(now: number): void {
    for (const player of this.players.values()) {
      const input = this.movement.get(player.id);
      if (!player.connected || player.inDuel || !input) continue;
      const duration = Math.max(0, Math.min(now, input.expiresAt) - Math.max(now - STEP_MS, input.receivedAt)) / 1000;
      const speed = player.holding ? holderSpeed(this.heldMs) : RULES.playerSpeed;
      player.x = Math.max(AVATAR_RADIUS, Math.min(RULES.arenaWidth - AVATAR_RADIUS, player.x + input.x * speed * duration));
      player.y = Math.max(AVATAR_RADIUS, Math.min(RULES.arenaHeight - AVATAR_RADIUS, player.y + input.y * speed * duration));
      if (this.phase6) clampPosition(player, this.phase6.scale);
    }
  }
  snapshot(now = performance.now()): Snapshot {
    return { tick: this.tick, phase: this.phase,
      remainingMs: this.phase === 'countdown' ? Math.max(0, this.countdownEndsAt - now) :
        this.phase === 'playing' ? Math.max(0, this.countdownEndsAt + RULES.roundMs - now) : this.phase === 'ended' ? 0 : RULES.roundMs,
      lastStand: this.phase6?.lastStand ?? false, arenaScale: this.phase6?.scale ?? 1,
      crown: { ...this.crownPosition, heldBy: this.heldBy, heldMs: this.heldMs },
      gem: this.phase6?.gemSnapshot(now) ?? null, duel: this.duel?.snapshot() ?? null, players: [...this.players.values()].map(player => ({ ...player })) };
  }
  dispose(): void { this.highlights?.clear(); this.phase6?.clear(); this.duel?.clear(); this.releaseDuelists(this.lastAdvanceAt); this.movement.clear(); this.yankSequences.clear(); this.foulSequences.clear(); this.cooldowns.clear(); this.tauntSequences.clear(); this.tauntAt.clear(); this.events = []; this.ended = []; }
}
