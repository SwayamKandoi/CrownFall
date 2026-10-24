import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotBuffer } from '../client/host/interpolation.js';
import { RoomManager } from '../server/RoomManager.js';
import { success } from './support/socketHarness.js';

test('renderer interpolates positions without predicting authoritative fields and converges when updates stop', () => {
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
  const halfway = buffer.sample(150)!;
  assert.equal(halfway.players[0].x, a.players[0].x + 50);
  assert.equal(halfway.phase, 'playing');
  assert.equal(halfway.players[0].score, 5);
  assert.equal(buffer.sample(1000)!.players[0].x, b.players[0].x);
  buffer.push(a, 1100); // Older ticks may not rewind the scene.
  assert.equal(buffer.sample(1300)!.tick, 2);
  assert.equal(a.players[0].score, 0);
  buffer.clear();
  assert.equal(buffer.sample(1400), undefined);
});
