import type { GameEvent } from '../../shared/events.js';

export const MAX_PRESENTATION_EVENTS = 1024;
export const STAT_EVENTS = new Set(['CROWN_STOLEN', 'REVENGE', 'DUEL_RESULT', 'GEM_TAKEN', 'LAST_STAND', 'PLAY_OF_GAME']);
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function roundStats(events: GameEvent[]) {
  const seen = new Set<string>(), steals = new Map<string, number>(), pairs = new Map<string, { a: string; b: string; count: number }>();
  let fastest: { id: string; ms: number } | undefined, play: GameEvent | undefined;
  for (const event of events) {
    if (seen.has(event.eventId)) continue; seen.add(event.eventId);
    if (event.type === 'PLAY_OF_GAME') play = event;
    if (event.type === 'CROWN_STOLEN' && event.actorId && event.victimId) {
      steals.set(event.actorId, (steals.get(event.actorId) ?? 0) + 1);
      const [a, b] = [event.actorId, event.victimId].sort(lexical), key = JSON.stringify([a, b]);
      const pair = pairs.get(key) ?? { a, b, count: 0 }; pair.count++; pairs.set(key, pair);
    }
    if (event.type === 'DUEL_RESULT' && event.winnerId && event.reactionMs !== undefined && Number.isFinite(event.reactionMs) && event.reactionMs >= 0) {
      if (!fastest || event.reactionMs < fastest.ms || (event.reactionMs === fastest.ms && lexical(event.winnerId, fastest.id) < 0)) fastest = { id: event.winnerId, ms: event.reactionMs };
    }
  }
  const mostWanted = [...steals].sort((a, b) => b[1] - a[1] || lexical(a[0], b[0]))[0];
  const nemesis = [...pairs.values()].sort((a, b) => b.count - a.count || lexical(a.a, b.a) || lexical(a.b, b.b))[0];
  return { mostWanted: mostWanted ? { id: mostWanted[0], count: mostWanted[1] } : undefined, fastest, nemesis, play };
}
