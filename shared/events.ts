// v0 proposal: success payloads stay flat; failures use { error: { code, message } }.
export type Phase = 'lobby' | 'countdown' | 'playing' | 'ended';
export interface PlayerState {
  id: string; name: string; color: string; x: number; y: number; score: number;
  holding: boolean; connected: boolean; inDuel: boolean; wantedId: string | null;
}
export interface Snapshot {
  tick: number; phase: Phase; remainingMs: number; lastStand: boolean; arenaScale: number;
  crown: { x: number; y: number; heldBy: string | null; heldMs: number };
  gem: null | { x: number; y: number; expiresMs: number };
  duel: null | { a: string; b: string; stage: 'ready' | 'cue' | 'done' };
  players: PlayerState[];
}
export interface PhoneState {
  phase: Phase; holding: boolean; score: number; inRange: boolean; wantedName: string | null;
  duel: null | { stage: 'ready' | 'cue' | 'done'; won?: boolean; foul?: boolean };
}
export interface MoveInput { seq: number; x: number; y: number }
export interface YankInput { seq: number; ts: number }
export interface DuelReplay {
  a: string; b: string; aMs: number | null; bMs: number | null;
  frames: { t: number; ax: number; ay: number; bx: number; by: number }[];
}
export type GameEventType = 'CROWN_PICKUP' | 'CROWN_STOLEN' | 'DUEL_START' | 'DUEL_READY' | 'DUEL_CUE' | 'DUEL_RESULT' | 'DUEL_FOUL' | 'REVENGE' | 'CROWN_DROPPED' | 'LAST_STAND' | 'GEM_SPAWN' | 'GEM_TAKEN' | 'TAUNT' | 'DUEL_REPLAY' | 'PLAY_OF_GAME' | 'PLAYER_LEFT' | 'PLAYER_BACK';
export interface GameEvent {
  eventId: string; type: GameEventType; actorId?: string; victimId?: string; points?: number;
  serverTime?: number; cueAt?: number; winnerId?: string; reactionMs?: number;
  replay?: DuelReplay; x?: number; y?: number;
}
export interface GameEnded { scores: { playerId: string; name: string; score: number }[]; winnerIds: string[] }
export type ErrorCode = 'INVALID_PAYLOAD' | 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'ALREADY_JOINED' | 'UNAUTHORIZED' | 'NOT_READY' | 'INVALID_PHASE' | 'RATE_LIMITED' | 'STALE_INPUT' | 'NOT_IMPLEMENTED';
export interface ActionError { error: { code: ErrorCode; message: string } }
export type Ack<T> = (result: T | ActionError) => void;
export interface CreateResult { roomCode: string; hostToken: string; joinUrl: string }
export interface JoinResult { playerId: string; resumeToken: string; color: string }
export interface ClientToServerEvents {
  'room:create': (ack: Ack<CreateResult>) => void;
  'room:join': (payload: { roomCode: string; name: string }, ack: Ack<JoinResult>) => void;
  'room:resume': (payload: { roomCode: string; resumeToken: string }, ack: Ack<JoinResult>) => void;
  'player:ready': (payload: { calibrated: true }, ack?: Ack<{ ok: true }>) => void;
  'host:start': (payload: { hostToken: string }, ack?: Ack<{ ok: true }>) => void;
  'clock:ping': (payload: { t0: number }) => void;
  'input:move': (payload: MoveInput, ack?: Ack<{ ok: true }>) => void;
  'input:yank': (payload: YankInput, ack?: Ack<{ ok: true }>) => void;
  'input:taunt': (payload: { seq: number }, ack?: Ack<{ ok: true }>) => void;
}
export interface ServerToClientEvents {
  'clock:pong': (payload: { t0: number; ts: number }) => void;
  'state:snapshot': (payload: Snapshot) => void;
  'phone:state': (payload: PhoneState) => void;
  'game:event': (payload: GameEvent) => void;
  'game:ended': (payload: GameEnded) => void;
}
