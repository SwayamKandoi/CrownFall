import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import QRCode from 'qrcode';
import type { ClientToServerEvents, ServerToClientEvents, CreateResult, Snapshot, GameEnded, GameEvent } from '../../shared/events.js';
import { RULES, AVATARS, isAvatarId } from '../../shared/constants.js';
import { ArenaView } from './ArenaView.js';
import { DuelOverlay } from './DuelOverlay.js';
import { WantedBoard } from './WantedBoard.js';
import { RoundStats } from './RoundStats.js';
import { ReplayPanel } from './ReplayPanel.js';
import { MAX_PRESENTATION_EVENTS, STAT_EVENTS } from './roundStatistics.js';
import { Announcer } from './announcer.js';
import { sfx, unlockAudio } from '../audio/sfx.js';
import './host.css';

type HostSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
function CrownIcon() {
  return <svg width="25" height="25" viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="m4 8 5 5 5-9 5 9 5-5-3 14H7L4 8Z" fill="currentColor"/><path d="M8 25h12" stroke="currentColor" strokeWidth="2"/></svg>;
}
export function HostPage() {
  const socketRef = useRef<HostSocket>();
  const lastSnapshot = useRef(0);
  const lobbyCount = useRef(0);
  const announcer = useRef<Announcer>();
  announcer.current ??= new Announcer();
  const [muted, setMuted] = useState(false);
  const [connected, setConnected] = useState(false);
  const [delayed, setDelayed] = useState(false);
  const [room, setRoom] = useState<CreateResult>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'create' | 'start'>();
  const [copied, setCopied] = useState(false);
  const [ended, setEnded] = useState<GameEnded>();
  const [banner, setBanner] = useState<GameEvent>();
  const [duelResult, setDuelResult] = useState<GameEvent>();
  const [duelFouls, setDuelFouls] = useState<string[]>([]);
  const [roundEvents, setRoundEvents] = useState<GameEvent[]>([]);
  const [replay, setReplay] = useState<{ event: GameEvent; fouls: string[] }>();
  const joinUrl = room ? new URL('/play/' + room.roomCode, location.origin).href : '';
  useEffect(() => {
    const fouls = new Set<string>();
    let bannerTimer: ReturnType<typeof setTimeout> | undefined;
    const connection: HostSocket = io();
    socketRef.current = connection;
    connection.on('connect', () => { setConnected(true); setError(''); });
    connection.on('disconnect', () => {
      setConnected(false); setRoom(undefined); setSnapshot(undefined); setPending(undefined); setEnded(undefined); setBanner(undefined);
      setDuelResult(undefined); setDuelFouls([]);
      setRoundEvents([]); setReplay(undefined); fouls.clear();
      setError('Host connection lost. Room recovery is not available yet; create a new room after reconnecting.');
    });
    connection.on('connect_error', () => setError('Cannot reach the server. Check your connection and /health.'));
    connection.on('state:snapshot', state => {
      lastSnapshot.current = performance.now(); setDelayed(false); setSnapshot(state);
      announcer.current?.snapshot(state);
      if (state.phase === 'lobby' && state.players.length > lobbyCount.current && !announcer.current?.muted) sfx.pickup();
      lobbyCount.current = state.players.length;
      if (!state.duel) { setDuelResult(undefined); setDuelFouls(previous => previous.length ? [] : previous); }
      if (state.phase === 'lobby' || state.phase === 'countdown') { setEnded(undefined); setBanner(undefined); setRoundEvents(previous => previous.length ? [] : previous); setReplay(undefined); fouls.clear(); }
    });
    connection.on('game:event', event => {
      window.dispatchEvent(new CustomEvent('crownfall:game-event', { detail: event }));
      announcer.current?.event(event);
      if (event.type === 'DUEL_START') { setDuelResult(undefined); setDuelFouls([]); setReplay(undefined); fouls.clear(); }
      if (STAT_EVENTS.has(event.type)) setRoundEvents(previous => previous.some(e => e.eventId === event.eventId) ? previous : [...previous.slice(-(MAX_PRESENTATION_EVENTS - 1)), event]);
      if (event.type === 'DUEL_FOUL' && event.actorId) fouls.add(event.actorId);
      if (event.type === 'DUEL_REPLAY') setReplay({ event, fouls: [...fouls] });
      if (event.type === 'DUEL_FOUL' && event.actorId) setDuelFouls(previous => previous.includes(event.actorId!) ? previous : [...previous, event.actorId!]);
      if (event.type === 'DUEL_RESULT') setDuelResult(event);
      if (['CROWN_PICKUP', 'CROWN_STOLEN', 'CROWN_DROPPED', 'REVENGE', 'GEM_TAKEN'].includes(event.type)) {
        clearTimeout(bannerTimer); setBanner(event);
        bannerTimer = setTimeout(() => setBanner(undefined), 2500);
      }
    });
    connection.on('game:ended', result => { setReplay(undefined); announcer.current?.ended(result); setEnded(result); setBanner(undefined); setDuelResult(undefined); setDuelFouls([]); });
    const timer = setInterval(() => setDelayed(lastSnapshot.current > 0 && performance.now() - lastSnapshot.current > 2000), 500);
    return () => { clearInterval(timer); clearTimeout(bannerTimer); connection.removeAllListeners(); connection.disconnect(); socketRef.current = undefined; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setQr('');
    if (joinUrl) void QRCode.toDataURL(joinUrl, { width: 240, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#111c2a', light: '#ffffff' } })
      .then(data => { if (!cancelled) setQr(data); })
      .catch(() => { if (!cancelled) setError('QR code could not be generated. Use the join link below.'); });
    return () => { cancelled = true; };
  }, [joinUrl]);
  function createRoom() {
    const connection = socketRef.current;
    if (!connection?.connected) return;
    unlockAudio(); announcer.current?.prime();
    announcer.current?.say('Room ready. Scan to join.');
    setPending('create'); setError('');
    connection.timeout(5000).emit('room:create', (timeoutError, result) => {
      if (socketRef.current !== connection || !connection.connected) return;
      setPending(undefined);
      if (timeoutError) return setError('Room creation timed out. Reconnect before retrying.');
      if ('error' in result) setError(result.error.message);
      else { setRoom(result); lastSnapshot.current = performance.now(); }
    });
  }
  async function start() {
    const connection = socketRef.current;
    if (!room || !connection?.connected) return;
    unlockAudio(); announcer.current?.prime();
    setPending('start'); setError('');
    try {
      const result = await connection.timeout(5000).emitWithAck('host:start', { hostToken: room.hostToken });
      if (socketRef.current === connection && connection.connected && 'error' in result) setError(result.error.message);
    } catch {
      if (socketRef.current === connection && connection.connected) setError('Start acknowledgement timed out. Check the current arena state.');
    } finally {
      if (socketRef.current === connection) setPending(undefined);
    }
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(joinUrl); setCopied(true); }
    catch { setError('Copy is unavailable. Select and copy the join link.'); }
  }
  const players = snapshot?.players ?? [];
  const readyCount = players.filter(p => p.connected && p.ready).length;
  const phase = snapshot?.phase ?? 'lobby';
  const canStart = connected && !delayed && !pending && (phase === 'ended' || (phase === 'lobby' && readyCount >= RULES.minPlayers));
  const ranked = ended?.scores ?? [...players].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map(p => ({ playerId: p.id, name: p.name, score: p.score }));
  const seconds = Math.ceil((snapshot?.remainingMs ?? RULES.roundMs) / 1000);
  const timer = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  const nameFor = (id?: string) => players.find(p => p.id === id)?.name ?? 'A rival';
  const bannerText = banner?.type === 'REVENGE' ? `REVENGE! ${nameFor(banner.actorId)} takes it back! +${banner.points}` :
    banner?.type === 'GEM_TAKEN' ? `${nameFor(banner.actorId)} unlocked the vault! +${banner.points}` :
    banner?.type === 'CROWN_STOLEN' ? `${nameFor(banner.actorId)} stole the crown from ${nameFor(banner.victimId)}! +${banner.points}` :
    banner?.type === 'CROWN_PICKUP' ? `${nameFor(banner.actorId)} claimed the crown!` : 'The crown is up for grabs!';
  const winners = ended?.scores.filter(p => ended.winnerIds.includes(p.playerId)).map(p => p.name).join(' & ');
  return <main className={'cf-host cf-phase-' + phase}>
    <header className="cf-header">
      <a href="/host" className="cf-brand"><CrownIcon/> CROWNFALL</a>
      <button className="cf-copy cf-mute" aria-pressed={muted} onClick={() => { unlockAudio(); const next = !muted; setMuted(next); announcer.current?.setMuted(next); if (!next) { announcer.current?.prime(); announcer.current?.say('Announcer on.'); } }}>{muted ? 'Sound off' : 'Sound on'}</button>
      <div className={'cf-connection ' + (connected && !delayed ? 'is-online' : '')}><span/>{!connected ? 'Connecting' : delayed ? 'Updates delayed' : 'Server connected'}</div>
    </header>
    {!room ? <section className="cf-welcome">
      <div className="cf-tag">A ROOM FULL OF RIVALS.</div>
      <h1>One crown.<br/><em>No safe friends.</em></h1>
      <p>Your phone is the controller. Your friends are the competition.<br/>Gather 2-8 players and take over the big screen.</p>
      <button className="cf-primary" disabled={!connected || Boolean(pending)} onClick={createRoom}>{pending === 'create' ? 'Creating room...' : 'Create a room'} <span aria-hidden="true">&#8599;</span></button>
      <div className="cf-steps"><span>01 CREATE</span><span>02 SCAN & CALIBRATE</span><span>03 CLAIM THE CROWN</span></div>
      <p className="cf-note">Hold the crown to score. Get close and yank to steal. Most points after 90 seconds wins.</p>
    </section> : <>
      <div className="cf-room-heading">
        <div><div className="cf-tag">{phase === 'lobby' ? 'THE RIVALS ARE GATHERING' : phase === 'countdown' ? 'GET READY' : phase === 'ended' ? 'THE RESULTS ARE IN' : 'THE ARENA IS LIVE'}</div><h1>{phase === 'lobby' ? 'Make yourself a rival.' : phase === 'countdown' ? 'Eyes on the arena.' : phase === 'ended' ? 'A crown well fought.' : 'Hold it. Steal it. Win it.'}</h1></div>
        <div className="cf-room-code"><span>ROOM CODE</span><strong>{room.roomCode}</strong></div>
      </div>
      <div className="cf-layout">
        <section className="cf-stage">
          <div className="cf-stage-heading"><span><i className="cf-live-dot"/>{phase === 'lobby' ? 'WARM-UP ARENA' : phase === 'countdown' ? 'COUNTDOWN' : phase === 'ended' ? 'FINAL ARENA' : 'LIVE ARENA'}</span>
            {snapshot?.lastStand && <strong className="cf-last-stand" role="status">LAST STAND! · 2× POINTS</strong>}
            {snapshot?.gem && <span className="cf-gem-status">◆ VAULT +{snapshot.lastStand ? 10 : 5} · {Math.ceil(snapshot.gem.expiresMs / 1000)}s</span>}
            <time className="cf-round-timer" aria-label="Time remaining">{timer}</time></div>
          <div className="cf-arena-wrap">
            <ArenaView snapshot={snapshot}/>
            {banner && phase === 'playing' && !snapshot?.duel && <div className={'cf-game-banner' + (banner.type === 'REVENGE' ? ' cf-revenge-banner' : '')} role="status">{bannerText}</div>}
            <DuelOverlay snapshot={snapshot} result={duelResult} fouls={duelFouls}/>
            {phase === 'countdown' && <div className="cf-countdown" aria-live="assertive"><span>READY YOUR PHONES</span><strong>{Math.max(1, seconds)}</strong><span>Keep your eyes on the big screen</span></div>}
            {phase === 'ended' && <div className="cf-results" aria-live="polite">{ended && <Confetti/>}<CrownIcon/><span>{ended ? ended.winnerIds.length > 1 ? 'TIED WINNERS' : 'WINNER' : 'ROUND COMPLETE'}</span><h2>{winners || 'Finalizing scores...'}</h2>{ended && <HostPodium scores={ended.scores} players={players}/>}{ended && <RoundStats events={roundEvents} players={players}/>}</div>}
            {!players.length && <div className="cf-empty-arena"><span>YOUR KINGDOM AWAITS.</span><p>Scan the code to claim your place.</p></div>}
            {(!connected || delayed) && <div className="cf-arena-warning">Connection interrupted - waiting for live state</div>}
          </div>
          <div className="cf-arena-footer"><span>{phase === 'lobby' ? 'Tilt to explore. Calibrate your phone to become ready.' : phase === 'countdown' ? 'Movement pauses during the countdown.' : phase === 'ended' ? 'Start a rematch, then ready up on the same phones.' : snapshot?.lastStand ? '2\u00d7 POINTS \u00b7 Hold +2 / 0.5s \u00b7 Steal +6 \u00b7 Revenge +12 \u00b7 Vault +10' : 'Hold: +1 every 0.5s. Steal: +3. The crown gets heavier as you hold it.'}</span><span>{players.filter(p => p.connected).length} / 8 ONLINE</span></div>
          {phase === 'playing' && <WantedBoard players={players}/>}
          <div className="cf-instructions"><div><b>01</b><strong>Claim the crown</strong><p>Tilt toward the crown to pick it up.</p></div><div><b>02</b><strong>Close the gap</strong><p>Get close, then yank when your phone says ready.</p></div><div><b>03</b><strong>Keep it moving</strong><p>Stealing grants two seconds of protection.</p></div></div>
        </section>
        <aside className="cf-sidebar">
          {phase === 'lobby' && <section className="cf-join-panel"><div><span className="cf-tag">JOIN THE ROOM</span><h2>Scan. Tilt. Rival.</h2></div>
            {qr ? <img className="cf-qr" src={qr} alt={'QR join link for room ' + room.roomCode} width="176" height="176"/> : <div className="cf-qr-loading">Preparing QR...</div>}
            <a className="cf-join-link" href={joinUrl}>{joinUrl}</a><button className="cf-copy" onClick={copyLink}>{copied ? 'Link copied' : 'Copy join link'}</button>
          </section>}
          <section className="cf-roster"><div className="cf-roster-heading"><h2>{phase === 'lobby' ? 'The contenders' : phase === 'ended' ? 'Final rankings' : 'Live scoreboard'}</h2><span>{players.length}/8</span></div>
            <ul>{(phase === 'lobby' ? players.map(p => ({ playerId: p.id, name: p.name, score: p.score })) : ranked).map((entry, index) => {
              const player = players.find(p => p.id === entry.playerId);
              const rank = ranked.findIndex(p => p.score === entry.score) + 1;
              return <li key={entry.playerId} className={(player?.holding ? 'is-holder ' : '') + (!player?.connected ? 'is-offline' : '')}>
                <span className="cf-avatar" style={{ backgroundColor: player?.color }}>{phase === 'lobby' ? index + 1 : rank}</span>
                <span className="cf-player-name">{isAvatarId(player?.avatar) && <span aria-hidden="true">{AVATARS[player.avatar]} </span>}{entry.name}{player?.holding && <span className="cf-crown-mark" aria-label="Crown holder"> &#9819;</span>}</span>
                {phase !== 'lobby' && <strong className="cf-score">{entry.score}</strong>}
                <span className={'cf-ready ' + (player?.connected && player.ready ? 'is-ready' : '')}>{!player?.connected ? 'Offline' : phase === 'lobby' ? player.ready ? 'Ready' : 'Calibrating' : ended?.winnerIds.includes(entry.playerId) ? 'Winner' : ''}</span>
              </li>;
            })}</ul>
            {phase === 'lobby' && <div className="cf-ready-count">{readyCount} ready <span>- {Math.max(0, RULES.minPlayers - readyCount)} more needed to start</span></div>}
            <button className="cf-primary cf-start" disabled={!canStart} onClick={start}>{pending === 'start' ? 'Please wait...' : phase === 'ended' ? 'Rematch - return to lobby' : phase === 'lobby' ? 'Start the arena' : phase === 'countdown' ? 'Starting...' : 'Arena is live'}</button>
          </section>
          {replay && phase === 'playing' && (!snapshot?.duel || snapshot.duel.stage === 'done') && <ReplayPanel key={replay.event.eventId} event={replay.event} fouls={replay.fouls} players={players}/>}
        </aside>
      </div>
    </>}
    {error && <p className="cf-error" role="alert">{error}</p>}
    <footer className="cf-footer"><span>BUILT FOR A ROOM FULL OF PEOPLE.</span><span>2-8 PLAYERS - MOTION CONTROLLED</span></footer>
  </main>;
}

const CONFETTI_COLORS = ['#f6ce68', '#ff6b6b', '#5ad1ff', '#79dfbc', '#c49bff', '#ffffff'];
/** Pure-CSS confetti: fixed pseudo-random layout so re-renders don't reshuffle it. */
function Confetti() {
  return <div className="cf-confetti" aria-hidden="true">{Array.from({ length: 36 }, (_, i) =>
    <i key={i} style={{ left: `${(i * 37) % 100}%`, background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      animationDelay: `${(i * 0.13) % 1.6}s`, animationDuration: `${2.4 + (i % 5) * 0.35}s`, transform: `rotate(${i * 29}deg)` }}/>)}</div>;
}
function HostPodium({ scores, players }: { scores: GameEnded['scores']; players: Snapshot['players'] }) {
  const top = [...scores].sort((a, b) => b.score - a.score).slice(0, 3);
  const order = [top[1], top[0], top[2]];
  return <div className="cf-podium">{order.map((entry, i) => {
    if (!entry) return <div key={i} className="cf-step cf-step-empty"/>;
    const place = top.indexOf(entry) + 1;
    const player = players.find(p => p.id === entry.playerId);
    return <div key={entry.playerId} className={'cf-step cf-step-' + place} style={{ ['--pc' as string]: player?.color ?? '#f6ce68' }}>
      <span className="cf-step-avatar">{isAvatarId(player?.avatar) ? AVATARS[player.avatar] : '🙂'}</span>
      <span className="cf-step-name">{entry.name}</span>
      <span className="cf-step-score">{entry.score}</span>
      <span className="cf-step-block">{place}</span>
    </div>;
  })}</div>;
}
