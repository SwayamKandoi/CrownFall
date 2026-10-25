import { GameRoom } from '../../server/GameRoom.js';
import { RULES, PLAYER_COLORS } from '../../shared/constants.js';
import type { GameOptions } from '../../server/GameRoom.js';
import type { PlayerState } from '../../shared/events.js';
export const EPOCH = 1_800_000_000_000;
export const PLAYING = RULES.countdownMs;
export function phase6Fixture(options: GameOptions = {}) {
  let now = 0;
  const players = new Map<string, PlayerState>();
  ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].forEach((id, i) => players.set(id, { id, name: id.toUpperCase(), color: PLAYER_COLORS[i],
    avatar: 'fox', x: i < 2 ? 480 + i * 40 : 700, y: i < 2 ? 270 : 400, score: 0,
    holding: false, connected: true, inDuel: false, wantedId: null }));
  const game = new GameRoom(players, 0, { phase6Enabled: true, random: () => 0, epochNow: () => EPOCH + now, ...options });
  const seq = new Map<string, number>();
  game.start(0);
  const advance = (time: number) => { now = time; game.advance(time); };
  advance(PLAYING);
  return { game, players, advance, get now() { return now; },
    yank(id: string, time = now, ts = EPOCH + time) {
      now = time; const next = (seq.get(id) ?? 0) + 1; seq.set(id, next);
      return game.yank(id, { seq: next, ts }, now);
    },
  };
}
