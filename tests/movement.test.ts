import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom, AVATAR_RADIUS, INPUT_TIMEOUT_MS } from '../server/GameRoom.js';
import { RULES } from '../shared/constants.js';
import type { PlayerState, Snapshot } from '../shared/events.js';
import { errorCode, harness, rawAck, sleep, success, waitSnapshot, type Client } from './support/socketHarness.js';

function fixture() {
  const player: PlayerState = { id: 'one', name: 'One', color: '#ff6b6b', x: 480, y: 270,
    score: 0, holding: false, connected: true, inDuel: false, wantedId: null };
  return { player, game: new GameRoom(new Map([[player.id, player]]), 0) };
}

test('fixed-step movement: speed, normalization, boundaries, latest input and timeout', () => {
  const { player, game } = fixture();
  success(game.move(player.id, { seq: 0, x: 5, y: 0 }, 0));
  game.advance(100);
  assert.ok(Math.abs(player.x - 501) < 0.001, '210 units/s, finite axes clamped');
  // Only the latest vector applies; no queue of old moves is accumulated.
  success(game.move(player.id, { seq: 1, x: 1, y: 0 }, 100));
  success(game.move(player.id, { seq: 2, x: 0, y: 1 }, 100));
  const before = player.x;
  game.advance(200);
  assert.equal(player.x, before);
  assert.ok(Math.abs(player.y - 291) < 0.001);
  game.advance(400);
  const expired = { x: player.x, y: player.y };
  game.advance(600);
  assert.deepEqual({ x: player.x, y: player.y }, expired, 'expired input cannot drift');
  const diagonal = fixture();
  success(diagonal.game.move('one', { seq: 1, x: 1, y: 1 }, 0));
  diagonal.game.advance(100);
  assert.ok(Math.abs(Math.hypot(diagonal.player.x - 480, diagonal.player.y - 270) - 21) < 0.001);
  player.x = RULES.arenaWidth - AVATAR_RADIUS - 1;
  player.y = AVATAR_RADIUS + 1;
  success(game.move('one', { seq: 3, x: 1, y: -1 }, 600));
  game.advance(700);
  assert.equal(player.x, RULES.arenaWidth - AVATAR_RADIUS);
  assert.equal(player.y, AVATAR_RADIUS);
});

test('movement rejects malformed, stale, spoofed and flooded input; disconnect stops immediately', () => {
  const { player, game } = fixture();
  for (const payload of [null, [], {}, { seq: -1, x: 0, y: 0 }, { seq: 0.5, x: 0, y: 0 },
    { seq: Number.MAX_SAFE_INTEGER + 1, x: 0, y: 0 }, { seq: 0, x: NaN, y: 0 },
    { seq: 0, x: Infinity, y: 0 }, { seq: 0, x: '1', y: 0 }, { seq: 0, x: 1, y: 0, playerId: 'victim' }])
    assert.equal(errorCode(game.move('one', payload, 0)), 'INVALID_PAYLOAD');
  assert.equal(errorCode(game.move('unknown', { seq: 0, x: 1, y: 0 }, 0)), 'UNAUTHORIZED');
  success(game.move('one', { seq: 1, x: 1, y: 0 }, 0));
  assert.equal(errorCode(game.move('one', { seq: 1, x: -1, y: 0 }, 1)), 'STALE_INPUT');
  assert.equal(errorCode(game.move('one', { seq: 0, x: -1, y: 0 }, 1)), 'STALE_INPUT');
  for (let seq = 2; seq <= 8; seq++) success(game.move('one', { seq, x: 1, y: 0 }, 1));
  assert.equal(errorCode(game.move('one', { seq: 9, x: 1, y: 0 }, 1)), 'RATE_LIMITED');
  game.advance(100);
  player.connected = false; game.disconnect('one');
  const x = player.x;
  game.advance(200);
  assert.equal(player.x, x);
  assert.equal(errorCode(game.move('one', { seq: 10, x: 1, y: 0 }, 200)), 'UNAUTHORIZED');
});

test('countdown survives stalled ticks and catch-up work remains bounded', () => {
  const { game } = fixture();
  game.start(0);
  game.advance(10_000);
  assert.equal(game.phase, 'playing');
  assert.ok(game.tick <= 8);
  const normal = fixture();
  for (let i = 1; i <= 300; i++) normal.game.advance(i * 1000 / 30);
  assert.equal(normal.game.tick, 300);
});

function stream(t: import('node:test').TestContext, socket: Client, x: number, y: number) {
  let seq = 0;
  const send = () => socket.volatile.emit('input:move', { seq: seq++, x, y });
  send();
  const timer = setInterval(send, 50);
  const stop = () => clearInterval(timer);
  t.after(stop);
  return stop;
}

test('four real simulated phones start, move independently, expire and survive one disconnect', { timeout: 12_000 }, async t => {
  const h = await harness(t);
  const { host, created, players } = await h.room(4);
  for (const p of players) success(await p.socket.timeout(1500).emitWithAck('player:ready', { calibrated: true }));
  const playing = waitSnapshot(host, s => s.phase === 'playing');
  success(await host.timeout(1500).emitWithAck('host:start', { hostToken: created.hostToken }));
  const initial = await playing;
  assert.equal(errorCode(await rawAck(host, 'input:move', { seq: 0, x: 1, y: 0 })), 'UNAUTHORIZED');
  assert.equal(errorCode(await rawAck(players[0].socket, 'input:move', { seq: 0, x: 1, y: 0, playerId: players[1].identity.playerId })), 'INVALID_PAYLOAD');
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const stops = players.map((p, i) => stream(t, p.socket, directions[i][0], directions[i][1]));
  const moved = await waitSnapshot(host, state => state.players.every((p, i) => Math.hypot(p.x - initial.players[i].x, p.y - initial.players[i].y) > 40));
  for (let i = 0; i < 4; i++) {
    const before = initial.players[i], after = moved.players[i];
    assert.equal(after.id, players[i].identity.playerId);
    if (directions[i][0]) { assert.ok((after.x - before.x) * directions[i][0] > 40); assert.equal(after.y, before.y); }
    else { assert.ok((after.y - before.y) * directions[i][1] > 40); assert.equal(after.x, before.x); }
    assert.ok(after.x >= 0 && after.x <= RULES.arenaWidth && after.y >= 0 && after.y <= RULES.arenaHeight);
  }
  stops[0](); players[0].socket.disconnect();
  const disconnected = await waitSnapshot(host, s => !s.players[0].connected);
  const later = await waitSnapshot(host, s => s.tick > disconnected.tick + 8);
  assert.equal(later.players[0].x, disconnected.players[0].x);
  assert.ok(later.players[1].x < disconnected.players[1].x);
  stops.forEach(stop => stop());
  await sleep(INPUT_TIMEOUT_MS + 150);
  const stopped = await waitSnapshot(host, () => true);
  const stable = await waitSnapshot(host, s => s.tick > stopped.tick + 5);
  assert.deepEqual(stable.players.map(p => [p.x, p.y]), stopped.players.map(p => [p.x, p.y]));
});

test('eight clients, room isolation, stale/invalid inputs and snapshot cadence', { timeout: 8000 }, async t => {
  const h = await harness(t);
  const a = await h.room(8);
  const b = await h.room(4);
  const initialB = h.rooms.snapshot(b.created.roomCode);
  const socket = a.players[0].socket;
  success(await socket.timeout(1500).emitWithAck('input:move', { seq: 5, x: 1, y: 0 }));
  assert.equal(errorCode(await socket.timeout(1500).emitWithAck('input:move', { seq: 5, x: -1, y: 0 })), 'STALE_INPUT');
  for (const bad of [null, { seq: 6, x: NaN, y: 0 }, { seq: 6, x: Infinity, y: 0 }, { seq: 6, x: '1', y: 0 }])
    assert.equal(errorCode(await rawAck(socket, 'input:move', bad)), 'INVALID_PAYLOAD');
  const allMoved = waitSnapshot(a.host, s => s.players.every(p => p.y > 205));
  for (const p of a.players) success(await p.socket.timeout(1500).emitWithAck('input:move', { seq: 10, x: 0, y: 1 }));
  const state = await allMoved;
  assert.equal(state.players.length, 8);
  assert.deepEqual(h.rooms.snapshot(b.created.roomCode).players.map(p => [p.x, p.y]), initialB.players.map(p => [p.x, p.y]));
  const samples: Snapshot[] = [];
  const receive = (s: Snapshot) => samples.push(s);
  a.host.on('state:snapshot', receive);
  await sleep(1000);
  a.host.off('state:snapshot', receive);
  assert.ok(samples.length >= 10 && samples.length <= 20, 'roughly 15 snapshots/s, actual=' + samples.length);
  const ticks = samples.at(-1)!.tick - samples[0].tick;
  assert.ok(ticks >= 23 && ticks <= 34, 'roughly 30 simulation ticks/s, actual=' + ticks);
  assert.ok(samples.every(s => s.players.every(p => p.x >= 0 && p.x <= 960 && p.y >= 0 && p.y <= 540)));
  assert.equal(samples.every(s => s.players.length === 8), true);
});

test('closing the server disposes room state and the simulation interval', { timeout: 4000 }, async t => {
  const h = await harness(t);
  await h.room(1);
  h.clients.forEach(client => client.disconnect());
  await new Promise<void>(resolve => h.io.close(() => resolve()));
  assert.equal(h.rooms.rooms.size, 0);
});
