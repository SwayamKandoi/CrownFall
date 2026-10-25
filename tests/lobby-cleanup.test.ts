import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../server/RoomManager.js';
import { RULES } from '../shared/constants.js';
import { errorCode, harness, success, waitSnapshot } from './support/socketHarness.js';

function fixture(count = 8) {
  let now = 0;
  const manager = new RoomManager(() => now);
  const created = manager.create('https://example.test');
  const players = Array.from({ length: count }, (_, i) => success(manager.join(created.roomCode, 'Player ' + i)));
  const room = manager.rooms.get(created.roomCode)!;
  return { manager, created, players, room, setTime: (value: number) => { now = value; } };
}

test('lobby ghosts remain offline for exactly 2000 ms, then free slots with unique reused colors', () => {
  const { manager, created, players, room, setTime } = fixture();
  const removed = [players[1], players[4], players[6]];
  setTime(100);
  success(manager.ready(created.roomCode, players[1].playerId));
  for (const player of removed) manager.disconnect(created.roomCode, player.playerId);
  assert.equal(room.players.size, 8);
  for (const player of removed) {
    assert.equal(room.players.get(player.playerId)!.connected, false);
    assert.equal(room.players.get(player.playerId)!.ready, false);
  }
  assert.equal(errorCode(manager.join(created.roomCode, 'Too soon')), 'ROOM_FULL');
  setTime(100 + RULES.disconnectDropMs - 1); manager.advance();
  assert.equal(room.players.size, 8);
  setTime(100 + RULES.disconnectDropMs);
  assert.deepEqual(manager.advance(), [created.roomCode], 'roster changes request a snapshot');
  assert.equal(room.players.size, 5);
  for (const player of removed) assert.equal(room.players.has(player.playerId), false);
  const replacements = removed.map((_, i) => success(manager.join(created.roomCode, 'Replacement ' + i)));
  assert.deepEqual(new Set(replacements.map(p => p.color)), new Set(removed.map(p => p.color)));
  assert.equal(room.players.size, 8);
  assert.equal(new Set([...room.players.values()].map(p => p.color)).size, 8);
  assert.equal(errorCode(manager.join(created.roomCode, 'Ninth')), 'ROOM_FULL');
  setTime(20_000); manager.advance();
  assert.equal(room.players.size, 8, 'connected players survive future cleanup passes');
});

test('cleanup protects a connected player and does not reuse an old disconnect deadline', () => {
  const { manager, created, players, room, setTime } = fixture(1);
  const id = players[0].playerId;
  manager.disconnect(created.roomCode, id);
  // Guard against connected state being restored during the grace period by future resume handling.
  room.players.get(id)!.connected = true;
  setTime(RULES.disconnectDropMs); manager.advance();
  assert.equal(room.players.has(id), true);
  manager.disconnect(created.roomCode, id);
  setTime(2 * RULES.disconnectDropMs - 1); manager.advance();
  assert.equal(room.players.has(id), true);
  setTime(2 * RULES.disconnectDropMs); manager.advance();
  assert.equal(room.players.has(id), false);
});

test('starting during the grace period preserves lobby, countdown and playing disconnects', () => {
  const { manager, created, players, room, setTime } = fixture();
  manager.disconnect(created.roomCode, players[0].playerId);
  for (const player of players.slice(1)) success(manager.ready(created.roomCode, player.playerId));
  success(manager.start(created.roomCode, created.hostToken));
  setTime(RULES.disconnectDropMs); manager.advance();
  assert.equal(room.game.phase, 'countdown');
  assert.equal(room.players.size, 8);
  manager.disconnect(created.roomCode, players[1].playerId);
  setTime(RULES.countdownMs); manager.advance();
  assert.equal(room.game.phase, 'playing');
  manager.disconnect(created.roomCode, players[2].playerId);
  setTime(RULES.countdownMs + RULES.disconnectDropMs + 1); manager.advance();
  assert.equal(room.players.size, 8);
  for (const player of players.slice(0, 3)) assert.equal(room.players.get(player.playerId)!.connected, false);
});

test('lobby disconnect deadlines and slot reuse stay isolated between rooms', () => {
  const { manager, created, players, setTime } = fixture();
  const second = manager.create('https://example.test');
  const secondPlayers = Array.from({ length: 8 }, (_, i) => success(manager.join(second.roomCode, 'Other ' + i)));
  manager.disconnect(created.roomCode, players[3].playerId);
  setTime(1000); manager.disconnect(second.roomCode, secondPlayers[0].playerId);
  setTime(2000); manager.advance();
  assert.equal(manager.snapshot(created.roomCode).players.length, 7);
  assert.equal(manager.snapshot(second.roomCode).players.length, 8);
  success(manager.join(created.roomCode, 'Replacement'));
  assert.equal(errorCode(manager.join(second.roomCode, 'Too soon')), 'ROOM_FULL');
  setTime(3000); manager.advance();
  success(manager.join(second.roomCode, 'Replacement'));
  for (const code of [created.roomCode, second.roomCode]) {
    assert.equal(manager.snapshot(code).players.length, 8);
    assert.equal(new Set(manager.snapshot(code).players.map(p => p.color)).size, 8);
  }
});

test('removing a lobby player clears movement, sequence and rate-limit state', () => {
  const { manager, created, players, room, setTime } = fixture(1);
  const id = players[0].playerId;
  const saved = { ...room.players.get(id)! };
  success(room.game.move(id, { seq: 99, x: 1, y: 0 }, 0));
  manager.disconnect(created.roomCode, id);
  setTime(RULES.disconnectDropMs); manager.advance();
  assert.equal(errorCode(room.game.move(id, { seq: 100, x: 1, y: 0 }, RULES.disconnectDropMs)), 'UNAUTHORIZED');
  // Reuse the identity only inside this unit test to detect retained input history.
  room.players.set(id, saved);
  setTime(RULES.disconnectDropMs + 100); manager.advance();
  assert.equal(saved.x, 180);
  success(room.game.move(id, { seq: 0, x: 0, y: 1 }, RULES.disconnectDropMs + 100));
});

test('real sockets: full lobby broadcasts offline then removal and accepts replacement players', { timeout: 7000 }, async t => {
  const h = await harness(t);
  const { host, created, players } = await h.room(8);
  const departing = [players[1], players[5]];
  const offline = waitSnapshot(host, s => s.players.length === 8 && departing.every(p => s.players.some(state => state.id === p.identity.playerId && !state.connected)));
  const removed = waitSnapshot(host, s => s.players.length === 6 && departing.every(p => s.players.every(state => state.id !== p.identity.playerId)));
  for (const player of departing) player.socket.disconnect();
  await offline;
  const replacement = await h.connect();
  assert.equal(errorCode(await replacement.timeout(1500).emitWithAck('room:join', { roomCode: created.roomCode, name: 'Too soon' })), 'ROOM_FULL');
  await removed;
  success(await replacement.timeout(1500).emitWithAck('room:join', { roomCode: created.roomCode, name: 'Replacement A' }));
  const other = await h.connect();
  const full = waitSnapshot(host, s => s.players.length === 8 && s.players.every(p => p.connected));
  success(await other.timeout(1500).emitWithAck('room:join', { roomCode: created.roomCode, name: 'Replacement B' }));
  const state = await full;
  assert.equal(new Set(state.players.map(p => p.color)).size, 8);
  for (const player of players.filter(p => !departing.includes(p))) assert.ok(state.players.some(p => p.id === player.identity.playerId && p.connected));
});
