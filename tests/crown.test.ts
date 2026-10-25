import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../server/GameRoom.js';
import { holderSpeed } from '../server/scoring.js';
import { RULES } from '../shared/constants.js';
import type { PlayerState } from '../shared/events.js';
import { success } from './support/socketHarness.js';

export function crownFixture() {
  const players = new Map<string, PlayerState>();
  for (const [id, x] of [['b', 480], ['a', 480], ['c', 700], ['d', 800]] as const)
    players.set(id, { id, name: id, color: '#ffffff', x, y: 270, score: 0, holding: false, connected: true, inDuel: false, wantedId: null });
  return { players, game: new GameRoom(players, 0) };
}

test('crown pickup is active-only, deterministic, unique and follows its holder', () => {
  const { game, players } = crownFixture();
  game.advance(100);
  assert.equal(game.snapshot(100).crown.heldBy, null);
  game.start(100); game.advance(3099);
  assert.equal(game.snapshot(3099).crown.heldBy, null);
  game.advance(3100);
  assert.equal(game.snapshot(3100).crown.heldBy, 'a', 'equal distance uses stable id, not insertion order');
  assert.equal([...players.values()].filter(p => p.holding).length, 1);
  assert.deepEqual(game.drainEvents().map(e => e.type), ['CROWN_PICKUP']);
  success(game.move('a', { seq: 1, x: 1, y: 0 }, 3100)); game.advance(3200);
  assert.equal(game.snapshot(3200).crown.x, players.get('a')!.x);
  assert.deepEqual(game.drainEvents(), []);
  const nearest = crownFixture();
  nearest.players.get('a')!.x = 500;
  nearest.game.start(0); nearest.game.advance(3000);
  assert.equal(nearest.game.snapshot(3000).crown.heldBy, 'b');
});

test('hold points follow 500 ms of monotonic possession, independent of snapshots and bounded physics', () => {
  const { game, players } = crownFixture();
  game.start(0); game.advance(3000); game.advance(3499);
  assert.equal(players.get('a')!.score, 0);
  game.advance(3500);
  assert.equal(players.get('a')!.score, 1);
  for (let i = 0; i < 100; i++) game.snapshot(4000);
  assert.equal(players.get('a')!.score, 1, 'snapshot reads never score');
  game.advance(13000);
  assert.equal(players.get('a')!.score, 20);
  game.advance(13000);
  assert.equal(players.get('a')!.score, 20, 'same clock cannot score twice');
});

test('holder slowdown respects existing speed constants and minimum', () => {
  assert.equal(holderSpeed(0), RULES.holderSpeed);
  assert.equal(holderSpeed(5000), RULES.holderSpeed - RULES.holderSlowdown * 5);
  assert.equal(holderSpeed(90000), RULES.holderMinSpeed);
  const { game, players } = crownFixture();
  game.start(0); game.advance(3000);
  for (const id of ['a', 'c']) success(game.move(id, { seq: 1, x: 1, y: 0 }, 3000));
  game.advance(3200);
  assert.ok(players.get('a')!.x - 480 < players.get('c')!.x - 700);
  const regularDistance = players.get('c')!.x - 700;
  assert.ok(regularDistance >= 35 && regularDistance <= 42, 'normal speed within one fixed-step boundary');
});

test('disconnected holder stops scoring immediately and drops exactly after the grace period', () => {
  const { game, players } = crownFixture();
  players.get('b')!.x = 100;
  game.start(0); game.advance(3000);
  game.disconnect('a', 3750);
  assert.equal(players.get('a')!.score, 1);
  assert.equal(players.get('a')!.connected, false);
  game.advance(5749);
  assert.equal(game.snapshot(5749).crown.heldBy, 'a');
  game.advance(5750);
  assert.equal(game.snapshot(5750).crown.heldBy, null);
  assert.equal(players.get('a')!.holding, false);
  game.advance(8000);
  assert.equal(players.get('a')!.score, 1);
  assert.equal(game.drainEvents().filter(e => e.type === 'CROWN_DROPPED').length, 1);
  assert.equal(players.size, 4, 'active-game roster remains intact');
});
