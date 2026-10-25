import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../server/RoomManager.js';
import { RULES } from '../shared/constants.js';
import { errorCode, harness, rawAck, success, waitSnapshot } from './support/socketHarness.js';

test('real clients: capacity, readiness, host authorization and automatic countdown', { timeout: 12_000 }, async t => {
  const h = await harness(t);
  const { host, created, players } = await h.room(8);
  assert.equal(h.rooms.snapshot(created.roomCode).players.length, 8);
  assert.equal(new Set(players.map(p => p.identity.color)).size, 8);
  const ninth = await h.connect();
  assert.equal(errorCode(await ninth.timeout(1500).emitWithAck('room:join', { roomCode: created.roomCode, name: 'Ninth' })), 'ROOM_FULL');
  const stranger = await h.connect();
  assert.equal(errorCode(await stranger.timeout(1500).emitWithAck('host:start', { hostToken: created.hostToken })), 'UNAUTHORIZED');
  assert.equal(errorCode(await players[0].socket.timeout(1500).emitWithAck('host:start', { hostToken: created.hostToken })), 'UNAUTHORIZED');
  assert.equal(errorCode(await host.timeout(1500).emitWithAck('host:start', { hostToken: 'wrong' })), 'UNAUTHORIZED');
  // Same UTF-16 length but different byte length must reject without throwing.
  assert.equal(errorCode(await host.timeout(1500).emitWithAck('host:start', { hostToken: 'é'.repeat(64) })), 'UNAUTHORIZED');
  const other = await h.room(0);
  assert.equal(errorCode(await other.host.timeout(1500).emitWithAck('host:start', { hostToken: created.hostToken })), 'UNAUTHORIZED');
  for (const p of players.slice(0, RULES.minPlayers - 1)) success(await p.socket.timeout(1500).emitWithAck('player:ready', { calibrated: true }));
  assert.equal(errorCode(await host.timeout(1500).emitWithAck('host:start', { hostToken: created.hostToken })), 'NOT_READY');
  const readyUpdate = waitSnapshot(host, s => s.players.filter(p => p.ready).length === RULES.minPlayers);
  success(await players[RULES.minPlayers - 1].socket.timeout(1500).emitWithAck('player:ready', { calibrated: true }));
  assert.equal((await readyUpdate).players.filter(p => p.ready).length, RULES.minPlayers);
  const countdown = waitSnapshot(host, s => s.phase === 'countdown');
  const playing = waitSnapshot(host, s => s.phase === 'playing');
  success(await host.timeout(1500).emitWithAck('host:start', { hostToken: created.hostToken }));
  const initial = await countdown;
  assert.ok(initial.remainingMs > 2500 && initial.remainingMs <= RULES.countdownMs);
  assert.equal(errorCode(await host.timeout(1500).emitWithAck('host:start', { hostToken: created.hostToken })), 'INVALID_PHASE');
  assert.equal((await playing).phase, 'playing');
  assert.equal(errorCode(await host.timeout(1500).emitWithAck('host:start', { hostToken: created.hostToken })), 'INVALID_PHASE');
  const disconnected = waitSnapshot(host, s => s.players.some(p => p.id === players[0].identity.playerId && !p.connected && !p.ready));
  players[0].socket.disconnect();
  await disconnected;
});

test('real clients: malformed requests, missing rooms, readiness and optional acknowledgements', { timeout: 6000 }, async t => {
  const h = await harness(t);
  const client = await h.connect();
  assert.equal(errorCode(await rawAck(client, 'room:join', null)), 'INVALID_PAYLOAD');
  assert.equal(errorCode(await rawAck(client, 'room:join', { roomCode: 'ABCDE', name: '\n' })), 'INVALID_PAYLOAD');
  assert.equal(errorCode(await rawAck(client, 'room:join', { roomCode: 'ABCDE', name: 'Good' })), 'ROOM_NOT_FOUND');
  assert.equal(errorCode(await rawAck(client, 'player:ready', { calibrated: false })), 'INVALID_PAYLOAD');
  assert.equal(errorCode(await rawAck(client, 'player:ready', { calibrated: true })), 'UNAUTHORIZED');
  assert.equal(errorCode(await rawAck(client, 'host:start', {})), 'INVALID_PAYLOAD');
  assert.equal(errorCode(await rawAck(client, 'room:resume', { roomCode: 'ABCDE', resumeToken: 'x' })), 'NOT_IMPLEMENTED');
  const room = await h.room(4);
  const update = waitSnapshot(room.host, s => s.players.every(p => p.ready));
  for (const p of room.players) p.socket.emit('player:ready', { calibrated: true });
  assert.equal((await update).players.length, 4);
});

test('cleanup expires only unoccupied rooms and snapshots do not leak tokens or internal references', () => {
  let now = 0;
  const manager = new RoomManager(() => now, 100);
  const empty = manager.create('https://example.test');
  const active = manager.create('https://example.test');
  const player = success(manager.join(active.roomCode, 'Aryan'));
  manager.disconnect(empty.roomCode);
  manager.disconnect(active.roomCode);
  now = 101; manager.advance();
  assert.equal(manager.rooms.has(empty.roomCode), false);
  assert.equal(manager.rooms.has(active.roomCode), true);
  const snapshot = manager.snapshot(active.roomCode);
  assert.ok(!JSON.stringify(snapshot).includes(active.hostToken));
  snapshot.players[0].score = 999;
  assert.equal(manager.snapshot(active.roomCode).players[0].score, 0);
  manager.disconnect(active.roomCode, player.playerId);
  now += 101; manager.advance();
  assert.equal(manager.rooms.size, 0);
});
