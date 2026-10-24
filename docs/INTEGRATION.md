# Crownfall integration handoff - Phases 1 and 2

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
| input:move | {seq,x,y} | operational, lobby and playing |
| input:yank | {seq,ts} | NOT_IMPLEMENTED |
| input:taunt | {seq} | NOT_IMPLEMENTED |

Start transitions lobby → countdown (3000 ms) → playing automatically using monotonic server time. Duplicate starts return INVALID_PHASE. Ready flags clear on disconnect. A player or another room's host cannot start a room even with its token. Errors include INVALID_PAYLOAD, ROOM_NOT_FOUND, ROOM_FULL, ALREADY_JOINED, UNAUTHORIZED, NOT_READY, INVALID_PHASE, RATE_LIMITED and NOT_IMPLEMENTED.

State snapshots contain `tick,phase,remainingMs,lastStand,arenaScale,crown,gem,duel,players`. The server advances fixed 30 Hz simulation steps and publishes snapshots at approximately 15 Hz plus immediate membership/phase changes. No game positions or scores are accepted from clients. Phone state contains `phase,holding,score,inRange,wantedName,duel`; during these foundation phases, holding/inRange are false, score is zero, wantedName/duel are null. Render the status phase, not fabricated local gameplay.

Server → client event names: `clock:pong`, `state:snapshot`, `phone:state`, `game:event`, `game:ended`. PLAYER_LEFT is emitted on disconnect; gameplay events and ended are reserved. All structures and event-type names are fully typed in shared/events.ts.

Clock pong ts uses epoch milliseconds (`Date.now()`); simulation/countdown uses monotonic time. Aryan owns offset estimation. Clock sync does not eliminate latency or cheating; yank timestamps are not implemented yet. General actions allow 5/s with burst 20 per connection; clock allows 10/s with burst 16. This is not global anti-abuse protection.

## Limits and future gates

Resume remains NOT_IMPLEMENTED. Refresh does not recover host/player membership; tokens are returned for the future contract but resume tokens are not yet stored. Disconnected avatars stay in the room and occupy slots until cleanup; do not silently rejoin on every reconnect and create duplicates. Show a clear reconnect limitation on the phone. Rooms with no connected host or players are removed after 60 seconds. Active rooms are not removed by cleanup. Closing the HTTP server stops the update interval and releases state.

Crown pickup, scoring, duels, round completion, rematches, revenge, gems and Last Stand are not implemented. Playing is an untimed movement preview; remainingMs stays at 90000 until the full-round phase. The arena crown is decorative. Future duel stages: null ordinary play; ready HOLD STILL; cue DRAW; done result using won/foul; null resumes ordinary play. The host forwards game:event as a typed detail payload on window event `crownfall:game-event`, so Aryan's announcer can subscribe independently. Do not modify the announcer to make the arena work.

## Integration verification

Automated tests use actual Socket.IO clients and bounded timeouts, including capacity, host authorization, ready status, countdown, validation and disconnect. Deployed HTTPS and physical phones are NOT VERIFIED.

Aryan: approve the optional readiness field; connect the controller route in client/main.tsx by agreement; verify same-origin Socket.IO over deployed HTTPS; test iPhone/Android motion permissions. Connection diagnosis: check /health first, then browser Network for /socket.io upgrade or polling, server process logs, PUBLIC_ORIGIN, matching origin, room code and acknowledgement errors. A healthy frontend alone does not confirm the persistent WebSocket backend.


## Phase 2 movement integration

Movement uses the same phone socket that joined the room; no host/controller direct imports are needed. The host receives authoritative snapshots automatically. After successful join, send tilt vectors at approximately 20 Hz:

```ts
let seq = 0;
// Called by Aryan's calibrated sensor pipeline, at about 20 Hz:
function sendTilt(x: number, y: number) {
  phone.volatile.emit('input:move', { seq: seq++, x, y });
}
```

Coordinates: positive x moves right, positive y moves down. seq is a nonnegative safe integer that strictly increases for movement packets for the lifetime of this player connection. Dropped packets and skipped sequence values are fine. A duplicate or lower sequence is rejected as STALE_INPUT. Invalid or rate-limited packets do not replace the last accepted vector or refresh its expiry. Use a movement counter; later yank/taunt sequencing will be documented at their gate.

The server accepts only the exact keys seq,x,y, clamps finite axes to [-1,1], then normalizes vectors longer than one to prevent faster diagonal movement. NaN, Infinity, strings, missing fields, extra keys such as playerId, negative/fractional/unsafe sequence numbers are INVALID_PAYLOAD. Non-player sockets are UNAUTHORIZED. Valid movement allows 30 packets/s with burst eight to tolerate jitter around the expected 20 Hz. Inputs expire after 250 ms. Each avatar center stays at least 18 units inside the 960?540 logical arena. Base speed is 210 units/s. Disconnect clears readiness and movement immediately. Countdown rejects movement with INVALID_PHASE; continue the counter after it ends. Movement is allowed in the lobby for warm-up.

The simulation uses monotonic elapsed time and fixed 1/30-second steps, with at most 250 ms of catch-up work after a process stall. Snapshots include simulation tick. Input commands never accumulate. Phaser renders snapshots with about 100 ms interpolation delay, holding the latest known state when updates stop; connection staleness is shown after two seconds. All scores and gameplay flags remain server-owned.

## Dependency and shared-file coordination

Phase 2 adds Phaser 3 and qrcode runtime packages, @types/qrcode and playwright-core development packages, and an optional test:host script. package-lock.json is updated in place; existing tooling and deployment configuration are preserved. Run npm ci after merging. No central router, Vite configuration or TypeScript configuration was changed. The initial readiness proposal remains the only protocol addition awaiting Aryan approval; no event names or acknowledgement shapes changed.

The host QR code encodes /play/:roomCode on the current browser origin. The room:create canonical joinUrl still uses PUBLIC_ORIGIN, so configure that variable for tools/clients using the acknowledgement directly. The host cannot know whether Aryan's controller is mounted; the current router placeholder is honestly identified on the host.

## Four-phone gate checklist

1. Merge/review the Swayam branch with Aryan's work; agree on optional snapshot.players[].ready and controller router exports.
2. Start with npm ci, npm run dev, or build/start behind Aryan's deployed HTTPS origin.
3. Open /host, create a room, scan its QR code on four separate devices after the controller route is connected.
4. On each phone join, grant permissions, calibrate, send player:ready and stream input:move. Check each name/color and ready indicator appears on the host.
5. Verify Start stays disabled with three ready players, enables at four, counts down for three seconds and becomes playing automatically.
6. Move all four avatars independently. Stop sending from one phone: it should stop within 250 ms. Disconnect it: other avatars should keep moving.
7. Verify iPhone Safari, Android Chrome, deployed HTTPS Socket.IO upgrade/polling, mobile lock/unlock limitations and venue network. These real-device/deployment checks remain NOT VERIFIED locally.

Repeatable server evidence: npm test runs four/eight Socket.IO clients, separate rooms, invalid/replayed input, timeout/disconnect and cadence tests with bounded timeouts. Tests in tests/multiplayer/, if independently added by QA, have not been overwritten; no such directory existed when work began. The optional npm run test:host verifies the actual production React/Phaser interface in headless Edge and writes dist/verification screenshots. It is separate from npm test so automated server tests do not require an installed browser.
