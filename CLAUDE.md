# Crownfall — HackPSU Fall 2026

Phone-motion party game for the **Mystery Stack** track. Our draw: **Phone motion + Rivalry + must work for a group of 4+**.
Players join from their phones (no install), tilt to move their avatar on a shared big screen, and **yank** the phone to steal the crown. Most crown-hold time wins.

Team: **Aryan** (phone side, this machine) and **Swayam** (server + big screen). Repo: `SwayamKandoi/CrownFall`.
Full plan: `Crownfall — HackPSU Battle Plan.pdf` (phases, gates, demo script). Ask Aryan for it if needed.

## Ownership (do not edit the other person's files without asking)
- **Aryan:** `client/controller/*`, `client/sensor-test/*`, announcer/sound module (later)
- **Swayam:** `server/*`, `client/host/*` (lobby, QR, Phaser arena), `tests/*`
- **Shared, change only together:** `shared/events.ts` (the socket contract), `client/main.tsx` (router)

## Stack and commands
TypeScript, React 18 + Vite client, Express + Socket.IO server, Phaser on the host screen. Node 20.
- `npm ci` · `npm run dev` (server :3000 + Vite :5173; open `/host`) · `npm run typecheck` · `npm test` · `npm run build` · `npm start`
- Imports use `.js` extensions (NodeNext).
- Always run `npm run typecheck && npm test && npm run build` before pushing.
- `git pull` before `git push`. Work happens on `main` for Aryan's folders; Swayam uses `swayam/*` branches and merges.

## Deployment
- Render web service, auto-deploy unreliable → use **Manual Deploy → Deploy latest commit** after pushing.
- URL: https://crownfall-4lgz.onrender.com (routes: `/host`, `/play/CODE`, `/sensor-test`, `/health`)
- Env: `NODE_VERSION=20`, `PUBLIC_ORIGIN=https://crownfall-4lgz.onrender.com` (needed for correct QR/join links). Render sets `PORT`.
- Build `npm install && npm run build`, start `npm start`.

## Phone side (Aryan) — what exists
- `client/controller/sensors.ts`: `requestMotionPermission()` (call inside a tap; iOS needs orientation AND motion), `onOrientation`, `onMotion` (gravity-free accel, high-pass fallback), `YankDetector(threshold, cooldownMs)`, `StillnessCheck`, `vibrate()`, `iosHapticTap()`.
- `client/controller/calibration.ts`: `calibrate(samples)`, `tiltToMove(o, cal)` → x/y in −1..1 with dead zone (maxTilt 25°, dead zone 0.12).
- `client/controller/clockSync.ts`: `ClockSync` over `clock:ping/pong`; `serverNow()` for yank timestamps.
- `client/controller/ControllerPage.tsx`: `/play/CODE` flow — name → Join → Enable Motion → Calibrate → I'm ready → sends `input:move` (volatile, 20 Hz, EMA smoothing 0.35).
- `client/sensor-test/SensorTestPage.tsx`: diagnostics page.

## Measured on real phones (5 iPhones, iOS Safari)
- Yank peak ≈ **40+ m/s²**; normal tilting **2–6 m/s²** → yank threshold **18 m/s²**.
- Motion events 60 Hz, native `acceleration` available. WS round trip ~120 ms on cellular.
- `navigator.vibrate` does nothing on iOS (expected). The iOS hidden-switch haptic trick did **not** work in testing — haptics are optional polish.
- **Android not yet tested** — borrow one before Playtest 1.

## Socket contract essentials (`shared/events.ts`)
- Phone → server: `room:join {roomCode,name}`, `player:ready {calibrated:true}`, `input:move {seq,x,y}` (volatile), `input:yank {seq,ts}` (ts = server epoch ms), `input:taunt {seq}`, `clock:ping {t0}`.
- Server → phone: `phone:state {phase, holding, score, inRange, wantedName, duel}`, `game:event`, `game:ended {scores, winnerIds}`, `clock:pong {t0,ts}`.
- Phone `seq` is shared between move and yank: always increasing, may skip numbers. Server rejects non-increasing move seq.
- Approved addition: `PlayerState.ready?: boolean`.

## Status (Sat Oct 24, ~8:10 PM)
- Gate 1 (sensors) ✅ on iOS. Gate 2 code ✅ on both sides; simulated 4-phone test passed (each phone moves its own avatar).
- Waiting on: Swayam merging `swayam/server` → `main` (trial merge was clean, 12/12 tests pass), then Render redeploy + real 4-phone Gate 2 test.

## Next for Aryan (Phase 3, 8:30–11:30 PM)
- Yank integrated: only when `phone:state.inRange`, 600 ms cooldown, ignore tilt for 300 ms after a yank. (Server still hardcodes `inRange:false` and returns NOT_IMPLEMENTED for `input:yank` until Swayam's Phase 3.)
- Phone screens: lobby, playing, holding (gold), stolen (red flash), ended with score/rank, rematch → ready again. A draft of this exists in the Claude chat; keep it off `main` until Gate 2 passes.
- Devpost: project must exist by **midnight**; first description draft.
- Gate 3 (11:30): full 90 s round with 4 phones, correct scores, rematch works.
