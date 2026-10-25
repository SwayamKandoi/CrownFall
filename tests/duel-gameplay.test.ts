import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../server/GameRoom.js';
import { RoomManager } from '../server/RoomManager.js';
import { RULES, PLAYER_COLORS } from '../shared/constants.js';
import type { PlayerState } from '../shared/events.js';
import { errorCode, success } from './support/socketHarness.js';

const EPOCH = 1_800_000_000_000;
function fixture(duelsEnabled = true) {
  let now = 0;
  const players = new Map<string, PlayerState>();
  ['a', 'b', 'c', 'd'].forEach((id, i) => players.set(id, { id, name: id, color: PLAYER_COLORS[i],
    x: [480, 520, 700, 800][i], y: 270, score: 0, holding: false, connected: true, inDuel: false, wantedId: null }));
  const game = new GameRoom(players, 0, { duelsEnabled, random: () => 0, epochNow: () => EPOCH + now });
  const sequences = new Map<string, number>();
  const seq = (id: string) => { const next = (sequences.get(id) ?? 0) + 1; sequences.set(id, next); return next; };
  game.start(0); now = 3000; game.advance(now); game.drainEvents();
  return { game, players, seq, get now() { return now; },
    advance: (time: number) => { now = time; game.advance(now); },
    yank: (id: string, time = now, ts = EPOCH + time) => { now = time; return game.yank(id, { seq: seq(id), ts }, now); },
    foul: (id: string, time = now, ts = EPOCH + time) => { now = time; return game.reportDuelFoul(id, { seq: seq(id), ts }, now); },
    disconnect: (id: string, time: number) => { now = time; game.disconnect(id, now); },
  };
}

test('feature-disabled mode preserves direct stealing and rejects the internal foul hook', () => {
  const f = fixture(false); success(f.yank('b'));
  assert.equal(f.game.snapshot(f.now).crown.heldBy, 'b');
  assert.equal(f.players.get('b')!.score, 3);
  assert.equal(f.game.snapshot(f.now).duel, null);
  assert.equal(f.game.phoneDuel('a'), null);
  assert.equal(errorCode(f.foul('a')), 'NOT_IMPLEMENTED');
  assert.deepEqual(f.game.drainEvents().map(e => e.type), ['CROWN_STOLEN']);
});
test('eligible challenge freezes two players only, preserves ownership, and blocks hijacking', () => {
  const f = fixture();
  assert.equal(errorCode(f.yank('c')), 'NOT_READY');
  assert.equal(errorCode(f.yank('a')), 'NOT_READY');
  for (const id of ['a', 'b', 'c', 'd']) success(f.game.move(id, { seq: f.seq(id), x: 1, y: 0 }, f.now));
  success(f.yank('b'));
  assert.deepEqual(f.game.snapshot(f.now).duel, { a: 'b', b: 'a', stage: 'ready' });
  assert.equal(f.game.snapshot(f.now).crown.heldBy, 'a');
  assert.equal(f.players.get('b')!.score, 0);
  assert.equal(f.game.inRange('b'), false);
  assert.equal(f.game.phoneDuel('b')?.stage, 'ready');
  assert.equal(f.game.phoneDuel('c'), null);
  assert.equal(errorCode(f.yank('c')), 'NOT_READY');
  assert.equal(errorCode(f.game.yank('b', { seq: 2, ts: EPOCH + f.now }, f.now)), 'STALE_INPUT');
  f.advance(3100);
  assert.equal(f.players.get('a')!.x, 480); assert.equal(f.players.get('b')!.x, 520);
  assert.ok(f.players.get('c')!.x > 700); assert.ok(f.players.get('d')!.x > 800);
  assert.equal(f.game.drainEvents().filter(e => e.type === 'DUEL_START').length, 1);
});
test('defense scores +2, pauses fractional hold time, and clears frozen input without catch-up', () => {
  const f = fixture(); f.advance(3250);
  for (const id of ['a', 'b']) success(f.game.move(id, { seq: f.seq(id), x: 1, y: 0 }, f.now));
  success(f.yank('b')); const before = f.game.snapshot(f.now);
  f.advance(4250);
  success(f.yank('b', 4700, EPOCH + 4550));
  success(f.yank('a', 4800, EPOCH + 4450));
  f.advance(6000);
  assert.equal(f.players.get('a')!.score, 2);
  assert.equal(f.game.snapshot(f.now).crown.heldMs, before.crown.heldMs);
  assert.ok([...f.players.values()].every(p => !p.inDuel));
  assert.equal(f.game.phoneDuel('a')?.won, true);
  assert.equal(f.game.snapshot(f.now).duel?.stage, 'done');
  assert.equal(f.game.drainEvents().filter(e => e.type === 'CROWN_STOLEN').length, 0);
  f.advance(6250);
  assert.equal(f.players.get('a')!.score, 3, 'only the remaining 250ms accrues after defense');
  assert.equal(f.players.get('a')!.x, before.players[0].x, 'old movement cannot resume');
  success(f.game.move('a', { seq: f.seq('a'), x: 1, y: 0 }, f.now)); f.advance(6350);
  assert.ok(f.players.get('a')!.x > before.players[0].x, 'new movement resumes during DONE');
});
test('timestamp validation, early yanks, late pre-cue packets and internal stillness fouls', () => {
  const f = fixture(); success(f.yank('b'));
  for (const payload of [null, {}, { seq: -1, ts: EPOCH }, { seq: 0.1, ts: EPOCH }, { seq: 5, ts: NaN },
    { seq: 5, ts: Infinity }, { seq: 5, ts: 'time' }, { seq: 5, ts: EPOCH + 3000, playerId: 'a' }])
    assert.equal(errorCode(f.game.yank('b', payload, f.now)), 'INVALID_PAYLOAD');
  assert.equal(errorCode(f.yank('b', 3100, EPOCH + 2099)), 'STALE_INPUT');
  assert.equal(errorCode(f.yank('b', 3200, EPOCH + 3351)), 'STALE_INPUT');
  assert.equal(errorCode(f.yank('b', 3300, EPOCH + 2999)), 'STALE_INPUT', 'predates this duel');
  assert.equal(errorCode(f.foul('outsider', 3300)), 'UNAUTHORIZED');
  assert.equal(errorCode(f.foul('c', 3300)), 'NOT_READY');
  assert.equal(errorCode(f.game.reportDuelFoul('a', { seq: 1, ts: NaN }, f.now)), 'INVALID_PAYLOAD');
  assert.equal(errorCode(f.foul('a', 3400, EPOCH + 1000)), 'STALE_INPUT');
  assert.equal(errorCode(f.foul('a', 3400, EPOCH + 3600)), 'STALE_INPUT');
  f.advance(4000);
  success(f.yank('b', 4100, EPOCH + 3990));
  assert.equal(f.game.phoneDuel('b')?.foul, true, 'pre-cue timestamp remains a foul despite late receipt');
  success(f.foul('a', 4200, EPOCH + 3900));
  assert.equal(errorCode(f.foul('a', 4200, EPOCH + 3900)), 'STALE_INPUT');
  f.advance(5750);
  assert.ok([...f.players.values()].every(p => p.score === 0));
  assert.equal(f.game.snapshot(f.now).crown.heldBy, 'a');
  assert.equal(f.game.drainEvents().filter(e => e.type === 'DUEL_FOUL').length, 2);
});
test('one valid response steals +3; immunity and cooldown block subsequent challenges', () => {
  const f = fixture(); success(f.yank('b')); f.advance(4000);
  success(f.game.move('b', { seq: 100, x: 0, y: 0 }, 4000));
  success(f.yank('b', 4200)); // Reaction seq 2 is allowed after movement seq 100.
  assert.equal(errorCode(f.yank('b', 4250)), 'STALE_INPUT', 'second reaction with a fresh seq is still rejected');
  f.advance(5750);
  assert.equal(f.game.snapshot(f.now).crown.heldBy, 'b'); assert.equal(f.players.get('b')!.score, 3);
  const output = f.game.drainEvents();
  assert.deepEqual(output.slice(-2).map(e => e.type), ['CROWN_STOLEN', 'DUEL_RESULT']);
  f.advance(6750); // DONE clears after 1s; immunity continues for another 1s.
  f.players.get('c')!.x = 550;
  assert.equal(errorCode(f.yank('c', 6800)), 'NOT_READY');
  assert.equal(f.game.inRange('c', 7750), false, 'blocked attempt starts challenger cooldown');
  assert.equal(errorCode(f.yank('c', 7750)), 'NOT_READY');
  success(f.yank('c', 9300)); assert.equal(f.game.snapshot(f.now).duel?.stage, 'ready');
});
test('no response awards no defense bonus and resumes ordinary possession scoring', () => {
  const f = fixture(); success(f.yank('b')); f.advance(4000); f.advance(5750);
  const result = f.game.drainEvents().find(e => e.type === 'DUEL_RESULT')!;
  assert.equal(result.points, 0); assert.equal(result.winnerId, undefined);
  assert.equal(f.players.get('a')!.score, 0);
  f.advance(6250); assert.equal(f.players.get('a')!.score, 1);
});
test('challenger and holder disconnects cancel during READY or CUE with no automatic awards', () => {
  for (const stage of ['ready', 'cue']) for (const id of ['a', 'b']) {
    const f = fixture(); success(f.yank('b'));
    const time = stage === 'ready' ? 3500 : 4500;
    if (stage === 'cue') f.advance(4000);
    f.disconnect(id, time);
    assert.equal(f.game.snapshot(time).duel, null);
    assert.ok([...f.players.values()].every(p => !p.inDuel && p.score === 0));
    const results = f.game.drainEvents().filter(e => e.type === 'DUEL_RESULT');
    assert.equal(results.length, 1); assert.equal(results[0].points, 0);
    if (id === 'a') {
      f.advance(time + 1999); assert.equal(f.game.snapshot(f.now).crown.heldBy, 'a');
      f.advance(time + 2000); assert.equal(f.game.snapshot(f.now).crown.heldBy, null);
    } else {
      f.advance(time + 500); assert.equal(f.game.snapshot(f.now).crown.heldBy, 'a');
      assert.equal(f.players.get('a')!.score, 1);
    }
    assert.equal(f.players.size, 4);
  }
});
test('round deadline cancels READY and CUE, preserves scores once, and rematch clears duel state', () => {
  for (const begin of [90000, 92500]) {
    const f = fixture(); f.advance(begin); const score = f.players.get('a')!.score;
    success(f.yank('b'));
    if (begin === 90000) { f.advance(91000); success(f.yank('b', 91100)); }
    // A stalled loop reaching the match deadline cancels even if a response was already present.
    f.advance(93000);
    assert.equal(f.game.phase, 'ended'); assert.equal(f.game.snapshot(f.now).duel, null);
    assert.equal(f.players.get('a')!.score, score); assert.equal(f.players.get('b')!.score, 0);
    assert.ok([...f.players.values()].every(p => !p.inDuel));
    assert.equal(f.game.drainEnded().length, 1);
    assert.equal(errorCode(f.yank('b', 93100)), 'INVALID_PHASE');
    assert.equal(f.game.drainEnded().length, 0);
    f.game.reset(93100);
    assert.equal(f.game.snapshot(93100).duel, null);
    assert.ok(f.game.drainEvents().every(e => !e.type.startsWith('DUEL_')));
    assert.ok([...f.players.values()].every(p => p.score === 0 && !p.inDuel));
  }
  const active = fixture(); success(active.yank('b')); active.game.reset(3200);
  assert.equal(active.game.snapshot(3200).duel, null);
  assert.ok([...active.players.values()].every(p => !p.inDuel));
});
test('ten consecutive duels resolve once each without state leakage or earlier packet replay', () => {
  const f = fixture(); const resultIds = new Set<string>();
  let start = 3000, holder = 'a';
  for (let i = 0; i < 10; i++) {
    const challenger = holder === 'a' ? 'b' : 'a';
    f.advance(start); success(f.yank(challenger));
    f.advance(start + 1000);
    success(f.yank(holder, start + 1350, EPOCH + start + 1300));
    success(f.yank(challenger, start + 1400, EPOCH + start + 1100));
    f.advance(start + 2750);
    const events = f.game.drainEvents(); const results = events.filter(e => e.type === 'DUEL_RESULT');
    assert.equal(results.length, 1); assert.equal(results[0].winnerId, challenger); assert.equal(results[0].points, 3);
    resultIds.add(results[0].eventId);
    assert.equal(events.filter(e => e.type === 'CROWN_STOLEN').length, 1);
    assert.equal(f.game.snapshot(f.now).crown.heldBy, challenger);
    assert.ok([...f.players.values()].every(p => !p.inDuel));
    assert.equal([...f.players.values()].filter(p => p.holding).length, 1);
    f.advance(start + 4750); assert.equal(f.game.snapshot(f.now).duel, null);
    assert.equal(errorCode(f.yank(holder, f.now, EPOCH + start + 1100)), 'STALE_INPUT');
    holder = challenger; start += 4750;
  }
  assert.equal(resultIds.size, 10); assert.equal(f.game.phase, 'playing');
});
test('room isolation and empty-room disposal clear active duels without affecting other rooms', () => {
  let now = 0;
  const manager = new RoomManager(() => now, 100, { duelsEnabled: true, random: () => 0, epochNow: () => EPOCH + now });
  const a = manager.create('http://test'), b = manager.create('http://test');
  const ids = [0, 1].map(i => success(manager.join(a.roomCode, 'P' + i)).playerId);
  for (const id of ids) success(manager.ready(a.roomCode, id));
  success(manager.start(a.roomCode, a.hostToken));
  const room = manager.rooms.get(a.roomCode)!;
  room.players.get(ids[0])!.x = 480; room.players.get(ids[0])!.y = 270;
  room.players.get(ids[1])!.x = 520; room.players.get(ids[1])!.y = 270;
  now = 3000; manager.advance();
  success(room.game.yank(ids[1], { seq: 1, ts: EPOCH + now }, now));
  assert.equal(manager.snapshot(b.roomCode).duel, null);
  assert.equal(manager.snapshot(b.roomCode).phase, 'lobby');
  for (const id of ids) manager.disconnect(a.roomCode, id);
  manager.disconnect(a.roomCode); now += 100; manager.advance();
  assert.equal(manager.rooms.has(a.roomCode), false);
  assert.equal(room.game.snapshot(now).duel, null);
  assert.deepEqual(room.game.drainEvents(), []);
  assert.equal(manager.rooms.has(b.roomCode), true);
});
