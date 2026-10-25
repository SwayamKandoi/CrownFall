import type { GameEvent, PlayerState } from '../../shared/events.js';
import { roundStats } from './roundStatistics.js';

export function RoundStats({ events, players }: { events: GameEvent[]; players: PlayerState[] }) {
  const stats = roundStats(events);
  const name = (id?: string) => players.find(p => p.id === id)?.name ?? 'Unknown player';
  return <section className="cf-end-stats" aria-label="Round highlights">
    <article className="cf-play-of-game"><span>PLAY OF THE GAME</span><b>{stats.play ? name(stats.play.actorId) : 'No qualifying play'}</b>
      {stats.play && <small>+{stats.play.points ?? 0} points{stats.play.reactionMs !== undefined ? ` · ${Math.round(stats.play.reactionMs)} ms draw` : stats.play.victimId ? ` against ${name(stats.play.victimId)}` : ' from the vault'}</small>}</article>
    <article><span>MOST WANTED</span><b>{stats.mostWanted ? name(stats.mostWanted.id) : 'No steals'}</b><small>{stats.mostWanted ? `${stats.mostWanted.count} successful steals` : 'The crown stayed safe'}</small></article>
    <article><span>FASTEST DRAW</span><b>{stats.fastest ? `${Math.round(stats.fastest.ms)} ms` : 'No winning draw'}</b><small>{stats.fastest ? name(stats.fastest.id) : 'No reaction result recorded'}</small></article>
    <article><span>NEMESIS</span><b>{stats.nemesis ? `${name(stats.nemesis.a)} × ${name(stats.nemesis.b)}` : 'No rivalry yet'}</b><small>{stats.nemesis ? `${stats.nemesis.count} steals between them` : 'No contested transfers'}</small></article>
  </section>;
}
