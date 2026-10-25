import { AVATARS, isAvatarId } from '../../shared/constants.js';
import type { PlayerState } from '../../shared/events.js';

export function WantedBoard({ players }: { players: PlayerState[] }) {
  const hunters = players.filter(p => p.wantedId);
  if (!hunters.length) return null;
  return <section className="cf-wanted" aria-label="Wanted targets">
    <strong>WANTED</strong><div>{hunters.map(hunter => {
      const target = players.find(p => p.id === hunter.wantedId);
      if (!target) return null;
      return <article key={hunter.id} style={{ borderColor: target.color }}>
        <span>{hunter.name} hunts</span><b style={{ color: target.color }}>{isAvatarId(target.avatar) ? AVATARS[target.avatar] : ''} {target.name}</b>
      </article>;
    })}</div>
  </section>;
}
