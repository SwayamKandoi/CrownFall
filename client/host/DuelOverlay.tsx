import type { GameEvent, Snapshot } from '../../shared/events.js';

/** Presentation of server decisions only: no reaction comparison, scoring or cue prediction. */
export function DuelOverlay({ snapshot, result, fouls }: { snapshot?: Snapshot; result?: GameEvent; fouls: string[] }) {
  const duel = snapshot?.duel;
  if (!duel || snapshot.phase !== 'playing') return null;
  const a = snapshot.players.find(p => p.id === duel.a), b = snapshot.players.find(p => p.id === duel.b);
  const resolved = result?.actorId === duel.a && result.victimId === duel.b ? result : undefined;
  const winner = snapshot.players.find(p => p.id === resolved?.winnerId);
  const holding = snapshot.players.find(p => p.id === snapshot.crown.heldBy);
  const heading = duel.stage === 'ready' ? 'HOLD STILL' : duel.stage === 'cue' ? 'DRAW!' :
    !resolved ? 'RESULT...' : winner ? `${winner.name} wins!` : 'CROWN RETAINED';
  const timing = (id: string, ms?: number | null) => fouls.includes(id) ? 'FOUL' : ms == null ? 'TOO SLOW' : `${Math.round(ms)} ms`;
  return <section className={'cf-duel cf-duel-' + duel.stage} aria-live="assertive" aria-label="Draw-off duel">
    <div className="cf-duel-rivals">
      <span style={{ color: a?.color }}>{a?.name ?? 'Challenger'}</span><small>VS</small><span style={{ color: b?.color }}>{b?.name ?? 'Holder'}</span>
    </div>
    <h2>{heading}</h2>
    {duel.stage === 'ready' ? <p>Wait for DRAW. Early yanks are fouls.</p> : duel.stage === 'cue' ? <p>Yank now! Both responses count.</p> :
      resolved && <>
        <div className="cf-duel-times"><span>{timing(duel.a, resolved.replay?.aMs)}</span><span>{timing(duel.b, resolved.replay?.bMs)}</span></div>
        <p>{holding?.name ?? 'The holder'} {resolved.winnerId === duel.a ? 'takes' : 'keeps'} the crown{resolved.points ? ` · +${resolved.points}` : ' · no bonus'}</p>
      </>}
  </section>;
}
