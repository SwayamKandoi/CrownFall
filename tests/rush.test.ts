import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../server/GameRoom.js';
import { RULES, PLAYER_COLORS } from '../shared/constants.js';
import type { PlayerState, PhoneState } from '../shared/events.js';
import { errorCode, harness, success, waitSnapshot } from './support/socketHarness.js';

const EPOCH = 1_800_000_000_000;
const START = 7000; // A round need not start at the server clock's origin.
const PLAYING = START + RULES.countdownMs;
const UNLOCK = PLAYING + RULES.rushMs;
function fixture(duelsEnabled: boolean) {
  const players = new Map<string, PlayerState>();
  ['a', 'b', 'c', 'd'].forEach((id, i) => players.set(id, { id, name: id, color: PLAYER_COLORS[i],
    x: [480, 520, 700, 800][i], y: 270, score: 0, holding: false, connected: true, inDuel: false, wantedId: null }));
  const game = new GameRoom(players, START, { duelsEnabled, random: () => 0 });
  const yank = (id: string, seq: number, now: number, ts = EPOCH + now) => game.yank(id, { seq, ts }, now, EPOCH + now);
  game.start(START);
  return { game, players, yank };
}

for (const duelsEnabled of [false, true]) {
  const mode = duelsEnabled ? 'duels' : 'direct steals';
  for (const after of [0, 1]) test(`Rush (${mode}): blocks before and unlocks ${after ? 'after' : 'exactly at'} 15 active seconds`, () => {
    const { game, players, yank } = fixture(duelsEnabled);
    game.advance(PLAYING - 1);
    assert.equal(game.phase, 'countdown');
    assert.equal(game.snapshot(PLAYING - 1).remainingMs, 1);
    assert.equal(game.snapshot(PLAYING - 1).crown.heldBy, null);
    assert.equal(errorCode(yank('b', 1, PLAYING - 1)), 'INVALID_PHASE');
    game.advance(PLAYING);
    assert.equal(game.phase, 'playing');
    assert.equal(game.snapshot(PLAYING).remainingMs, RULES.roundMs);
    assert.equal(game.snapshot(PLAYING).crown.heldBy, 'a', 'pickup is available immediately');
    for (const id of players.keys()) {
      assert.equal(game.inRange(id), false);
      assert.equal(errorCode(yank(id, 1, PLAYING)), 'NOT_READY');
      success(game.move(id, { seq: 1, x: 1, y: 0 }, PLAYING));
    }
    const before = game.snapshot(PLAYING);
    game.advance(PLAYING + 100);
    assert.ok(game.snapshot(PLAYING + 100).players.every((p, i) => p.x > before.players[i].x), 'all four players move during Rush');
    game.advance(PLAYING + RULES.holdPointMs);
    assert.equal(players.get('a')!.score, 1, 'possession scores during Rush');
    game.advance(UNLOCK - 1);
    assert.equal(game.snapshot(UNLOCK - 1).remainingMs, RULES.roundMs - RULES.rushMs + 1);
    assert.equal(game.snapshot(UNLOCK - 1).crown.heldMs, RULES.rushMs - 1);
    for (const id of players.keys()) {
      assert.equal(game.inRange(id), false);
      assert.equal(errorCode(yank(id, 2, UNLOCK - 1)), 'NOT_READY');
    }
    assert.equal(game.snapshot(UNLOCK - 1).duel, null);
    assert.deepEqual(game.drainEvents().map(e => e.type), ['CROWN_PICKUP']);
    const now = UNLOCK + after;
    game.advance(now);
    assert.equal(game.inRange('b'), true, 'unlock uses elapsed playing time, not a separate timer');
    assert.equal(players.get('a')!.score, RULES.rushMs / RULES.holdPointMs);
    success(yank('b', 3, now));
    assert.equal(game.snapshot(now).crown.heldBy, duelsEnabled ? 'a' : 'b');
    assert.equal(game.snapshot(now).duel?.stage, duelsEnabled ? 'ready' : undefined);
    assert.equal(players.get('b')!.score, duelsEnabled ? 0 : RULES.stealPoints);
  });

  test(`Rush (${mode}): validation, replay history, no rejected-attempt cooldown, and fresh Rush on rematch`, () => {
    const { game, players, yank } = fixture(duelsEnabled);
    game.advance(UNLOCK - 1);
    assert.equal(errorCode(game.yank('b', { seq: 10, ts: NaN }, UNLOCK - 1, EPOCH + UNLOCK - 1)), 'INVALID_PAYLOAD');
    assert.equal(errorCode(yank('b', 10, UNLOCK - 1, EPOCH + UNLOCK - 1002)), 'STALE_INPUT');
    assert.equal(errorCode(yank('b', 10, UNLOCK - 1, EPOCH + UNLOCK + 150)), 'STALE_INPUT');
    assert.equal(errorCode(yank('b', 10, UNLOCK - 1, EPOCH + UNLOCK)), 'NOT_READY', 'future-tolerant timestamp cannot bypass monotonic Rush');
    assert.equal(errorCode(yank('b', 10, UNLOCK)), 'STALE_INPUT', 'Rush rejection consumes the action sequence');
    success(yank('b', 11, UNLOCK)); // No cooldown from the Rush rejection.
    const end = PLAYING + RULES.roundMs;
    game.advance(end);
    assert.equal(game.phase, 'ended');
    assert.equal(game.drainEnded().length, 1);
    game.reset(end); game.start(end);
    const nextPlaying = end + RULES.countdownMs;
    Object.assign(players.get('a')!, { x: 480, y: 270 });
    Object.assign(players.get('b')!, { x: 520, y: 270 });
    game.advance(nextPlaying);
    assert.equal(errorCode(yank('b', 11, nextPlaying)), 'STALE_INPUT', 'rematch retains replay history');
    assert.equal(errorCode(yank('b', 12, nextPlaying + RULES.rushMs - 1)), 'NOT_READY');
    assert.equal(game.inRange('b'), false);
    success(yank('b', 13, nextPlaying + RULES.rushMs));
  });

  test(`Rush (${mode}): four actual sockets receive false eligibility until the boundary`, { timeout: 10000 }, async t => {
    let now = START;
    const h = await harness(t, { duelsEnabled, random: () => 0, now: () => now, epochNow: () => EPOCH + now });
    const { host, created, players } = await h.room(4);
    const room = h.rooms.rooms.get(created.roomCode)!;
    players.forEach((p, i) => Object.assign(room.players.get(p.identity.playerId)!, { x: 480 + i * 40, y: 270 }));
    for (const p of players) success(await p.socket.timeout(1500).emitWithAck('player:ready', { calibrated: true }));
    success(await host.timeout(1500).emitWithAck('host:start', { hostToken: created.hostToken }));
    const phones = players.map(p => new Promise<PhoneState>(resolve => {
      p.socket.on('phone:state', function receive(state) {
        if (state.phase === 'playing') { p.socket.off('phone:state', receive); resolve(state); }
      });
    }));
    now = UNLOCK - 50; // Leave a full snapshot tick before checking the exact unlock boundary.
    assert.ok((await Promise.all(phones)).every(p => !p.inRange));
    assert.equal(errorCode(await players[1].socket.timeout(1500).emitWithAck('input:yank', { seq: 1, ts: EPOCH + now })), 'NOT_READY');
    const eligible = new Promise<PhoneState>(resolve => players[1].socket.on('phone:state', function receive(state) {
      if (state.inRange) { players[1].socket.off('phone:state', receive); resolve(state); }
    }));
    now = UNLOCK;
    assert.equal((await eligible).inRange, true);
    const changed = waitSnapshot(host, s => duelsEnabled ? s.duel?.stage === 'ready' : s.crown.heldBy === players[1].identity.playerId);
    success(await players[1].socket.timeout(1500).emitWithAck('input:yank', { seq: 2, ts: EPOCH + now }));
    await changed;
  });
}
