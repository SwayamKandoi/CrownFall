# Crownfall integration handoff — Phase 1

## Contract status and ownership

The exact event names and payload types remain in `shared/events.ts`; constants remain in `shared/constants.ts`. The only additive proposal is optional `PlayerState.ready?: boolean` in snapshots, needed by the host roster and start control. Treat absent as false. **Aryan must approve this addition before it is considered agreed/frozen.** Existing success payloads, failure shapes, event names, and required snapshot fields are unchanged. No message has been sent to Aryan automatically.

Phone/controller, sensors, audio and deployment remain Aryan-owned. The server and host never import controller modules. `client/main.tsx` has not been changed: `/sensor-test` uses Aryan's existing named `SensorTestPage` export; `/play/:roomCode` remains a placeholder until Aryan coordinates connecting his named `ControllerPage` export from `client/controller/ControllerPage.tsx`.

## Run and deploy

```sh
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npm start
```

Open http://localhost:5173/host during development. Set `PUBLIC_ORIGIN=http://localhost:5173` before starting dev for matching join links. Vite proxies `/socket.io` (including upgrade) and `/health` to port 3000. To use phones on a LAN, substitute the laptop's LAN IP in PUBLIC_ORIGIN and open Vite on that IP. Use HTTPS for motion permissions.

Production uses one persistent Node process serving `dist/client`, SPA routes, `/health` and Socket.IO. Aryan supplies HTTPS termination and `PUBLIC_ORIGIN=https://actual-render-origin` without a trailing slash. `PORT` is honored. The fallback join URL is localhost; PUBLIC_ORIGIN must be set for shared/deployed use. No deployment-provider configuration was modified.

## Typed client integration

From a file directly in `client/controller/`:

```ts
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/events.js';
const phone: Socket<ServerToClientEvents, ClientToServerEvents> = io();
phone.emit('room:join', { roomCode: 'ABCDE', name: 'Aryan' }, result => {
  if ('error' in result) return console.error(result.error);
  console.log(result.playerId, result.resumeToken, result.color);
  // Only after motion permissions and calibration succeed:
  phone.emit('player:ready', { calibrated: true }, console.log);
});
phone.on('state:snapshot', snapshot => console.log(snapshot.phase, snapshot.players));
phone.on('phone:state', state => console.log(state.phase, state.score));
phone.emit('clock:ping', { t0: performance.now() });
phone.on('clock:pong', ({ t0, ts }) => console.log(t0, ts));
```

A separate host socket calls `socket.emit('room:create', callback)` then `socket.emit('host:start', {hostToken}, callback)`. Creation takes callback only, no payload. One connection belongs to exactly one room and one role. Keep tokens private; do not put them in URLs. Room codes are five uppercase characters from A–Z excluding I/O and digits 2–9. Names are trimmed, 1–20 printable characters.

Successful create: `{"roomCode":"ABCDE","hostToken":"opaque-secret","joinUrl":"https://example.test/play/ABCDE"}`.
Successful join: `{"playerId":"uuid","resumeToken":"opaque-secret","color":"#ff6b6b"}`.
Ready/start success: `{"ok":true}`.
Every acknowledged failure: `{"error":{"code":"NOT_READY","message":"At least four connected, calibrated players are required."}}`.
Narrow with `'error' in result`. Create/join/resume require callbacks. Ready/start/input callbacks are optional; use them to observe rejections. Apply a client acknowledgement timeout.

## Event reference

| Client → server | Payload | Status |
| --- | --- | --- |
| room:create | callback only | operational |
| room:join | {roomCode,name} | operational, lobby only, maximum eight |
| room:resume | {roomCode,resumeToken} | NOT_IMPLEMENTED |
| player:ready | {calibrated:true} | operational, lobby only |
| host:start | {hostToken} | bound host socket + matching room token + four connected ready players |
| clock:ping | {t0} | operational; clock:pong replies with {t0,ts} |
| input:move | {seq,x,y} | Phase 2 |
| input:yank | {seq,ts} | NOT_IMPLEMENTED |
| input:taunt | {seq} | NOT_IMPLEMENTED |

Start transitions lobby → countdown (3000 ms) → playing automatically using monotonic server time. Duplicate starts return INVALID_PHASE. Ready flags clear on disconnect. A player or another room's host cannot start a room even with its token. Errors include INVALID_PAYLOAD, ROOM_NOT_FOUND, ROOM_FULL, ALREADY_JOINED, UNAUTHORIZED, NOT_READY, INVALID_PHASE, RATE_LIMITED and NOT_IMPLEMENTED.

State snapshots contain `tick,phase,remainingMs,lastStand,arenaScale,crown,gem,duel,players`. Phase 1 publishes lobby/countdown/playing snapshots at 15 Hz plus changes. No game positions or scores are accepted from clients. Phone state contains `phase,holding,score,inRange,wantedName,duel`; during these foundation phases, holding/inRange are false, score is zero, wantedName/duel are null. Render the status phase, not fabricated local gameplay.

Server → client event names: `clock:pong`, `state:snapshot`, `phone:state`, `game:event`, `game:ended`. PLAYER_LEFT is emitted on disconnect; gameplay events and ended are reserved. All structures and event-type names are fully typed in shared/events.ts.

Clock pong ts uses epoch milliseconds (`Date.now()`); simulation/countdown uses monotonic time. Aryan owns offset estimation. Clock sync does not eliminate latency or cheating; yank timestamps are not implemented yet. General actions allow 5/s with burst 20 per connection; clock allows 10/s with burst 16. This is not global anti-abuse protection.

## Limits and future gates

Resume remains NOT_IMPLEMENTED. Refresh does not recover host/player membership; tokens are returned for the future contract but resume tokens are not yet stored. Disconnected avatars stay in the room and occupy slots until cleanup; do not silently rejoin on every reconnect and create duplicates. Show a clear reconnect limitation on the phone. Rooms with no connected host or players are removed after 60 seconds. Active rooms are not removed by cleanup. Closing the HTTP server stops the update interval and releases state.

Crown pickup, scoring, duels, round completion, rematches, revenge, gems and Last Stand are not implemented. Future duel stages: null ordinary play; ready HOLD STILL; cue DRAW; done result using won/foul; null resumes ordinary play. The host forwards game:event as a typed detail payload on window event `crownfall:game-event`, so Aryan's announcer can subscribe independently. Do not modify the announcer to make the arena work.

## Integration verification

Automated tests use actual Socket.IO clients and bounded timeouts, including capacity, host authorization, ready status, countdown, validation and disconnect. Deployed HTTPS and physical phones are NOT VERIFIED.

Aryan: approve the optional readiness field; connect the controller route in client/main.tsx by agreement; verify same-origin Socket.IO over deployed HTTPS; test iPhone/Android motion permissions. Connection diagnosis: check /health first, then browser Network for /socket.io upgrade or polling, server process logs, PUBLIC_ORIGIN, matching origin, room code and acknowledgement errors. A healthy frontend alone does not confirm the persistent WebSocket backend.
