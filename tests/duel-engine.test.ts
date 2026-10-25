import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DuelEngine, DUEL_RECEIVE_GRACE_MS, DUEL_RESULT_MS } from '../server/duel.js';
import { RULES } from '../shared/constants.js';
import { errorCode, success } from './support/socketHarness.js';

const EPOCH = 1_800_000_000_000;
function fixture(random = 0) {
  const duel = new DuelEngine(() => random);
  assert.equal(duel.start('challenger', 'holder', 0, EPOCH), true);
  const cueAt = RULES.duelReadyMinMs + Math.floor(random * (RULES.duelReadyMaxMs - RULES.duelReadyMinMs));
  const finishAt = cueAt + RULES.duelTimeoutMs + DUEL_RECEIVE_GRACE_MS;
  return { duel, cueAt, finishAt, advance: (now: number) => duel.advance(now, EPOCH + now),
    react: (id: string, ts: number, receive = ts) => duel.reaction(id, EPOCH + ts, receive, EPOCH + receive) };
}
test('duel READY is bounded, hides its schedule and issues exactly one non-backdated cue', () => {
  for (const random of [0, 0.5, 1]) {
    const { duel, cueAt, advance } = fixture(random);
    assert.ok(cueAt >= 1000 && cueAt <= 2500);
    assert.deepEqual(duel.snapshot(), { a: 'challenger', b: 'holder', stage: 'ready' });
    const initial = duel.drainEvents();
    assert.deepEqual(initial.map(e => e.type), ['DUEL_START', 'DUEL_READY']);
    assert.ok(initial.every(e => e.cueAt === undefined));
    advance(cueAt - 1); assert.equal(duel.snapshot()?.stage, 'ready');
    advance(cueAt + 20); advance(cueAt + 25);
    const cues = duel.drainEvents(); assert.equal(cues.length, 1);
    assert.equal(cues[0].cueAt, EPOCH + cueAt + 20);
    assert.equal(duel.start('third', 'holder', cueAt, EPOCH + cueAt), false);
  }
});
test('reaction timestamps decide after the bounded receive grace, regardless of arrival order', () => {
  const { duel, advance, react, finishAt } = fixture();
  advance(1000);
  success(react('holder', 1400, 1450));
  success(react('challenger', 1200, 1600));
  assert.equal(advance(finishAt - 1), null);
  const result = advance(finishAt)!;
  assert.equal(result.winnerId, 'challenger'); assert.equal(result.points, 3);
  assert.deepEqual(result.event.replay, { a: 'challenger', b: 'holder', aMs: 200, bMs: 400, frames: [] });
  assert.equal(advance(finishAt), null, 'cannot resolve twice');
  assert.equal(duel.phone('challenger')?.won, true);
  assert.equal(duel.phone('spectator'), null);
  advance(finishAt + DUEL_RESULT_MS); assert.equal(duel.snapshot(), null);
});
test('duel outcome matrix: defense, single responses, inactivity, fouls and stable ties', () => {
  const cases: { a?: number; b?: number; winner?: string; points: number }[] = [
    { a: 1300, b: 1100, winner: 'holder', points: 2 },
    { a: 1200, winner: 'challenger', points: 3 }, { b: 1200, winner: 'holder', points: 2 },
    { points: 0 }, { a: 900, b: 900, points: 0 },
    { a: 900, winner: 'holder', points: 2 }, { b: 900, winner: 'challenger', points: 3 },
    { a: 1200, b: 1200, winner: 'challenger', points: 3 },
  ];
  for (const expected of cases) {
    const { duel, advance, react, finishAt } = fixture();
    advance(1000);
    if (expected.a !== undefined) success(react('challenger', expected.a, Math.max(1001, expected.a)));
    if (expected.b !== undefined) success(react('holder', expected.b, Math.max(1001, expected.b)));
    const result = advance(finishAt)!;
    assert.equal(result.winnerId, expected.winner, JSON.stringify(expected));
    assert.equal(result.points, expected.points);
    assert.equal(result.holderId, expected.winner ?? 'holder');
    assert.equal(duel.active, false);
  }
});
test('early yanks, delayed stillness fouls and duplicate responses cannot become valid reactions', () => {
  const { duel, react, advance, finishAt } = fixture();
  success(react('challenger', 500));
  assert.equal(duel.phone('challenger')?.foul, true);
  advance(1000);
  assert.equal(errorCode(react('challenger', 1100)), 'STALE_INPUT');
  success(react('holder', 1200));
  success(duel.reportFoul('holder', EPOCH + 950, 1300, EPOCH + 1300));
  assert.equal(duel.drainEvents().filter(e => e.type === 'DUEL_FOUL').length, 2);
  assert.equal(advance(finishAt)!.points, 0);
});
test('duel bounds exclude previous-session reports, outsiders and late reactions', () => {
  const { duel, advance, react, finishAt } = fixture();
  assert.equal(errorCode(react('challenger', -1, 100)), 'STALE_INPUT');
  assert.equal(errorCode(react('outsider', 100)), 'NOT_READY');
  advance(1000);
  assert.equal(errorCode(duel.reportFoul('holder', EPOCH + 1100, 1100, EPOCH + 1100)), 'INVALID_PHASE');
  assert.equal(errorCode(react('holder', 2501, 2600)), 'STALE_INPUT');
  assert.equal(errorCode(react('holder', 2400, finishAt)), 'STALE_INPUT');
  success(react('holder', 2500, finishAt - 1));
  assert.equal(errorCode(react('holder', 2500, finishAt - 1)), 'STALE_INPUT');
  assert.equal(advance(finishAt)!.points, 2);
  assert.equal(errorCode(react('challenger', 2500, finishAt)), 'INVALID_PHASE');
});
test('cancellation emits no winning award and clearing removes all session state and output', () => {
  const { duel } = fixture();
  duel.cancel(EPOCH + 100);
  const result = duel.drainEvents().find(e => e.type === 'DUEL_RESULT')!;
  assert.equal(result.winnerId, undefined); assert.equal(result.points, 0);
  assert.equal(duel.snapshot(), null);
  duel.cancel(EPOCH + 200); assert.deepEqual(duel.drainEvents(), []);
  duel.start('a', 'b', 1000, EPOCH + 1000); duel.clear();
  assert.equal(duel.busy, false); assert.deepEqual(duel.drainEvents(), []);
});
