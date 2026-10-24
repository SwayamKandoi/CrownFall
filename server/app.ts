import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '../shared/events.js';
import { RoomManager, failure } from './RoomManager.js';

export function createApp(options: { publicOrigin?: string; clientDir?: string } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const http = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(http, { maxHttpBufferSize: 16_384 });
  const rooms = new RoomManager();
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'crownfall' }));
  const clientDir = options.clientDir ?? fileURLToPath(new URL('../client/', import.meta.url));
  if (existsSync(`${clientDir}/index.html`)) {
    app.use(express.static(clientDir));
    app.get('*', (_req, res) => res.sendFile(`${clientDir}/index.html`));
  }
  io.on('connection', socket => {
    let membership: { code: string; playerId?: string } | undefined;
    let lastAction = 0;
    const limited = () => { const now = Date.now(); if (now - lastAction < 100) return true; lastAction = now; return false; };
    socket.on('room:create', ack => {
      if (typeof ack !== 'function') return;
      if (membership) return ack(failure('ALREADY_JOINED', 'This connection already belongs to a room.'));
      if (limited()) return ack(failure('RATE_LIMITED', 'Try again shortly.'));
      const origin = options.publicOrigin ?? `http://localhost:${(http.address() as { port: number }).port}`;
      const result = rooms.create(origin);
      membership = { code: result.roomCode };
      void socket.join(result.roomCode);
      ack(result);
      socket.emit('state:snapshot', rooms.snapshot(result.roomCode));
    });
    socket.on('room:join', (payload, ack) => {
      if (typeof ack !== 'function') return;
      if (membership) return ack(failure('ALREADY_JOINED', 'This connection already belongs to a room.'));
      if (limited()) return ack(failure('RATE_LIMITED', 'Try again shortly.'));
      if (!payload || typeof payload.roomCode !== 'string' || !/^[A-Z2-9]{5}$/.test(payload.roomCode) || typeof payload.name !== 'string' || !payload.name.trim() || payload.name.trim().length > 20)
        return ack(failure('INVALID_PAYLOAD', 'Use a five-character room code and a name of 1–20 characters.'));
      const result = rooms.join(payload.roomCode, payload.name.trim());
      if ('error' in result) return ack(result);
      membership = { code: payload.roomCode, playerId: result.playerId };
      void socket.join(payload.roomCode);
      ack(result);
      io.to(payload.roomCode).emit('state:snapshot', rooms.snapshot(payload.roomCode));
      socket.emit('phone:state', { phase: 'lobby', holding: false, score: 0, inRange: false, wantedName: null, duel: null });
    });
    socket.on('clock:ping', payload => {
      if (payload && typeof payload.t0 === 'number' && Number.isFinite(payload.t0)) socket.emit('clock:pong', { t0: payload.t0, ts: Date.now() });
    });
    // Reserved events explicitly reject unsupported actions until their phase gate.
    socket.on('room:resume', (_payload, ack) => { if (typeof ack === 'function') ack(failure('NOT_IMPLEMENTED', 'Resume arrives in a later phase.')); });
    for (const event of ['player:ready', 'host:start', 'input:move', 'input:yank', 'input:taunt'] as const) {
      socket.on(event, (_payload: unknown, ack?: (value: ReturnType<typeof failure>) => void) => {
        if (typeof ack === 'function') ack(failure('NOT_IMPLEMENTED', 'Gameplay is unavailable in the Phase 0 scaffold.'));
      });
    }
    socket.on('disconnect', () => {
      if (!membership?.playerId) return;
      const player = rooms.rooms.get(membership.code)?.players.get(membership.playerId);
      if (player) player.connected = false;
      io.to(membership.code).emit('state:snapshot', rooms.snapshot(membership.code));
    });
  });
  return { app, http, io, rooms };
}
