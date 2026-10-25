import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotBuffer } from '../client/host/interpolation.js';
import { RoomManager } from '../server/RoomManager.js';
import { success } from './support/socketHarness.js';

test('renderer interpolates 50 ms behind receipt without predicting and converges when updates stop', () => {
  let now = 0;
  const manager = new RoomManager(() => now);
  const room = manager.create('https://example.test');
  success(manager.join(room.roomCode, 'Aryan'));
  const a = manager.snapshot(room.roomCode);
  const b = structuredClone(a);
  b.tick = 2; b.phase = 'playing'; b.players[0].x += 100; b.players[0].score = 5;
  const buffer = new SnapshotBuffer();
  assert.equal(buffer.sample(0), undefined);
  buffer.push(a, 0); buffer.push(b, 100);
  const halfway = buffer.sample(100)!;
  assert.equal(halfway.players[0].x, a.players[0].x + 50);
  assert.equal(halfway.phase, 'playing');
  assert.equal(halfway.players[0].score, 5);
  assert.equal(buffer.sample(150)!.players[0].x, b.players[0].x);
  assert.equal(buffer.sample(1000)!.players[0].x, b.players[0].x);
  buffer.push(a, 1100); // Older ticks may not rewind the scene.
  assert.equal(buffer.sample(1300)!.tick, 2);
  assert.equal(a.players[0].score, 0);
  buffer.clear();
  assert.equal(buffer.sample(1400), undefined);
});

test('crown follows the interpolated authoritative holder and rematch positions snap to the reset lobby', () => {
  const manager = new RoomManager(() => 0);
  const room = manager.create('http://test');
  const player = success(manager.join(room.roomCode, 'Holder'));
  const a = manager.snapshot(room.roomCode);
  a.phase = 'playing'; a.players[0].holding = true;
  a.crown.heldBy = player.playerId; a.crown.x = a.players[0].x;
  const b = structuredClone(a);
  b.tick = 1; b.players[0].x += 100; b.crown.x += 100; b.players[0].score = 10;
  const buffer = new SnapshotBuffer(); buffer.push(a, 0); buffer.push(b, 100);
  const smoothed = buffer.sample(100)!;
  assert.equal(smoothed.crown.x, a.players[0].x + 50);
  assert.equal(smoothed.crown.heldBy, player.playerId);
  assert.equal(smoothed.players[0].score, 10);
  const dropped = structuredClone(b); dropped.tick++; dropped.crown.heldBy = null; dropped.crown.x = 700;
  buffer.push(dropped, 110);
  assert.equal(buffer.sample(110)!.crown.x, 700, 'a drop uses the server position immediately');
  const ended = structuredClone(dropped); ended.tick++; ended.phase = 'ended'; buffer.push(ended, 120);
  const reset = structuredClone(a); reset.tick = ended.tick; reset.phase = 'lobby'; reset.players[0].x = 180;
  reset.players[0].score = 0; reset.players[0].holding = false; reset.crown = { x: 480, y: 270, heldBy: null, heldMs: 0 };
  buffer.push(reset, 130);
  assert.equal(buffer.sample(130)!.players[0].x, 180);
  assert.equal(buffer.sample(130)!.crown.heldBy, null);
});
