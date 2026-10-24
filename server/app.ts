import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import type { Ack, ActionError, ClientToServerEvents, ServerToClientEvents } from '../shared/events.js';
import { RULES } from '../shared/constants.js';
import { RoomManager, failure } from './RoomManager.js';
import { exact, finite, roomCode, RateLimit } from './validation.js';

interface Membership { code: string; playerId?: string }
export function createApp(options: { publicOrigin?: string; clientDir?: string; emptyTtlMs?: number } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const http = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(http, { maxHttpBufferSize: 16_384 });
  const rooms = new RoomManager(undefined, options.emptyTtlMs);
  const memberships = new Map<string, Membership>();
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'crownfall' }));
  const clientDir = options.clientDir ?? fileURLToPath(new URL('../client/', import.meta.url));
  if (existsSync(clientDir + '/index.html')) {
    app.use(express.static(clientDir));
    app.get('*', (_req, res) => res.sendFile(clientDir + '/index.html'));
  }
  function broadcast(code: string) {
    if (!rooms.rooms.has(code)) return;
    const snapshot = rooms.snapshot(code);
    io.to(code).emit('state:snapshot', snapshot);
    for (const [socketId, member] of memberships) if (member.code === code && member.playerId) {
      const player = rooms.rooms.get(code)?.players.get(member.playerId);
      if (player) io.to(socketId).emit('phone:state', { phase: snapshot.phase, holding: player.holding, score: player.score, inRange: false, wantedName: null, duel: null });
    }
  }
  const interval = setInterval(() => {
    rooms.advance();
    for (const code of rooms.rooms.keys()) broadcast(code);
  }, 1000 / RULES.snapshotHz);
  interval.unref();
  http.on('close', () => { clearInterval(interval); rooms.dispose(); memberships.clear(); });
  io.on('connection', socket => {
    const actions = new RateLimit(5, 20);
    const clock = new RateLimit(10, 16);
    const reject = (ack: unknown, error: ActionError) => { if (typeof ack === 'function') (ack as Ack<never>)(error); };
    const allowed = (ack: unknown) => { if (actions.take()) return true; reject(ack, failure('RATE_LIMITED', 'Too many actions.')); return false; };
    socket.on('room:create', async ack => {
      if (typeof ack !== 'function') return;
      if (memberships.has(socket.id)) return ack(failure('ALREADY_JOINED', 'This connection already belongs to a room.'));
      if (!allowed(ack)) return;
      // Never reflect an untrusted Origin/Host header into a join link.
      const origin = options.publicOrigin ?? 'http://localhost:' + (http.address() as { port: number }).port;
      const result = rooms.create(origin);
      memberships.set(socket.id, { code: result.roomCode });
      await socket.join(result.roomCode);
      ack(result); broadcast(result.roomCode);
    });
    socket.on('room:join', async (payload, ack) => {
      if (typeof ack !== 'function') return;
      if (memberships.has(socket.id)) return ack(failure('ALREADY_JOINED', 'This connection already belongs to a room.'));
      if (!allowed(ack)) return;
      if (!exact(payload, ['roomCode', 'name']) || !roomCode(payload.roomCode) || typeof payload.name !== 'string' || !payload.name.trim() || payload.name.trim().length > 20 || /[\u0000-\u001f\u007f]/.test(payload.name))
        return ack(failure('INVALID_PAYLOAD', 'Use a five-character room code and a name of 1–20 printable characters.'));
      const result = rooms.join(payload.roomCode, payload.name.trim());
      if ('error' in result) return ack(result);
      memberships.set(socket.id, { code: payload.roomCode, playerId: result.playerId });
      await socket.join(payload.roomCode);
      ack(result); broadcast(payload.roomCode);
    });
    socket.on('player:ready', (payload, ack) => {
      if (!allowed(ack)) return;
      if (!exact(payload, ['calibrated']) || payload.calibrated !== true) return reject(ack, failure('INVALID_PAYLOAD', 'calibrated must be true.'));
      const member = memberships.get(socket.id);
      if (!member?.playerId) return reject(ack, failure('UNAUTHORIZED', 'Join as a player first.'));
      const result = rooms.ready(member.code, member.playerId);
      if (typeof ack === 'function') ack(result);
      if (!('error' in result)) broadcast(member.code);
    });
    socket.on('host:start', (payload, ack) => {
      if (!allowed(ack)) return;
      if (!exact(payload, ['hostToken']) || typeof payload.hostToken !== 'string' || payload.hostToken.length > 128)
        return reject(ack, failure('INVALID_PAYLOAD', 'A hostToken is required.'));
      const member = memberships.get(socket.id);
      if (!member || member.playerId) return reject(ack, failure('UNAUTHORIZED', 'Only the room host can start.'));
      const result = rooms.start(member.code, payload.hostToken);
      if (typeof ack === 'function') ack(result);
      if (!('error' in result)) broadcast(member.code);
    });
    socket.on('clock:ping', payload => {
      if (clock.take() && exact(payload, ['t0']) && finite(payload.t0)) socket.emit('clock:pong', { t0: payload.t0, ts: Date.now() });
    });
    socket.on('room:resume', (_payload, ack) => reject(ack, failure('NOT_IMPLEMENTED', 'Resume is not available yet.')));
    for (const event of ['input:move', 'input:yank', 'input:taunt'] as const) {
      socket.on(event, (_payload: unknown, ack?: Ack<{ ok: true }>) => reject(ack, failure('NOT_IMPLEMENTED', 'Movement and gameplay arrive in later phases.')));
    }
    socket.on('disconnect', () => {
      const member = memberships.get(socket.id);
      if (!member) return;
      memberships.delete(socket.id); rooms.disconnect(member.code, member.playerId);
      if (member.playerId) io.to(member.code).emit('game:event', { eventId: randomUUID(), type: 'PLAYER_LEFT', actorId: member.playerId });
      broadcast(member.code);
    });
  });
  return { app, http, io, rooms };
}
