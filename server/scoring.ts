import { RULES } from '../shared/constants.js';
import type { GameEnded, PlayerState } from '../shared/events.js';

export function rankPlayers(players: Iterable<PlayerState>): GameEnded {
  const scores = [...players].map(p => ({ playerId: p.id, name: p.name, score: p.score }));
  scores.sort((a, b) => b.score - a.score || (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
  return { scores, winnerIds: scores.filter(p => p.score === scores[0]?.score).map(p => p.playerId) };
}

export function holdPoints(heldMs: number): number {
  return Math.floor((heldMs + 1e-7) / RULES.holdPointMs);
}
export function holderSpeed(heldMs: number): number {
  return Math.max(RULES.holderMinSpeed, RULES.holderSpeed - RULES.holderSlowdown * heldMs / 1000);
}

/** Score at the moment earned; never multiply a player's existing balance. */
export function earnedPoints(base: number, now: number, playingAt: number, phase6: boolean): number {
  // Match holdPoints' sub-microsecond tolerance for accumulated 30 Hz step rounding.
  return base * (phase6 && now + 1e-7 >= playingAt + RULES.roundMs - RULES.lastStandMs ? 2 : 1);
}
export function possessionPoints(heldMs: number, elapsed: number, from: number, playingAt: number, phase6: boolean): number {
  const total = holdPoints(heldMs + elapsed) - holdPoints(heldMs);
  if (!phase6) return total;
  let points = 0;
  // At most 180 thresholds per round, including after a stalled update.
  for (let i = 1; i <= total; i++) {
    const earnedAt = from + (holdPoints(heldMs) + i) * RULES.holdPointMs - heldMs;
    points += earnedPoints(1, earnedAt, playingAt, true);
  }
  return points;
}
