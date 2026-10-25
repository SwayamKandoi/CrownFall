import { randomUUID } from 'node:crypto';
import { RULES } from '../shared/constants.js';
import type { ActionError, GameEvent, PhoneState, Snapshot } from '../shared/events.js';

export const DUEL_RECEIVE_GRACE_MS = 250;
export const DUEL_RESULT_MS = 1000;
type Response = { reactionMs?: number; foul: boolean };
interface Session {
  a: string; b: string; stage: 'ready' | 'cue' | 'done';
  startedAt: number; startedEpoch: number; plannedCueAt: number;
  cueAt?: number; cueEpoch?: number; resolvedAt?: number; winnerId?: string;
  responses: Map<string, Response>;
}
export interface DuelOutcome { holderId: string; winnerId?: string; points: number; event: GameEvent }
const reject = (code: ActionError['error']['code'], message: string): ActionError => ({ error: { code, message } });

/** One room's duel. All deadlines are monotonic; only validated reaction comparisons use epoch time. */
export class DuelEngine {
  private session: Session | null = null;
  private events: GameEvent[] = [];
  constructor(private random = Math.random) {}
  get active(): boolean { return Boolean(this.session && this.session.stage !== 'done'); }
  get busy(): boolean { return this.session !== null; }
  includes(id: string): boolean { return this.session?.a === id || this.session?.b === id; }
  snapshot(): Snapshot['duel'] {
    const s = this.session;
    return s ? { a: s.a, b: s.b, stage: s.stage } : null;
  }
  phone(id: string): PhoneState['duel'] {
    const s = this.session;
    if (!s || !this.includes(id)) return null;
    return { stage: s.stage, foul: s.responses.get(id)?.foul ?? false,
      ...(s.stage === 'done' ? { won: s.winnerId === id } : {}) };
  }
  drainEvents(): GameEvent[] { return this.events.splice(0); }
  start(a: string, b: string, now: number, epoch: number): boolean {
    if (this.busy || a === b) return false;
    const random = this.random();
    const fraction = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0;
    const delay = RULES.duelReadyMinMs + Math.floor(fraction * (RULES.duelReadyMaxMs - RULES.duelReadyMinMs));
    this.session = { a, b, stage: 'ready', startedAt: now, startedEpoch: epoch, plannedCueAt: now + delay, responses: new Map() };
    // Never expose plannedCueAt, delay, or a future cue epoch during READY.
    this.emit('DUEL_START', epoch); this.emit('DUEL_READY', epoch);
    return true;
  }
  reaction(id: string, ts: number, now: number, epoch: number): { ok: true } | ActionError {
    const s = this.session;
    const invalid = this.checkResponse(id, ts, now);
    if (invalid || !s) return invalid!;
    if (s.responses.has(id)) return reject('STALE_INPUT', 'This duelist already responded.');
    if (s.stage === 'ready' || ts < s.cueEpoch!) return this.foul(id, epoch);
    const reactionMs = ts - s.cueEpoch!;
    if (reactionMs > RULES.duelTimeoutMs) return reject('STALE_INPUT', 'Reaction was outside the 1500 ms window.');
    s.responses.set(id, { reactionMs, foul: false });
    return { ok: true };
  }
  /** Internal only until Aryan approves/wires the proposed physical-stillness event. */
  reportFoul(id: string, ts: number, now: number, epoch: number): { ok: true } | ActionError {
    const invalid = this.checkResponse(id, ts, now);
    if (invalid) return invalid;
    const s = this.session!;
    if (s.stage !== 'ready' && ts >= s.cueEpoch!) return reject('INVALID_PHASE', 'Stillness reports must describe READY.');
    if (s.responses.get(id)?.foul) return reject('STALE_INPUT', 'This foul was already recorded.');
    // A delayed READY violation may supersede a reaction, until the receive deadline.
    return this.foul(id, epoch);
  }
  private checkResponse(id: string, ts: number, now: number): ActionError | undefined {
    const s = this.session;
    if (!s || s.stage === 'done') return reject('INVALID_PHASE', 'No active duel is accepting responses.');
    if (!this.includes(id)) return reject('NOT_READY', 'Only the duelists can respond.');
    if (!Number.isFinite(ts) || ts < s.startedEpoch) return reject('STALE_INPUT', 'Response predates this duel.');
    if (s.cueAt !== undefined && now >= s.cueAt + RULES.duelTimeoutMs + DUEL_RECEIVE_GRACE_MS)
      return reject('STALE_INPUT', 'Duel receive deadline has passed.');
    return undefined;
  }
  private foul(id: string, epoch: number): { ok: true } {
    this.session!.responses.set(id, { foul: true });
    this.events.push({ eventId: randomUUID(), type: 'DUEL_FOUL', actorId: id,
      victimId: id === this.session!.a ? this.session!.b : this.session!.a, serverTime: epoch });
    return { ok: true };
  }
  advance(now: number, epoch: number): DuelOutcome | null {
    const s = this.session;
    if (!s) return null;
    if (s.stage === 'done') {
      if (now >= s.resolvedAt! + DUEL_RESULT_MS) this.session = null;
      return null;
    }
    if (s.stage === 'ready' && now >= s.plannedCueAt) {
      // A stalled update issues a cue NOW, never a backdated cue players could not see.
      s.stage = 'cue'; s.cueAt = now; s.cueEpoch = epoch;
      this.emit('DUEL_CUE', epoch, { cueAt: epoch });
    }
    if (s.stage !== 'cue' || now < s.cueAt! + RULES.duelTimeoutMs + DUEL_RECEIVE_GRACE_MS) return null;
    const a = s.responses.get(s.a), b = s.responses.get(s.b);
    let winnerId: string | undefined;
    if (a?.foul && b?.foul) winnerId = undefined;
    else if (a?.foul) winnerId = s.b;
    else if (b?.foul) winnerId = s.a;
    else if (a?.reactionMs !== undefined && b?.reactionMs !== undefined)
      winnerId = a.reactionMs === b.reactionMs ? [s.a, s.b].sort()[0] : a.reactionMs < b.reactionMs ? s.a : s.b;
    else if (a?.reactionMs !== undefined) winnerId = s.a;
    else if (b?.reactionMs !== undefined) winnerId = s.b;
    const points = winnerId === s.a ? RULES.stealPoints : winnerId === s.b ? RULES.defendPoints : 0;
    s.stage = 'done'; s.resolvedAt = now; s.winnerId = winnerId;
    return { holderId: winnerId ?? s.b, winnerId, points,
      event: { eventId: randomUUID(), type: 'DUEL_RESULT', actorId: s.a, victimId: s.b, winnerId,
        points, serverTime: epoch, cueAt: s.cueEpoch,
        reactionMs: winnerId ? s.responses.get(winnerId)?.reactionMs : undefined,
        replay: { a: s.a, b: s.b, aMs: a?.reactionMs ?? null, bMs: b?.reactionMs ?? null, frames: [] } } };
  }
  cancel(epoch: number): void {
    if (this.active) this.emit('DUEL_RESULT', epoch, { points: 0 });
    this.session = null;
  }
  clear(): void { this.session = null; this.events = []; }
  private emit(type: GameEvent['type'], epoch: number, extra: Partial<GameEvent> = {}): void {
    this.events.push({ eventId: randomUUID(), type, actorId: this.session!.a, victimId: this.session!.b, serverTime: epoch, ...extra });
  }
}
