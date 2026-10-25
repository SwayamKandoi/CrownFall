# Phase 3 integration notes

The server owns crown pickup, possession time, scores, direct steals and round results. The host renders snapshots at the existing 50 ms interpolation delay; it never predicts ownership or awards points. Simulation and snapshots remain 30 Hz, phone movement remains 20 Hz, and `minPlayers` remains two (eight-player capacity).

## Existing contract, new behavior

No shared types, event names or payload shapes changed. No controller, sensor, audio or deployment files changed.

- `state:snapshot`: authoritative crown position/holder/held duration, player holding/score, and monotonic round remaining time.
- `phone:state`: current phase, possession, score and authoritative steal eligibility. `inRange` is false outside playing, without a connected holder, for the holder, outside `duelRange`, during immunity or the challenger's cooldown. No duel/revenge state is enabled.
- `game:event`: one `CROWN_PICKUP` per collection, `CROWN_DROPPED` after a disconnected holder's 2,000 ms grace, and `CROWN_STOLEN` with actorId, victimId and points. Existing `PLAYER_LEFT` remains. Event IDs are unique.
- `game:ended`: emitted once per completed round, with scores descending and stable player-ID ordering for ties. All top scorers appear in `winnerIds`, including a zero-score tie. Results include disconnected active-round players.

## Rematch proposal — Aryan approval pending

An authenticated host's existing `host:start {hostToken}` in **ended** resets the room to **lobby**. It does not immediately start another round. Phone connections, identities, names and colors remain. Scores, crown, positions, ready flags, cooldowns and timer reset. Players send the existing `player:ready {calibrated:true}` again; the host starts once at least two are ready. The existing controller's ended-to-lobby handling clears results and restores readiness controls.

This extension is implemented for integration testing and is **not a frozen contract decision until Aryan approves it**. Host socket membership and token checks still apply. Disconnected active-game players remain for results, then receive the existing two-second lobby cleanup grace on reset. Move/yank sequence history stays intact across rematches because the controller keeps its global counter.

## Direct-steal rules

- Nearest connected player inside `crownPickupRadius` collects an unheld crown during playing. Equal distances use lexical player ID, independent of map insertion order.
- Each uninterrupted connected possession awards one point per 500 ms; fractional time resets on transfer/drop. Hold speed starts at 175, falls 3 units/s per second held and bottoms out at 130. Normal speed stays 210.
- `input:yank {seq,ts}` uses server-epoch milliseconds, as produced by the existing `clock:ping/pong` synchronizer. Accepted age is at most 1,000 ms, future tolerance is 150 ms, and timestamps before the current round are rejected. These tolerances should be checked on real cellular connections.
- Sequence numbers are nonnegative safe integers. Movement and yank track increasing sequences independently, allow skips, and reject replay. A yank with seq 50 may follow move seq 100; a second yank seq 50 cannot succeed. Structurally valid, timely yanks consume their sequence even if gameplay eligibility rejects them.
- Server receipt order decides competing yanks. An in-range attempt by an eligible challenger starts the 2,500 ms challenger cooldown, including an attempt blocked by holder immunity. A successful steal awards three points and grants the new holder 2,000 ms immunity. Invalid attempts never transfer ownership or award steal points; normal elapsed hold scoring still settles independently.
- Initial pickup has no immunity. No opening rush restriction, draw-off duels, revenge, gems or last-stand shrink is added in this milestone. Reserved snapshot fields remain neutral.
- A disconnected holder stops scoring immediately, drops at its last position after two seconds, and remains in the active roster. A connected nearby player can then collect the dropped crown.
- After the three-second countdown, the round lasts exactly 90,000 monotonic ms. Late updates cap scoring at the deadline. Movement/yanks arriving at or after it are rejected, even before the next scheduled update.

## Verification and manual gate

`npm run typecheck`, `npm test`, `npm run build`, and `npm run test:host` cover deterministic clocks, real Socket.IO clients and the built host in headless Edge. Clock injection exists only as an in-process server constructor option for tests; no network clock/debug endpoint exists. Automated full-round tests advance the clock instead of sleeping 90 seconds. Browser screenshots are generated under ignored `dist/verification/`.

Aryan should verify four real phones on the deployed HTTPS service: independent tilt, pickup/holding screen and score, close-range yank and stolen flash, immunity/availability feedback, a full real-time 90-second round, tied results, and rematch readiness on the same connections. The controller currently labels every `inRange:false` yank as “Too far,” including cooldown/immunity; this is an existing phone UX limitation for Aryan to review. Its ordinal tied-rank display may differ from the host's shared rank; `winnerIds` includes every tied winner.

Reconnect/resume remains unsupported. No deployment or merge is performed by this branch. After Aryan approves rematch semantics and Gate 3 passes, review `swayam/server` against the latest `main` and merge through the team's normal PR workflow. Re-run checks after integration; deploy with the existing Render procedure.
