# Phase 0 integration handoff / contract v0 proposal

Source of truth for exact TypeScript payloads and acknowledgements: `shared/events.ts`. Constants: `shared/constants.ts`. Aryan must review these before both teammates freeze v0. Further shared-file edits require agreement. No message has been sent to Aryan automatically.

## Running and routing

Run `npm ci` then `npm run dev`; open `/host` on port 5173. Server port is 3000. Vite proxies `/socket.io` and `/health`. Set `PUBLIC_ORIGIN=http://localhost:5173` before starting the backend for development join links. Production: `npm run build` then `npm start`, with `PORT` and HTTPS `PUBLIC_ORIGIN` configured by Aryan. The persistent server serves the frontend and sockets together.

The integration-owned router is `client/main.tsx`. Proposed module connection: Aryan supplies named `ControllerPage` from `client/controller/ControllerPage.tsx` and named `SensorTestPage` from `client/sensor-test/SensorTestPage.tsx`. Coordinate the router import when those exports exist. ControllerPage may read the room code from `location.pathname.split('/')[2]`. These are proposed exports, not existing modules. No controller files were created.

## Acknowledgements

Success payloads stay flat. All failures use `{ "error": { "code": "ROOM_NOT_FOUND", "message": "Room does not exist." } }`. Narrow with `'error' in result`. No success wrapper is added. Create/join/resume require callbacks. Ready/start/input callbacks are optional, but pass one for explicit rejected-action reporting. Only create, join, clock and disconnect snapshots are operational in Phase 0; all other declared actions acknowledge `NOT_IMPLEMENTED` and do not mutate state.

```ts
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../shared/events.js';
const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io();
socket.emit('room:create', result => {
  if ('error' in result) return console.error(result.error);
  console.log(result.roomCode, result.hostToken, result.joinUrl);
});
// Use a separate phone connection; a connection belongs to one room only.
const phone: Socket<ServerToClientEvents, ClientToServerEvents> = io();
phone.emit('room:join', { roomCode: 'ABCDE', name: 'Aryan' }, result => {
  if ('error' in result) return console.error(result.error);
  console.log(result.playerId, result.resumeToken, result.color);
});
```

Illustrative create success: `{"roomCode":"ABCDE","hostToken":"opaque-secret","joinUrl":"https://example.test/play/ABCDE"}`.
Join success: `{"playerId":"uuid","resumeToken":"opaque-secret","color":"#ff6b6b"}`. Room codes are uppercase, five characters; names are trimmed, 1–20 characters. Capacity is eight. Duplicate joins on the same connection are rejected. Keep tokens private; do not put them in URLs or announcer events.

## Reserved actions and phone behavior

| Client event | Exact request | Intended later-phase behavior |
| --- | --- | --- |
| room:create | callback only | Return roomCode, hostToken, joinUrl |
| room:join | `{roomCode,name}` | Return playerId, resumeToken, color |
| room:resume | `{roomCode,resumeToken}` | Recover same identity and score |
| player:ready | `{calibrated:true}` | Mark calibrated player ready |
| host:start | `{hostToken}` | Authorize host and require 4+ ready |
| clock:ping | `{t0}` | Emit clock:pong `{t0,ts}` |
| input:move | `{seq,x,y}` | Latest intention at 20 Hz; finite axes in [-1,1] |
| input:yank | `{seq,ts}` | Challenge or duel draw; ts in server epoch milliseconds |
| input:taunt | `{seq}` | Taunt outside duel range |

Example calls for later phases:

```ts
phone.emit('room:resume', { roomCode: 'ABCDE', resumeToken: 'stored-token' }, console.log);
phone.emit('player:ready', { calibrated: true }, console.log);
socket.emit('host:start', { hostToken: 'stored-host-token' }, console.log);
phone.volatile.emit('input:move', { seq: 1, x: 0.25, y: -0.5 });
phone.emit('input:yank', { seq: 2, ts: Date.now() }, console.log);
phone.emit('input:taunt', { seq: 3 }, console.log);
phone.emit('clock:ping', { t0: performance.now() });
phone.on('clock:pong', ({ t0, ts }) => console.log(t0, ts));
```

Clock replies use `Date.now()` epoch milliseconds. Aryan owns the lowest-RTT clock-offset estimator; client `ts` remains untrusted. Synchronization cannot eliminate latency or cheating. Sequence deduplication, movement rate limits, skew validation and simulation are later-phase work, not active guarantees. Create/join currently have a per-connection 100 ms throttle; it is not global abuse protection.

`state:snapshot` contains tick, phase, remainingMs, lastStand, arenaScale, crown, gem, duel and players; see fully defined structures in `shared/events.ts`. Phase 0 emits snapshots on create/join/disconnect, not at 15 Hz. `phone:state` sends lobby state on join. Later it drives score, holding flashes, inRange eligibility, wantedName and duel feedback. `game:ended` returns scores and winnerIds; it is reserved.

Future duel stages: null = ordinary play; ready = HOLD STILL; cue = DRAW; done = result using won/foul; null again = ordinary play. No duel transitions or gameplay events are emitted in Phase 0. `GameEventType` enumerates every agreed event; `DuelReplay` defines typed replay frames. Event-specific optional fields are additive proposals to review before freeze. The host forwards received `game:event` messages as `CustomEvent<GameEvent>('crownfall:game-event')` on window; Aryan's announcer can subscribe independently. No announcer module was created or changed.

## Reconnect limitations and gate checks

Phase 0 disconnect marks the avatar disconnected. Resume tokens are returned but not persisted or accepted yet. Host refresh does not recover the room yet. Do not imply resume support in the phone UI until the corresponding server phase. An explicit disconnected state is shown on the host.

Automated tests use actual Socket.IO clients for host/create/join/validation/clock/disconnect. Run `npm run typecheck`, `npm test`, `npm run build`. For deployment smoke tests, check `/health`, load `/host`, create a room, and connect a Socket.IO client on the same HTTPS origin. Aryan must verify HTTPS/WebSocket upgrade, phone routes and real devices; these have NOT BEEN VERIFIED here.

Gate 0 requires both teammates can run the scaffold and agree to freeze the contract. Merge the Swayam branch through normal review; do not overwrite controller, audio or deployment work. Later requirements remain gated: rooms lifecycle and auth, 30 Hz simulation/15 Hz snapshots, ready/start, real phone inputs, gameplay, reconnect, QR and Phaser.
