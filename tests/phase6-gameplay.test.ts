import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES } from '../shared/constants.js';
import { arenaBounds, GEM_PICKUP_RADIUS } from '../server/phase6.js';
import { possessionPoints, earnedPoints } from '../server/scoring.js';
import { phase6Fixture, PLAYING, EPOCH } from './support/phase6Fixture.js';
import { success } from './support/socketHarness.js';

test('Phase 6 disabled preserves direct steals, neutral state and normal possession scoring', () => {
  const f = phase6Fixture({ phase6Enabled: false });
  success(f.yank('b', 18000)); success(f.yank('a', 20500));
  assert.equal(f.game.drainEvents().filter(e => e.type === 'CROWN_STOLEN').at(-1)?.points, 3);
  assert.equal(f.game.wantedName('b'), null);
  f.advance(78000); const s = f.game.snapshot(f.now);
  assert.equal(s.lastStand, false); assert.equal(s.arenaScale, 1); assert.equal(s.gem, null);
  assert.ok([...f.players.values()].every(p => p.wantedId === null));
  const before = f.players.get('a')!.score; f.advance(78500);
  assert.equal(f.players.get('a')!.score - before, 1);
});

for (const delay of [11999, 12000, 12001]) test(`Wanted expires strictly at 12 seconds: transfer after ${delay}ms`, () => {
  const f = phase6Fixture(); success(f.yank('b', 18000));
  assert.equal(f.players.get('a')!.wantedId, 'b'); assert.equal(f.game.wantedName('a'), 'B');
  assert.equal(f.game.wantedName('c'), null);
  const before = f.players.get('a')!.score;
  success(f.yank('a', 18000 + delay));
  assert.equal(f.players.get('a')!.score - before, delay < 12000 ? 6 : 3);
  assert.equal(f.players.get('a')!.wantedId, null);
  assert.equal(f.players.get('b')!.wantedId, 'a');
  const events = f.game.drainEvents();
  assert.equal(events.filter(e => e.type === 'REVENGE').length, delay < 12000 ? 1 : 0);
  assert.equal(events.filter(e => e.type === 'CROWN_STOLEN').at(-1)?.points, delay < 12000 ? 6 : 3);
});

test('Wanted cannot be claimed against the wrong holder and clears on disconnect/removal/reset', () => {
  const f = phase6Fixture(); success(f.yank('b', 18000));
  Object.assign(f.players.get('c')!, { x: 540, y: 270 });
  success(f.yank('c', 20500)); success(f.yank('a', 23000));
  assert.equal(f.game.drainEvents().filter(e => e.type === 'CROWN_STOLEN').at(-1)?.points, 3);
  assert.equal(f.players.get('a')!.wantedId, 'b');
  f.game.disconnect('b', f.now); assert.equal(f.players.get('a')!.wantedId, null);
  f.game.removePlayer('a'); assert.equal(f.players.get('c')!.wantedId, null);
  f.game.reset(f.now); assert.ok([...f.players.values()].every(p => p.wantedId === null));
});

test('duel revenge is decided only on successful transfer, with the original expiry deadline', () => {
  for (const resolveDelay of [11999, 12000, 13000]) {
    const f = phase6Fixture({ duelsEnabled: true });
    success(f.yank('b', 18000)); f.advance(19000); success(f.yank('b', 19100)); f.advance(20750);
    assert.equal(f.players.get('a')!.wantedId, 'b');
    const resolve = 20750 + resolveDelay;
    success(f.yank('a', resolve - 2750));
    assert.equal(f.players.get('a')!.wantedId, 'b', 'initiation does not consume Wanted');
    f.advance(resolve - 1750); success(f.yank('a', resolve - 1650));
    const before = f.players.get('a')!.score; f.advance(resolve);
    assert.equal(f.players.get('a')!.score - before, resolveDelay < 12000 ? 6 : 3);
    const events = f.game.drainEvents();
    assert.equal(events.filter(e => e.type === 'DUEL_RESULT').at(-1)?.points, resolveDelay < 12000 ? 6 : 3);
  }
});

test('failed revenge duel and cancellation do not claim revenge', () => {
  for (const cancel of [false, true]) {
    const f = phase6Fixture({ duelsEnabled: true });
    success(f.yank('b', 18000)); f.advance(19000); success(f.yank('b', 19100)); f.advance(20750);
    success(f.yank('a', 23000));
    if (cancel) f.game.disconnect('a', 23500);
    else { success(f.yank('a', 23100)); f.advance(24000); f.advance(25750); }
    assert.equal(f.game.snapshot(f.now).crown.heldBy, 'b');
    assert.equal(f.game.drainEvents().filter(e => e.type === 'REVENGE').length, 0);
  }
});

test('gems follow 25/50/75-second schedule and expire exactly eight seconds later', () => {
  const f = phase6Fixture({ random: () => 1 });
  for (const elapsed of [25000, 50000, 75000]) {
    const at = PLAYING + elapsed;
    f.advance(at - 1); assert.equal(f.game.snapshot(f.now).gem, null);
    f.advance(at); const gem = f.game.snapshot(f.now).gem!;
    assert.ok(gem); assert.equal(gem.expiresMs, 8000);
    const bounds = arenaBounds(f.game.snapshot(f.now).arenaScale, GEM_PICKUP_RADIUS);
    assert.ok(gem.x >= bounds.left && gem.x <= bounds.right && gem.y >= bounds.top && gem.y <= bounds.bottom);
    f.advance(at + 7999); assert.equal(f.game.snapshot(f.now).gem?.expiresMs, 1);
    f.advance(at + 8000); assert.equal(f.game.snapshot(f.now).gem, null);
  }
  assert.equal(f.game.drainEvents().filter(e => e.type === 'GEM_SPAWN').length, 3);
});

test('simultaneous gem pickup uses distance then stable ID, awards once and doubles in Last Stand', () => {
  for (const at of [28000, 78000]) {
    const f = phase6Fixture(); f.advance(at);
    const gem = f.game.snapshot(f.now).gem!;
    for (const id of ['d', 'c']) Object.assign(f.players.get(id)!, { x: gem.x, y: gem.y });
    f.players.get('e')!.connected = false; Object.assign(f.players.get('e')!, { x: gem.x, y: gem.y });
    f.advance(at + 40); f.advance(at + 100);
    const taken = f.game.drainEvents().filter(e => e.type === 'GEM_TAKEN');
    assert.equal(taken.length, 1); assert.equal(taken[0].actorId, 'c');
    assert.equal(taken[0].points, at === 78000 ? 10 : 5);
    assert.equal(f.players.get('c')!.score, taken[0].points);
    assert.equal(f.players.get('d')!.score, 0); assert.equal(f.game.snapshot(f.now).gem, null);
  }
});

test('late updates skip expired gems, preserve live expiry, and reset clears gem state', () => {
  const f = phase6Fixture(); f.advance(40000);
  assert.equal(f.game.snapshot(f.now).gem, null);
  assert.equal(f.game.drainEvents().filter(e => e.type === 'GEM_SPAWN').length, 0);
  f.advance(55000); assert.equal(f.game.snapshot(f.now).gem?.expiresMs, 6000);
  f.game.reset(f.now); assert.equal(f.game.snapshot(f.now).gem, null);
});

test('Last Stand starts once at 75s, shrinks all eight players/entities and ends at the deadline', () => {
  const f = phase6Fixture({ random: () => 1 });
  f.advance(77999); assert.equal(f.game.snapshot(f.now).lastStand, false);
  f.advance(78000); assert.equal(f.game.snapshot(f.now).lastStand, true);
  assert.equal(f.game.snapshot(f.now).arenaScale, 1);
  for (const p of f.players.values()) { p.x = 950; p.y = 530; }
  f.players.get('h')!.connected = false;
  f.advance(85500);
  assert.equal(f.game.snapshot(f.now).arenaScale, 0.85);
  const bounds = arenaBounds(0.85);
  assert.ok([...f.players.values()].every(p => p.x <= bounds.right && p.y <= bounds.bottom));
  assert.equal(f.game.snapshot(f.now).crown.x, f.players.get('a')!.x);
  f.advance(93000);
  assert.equal(f.game.phase, 'ended'); assert.equal(f.game.snapshot(f.now).lastStand, false);
  assert.equal(f.game.snapshot(f.now).arenaScale, 0.7);
  assert.equal(f.game.drainEvents().filter(e => e.type === 'LAST_STAND').length, 1);
  f.advance(95000); assert.equal(f.game.drainEvents().length, 0);
  f.game.reset(f.now); assert.equal(f.game.snapshot(f.now).arenaScale, 1);
});

test('scoring thresholds crossing Last Stand are doubled only when earned, even on delayed updates', () => {
  assert.equal(possessionPoints(0, 90000, PLAYING, PLAYING, true), 211);
  assert.equal(possessionPoints(0, 90000, PLAYING, PLAYING, false), 180);
  assert.equal(possessionPoints(250, 1000, 77500, PLAYING, true), 3);
  assert.equal(earnedPoints(6, 78000, PLAYING, true), 12);
  const f = phase6Fixture(); f.advance(77999); assert.equal(f.players.get('a')!.score, 149);
  f.advance(78000); assert.equal(f.players.get('a')!.score, 151);
  f.advance(93000); assert.equal(f.players.get('a')!.score, 211);
  assert.equal(f.game.drainEnded()[0].scores[0].score, 211);
});

test('Last Stand revenge awards +12 total and defense +4, with matching result/event points', () => {
  const f = phase6Fixture(); success(f.yank('b', 76000));
  const before = f.players.get('a')!.score; success(f.yank('a', 78500));
  assert.equal(f.players.get('a')!.score - before, 12);
  assert.equal(f.game.drainEvents().find(e => e.type === 'REVENGE')?.points, 12);
  const d = phase6Fixture({ duelsEnabled: true }); success(d.yank('b', 77500));
  d.advance(78500); success(d.yank('a', 78600)); const score = d.players.get('a')!.score;
  d.advance(80250); assert.equal(d.players.get('a')!.score - score, 4);
  assert.equal(d.game.drainEvents().find(e => e.type === 'DUEL_RESULT')?.points, 4);
});

test('duelists and disconnected players are clamped during contraction; rooms remain isolated', () => {
  const f = phase6Fixture({ duelsEnabled: true }), other = phase6Fixture();
  for (const id of ['a', 'b']) Object.assign(f.players.get(id)!, { x: 940, y: 520 });
  success(f.yank('b', 78000)); f.advance(79000);
  const bounds = arenaBounds(f.game.snapshot(f.now).arenaScale);
  assert.ok(['a', 'b'].every(id => f.players.get(id)!.x <= bounds.right && f.players.get(id)!.inDuel));
  assert.equal(other.game.snapshot(other.now).arenaScale, 1);
  assert.equal(other.game.snapshot(other.now).gem, null);
  f.game.dispose(); assert.equal(f.game.snapshot(f.now).gem, null);
  assert.ok([...f.players.values()].every(p => p.wantedId === null && !p.inDuel));
});
