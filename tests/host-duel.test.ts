import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DuelOverlay } from '../client/host/DuelOverlay.js';
import type { GameEvent, Snapshot } from '../shared/events.js';
import { RoomManager } from '../server/RoomManager.js';
import { success } from './support/socketHarness.js';

test('host duel overlay renders server winners, both timings, fouls and inactivity without deriving a winner', () => {
  const rooms = new RoomManager(() => 0); const room = rooms.create('http://test');
  const a = success(rooms.join(room.roomCode, 'Challenger')), b = success(rooms.join(room.roomCode, 'Holder'));
  const snapshot: Snapshot = rooms.snapshot(room.roomCode);
  snapshot.phase = 'playing'; snapshot.duel = { a: a.playerId, b: b.playerId, stage: 'ready' };
  snapshot.crown.heldBy = b.playerId;
  const render = (result?: GameEvent, fouls: string[] = []) => renderToStaticMarkup(createElement(DuelOverlay, { snapshot, result, fouls }));
  assert.match(render(), /HOLD STILL/); assert.doesNotMatch(render(), /TOO SLOW|ms/);
  snapshot.duel.stage = 'cue'; assert.match(render(), /DRAW!/);
  snapshot.duel.stage = 'done';
  const result: GameEvent = { eventId: 'result', type: 'DUEL_RESULT', actorId: a.playerId, victimId: b.playerId,
    winnerId: b.playerId, points: 2, replay: { a: a.playerId, b: b.playerId, aMs: 100, bMs: 200, frames: [] } };
  assert.match(render(result), /Holder wins!/); // UI trusts the server even when numbers alone suggest otherwise.
  assert.match(render(result), /100 ms/); assert.match(render(result), /200 ms/);
  assert.match(render(result, [a.playerId]), /FOUL/); assert.doesNotMatch(render(result, [a.playerId]), /100 ms/);
  result.winnerId = undefined; result.points = 0; result.replay!.aMs = null; result.replay!.bMs = null;
  assert.match(render(result), /CROWN RETAINED/); assert.equal((render(result).match(/TOO SLOW/g) ?? []).length, 2);
  assert.match(render(result), /no bonus/);
  snapshot.duel = null; assert.equal(render(result), '');
  snapshot.phase = 'ended'; snapshot.duel = { a: a.playerId, b: b.playerId, stage: 'done' };
  assert.equal(render(result), '');
});
