import { randomUUID } from 'node:crypto';
import { RULES } from '../shared/constants.js';
import type { DuelReplay, GameEvent, PlayerState } from '../shared/events.js';

export const HISTORY_INTERVAL_MS = 100;
export const MAX_HISTORY_FRAMES = RULES.replayMs / HISTORY_INTERVAL_MS + 1;
export const MAX_ROUND_MOMENTS = 1024;
interface PositionFrame { at: number; positions: Map<string, { x: number; y: number }> }
interface Moment { event: GameEvent; priority: number }
const lexical = (a = '', b = '') => a < b ? -1 : a > b ? 1 : 0;
function compare(a: Moment, b: Moment): number {
  return b.priority - a.priority || (a.event.reactionMs ?? Infinity) - (b.event.reactionMs ?? Infinity) ||
    (b.event.points ?? 0) - (a.event.points ?? 0) || (a.event.serverTime ?? 0) - (b.event.serverTime ?? 0) ||
    lexical(a.event.actorId, b.event.actorId) || lexical(a.event.victimId, b.event.victimId);
}

/** Bounded authoritative evidence; no replay can mutate live simulation or scores. */
export class RoundHighlights {
  private history: PositionFrame[] = [];
  private approach?: Pick<DuelReplay, 'a' | 'b' | 'frames'>;
  private moments: GameEvent[] = [];
  private best?: Moment;
  private finale = false;
  capture(now: number, players: Iterable<PlayerState>): void {
    this.history = this.history.filter(frame => frame.at >= now - RULES.replayMs);
    if (this.history.length && now - this.history.at(-1)!.at < HISTORY_INTERVAL_MS) return;
    this.history.push({ at: now, positions: new Map([...players].filter(p => p.connected).map(p => [p.id, { x: p.x, y: p.y }])) });
    if (this.history.length > MAX_HISTORY_FRAMES) this.history.shift();
  }
  beginDuel(a: string, b: string, now: number): void {
    const frames: DuelReplay['frames'] = [];
    for (const frame of this.history) {
      const pa = frame.positions.get(a), pb = frame.positions.get(b);
      if (frame.at < now - RULES.replayMs || !pa || !pb) continue;
      frames.push({ t: frame.at, ax: pa.x, ay: pa.y, bx: pb.x, by: pb.y });
    }
    const origin = frames[0]?.t ?? now;
    this.approach = { a, b, frames: frames.map(frame => ({ ...frame, t: frame.t - origin })) };
  }
  completed(result: GameEvent): GameEvent | undefined {
    const approach = this.approach; this.approach = undefined;
    if (!approach || approach.frames.length < 2 || !result.replay || result.replay.a !== approach.a || result.replay.b !== approach.b) return;
    return { ...result, eventId: randomUUID(), type: 'DUEL_REPLAY', replay: { ...result.replay, ...approach } };
  }
  cancelDuel(): void { this.approach = undefined; }
  record(event: GameEvent, players: Iterable<PlayerState>): void {
    if (!['CROWN_PICKUP', 'CROWN_STOLEN', 'REVENGE', 'DUEL_RESULT', 'GEM_TAKEN', 'LAST_STAND'].includes(event.type)) return;
    const summary = { ...event, replay: event.replay ? { ...event.replay, frames: [] } : undefined };
    this.moments.push(summary);
    if (this.moments.length > MAX_ROUND_MOMENTS) this.moments.shift();
    if (event.type === 'LAST_STAND') this.finale = true;
    let priority = event.type === 'REVENGE' ? 5 : event.type === 'CROWN_STOLEN' ? 2 : event.type === 'GEM_TAKEN' ? 1 : 0;
    const actor = event.type === 'DUEL_RESULT' ? event.winnerId : event.actorId;
    if (event.type === 'DUEL_RESULT' && actor && event.reactionMs !== undefined) priority = 3;
    if (this.finale && actor && (event.points ?? 0) > 0) {
      const roster = [...players], winner = roster.find(p => p.id === actor);
      const otherBest = Math.max(...roster.filter(p => p.id !== actor).map(p => p.score));
      // Evidence of an actual lead-taking scoring action, not an invented comeback narrative.
      if (winner && winner.score - event.points! < otherBest && winner.score > otherBest) priority = Math.max(priority, 4);
    }
    if (!priority || !actor) return;
    const candidate: Moment = { priority, event: { ...summary, actorId: actor,
      victimId: event.type === 'DUEL_RESULT' ? (actor === event.actorId ? event.victimId : event.actorId) : event.victimId } };
    if (!this.best || compare(candidate, this.best) < 0) this.best = candidate;
  }
  playOfGame(): GameEvent | undefined {
    return this.best ? { ...this.best.event, eventId: randomUUID(), type: 'PLAY_OF_GAME' } : undefined;
  }
  clear(): void { this.history = []; this.approach = undefined; this.moments = []; this.best = undefined; this.finale = false; }
}
