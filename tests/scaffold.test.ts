import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../shared/events.js';
import { createApp } from '../server/app.js';
import { RoomManager } from '../server/RoomManager.js';

test('rooms have unique codes, random tokens and a strict eight-player capacity', () => {
  const manager = new RoomManager();
  const first = manager.create('https://example.test');
  const second = manager.create('https://example.test');
  assert.notEqual(first.roomCode, second.roomCode);
  assert.notEqual(first.hostToken, second.hostToken);
  assert.equal(first.joinUrl, `https://example.test/play/${first.roomCode}`);
  for (let i = 0; i < 8; i++) assert.ok('playerId' in manager.join(first.roomCode, `Player ${i}`));
  assert.deepEqual(manager.join(first.roomCode, 'Ninth'), { error: { code: 'ROOM_FULL', message: 'Room has eight players.' } });
});

test('HTTP and real Socket.IO host/join/clock/validation/disconnect flow', async t => {
  const server = createApp();
  server.http.listen(0, '127.0.0.1');
  await once(server.http, 'listening');
  const address = server.http.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const clients: Socket<ServerToClientEvents, ClientToServerEvents>[] = [];
  t.after(async () => { clients.forEach(client => client.disconnect()); await new Promise<void>(resolve => server.io.close(() => resolve())); });
  async function connect() {
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(origin, { transports: ['websocket'], reconnection: false });
    clients.push(socket);
    await new Promise<void>(resolve => socket.once('connect', resolve));
    return socket;
  }
  assert.equal((await (await fetch(`${origin}/health`)).json()).ok, true);
  const host = await connect();
  const created = await host.emitWithAck('room:create');
  assert.ok(!('error' in created));
  if ('error' in created) return;
  const phone = await connect();
  const update = new Promise<import('../shared/events.js').Snapshot>(resolve => host.once('state:snapshot', resolve));
  const joined = await phone.emitWithAck('room:join', { roomCode: created.roomCode, name: ' Swayam ' });
  assert.ok(!('error' in joined));
  assert.equal((await update).players[0].name, 'Swayam');
  const duplicate = await phone.emitWithAck('room:join', { roomCode: created.roomCode, name: 'Duplicate' });
  assert.ok('error' in duplicate && duplicate.error.code === 'ALREADY_JOINED');
  const pong = new Promise<{ t0: number; ts: number }>(resolve => phone.once('clock:pong', resolve));
  phone.emit('clock:ping', { t0: 123 });
  assert.equal((await pong).t0, 123);
  const invalid = await connect();
  const rejected = await invalid.emitWithAck('room:join', { roomCode: 'BAD', name: '' });
  assert.ok('error' in rejected && rejected.error.code === 'INVALID_PAYLOAD');
  const unsupported = await host.emitWithAck('host:start', { hostToken: created.hostToken });
  assert.ok('error' in unsupported && unsupported.error.code === 'NOT_IMPLEMENTED');
  const disconnected = new Promise<import('../shared/events.js').Snapshot>(resolve => host.once('state:snapshot', resolve));
  phone.disconnect();
  assert.equal((await disconnected).players[0].connected, false);
});
