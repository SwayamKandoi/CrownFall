import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { PLAYER_COLORS, RULES } from '../shared/constants.js';
import type { ActionError, CreateResult, JoinResult, PlayerState, Snapshot } from '../shared/events.js';
import { GameRoom } from './GameRoom.js';

export interface Room {
  code: string; hostToken: string; players: Map<string, PlayerState>;
  game: GameRoom; hostConnected: boolean; lastOccupiedAt: number;
  lobbyDisconnects: Map<string, number>;
}
export const failure = (code: ActionError['error']['code'], message: string): ActionError => ({ error: { code, message } });
export const OK = { ok: true } as const;
export class RoomManager {
  readonly rooms = new Map<string, Room>();
  constructor(private now = () => performance.now(), private emptyTtlMs = 60_000) {}
  create(origin: string): CreateResult {
    let code: string;
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    do { code = Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (this.rooms.has(code));
    const hostToken = randomBytes(32).toString('hex');
    const players = new Map<string, PlayerState>();
    this.rooms.set(code, { code, hostToken, players, game: new GameRoom(players, this.now()), hostConnected: true, lastOccupiedAt: this.now(), lobbyDisconnects: new Map() });
    return { roomCode: code, hostToken, joinUrl: origin + '/play/' + code };
  }
  join(code: string, name: string): JoinResult | ActionError {
    const room = this.rooms.get(code);
    if (!room) return failure('ROOM_NOT_FOUND', 'Room does not exist.');
    if (room.game.phase !== 'lobby') return failure('INVALID_PHASE', 'Joining is only available in the lobby.');
    if (room.players.size >= RULES.maxPlayers) return failure('ROOM_FULL', 'Room has eight players.');
    const id = randomUUID();
    const usedColors = new Set([...room.players.values()].map(player => player.color));
    const slot = PLAYER_COLORS.findIndex(color => !usedColors.has(color));
    const color = PLAYER_COLORS[slot];
    room.players.set(id, { id, name, color, x: 180 + slot % 4 * 200, y: slot < 4 ? 180 : 360,
      score: 0, holding: false, connected: true, inDuel: false, wantedId: null, ready: false });
    room.lastOccupiedAt = this.now();
    return { playerId: id, resumeToken: randomBytes(32).toString('hex'), color };
  }
  ready(code: string, id: string): typeof OK | ActionError {
    const room = this.rooms.get(code);
    const player = room?.players.get(id);
    if (!player?.connected) return failure('UNAUTHORIZED', 'Join as a player first.');
    if (room!.game.phase !== 'lobby') return failure('INVALID_PHASE', 'Readiness is only available in the lobby.');
    player.ready = true;
    return OK;
  }
  start(code: string, token: string): typeof OK | ActionError {
    const room = this.rooms.get(code);
    const supplied = Buffer.from(token);
    const expected = Buffer.from(room?.hostToken ?? '');
    if (!room || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return failure('UNAUTHORIZED', 'Invalid host token.');
    if (room.game.phase !== 'lobby') return failure('INVALID_PHASE', 'This room has already started.');
    if ([...room.players.values()].filter(p => p.connected && p.ready).length < RULES.minPlayers)
      return failure('NOT_READY', `At least ${RULES.minPlayers} connected, calibrated players are required.`);
    room.game.start(this.now());
    return OK;
  }
  disconnect(code: string, id?: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    if (id) {
      room.game.disconnect(id, this.now());
      const player = room.players.get(id);
      if (player) {
        player.connected = false; player.ready = false;
        if (room.game.phase === 'lobby' && !room.lobbyDisconnects.has(id)) room.lobbyDisconnects.set(id, this.now());
      }
    } else room.hostConnected = false;
    room.lastOccupiedAt = this.now();
  }
  advance(): string[] {
    const changed: string[] = [];
    const now = this.now();
    for (const room of this.rooms.values()) {
      const phase = room.game.phase;
      room.game.advance(now);
      let rosterChanged = false;
      if (room.game.phase === 'lobby') {
        for (const [id, disconnectedAt] of room.lobbyDisconnects) {
          const player = room.players.get(id);
          if (!player || player.connected) room.lobbyDisconnects.delete(id);
          else if (now - disconnectedAt >= RULES.disconnectDropMs) {
            room.game.removePlayer(id);
            room.lobbyDisconnects.delete(id);
            rosterChanged = true;
          }
        }
      } else {
        // A start during the grace period must preserve the complete active-game roster.
        room.lobbyDisconnects.clear();
      }
      if (phase !== room.game.phase || rosterChanged) changed.push(room.code);
      if (room.hostConnected || [...room.players.values()].some(p => p.connected)) room.lastOccupiedAt = now;
      else if (now - room.lastOccupiedAt >= this.emptyTtlMs) { room.game.dispose(); this.rooms.delete(room.code); }
    }
    return changed;
  }
  snapshot(code: string): Snapshot {
    const room = this.rooms.get(code)!;
    return room.game.snapshot(this.now());
  }
  dispose(): void { for (const room of this.rooms.values()) room.game.dispose(); this.rooms.clear(); }
}
