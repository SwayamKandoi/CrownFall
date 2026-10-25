import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCode, harness, rawAck, success, waitSnapshot } from './support/socketHarness.js';

test('avatars: join stores a valid pick, defaults when absent, rejects unknown ids', async t => {
  const h = await harness(t);
  const { host, created } = await h.room(0);
  const a = await h.connect();
  success(await a.timeout(1500).emitWithAck('room:join', { roomCode: created.roomCode, name: 'Fox fan', avatar: 'robot' }));
  const b = await h.connect();
  success(await b.timeout(1500).emitWithAck('room:join', { roomCode: created.roomCode, name: 'No pick' }));
  const c = await h.connect();
  assert.equal(errorCode(await rawAck(c, 'room:join', { roomCode: created.roomCode, name: 'Hacker', avatar: '<script>' })), 'INVALID_PAYLOAD');
  const snap = await waitSnapshot(host, s => s.players.length === 2);
  assert.deepEqual(snap.players.map(p => p.avatar).sort(), ['fox', 'robot']);
});

test('resume: a returning phone keeps its identity, score and color; stale or foreign tokens fail', async t => {
  const h = await harness(t);
  const { host, created, players } = await h.room(2);
  const [first] = players;
  first.socket.disconnect();
  await waitSnapshot(host, s => s.players.some(p => p.id === first.identity.playerId && !p.connected));
  const again = await h.connect();
  const resumed = success(await again.timeout(1500).emitWithAck('room:resume', { roomCode: created.roomCode, resumeToken: first.identity.resumeToken }));
  assert.equal(resumed.playerId, first.identity.playerId);
  assert.equal(resumed.color, first.identity.color);
  const back = await waitSnapshot(host, s => s.players.some(p => p.id === first.identity.playerId && p.connected));
  assert.equal(back.players.length, 2, 'no duplicate player was created');
  const stranger = await h.connect();
  assert.equal(errorCode(await rawAck(stranger, 'room:resume', { roomCode: created.roomCode, resumeToken: 'f'.repeat(64) })), 'UNAUTHORIZED');
  // A second device with the same token takes over the seat instead of duplicating it.
  const takeover = await h.connect();
  success(await takeover.timeout(1500).emitWithAck('room:resume', { roomCode: created.roomCode, resumeToken: first.identity.resumeToken }));
  await new Promise(r => setTimeout(r, 150));
  assert.equal(again.connected, false, 'the older socket is disconnected');
  const snap = await waitSnapshot(host, s => s.players.length === 2);
  assert.ok(snap.players.find(p => p.id === first.identity.playerId)?.connected);
});

test('resume: a player dropped from the lobby after the grace period cannot resume', async t => {
  const h = await harness(t);
  const { host, created, players } = await h.room(2);
  players[0].socket.disconnect();
  await waitSnapshot(host, s => s.players.length === 1, 5000);
  const again = await h.connect();
  assert.equal(errorCode(await rawAck(again, 'room:resume', { roomCode: created.roomCode, resumeToken: players[0].identity.resumeToken })), 'UNAUTHORIZED');
});

test('taunt: emits TAUNT, rate-limits, rejects replays and bad payloads', async t => {
  const h = await harness(t);
  const { host, created, players } = await h.room(2);
  void created;
  const got: string[] = [];
  host.on('game:event', e => { if (e.type === 'TAUNT') got.push(e.actorId ?? ''); });
  const me = players[0];
  success(await me.socket.timeout(1500).emitWithAck('input:taunt', { seq: 1 }));
  assert.equal(errorCode(await me.socket.timeout(1500).emitWithAck('input:taunt', { seq: 2 })), 'RATE_LIMITED');
  assert.equal(errorCode(await me.socket.timeout(1500).emitWithAck('input:taunt', { seq: 2 })), 'STALE_INPUT');
  assert.equal(errorCode(await rawAck(me.socket, 'input:taunt', { seq: 'x' })), 'INVALID_PAYLOAD');
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(got, [me.identity.playerId]);
});
