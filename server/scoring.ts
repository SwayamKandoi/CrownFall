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
