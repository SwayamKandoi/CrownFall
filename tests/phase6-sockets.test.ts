import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GameEvent, PhoneState } from '../shared/events.js';
import { EPOCH } from './support/phase6Fixture.js';
import { harness, sleep, success, waitSnapshot } from './support/socketHarness.js';

for (const duelsEnabled of [false, true]) test(`Phase 6 eight sockets: Wanted, gems, finale, rematch and isolation (duels=${duelsEnabled})`, { timeout: 15000 }, async t => {
  let now = 0;
  const h = await harness(t, { phase6Enabled: true, duelsEnabled, random: () => 0, now: () => now, epochNow: () => EPOCH + now });
  const a = await h.room(8), other = await h.room(2);
  const events: GameEvent[] = [], phone: (PhoneState | undefined)[] = [];
  a.host.on('game:event', e => events.push(e));
  a.players.forEach((p, i) => p.socket.on('phone:state', state => { phone[i] = state; }));
  const room = h.rooms.rooms.get(a.created.roomCode)!;
  const ids = a.players.map(p => p.identity.playerId);
  ids.forEach((id, i) => Object.assign(room.players.get(id)!, { x: i < 2 ? 480 + 40 * i : 700, y: i < 2 ? 270 : 400 }));
  for (const p of a.players) success(await p.socket.timeout(1500).emitWithAck('player:ready', { calibrated: true }));
  success(await a.host.timeout(1500).emitWithAck('host:start', { hostToken: a.created.hostToken }));
  let update = waitSnapshot(a.host, s => s.phase === 'playing'); now = 18000; await update;
  success(await a.players[1].socket.timeout(1500).emitWithAck('input:yank', { seq: 1, ts: EPOCH + now }));
  if (duelsEnabled) {
    update = waitSnapshot(a.host, s => s.duel?.stage === 'cue'); now = 19000; await update;
    now = 19100; success(await a.players[1].socket.timeout(1500).emitWithAck('input:yank', { seq: 2, ts: EPOCH + now }));
  }
  update = waitSnapshot(a.host, s => s.crown.heldBy === ids[1]);
  now = duelsEnabled ? 20750 : 18050; await update; await sleep(30);
  assert.equal(phone[0]?.wantedName, 'Player 1'); assert.ok(phone.slice(1).every(p => p?.wantedName === null));
  update = waitSnapshot(a.host, s => Boolean(s.gem)); now = 28000; const spawned = await update;
  Object.assign(room.players.get(ids[2])!, { x: spawned.gem!.x, y: spawned.gem!.y });
  update = waitSnapshot(a.host, s => s.gem === null && s.players[2].score === 5); now = 28050; await update;
  update = waitSnapshot(a.host, s => s.players[0].wantedId === null); now = duelsEnabled ? 32750 : 30000; await update; await sleep(30);
  assert.equal(phone[0]?.wantedName, null);
  update = waitSnapshot(a.host, s => s.lastStand); now = 78000; await update;
  update = waitSnapshot(a.host, s => s.arenaScale <= 0.85); now = 85500; await update;
  update = waitSnapshot(a.host, s => s.phase === 'ended'); now = 93000; const ended = await update; await sleep(30);
  assert.equal(ended.players.length, 8); assert.equal(ended.lastStand, false);
  assert.equal(events.filter(e => e.type === 'LAST_STAND').length, 1);
  assert.ok(events.some(e => e.type === 'GEM_TAKEN' && e.points === 5));
  assert.equal(h.rooms.snapshot(other.created.roomCode).phase, 'lobby');
  assert.equal(h.rooms.snapshot(other.created.roomCode).gem, null);
  update = waitSnapshot(a.host, s => s.phase === 'lobby');
  success(await a.host.timeout(1500).emitWithAck('host:start', { hostToken: a.created.hostToken }));
  const reset = await update; await sleep(30);
  assert.equal(reset.gem, null); assert.equal(reset.arenaScale, 1); assert.equal(reset.duel, null);
  assert.ok(reset.players.every(p => p.wantedId === null && p.score === 0));
  assert.ok(phone.every(p => p?.wantedName === null));
});
