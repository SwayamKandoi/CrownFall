import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import QRCode from 'qrcode';
import type { ClientToServerEvents, ServerToClientEvents, CreateResult, Snapshot } from '../../shared/events.js';
import { RULES } from '../../shared/constants.js';
import { ArenaView } from './ArenaView.js';
import './host.css';

type HostSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
function CrownIcon() {
  return <svg width="25" height="25" viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="m4 8 5 5 5-9 5 9 5-5-3 14H7L4 8Z" fill="currentColor"/><path d="M8 25h12" stroke="currentColor" strokeWidth="2"/></svg>;
}
export function HostPage() {
  const socketRef = useRef<HostSocket>();
  const lastSnapshot = useRef(0);
  const [connected, setConnected] = useState(false);
  const [delayed, setDelayed] = useState(false);
  const [room, setRoom] = useState<CreateResult>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'create' | 'start'>();
  const [copied, setCopied] = useState(false);
  const joinUrl = room ? new URL('/play/' + room.roomCode, location.origin).href : '';
  useEffect(() => {
    const connection: HostSocket = io();
    socketRef.current = connection;
    connection.on('connect', () => { setConnected(true); setError(''); });
    connection.on('disconnect', () => {
      setConnected(false); setRoom(undefined); setSnapshot(undefined); setPending(undefined);
      setError('Host connection lost. Room recovery is not available yet; create a new room after reconnecting.');
    });
    connection.on('connect_error', () => setError('Cannot reach the server. Check your connection and /health.'));
    connection.on('state:snapshot', state => { lastSnapshot.current = performance.now(); setDelayed(false); setSnapshot(state); });
    connection.on('game:event', event => window.dispatchEvent(new CustomEvent('crownfall:game-event', { detail: event })));
    const timer = setInterval(() => setDelayed(lastSnapshot.current > 0 && performance.now() - lastSnapshot.current > 2000), 500);
    return () => { clearInterval(timer); connection.removeAllListeners(); connection.disconnect(); socketRef.current = undefined; };
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
  const canStart = connected && !delayed && phase === 'lobby' && readyCount >= RULES.minPlayers && !pending;
  return <main className="cf-host">
    <header className="cf-header">
      <a href="/host" className="cf-brand"><CrownIcon/> CROWNFALL</a>
      <div className={'cf-connection ' + (connected && !delayed ? 'is-online' : '')}><span/>{!connected ? 'Connecting' : delayed ? 'Updates delayed' : 'Server connected'}</div>
    </header>
    {!room ? <section className="cf-welcome">
      <div className="cf-tag">A ROOM FULL OF RIVALS.</div>
      <h1>One crown.<br/><em>No safe friends.</em></h1>
      <p>Your phone is the controller. Your friends are the competition.<br/>Gather 4–8 players and take over the big screen.</p>
      <button className="cf-primary" disabled={!connected || Boolean(pending)} onClick={createRoom}>{pending === 'create' ? 'Creating room…' : 'Create a room'} <span aria-hidden="true">↗</span></button>
      <div className="cf-steps"><span>01 · CREATE</span><span>02 · SCAN & CALIBRATE</span><span>03 · TILT TO MOVE</span></div>
      <p className="cf-note">Multiplayer movement preview · Crown gameplay arrives at the next gate.</p>
    </section> : <>
      <div className="cf-room-heading">
        <div><div className="cf-tag">{phase === 'lobby' ? 'THE RIVALS ARE GATHERING' : phase === 'countdown' ? 'GET READY' : 'THE ARENA IS LIVE'}</div><h1>{phase === 'lobby' ? 'Make yourself a rival.' : phase === 'countdown' ? 'Eyes on the arena.' : 'Every tilt counts.'}</h1></div>
        <div className="cf-room-code"><span>ROOM CODE</span><strong>{room.roomCode}</strong></div>
      </div>
      <div className="cf-layout">
        <section className="cf-stage">
          <div className="cf-stage-heading"><span><i className="cf-live-dot"/>{phase === 'lobby' ? 'WARM-UP ARENA' : phase === 'countdown' ? 'COUNTDOWN' : 'LIVE ARENA'}</span><span>960 × 540</span></div>
          <div className="cf-arena-wrap">
            <ArenaView snapshot={snapshot}/>
            {phase === 'countdown' && <div className="cf-countdown" aria-live="assertive"><span>READY YOUR PHONES</span><strong>{Math.max(1, Math.ceil((snapshot?.remainingMs ?? 3000) / 1000))}</strong><span>Keep your eyes on the big screen</span></div>}
            {!players.length && <div className="cf-empty-arena"><span>YOUR KINGDOM AWAITS.</span><p>Scan the code to claim your place.</p></div>}
            {(!connected || delayed) && <div className="cf-arena-warning">Connection interrupted · waiting for live state</div>}
          </div>
          <div className="cf-arena-footer"><span>{phase === 'lobby' ? 'Tilt to explore. Calibrate your phone to become ready.' : phase === 'countdown' ? 'Movement pauses during the countdown.' : 'Move together. Every avatar is controlled by its own player.'}</span><span>{players.filter(p => p.connected).length} / 8 ONLINE</span></div>
          <div className="cf-instructions"><div><b>01</b><strong>Scan to join</strong><p>Open the link on your phone.</p></div><div><b>02</b><strong>Find your balance</strong><p>Enable motion, then calibrate.</p></div><div><b>03</b><strong>Make your move</strong><p>Tilt your phone to explore.</p></div></div>
        </section>
        <aside className="cf-sidebar">
          <section className="cf-join-panel"><div><span className="cf-tag">JOIN THE ROOM</span><h2>Scan. Tilt. Rival.</h2></div>
            {qr ? <img className="cf-qr" src={qr} alt={'QR join link for room ' + room.roomCode} width="176" height="176"/> : <div className="cf-qr-loading">Preparing QR…</div>}
            <a className="cf-join-link" href={joinUrl}>{joinUrl}</a><button className="cf-copy" onClick={copyLink}>{copied ? 'Link copied ✓' : 'Copy join link'}</button>
          </section>
          <section className="cf-roster"><div className="cf-roster-heading"><h2>The contenders</h2><span>{players.length}/8</span></div>
            <ul>{players.map((player, index) => <li key={player.id} className={!player.connected ? 'is-offline' : ''}><span className="cf-avatar" style={{ backgroundColor: player.color }}>{index + 1}</span><span className="cf-player-name">{player.name}</span><span className={'cf-ready ' + (player.connected && player.ready ? 'is-ready' : '')}>{!player.connected ? 'Offline' : player.ready ? 'Ready ✓' : 'Calibrating'}</span></li>)}
            {Array.from({ length: Math.max(0, 4 - players.length) }, (_, index) => <li key={'empty-' + index} className="cf-empty-slot"><span>+</span> Waiting for a contender</li>)}</ul>
            <div className="cf-ready-count">{readyCount} ready <span>· {Math.max(0, RULES.minPlayers - readyCount)} more needed to start</span></div>
            <button className="cf-primary cf-start" disabled={!canStart} onClick={start}>{pending === 'start' ? 'Starting…' : phase === 'lobby' ? 'Start the arena →' : phase === 'countdown' ? 'Starting…' : 'Arena is live'}</button>
          </section>
        </aside>
      </div>
      <p className="cf-note">Movement preview · Controller route integration pending Aryan · No crown scoring yet</p>
    </>}
    {error && <p className="cf-error" role="alert">{error}</p>}
    <footer className="cf-footer"><span>BUILT FOR A ROOM FULL OF PEOPLE.</span><span>4–8 PLAYERS · MOTION CONTROLLED</span></footer>
  </main>;
}
