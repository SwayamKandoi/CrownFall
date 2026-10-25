import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../server/GameRoom.js';
import { RoomManager } from '../server/RoomManager.js';
import { RULES, PLAYER_COLORS } from '../shared/constants.js';
import type { GameEnded, GameEvent, PhoneState, PlayerState } from '../shared/events.js';
import { errorCode, harness, rawAck, sleep, success, waitSnapshot } from './support/socketHarness.js';

const EPOCH = 1_800_000_000_000;
function fixture() {
  const players = new Map<string, PlayerState>();
  ['a', 'b', 'c', 'd'].forEach((id, i) => players.set(id, { id, name: id, color: PLAYER_COLORS[i],
    x: 480 + i * 40, y: 270, score: 0, holding: false, connected: true, ready: true, inDuel: false, wantedId: null }));
  const game = new GameRoom(players, 0);
  game.start(0); game.advance(3000);
  const yank = (id: string, seq: number, now = 3000, ts = EPOCH + now) => game.yank(id, { seq, ts }, now, EPOCH + now);
  return { players, game, yank };
}

test('yank validates phase, identity, shape, epoch, range and per-event replay history', () => {
  const { game, players, yank } = fixture();
  assert.equal(game.inRange('a'), false);
  assert.equal(game.inRange('b'), true);
  assert.equal(game.inRange('d'), false);
  const before = game.snapshot(3000);
  assert.equal(errorCode(yank('unknown', 1)), 'UNAUTHORIZED');
  for (const payload of [null, {}, { seq: -1, ts: EPOCH }, { seq: 1.5, ts: EPOCH }, { seq: 1, ts: NaN },
    { seq: 1, ts: Infinity }, { seq: 1, ts: '3000' }, { seq: 1, ts: EPOCH, playerId: 'a' }])
    assert.equal(errorCode(game.yank('b', payload, 3000, EPOCH + 3000)), 'INVALID_PAYLOAD');
  assert.equal(errorCode(yank('b', 1, 3000, EPOCH + 1999)), 'STALE_INPUT');
  assert.equal(errorCode(yank('b', 1, 3000, EPOCH + 3151)), 'STALE_INPUT');
  assert.equal(errorCode(yank('d', 1)), 'NOT_READY');
  assert.equal(errorCode(yank('a', 1)), 'NOT_READY');
  assert.deepEqual(game.snapshot(3000), before, 'invalid attempts leave scores and ownership unchanged');
  success(game.move('b', { seq: 100, x: 0, y: 0 }, 3000));
  success(yank('b', 50)); // A reliable yank may arrive behind a newer volatile movement packet.
  assert.equal(players.get('b')!.score, RULES.stealPoints);
  assert.equal(game.snapshot(3000).crown.heldBy, 'b');
  assert.equal(errorCode(yank('b', 50)), 'STALE_INPUT');
  assert.equal(errorCode(yank('b', 49)), 'STALE_INPUT');
  assert.equal(errorCode(game.move('b', { seq: 99, x: 1, y: 0 }, 3000)), 'STALE_INPUT');
  const stolen = game.drainEvents().filter(e => e.type === 'CROWN_STOLEN');
  assert.equal(stolen.length, 1);
  assert.equal(stolen[0].victimId, 'a');
  assert.equal(stolen[0].points, 3);
  game.reset(3000);
  assert.equal(errorCode(yank('b', 51)), 'INVALID_PHASE');
  assert.equal(game.inRange('c'), false);
});

test('first simultaneous yank wins; immunity and challenger cooldown use monotonic deadlines', () => {
  const { game, players, yank } = fixture();
  success(yank('b', 10));
  assert.equal(game.inRange('c', 3000), false);
  assert.equal(errorCode(yank('c', 20)), 'NOT_READY');
  assert.equal(game.snapshot(3000).crown.heldBy, 'b');
  assert.equal(players.get('c')!.score, 0);
  assert.equal(game.inRange('a', 4999), false);
  assert.equal(game.inRange('a', 5000), true);
  assert.equal(game.inRange('c', 5000), false, 'failed in-range challenge cools down for 2500ms');
  assert.equal(errorCode(yank('c', 21, 5499)), 'NOT_READY');
  success(yank('c', 22, 5500));
  assert.equal(game.snapshot(5500).crown.heldBy, 'c');
  assert.equal([...players.values()].filter(p => p.holding).length, 1);
  assert.equal(game.drainEvents().filter(e => e.type === 'CROWN_STOLEN').length, 2);
  game.disconnect('c', 5500);
  assert.equal(game.inRange('b', 8000), false, 'disconnected holders cannot be challenged');
});

test('round deadline caps scoring, stops inputs, ranks ties and queues one immutable result', () => {
  const { game, players, yank } = fixture();
  game.advance(92999);
  assert.equal(game.snapshot(92999).remainingMs, 1);
  assert.equal(players.get('a')!.score, 179);
  const x = players.get('a')!.x;
  assert.equal(errorCode(game.move('a', { seq: 1, x: 1, y: 0 }, 93000)), 'INVALID_PHASE');
  assert.equal(errorCode(yank('b', 1, 93000)), 'INVALID_PHASE');
  game.advance(190000);
  assert.equal(game.phase, 'ended');
  assert.equal(game.snapshot(190000).remainingMs, 0);
  assert.equal(players.get('a')!.score, 180);
  assert.equal(players.get('a')!.x, x);
  const results = game.drainEnded();
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].winnerIds, ['a']);
  assert.equal(results[0].scores[0].score, 180);
  game.advance(200000); assert.deepEqual(game.drainEnded(), []);
  game.reset(200000);
  assert.equal(results[0].scores[0].score, 180, 'reset cannot mutate the broadcast result');
  game.start(200000); game.advance(293000);
  assert.deepEqual(game.drainEnded()[0].winnerIds, ['a', 'b', 'c', 'd'], 'zero-score ties include every player');
});

test('authorized rematch resets gameplay, preserves identities and cleans old offline players only in lobby', () => {
  let now = 0;
  const rooms = new RoomManager(() => now);
  const created = rooms.create('http://test');
  const joined = [0, 1, 2, 3].map(i => success(rooms.join(created.roomCode, 'P' + i)));
  for (const p of joined) success(rooms.ready(created.roomCode, p.playerId));
  success(rooms.start(created.roomCode, created.hostToken));
  const room = rooms.rooms.get(created.roomCode)!;
  now = 3000; rooms.advance();
  rooms.disconnect(created.roomCode, joined[3].playerId);
  now = 93000; rooms.advance();
  assert.equal(room.players.size, 4);
  assert.equal(errorCode(rooms.start(created.roomCode, 'wrong')), 'UNAUTHORIZED');
  success(rooms.start(created.roomCode, created.hostToken));
  assert.equal(room.game.phase, 'lobby');
  assert.equal(room.game.snapshot(now).crown.heldBy, null);
  assert.equal(room.game.snapshot(now).remainingMs, 90000);
  assert.ok([...room.players.values()].every(p => p.score === 0 && !p.ready && !p.holding));
  assert.deepEqual([...room.players.keys()], joined.map(p => p.playerId));
  assert.equal(errorCode(rooms.start(created.roomCode, created.hostToken)), 'NOT_READY');
  now += 2000; rooms.advance();
  assert.equal(room.players.size, 3);
  const replacement = success(rooms.join(created.roomCode, 'Replacement'));
  assert.equal(replacement.color, joined[3].color);
});

test('real Socket.IO: four phones complete pickup, scoring, steals, results and rematch in isolated rooms', { timeout: 10000 }, async t => {
  let now = 0;
  const h = await harness(t, { now: () => now, epochNow: () => EPOCH + now });
  const a = await h.room(4), b = await h.room(2);
  const events: GameEvent[] = [], ended: GameEnded[] = [];
  const phones: (PhoneState | undefined)[] = [];
  a.host.on('game:event', event => events.push(event));
  a.host.on('game:ended', result => ended.push(result));
  a.players.forEach((p, i) => p.socket.on('phone:state', state => { phones[i] = state; }));
  const room = h.rooms.rooms.get(a.created.roomCode)!;
  const ids = a.players.map(p => p.identity.playerId);
  for (const p of a.players) success(await p.socket.timeout(1500).emitWithAck('player:ready', { calibrated: true }));
  success(await a.host.timeout(1500).emitWithAck('host:start', { hostToken: a.created.hostToken }));
  // Deterministic starting positions; all gameplay actions below use real sockets.
  ids.forEach((id, i) => { room.players.get(id)!.x = 480 + i * 40; room.players.get(id)!.y = 270; });
  let next = waitSnapshot(a.host, s => s.phase === 'playing'); now = 3000; await next;
  await sleep(30);
  assert.equal(phones[0]?.holding, true); assert.equal(phones[1]?.inRange, true); assert.equal(phones[3]?.inRange, false);
  next = waitSnapshot(a.host, s => s.players[0].score === 1); now = 3500; await next;
  assert.equal(errorCode(await rawAck(a.host, 'input:yank', { seq: 1, ts: EPOCH + now })), 'UNAUTHORIZED');
  success(await a.players[1].socket.timeout(1500).emitWithAck('input:move', { seq: 100, x: 0, y: 0 }));
  next = waitSnapshot(a.host, s => s.crown.heldBy === ids[1]);
  success(await a.players[1].socket.timeout(1500).emitWithAck('input:yank', { seq: 50, ts: EPOCH + now }));
  await next;
  assert.equal(errorCode(await rawAck(a.players[1].socket, 'input:yank', { seq: 50, ts: EPOCH + now })), 'STALE_INPUT');
  assert.equal(errorCode(await rawAck(a.players[2].socket, 'input:yank', { seq: 1, ts: EPOCH + now })), 'NOT_READY');
  await sleep(30);
  assert.equal(phones[0]?.inRange, false); assert.equal(phones[1]?.holding, true);
  assert.equal(events.filter(e => e.type === 'CROWN_PICKUP').length, 1);
  assert.equal(events.filter(e => e.type === 'CROWN_STOLEN').length, 1);
  next = waitSnapshot(a.host, s => s.phase === 'ended'); now = 93000; await next; await sleep(40);
  assert.equal(ended.length, 1); assert.deepEqual(ended[0].winnerIds, [ids[1]]);
  assert.equal(ended[0].scores[0].score, 182); // 89.5s possession + 3 steal points.
  assert.equal(h.rooms.snapshot(b.created.roomCode).phase, 'lobby');
  assert.ok(h.rooms.snapshot(b.created.roomCode).players.every(p => p.score === 0 && !p.holding));
  next = waitSnapshot(a.host, s => s.phase === 'lobby');
  success(await a.host.timeout(1500).emitWithAck('host:start', { hostToken: a.created.hostToken }));
  const reset = await next; await sleep(30);
  assert.ok(reset.players.every(p => p.connected && p.score === 0 && !p.holding && !p.ready));
  assert.ok(phones.every(p => p?.phase === 'lobby'));
  assert.ok(a.players.every(p => p.socket.connected));
  for (const p of a.players) success(await p.socket.timeout(1500).emitWithAck('player:ready', { calibrated: true }));
  success(await a.host.timeout(1500).emitWithAck('host:start', { hostToken: a.created.hostToken }));
  next = waitSnapshot(a.host, s => s.phase === 'playing'); now = 96000; await next;
  assert.equal(errorCode(await rawAck(a.players[1].socket, 'input:yank', { seq: 50, ts: EPOCH + now })), 'STALE_INPUT');
  next = waitSnapshot(a.host, s => s.phase === 'ended'); now = 186000; await next; await sleep(50);
  assert.equal(ended.length, 2); assert.equal(ended[1].winnerIds.length, 4);
});
