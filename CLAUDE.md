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
- `client/controller/sensors.ts`: motion permission (call inside a tap; iOS needs orientation AND motion), `onOrientation`, `onMotion`, `YankDetector` (18 m/s², 600 ms), `ShakeDetector` (taunts), `StillnessCheck`, `vibrate()`.
- `client/controller/calibration.ts`: `calibrate`, `tiltToMove` → −1..1 (maxTilt 25°, dead zone 0.12).
- `client/controller/clockSync.ts`: `ClockSync.serverNow()` for yank timestamps.
- `client/controller/ControllerPage.tsx` (`/play/CODE`): name + character pick → Join → Enable Motion → Calibrate → Ready. Sends `input:move` 20 Hz (EMA 0.6). Range-gated yank (not during the 15 s rush), duel screens (HOLD STILL / DRAW! / result with ms), holding/stolen flashes, results + rematch, shake-to-taunt out of range, auto-rejoin via `room:resume` (seat in sessionStorage; move/yank `seq` starts at `Date.now()` so a reloaded page stays above the old sequence).
- `client/audio/sfx.ts`: synthesized Web Audio SFX (no files), used by phone and host. `unlockAudio()` must run in a tap/click.
- `client/host/announcer.ts`: big-screen voice (speechSynthesis) for countdown, pickup, steal, rush end, duels, fouls, 30/10 s, winner. "Sound on/off" toggle in the host header.
- `client/sensor-test/`: diagnostics page.

## Measured on real phones
- iPhone yank peak ≈ 40+ m/s², tilting 2–6 → threshold 18. Gate 3 also checked on Android.
- iOS can't vibrate from the web; Android uses `navigator.vibrate`.

## Socket contract essentials (`shared/events.ts`)
- Phone → server: `room:join {roomCode, name, avatar?}` (avatar ∈ `AVATARS` in shared/constants: fox, frog, panda, lion, octopus, tiger, robot, ghost), `room:resume {roomCode, resumeToken}`, `player:ready`, `input:move {seq,x,y}` (volatile), `input:yank {seq,ts}` (server epoch ms), `input:taunt {seq}`, `clock:ping`.
- Server → phone: `phone:state {phase, holding, score, inRange, wantedName, duel}`, `game:event`, `game:ended`, `clock:pong`.
- `PlayerState.avatar?` and `PlayerState.ready?` are approved additions.
- Taunts: server accepts out of steal range, not mid-duel, ≤1 per 1.5 s; emits `TAUNT`; host shows a speech bubble.
- Resume: server stores each player's token; a newer socket with the same token takes over the seat. Lobby players are dropped 2 s after disconnect (then resume fails and the phone shows the join form).

## Server (Swayam) — what exists
- Phase 3: authoritative pickup, hold scoring (+1 / 0.5 s, heavy crown), steals (+3), immunity/cooldowns, 90 s rounds, results, rematch (`host:start` in ended → lobby).
- Phase 4: draw-off duels behind `CROWNFALL_DUELS=1` (set on Render). 15 s opening rush: no steals/duels.
- Min players 2, max 8.

## Status (Sun Oct 25, ~2:20 AM)
- Phases 0–5 done. 61 automated tests. Simulated: 10/10 duels, 8-player movement, reload-resume, taunts, announcer lines.
- Real phones: Gates 1–3 passed (iPhones + Android). Gate 4 (10 duels) and Phase 5 features still to verify on real phones.

## Next
- Swayam — Phase 6: Wanted poster + revenge (12 s, double points), vault gems (+5, every 25 s, 8 s life), Last Stand (final 15 s, arena ×0.7, points ×2), slow-mo duel replay, Play of the Game + end stats, 8-player layout check. Pull `main` first.
- Phase 7 (8:00–9:30 AM, together): merge, Playtest 2 + record video, tune constants. Code freeze 9:30 AM. Submission by 11:45 AM (deadline noon).
- Parked: move Render to Virginia (lower latency) before recording the video; UI polish pass; iOS haptics.
