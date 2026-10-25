import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { RoundHighlights, MAX_HISTORY_FRAMES } from '../server/highlights.js';
import { roundStats } from '../client/host/roundStatistics.js';
import { RoundStats } from '../client/host/RoundStats.js';
import { replayPosition } from '../client/host/ReplayPanel.js';
import type { GameEvent } from '../shared/events.js';
import { phase6Fixture } from './support/phase6Fixture.js';
import { success } from './support/socketHarness.js';

test('replay history stays within two seconds and 21 samples, copies positions and keeps participant IDs/timings', () => {
  const f = phase6Fixture(), history = new RoundHighlights();
  for (let now = 0; now <= 10000; now += 10) { f.players.get('b')!.x = now / 100; history.capture(now, f.players.values()); }
  history.beginDuel('b', 'a', 10000);
  f.players.get('b')!.x = -1;
  const result: GameEvent = { eventId: 'result', type: 'DUEL_RESULT', winnerId: 'b', reactionMs: 100, replay: { a: 'b', b: 'a', aMs: 100, bMs: 200, frames: [] } };
  const replay = history.completed(result)!.replay!;
  assert.equal(replay.frames.length, MAX_HISTORY_FRAMES);
  assert.equal(replay.frames[0].t, 0); assert.equal(replay.frames.at(-1)!.t, 2000);
  assert.equal(replay.frames[0].ax, 80); assert.equal(replay.frames.at(-1)!.ax, 100);
  assert.equal(replay.a, 'b'); assert.equal(replay.b, 'a'); assert.equal(replay.aMs, 100);
  assert.equal(history.completed(result), undefined, 'one replay per completed capture');
  history.beginDuel('a', 'b', 20000); assert.equal(history.completed({ ...result, replay: { ...result.replay!, a: 'a', b: 'b' } }), undefined, 'stale history never invents a chase');
  history.clear(); history.beginDuel('b', 'a', 10000); assert.equal(history.completed(result), undefined);
});

test('completed duel emits authoritative approach replay once without scoring again; cancellation and rematch clear it', () => {
  for (const cancel of [false, true]) {
    const f = phase6Fixture({ duelsEnabled: true });
    for (let now = 16000; now <= 18000; now += 100) {
      f.advance(now); success(f.game.move('b', { seq: now, x: -0.1, y: 0 }, now));
    }
    success(f.yank('b'));
    if (cancel) f.game.disconnect('b', 18500);
    else { f.advance(19000); success(f.yank('b', 19150)); f.advance(20750); }
    const events = f.game.drainEvents(), replay = events.filter(e => e.type === 'DUEL_REPLAY');
    assert.equal(replay.length, cancel ? 0 : 1);
    if (!cancel) {
      assert.equal(replay[0].replay?.aMs, 150); assert.equal(replay[0].replay?.bMs, null);
      assert.notEqual(replay[0].replay!.frames[0].ax, replay[0].replay!.frames.at(-1)!.ax);
      assert.equal(f.players.get('b')!.score, 3);
      assert.ok(events.findIndex(e => e.type === 'DUEL_RESULT') < events.findIndex(e => e.type === 'DUEL_REPLAY'));
    }
    f.game.reset(f.now); assert.ok(f.game.drainEvents().every(e => e.type !== 'DUEL_REPLAY'));
    f.game.dispose(); assert.equal(f.game.drainEvents().length, 0);
  }
});

test('Play of the Game prefers revenge, emits once before results, and never invents an empty highlight', () => {
  const f = phase6Fixture(); success(f.yank('b', 18000)); success(f.yank('a', 20500));
  f.advance(93000); const events = f.game.drainEvents();
  const potg = events.filter(e => e.type === 'PLAY_OF_GAME');
  assert.equal(potg.length, 1); assert.equal(potg[0].actorId, 'a'); assert.equal(potg[0].points, 6);
  assert.equal(f.game.drainEnded().length, 1);
  f.advance(94000); assert.equal(f.game.drainEvents().length, 0);
  f.game.reset(94000); f.game.start(94000); f.advance(187000);
  assert.equal(f.game.drainEvents().filter(e => e.type === 'PLAY_OF_GAME').length, 0);
  const off = phase6Fixture({ phase6Enabled: false }); success(off.yank('b', 18000)); off.advance(93000);
  assert.equal(off.game.drainEvents().filter(e => e.type === 'PLAY_OF_GAME').length, 0);
});

test('highlight ranking uses evidenced Last Stand lead changes, fastest wins, value and stable IDs', () => {
  const f = phase6Fixture(), history = new RoundHighlights();
  const event = (id: string, type: GameEvent['type'], actorId: string, points: number, reactionMs?: number): GameEvent => ({ eventId: id, type, actorId, victimId: 'h', points, serverTime: 1, reactionMs,
    ...(type === 'DUEL_RESULT' ? { winnerId: actorId } : {}) });
  history.record(event('steal', 'CROWN_STOLEN', 'b', 3), f.players.values());
  history.record(event('draw', 'DUEL_RESULT', 'c', 2, 150), f.players.values());
  history.record(event('draw2', 'DUEL_RESULT', 'b', 2, 150), f.players.values());
  assert.equal(history.playOfGame()?.actorId, 'b');
  history.record({ eventId: 'ls', type: 'LAST_STAND' }, f.players.values());
  f.players.get('a')!.score = 12; f.players.get('b')!.score = 10;
  history.record(event('comeback', 'GEM_TAKEN', 'a', 10), f.players.values());
  assert.equal(history.playOfGame()?.actorId, 'a');
  history.record(event('revenge', 'REVENGE', 'c', 6), f.players.values());
  assert.equal(history.playOfGame()?.actorId, 'c');
  history.clear(); assert.equal(history.playOfGame(), undefined);
});

test('host statistics deduplicate events, use stable ties and omit invented data', () => {
  const events: GameEvent[] = [
    { eventId: '1', type: 'CROWN_STOLEN', actorId: 'a', victimId: 'b', points: 3 },
    { eventId: '2', type: 'CROWN_STOLEN', actorId: 'b', victimId: 'a', points: 6 },
    { eventId: '3', type: 'REVENGE', actorId: 'b', victimId: 'a', points: 6 },
    { eventId: '4', type: 'DUEL_RESULT', winnerId: 'b', reactionMs: 140 },
    { eventId: '5', type: 'DUEL_RESULT', winnerId: 'a', reactionMs: 140 },
    { eventId: '6', type: 'DUEL_RESULT', reactionMs: 20 },
  ];
  const stats = roundStats([...events, events[0]]);
  assert.deepEqual(stats.mostWanted, { id: 'a', count: 1 });
  assert.deepEqual(stats.nemesis, { a: 'a', b: 'b', count: 2 });
  assert.deepEqual(stats.fastest, { id: 'a', ms: 140 });
  const empty = renderToStaticMarkup(createElement(RoundStats, { events: [], players: [] }));
  assert.match(empty, /No qualifying play/); assert.match(empty, /No winning draw/);
  const frames = [{ t: 0, ax: 0, ay: 0, bx: 100, by: 100 }, { t: 1000, ax: 100, ay: 100, bx: 200, by: 200 }];
  assert.deepEqual(replayPosition(frames, 500), { ax: 50, ay: 50, bx: 150, by: 150 });
  assert.equal(replayPosition(frames, 9000)?.ax, 100);
});
