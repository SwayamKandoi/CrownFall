import { useEffect, useState } from 'react';
import { RULES, AVATARS, isAvatarId } from '../../shared/constants.js';
import type { DuelReplay, GameEvent, PlayerState } from '../../shared/events.js';

export function replayPosition(frames: DuelReplay['frames'], t: number) {
  if (!frames.length) return undefined;
  const after = frames.find(frame => frame.t >= t) ?? frames.at(-1)!;
  const index = frames.indexOf(after), before = frames[Math.max(0, index - 1)];
  const amount = after.t > before.t ? Math.max(0, Math.min(1, (t - before.t) / (after.t - before.t))) : 1;
  return { ax: before.ax + (after.ax - before.ax) * amount, ay: before.ay + (after.ay - before.ay) * amount,
    bx: before.bx + (after.bx - before.bx) * amount, by: before.by + (after.by - before.by) * amount };
}
export function ReplayPanel({ event, players, fouls }: { event: GameEvent; players: PlayerState[]; fouls: string[] }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = performance.now(); let request = 0;
    const tick = () => { const elapsed = performance.now() - start; setElapsed(elapsed); if (elapsed <= RULES.replayMs / RULES.replaySpeed + 500) request = requestAnimationFrame(tick); };
    setElapsed(0); request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [event.eventId]);
  const replay = event.replay;
  if (!replay?.frames.length || elapsed > RULES.replayMs / RULES.replaySpeed + 500) return null;
  const a = players.find(p => p.id === replay.a), b = players.find(p => p.id === replay.b);
  const position = replayPosition(replay.frames, elapsed * RULES.replaySpeed)!;
  const label = (p?: PlayerState) => `${isAvatarId(p?.avatar) ? AVATARS[p.avatar] : ''} ${p?.name ?? 'Rival'}`;
  const time = (id: string, ms: number | null) => fouls.includes(id) ? 'FOUL' : ms === null ? 'TOO SLOW' : `${Math.round(ms)} ms`;
  return <section className="cf-replay" aria-label="Slow motion duel replay">
    <header><strong>SLOW MOTION</strong><span>0.4× · THE APPROACH</span></header>
    <svg viewBox="0 0 960 540" role="img" aria-label="Recorded authoritative duel approach">
      <rect x="10" y="10" width="940" height="520" rx="20" fill="#111c2a" stroke="#52677f" strokeWidth="8"/>
      <polyline points={replay.frames.map(f => `${f.ax},${f.ay}`).join(' ')} fill="none" stroke={a?.color ?? '#fff'} strokeWidth="5" opacity=".35"/>
      <polyline points={replay.frames.map(f => `${f.bx},${f.by}`).join(' ')} fill="none" stroke={b?.color ?? '#fff'} strokeWidth="5" opacity=".35"/>
      <circle cx={position.ax} cy={position.ay} r="23" fill={a?.color ?? '#fff'}/><circle cx={position.bx} cy={position.by} r="23" fill={b?.color ?? '#fff'}/>
    </svg>
    <div><span style={{ color: a?.color }}>{label(a)}<b>{time(replay.a, replay.aMs)}</b></span><span style={{ color: b?.color }}>{label(b)}<b>{time(replay.b, replay.bMs)}</b></span></div>
  </section>;
}
