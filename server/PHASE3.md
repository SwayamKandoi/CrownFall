# Phase 3 integration notes

**Status:** Phase 3 is implemented and merged into `main` (through `e968f3c`). Aryan reviewed the implementation and explicitly approved the rematch semantics described below. Aryan's agent reported successful end-to-end rounds with two phone controllers, including pickup, stealing, the 90-second ending and rematch. Full four-physical-phone Gate 3 verification on the deployed version remains pending confirmation.

The server owns crown pickup, possession time, scores, direct steals and round results. The host renders snapshots at the existing 50 ms interpolation delay; it never predicts ownership or awards points. Simulation and snapshots remain 30 Hz, phone movement remains 20 Hz, and `minPlayers` remains two (eight-player capacity).

## Existing contract, new behavior

The Phase 3 server/host implementation required no new shared Socket.IO contract: existing types, event names and payload shapes were reused. That implementation did not modify Aryan's controller, sensor, audio or deployment files.

- `state:snapshot`: authoritative crown position/holder/held duration, player holding/score, and monotonic round remaining time.
- `phone:state`: current phase, possession, score and authoritative steal eligibility. `inRange` is false outside playing, without a connected holder, for the holder, outside `duelRange`, during immunity or the challenger's cooldown. No duel/revenge state is enabled.
- `game:event`: one `CROWN_PICKUP` per collection, `CROWN_DROPPED` after a disconnected holder's 2,000 ms grace, and `CROWN_STOLEN` with actorId, victimId and points. Existing `PLAYER_LEFT` remains. Event IDs are unique.
- `game:ended`: emitted once per completed round, with scores descending and stable player-ID ordering for ties. All top scorers appear in `winnerIds`, including a zero-score tie. Results include disconnected active-round players.

Queued gameplay events and results are drained once by the broadcaster. If a round ends and resets in the same update, its queued events/results are delivered before the new lobby state so old results cannot reopen the phones' ended screens after reset.

## Approved rematch behavior

An authenticated host's existing `host:start {hostToken}` in **ended** resets the room to **lobby**. It does not immediately start another round. Phone connections, identities, names and colors remain. Scores, crown, positions, ready flags, cooldowns and timer reset. Players send the existing `player:ready {calibrated:true}` again; the host starts once at least two are ready. The existing controller's ended-to-lobby handling clears results and restores readiness controls.

Aryan explicitly approved this extension to the existing `host:start` semantics; no additional event or payload was needed. Host socket membership and token checks still apply. Disconnected active-game players remain for results, then receive the existing two-second lobby cleanup grace on reset. Move/yank sequence history stays intact across rematches because the controller keeps its global counter.

## Direct-steal rules

- Nearest connected player inside `crownPickupRadius` collects an unheld crown during playing. Equal distances use lexical player ID, independent of map insertion order.
- Each uninterrupted connected possession awards one point per 500 ms; fractional time resets on transfer/drop. Hold speed starts at 175, falls 3 units/s per second held and bottoms out at 130. Normal speed stays 210.
- `input:yank {seq,ts}` uses server-epoch milliseconds, as produced by the existing `clock:ping/pong` synchronizer. Accepted age is at most 1,000 ms, future tolerance is 150 ms, and timestamps before the current round are rejected. These tolerances should be checked on real cellular connections.
- Socket membership supplies player identity; clients cannot choose another player's ID in the input payload. Yanks require a connected player in the playing phase, an exact payload shape, a nonnegative safe-integer sequence and a finite nonnegative timestamp. Distance and eligibility use current server positions, not client positions or timestamp-based rewinding.
- Sequence numbers are nonnegative safe integers. Movement and yank track increasing sequences independently, allow skips, and reject replay. A yank with seq 50 may follow move seq 100; a second yank seq 50 cannot succeed. Structurally valid, timely yanks consume their sequence even if gameplay eligibility rejects them.
- Server receipt order decides competing yanks. An in-range attempt by an eligible challenger starts the 2,500 ms challenger cooldown, including an attempt blocked by holder immunity. A successful steal awards three points and grants the new holder 2,000 ms immunity. Invalid attempts never transfer ownership or award steal points; normal elapsed hold scoring still settles independently.
- Initial pickup has no immunity. No opening rush restriction, draw-off duels, revenge, gems or last-stand shrink is added in this milestone. Reserved snapshot fields remain neutral.
- A disconnected holder stops scoring immediately, drops at its last position after two seconds, and remains in the active roster. A connected nearby player can then collect the dropped crown.
- In the lobby, disconnect marks a player offline immediately. After 2,000 ms the shared room update loop removes that offline player and its input state, frees the slot and broadcasts the roster change. Replacement players receive unused colors. Connected players are protected; this cleanup does not remove players during countdown or active play.
- After the three-second countdown, the round lasts exactly 90,000 monotonic ms. Late updates cap scoring at the deadline. Movement/yanks arriving at or after it are rejected, even before the next scheduled update.

## Verification and manual gate

`npm run typecheck` checks TypeScript, `npm test` runs 29 deterministic and real Socket.IO tests, and `npm run build` compiles the server and bundles the client. The optional `npm run test:host` verifies the built host through the application server in headless Edge and passed during Phase 3 implementation. Clock injection exists only as an in-process server constructor option for tests; no network clock/debug endpoint exists. Automated full-round tests advance the clock instead of sleeping 90 seconds. Browser screenshots are generated under ignored `dist/verification/`.

Phase 2 was tested on four real iPhones. According to Aryan's agent, the two-controller Phase 3 test covered pickup, stealing, the 90-second ending and rematch. That report does not independently confirm the final four-physical-phone deployment gate. The remaining Gate 3 check is four real phones on the deployed HTTPS version: independent tilt, pickup/holding screen and score, close-range yank and stolen flash, immunity/availability feedback, a full real-time 90-second round, tied results, and rematch readiness on the same connections. Record the deployed revision and result when that check is confirmed.

The controller currently labels every `inRange:false` yank as “Too far,” including cooldown/immunity; this is an existing phone UX limitation. Its ordinal tied-rank display may differ from the host's shared rank; `winnerIds` includes every tied winner. Reconnect/resume and host refresh recovery remain unsupported. Rooms are in memory and disappear on server restart; unoccupied rooms expire after 60 seconds. Draw-off duels, revenge, vault gems, Last Stand, announcer support and advanced audiovisual polish remain future work.

Phase 3 is already in `main`; this documentation update does not establish that a particular revision is deployed and does not perform a deployment. Use the existing deployment procedure and confirm the remaining four-phone gate against the running version. The earlier [Phases 1–2 handoff](../docs/INTEGRATION.md) is historical and contains superseded status/proposal text; use this document, the [README](../README.md) and current source for Phase 3 behavior.
