import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, CreateResult, Snapshot } from '../../shared/events.js';
import './host.css';
export function HostPage() {
  const [socket, setSocket] = useState<Socket<ServerToClientEvents, ClientToServerEvents>>();
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState<CreateResult>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const connection: Socket<ServerToClientEvents, ClientToServerEvents> = io();
    setSocket(connection);
    connection.on('connect', () => setConnected(true));
    connection.on('disconnect', () => { setConnected(false); setRoom(undefined); });
    connection.on('connect_error', () => setError('Cannot connect to the server.'));
    connection.on('state:snapshot', setSnapshot);
    // Announcer modules can subscribe to this DOM event without importing arena code.
    connection.on('game:event', event => window.dispatchEvent(new CustomEvent('crownfall:game-event', { detail: event })));
    return () => { connection.disconnect(); };
  }, []);
  function createRoom() {
    setPending(true); setError('');
    socket?.timeout(5000).emit('room:create', (timeoutError: Error | null, result: CreateResult | { error: { message: string } }) => {
      setPending(false);
      if (timeoutError) return setError('Room creation timed out. Reconnect before retrying.');
      if ('error' in result) setError(result.error.message); else setRoom(result);
    });
  }
  return <main><header><span>CROWNFALL</span><small>{connected ? 'SERVER CONNECTED' : 'CONNECTING…'}</small></header>
    <section><p className="eyebrow">ONE CROWN. EVERYONE WANTS IT.</p><h1>The room is yours.</h1><p>A motion-controlled showdown for 4–8 players.</p>
    {!room ? <button disabled={!connected || pending} onClick={createRoom}>{pending ? 'Creating…' : 'Create a room'}</button> : <><p>ROOM CODE</p><strong className="code">{room.roomCode}</strong><p><a href={room.joinUrl}>{room.joinUrl}</a></p><p>Phone controller integration pending. Share this link once Aryan's controller is merged.</p><h2>Players · {snapshot?.players.length ?? 0}/8</h2><ul>{snapshot?.players.map(player => <li key={player.id} style={{ color: player.color }}>{player.name} · {player.connected ? 'connected' : 'disconnected'}</li>)}</ul></>}
    {error && <p role="alert">{error}</p>}<footer>Phase 0 · Room server ready · Gameplay arrives after integration</footer></section></main>;
}
