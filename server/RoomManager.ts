import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { PLAYER_COLORS, RULES } from '../shared/constants.js';
import type { ActionError, CreateResult, JoinResult, PlayerState, Snapshot } from '../shared/events.js';
export interface Room { code: string; hostToken: string; players: Map<string, PlayerState>; createdAt: number }
export const failure = (code: ActionError['error']['code'], message: string): ActionError => ({ error: { code, message } });
export class RoomManager {
  readonly rooms = new Map<string, Room>();
  create(origin: string): CreateResult {
    let code: string;
    do { code = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join(''); } while (this.rooms.has(code));
    const hostToken = randomBytes(32).toString('hex');
    this.rooms.set(code, { code, hostToken, players: new Map(), createdAt: Date.now() });
    return { roomCode: code, hostToken, joinUrl: `${origin}/play/${code}` };
  }
  join(roomCode: string, name: string): JoinResult | ActionError {
    const room = this.rooms.get(roomCode);
    if (!room) return failure('ROOM_NOT_FOUND', 'Room does not exist.');
    if (room.players.size >= RULES.maxPlayers) return failure('ROOM_FULL', 'Room has eight players.');
    const id = randomUUID();
    const color = PLAYER_COLORS[room.players.size];
    room.players.set(id, { id, name, color, x: 480, y: 270, score: 0, holding: false, connected: true, inDuel: false, wantedId: null });
    return { playerId: id, resumeToken: randomBytes(32).toString('hex'), color };
  }
  snapshot(code: string): Snapshot {
    return { tick: 0, phase: 'lobby', remainingMs: RULES.roundMs, lastStand: false, arenaScale: 1,
      crown: { x: 480, y: 270, heldBy: null, heldMs: 0 }, gem: null, duel: null,
      players: [...this.rooms.get(code)!.players.values()] };
  }
}
