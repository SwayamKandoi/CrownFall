# Phase 6: Wanted, vaults and the finale

Implemented on `swayam/server`, starting from Phase 5 `f6411f8`, with `034bac9` integrated afterward. The latter removes local `CLAUDE.md` notes from tracking; they are not reintroduced. No merge into main or deployment is performed by this work.

The production origin reported by the team is now **https://crownfall-sqi0.onrender.com**. The old Render service is deleted. This document does not certify the revision or flags running there.

## Independent flags

Both flags are server process environment variables. Restart with the desired values and create fresh rooms; clients cannot change them.

| `CROWNFALL_PHASE6` | `CROWNFALL_DUELS` | Behavior |
| --- | --- | --- |
| unset / not `1` | unset / not `1` | Phase 5 with direct steals |
| unset / not `1` | `1` | Phase 5 draw-off duels |
| `1` | unset / not `1` | Wanted, gems and Last Stand with direct steals |
| `1` | `1` | All Phase 6 gameplay plus duel approach replays |

`createApp`/`GameRoom` accept equivalent `phase6Enabled` and `duelsEnabled` options for tests. No hosting configuration or shared constants are changed. Keep Phase 6 opt-in until the team reviews the integration and runs physical-device Playtest 2.

## Wanted and revenge

A successful crown transfer from A to B gives A a Wanted target of B until `transferTime + 12,000` monotonic milliseconds. The target is public in A's `PlayerState.wantedId`; only A receives B's name as their own `PhoneState.wantedName`. The host shows compact posters outside the arena using player names, colors and avatar emoji.

If A takes the crown from that exact target strictly before the deadline, the award is **6 total**, replacing the ordinary 3. `CROWN_STOLEN` and `REVENGE` describe the same award; never add their `points` together. A's fulfilled opportunity clears, and B acquires A as their new target. Stealing from someone else gives ordinary points and does not fulfill the old target. At the exact expiry boundary, the bonus is unavailable.

In duel mode eligibility is evaluated at the **successful crown transfer**, not initiation or client reaction time. A challenge begun before expiry but resolved afterward earns ordinary steal points. Revenge requires a valid winning challenger reaction with neither duelist fouled. Initiation, cancellation, defense, inactivity and foul-decided outcomes do not claim revenge. A holder foul still transfers the crown under existing duel rules, but awards ordinary steal points and clears the now-fulfilled target. A lone valid challenger reaction can win against an opponent who does not respond. The duel's result reports the actual transfer award; no separate bonus is awarded for starting a challenge.

Wanted state expires in the room update loop and clears for a disconnected/removed player and everyone targeting them. Reconnecting does not restore an erased opportunity. End of round, rematch and disposal clear the state.

## Vault gems

Active gameplay begins after the three-second countdown. Spawn slots are at **25, 50 and 75 seconds** of that gameplay, independent of the opening Rush. Each slot expires eight seconds after its scheduled time. A late update skips slots already expired at the simulated time; a still-live slot retains its original expiration rather than receiving eight extra seconds. Existing physics catch-up remains bounded to 250 ms.

The injected random source chooses x/y within the current arena with a 28-unit margin. There is at most one gem. Connected avatars outside a duel collect within **28 arena units**; holders can collect normally. Collection runs with the fixed simulation steps. Ties use shortest distance, then lexical player ID. Removal happens before the award, so subsequent checks cannot collect the same gem twice. Collection and expiry do not affect crown ownership.

`Snapshot.gem = {x, y, expiresMs}` uses **remaining duration in milliseconds at snapshot creation**, not epoch time. It is null after collection/expiration. A client can count down from receipt for display but must treat server snapshots as authoritative. `GEM_SPAWN` and `GEM_TAKEN` include world coordinates; collection includes the actual awarded points and actor ID.

## Last Stand and scoring

At active gameplay time **75,000 ms**, the server emits one `LAST_STAND`, sets `lastStand:true`, and begins a centered linear contraction. Scale is 1 at 75 seconds, 0.85 at 82.5 seconds, and 0.7 at 90 seconds. `lastStand` becomes false at the round deadline; the final 0.7 arena remains visible until rematch resets it to 1.

Server bounds use half the removed width/height as each inset, plus an 18-unit avatar/crown margin (28 for gems). All eight avatars, including disconnected players and frozen duelists, are clamped toward the nearest valid boundary. The held crown follows its holder; an unclaimed crown and gem are clamped too. This is deterministic boundary pressure, not client prediction. After a long server stall, positions may move directly to the current valid edge.

`earnedPoints` centralizes point multiplication. Every new award at or after the Last Stand boundary is doubled once:

| Award | Before Last Stand | Last Stand |
| --- | --- | --- |
| Each completed 500 ms of possession | 1 | 2 |
| Ordinary theft | 3 | 6 |
| Revenge theft (total) | 6 | 12 |
| Vault gem | 5 | 10 |
| Successful duel defense | 2 | 4 |

Possession retains fractional time and is scored at each completed 500 ms threshold. A threshold exactly at 75 seconds is doubled; an earlier threshold is not. This remains true across delayed updates and normal 30 Hz floating-point steps (using the existing sub-microsecond scoring tolerance). For uninterrupted possession from active time 0 through 90 seconds, this convention gives 149 ordinary thresholds plus 31 doubled thresholds: **211 points**. Scores earned earlier are never multiplied retroactively.

Possession still pauses during an active duel and resumes without catch-up. Event `points` equals the actual award. `DUEL_RESULT` and `CROWN_STOLEN`, when both emitted for a win, describe one transfer rather than two awards. Round end still caps all scoring at 90 seconds. The 15-second opening Rush is unchanged.

## Replay data and presentation

When Phase 6 is enabled, `RoundHighlights` samples connected players' authoritative positions at most every 100 ms. Each room holds at most **21 samples over the last 2,000 ms**, each containing at most eight players. Samples are taken from actual updates; missing history is not fabricated after a stall.

At duel initiation the current approach is copied for the exact challenger (`a`) and original holder (`b`). Frame `t` is relative milliseconds from the first retained frame, beginning at zero and spanning at most two seconds. Coordinates are original arena units. No future cue schedule is included.

After a completed duel, `DUEL_RESULT` retains its existing timing summary with empty frames for phone compatibility. A separate **`DUEL_REPLAY`** carries those same `aMs`/`bMs` reaction timings plus the captured approach frames. Null reaction times represent foul/no valid response; use that duel's `DUEL_FOUL` events to distinguish them. Cancellation emits no replay. A capture with fewer than two valid samples is omitted rather than inventing a chase.

The host renders a small SVG picture-in-picture panel beneath the scoreboard, using the existing React host and no second Phaser engine. Positions play at `RULES.replaySpeed = 0.4`; a full two-second recording takes five seconds, then the panel clears after a brief 500 ms hold. It shows both participants, paths, reaction times and FOUL/TOO SLOW labels. A new live duel, results, disconnect or rematch takes priority and clears/hides replay. Playback never controls simulation, score, movement or the match timer.

## Play of the Game and statistics

Server evidence includes pickups, steals, revenge, completed duel outcomes, gems and Last Stand. The per-round summary history is capped at 1,024 events with replay frames stripped; one best candidate is retained independently so an older standout cannot be lost when the history reaches its bound.

The server chooses a qualifying event deterministically in this priority order:

1. Successful revenge.
2. An actual Last Stand scoring action that moved its recipient from strictly behind the highest rival score to strictly ahead.
3. Lowest valid winning duel reaction.
4. Highest-value successful theft.
5. Gem collection.

Ties within a priority use lowest available reaction time, then higher points, earlier event time, lexical actor ID, and lexical victim ID. A pickup alone, failed challenge or empty round is not a fabricated highlight. `PLAY_OF_GAME` is emitted once at completion when a qualifying moment exists, through `game:event` before `game:ended`. Its actor is the actual scorer/winner; `serverTime` remains the selected moment's epoch time, not the end of the round. Other fields reuse that moment's actual points, opponent and available reaction metadata. No new shared field encodes a narrative category.

The host derives presentation statistics from at most 1,024 deduplicated authoritative event summaries, cleared at lobby/countdown:

- **Most Wanted:** most `CROWN_STOLEN` events by one actor, counting direct and duel thefts once. Ties use lexical player ID.
- **Fastest Draw:** lowest finite, nonnegative `reactionMs` from a completed `DUEL_RESULT` with a winner. Ties use lexical winner ID. A no-reaction foul victory cannot invent a reaction time.
- **Nemesis:** unordered player pair with the most successful crown steals between them. Ties use lexical ordered pair IDs.
- **Play of the Game:** the server-selected event, never recomputed by the host.

Missing evidence yields explicit placeholders. `GameEnded` is unchanged. These presentation statistics also work from existing events when Phase 6 gameplay is disabled; the server sends no Phase 6 Play of the Game or replay in that mode. Host refresh recovery remains unsupported, so statistics are not claimed to be reconstructed after a lost host connection.

## Aryan handoff

No new Socket.IO events, payload types, shared constants, controller files, sensor files, audio files or announcer modules were modified.

| Existing output | Exact meaning / suggested phone use |
| --- | --- |
| `REVENGE` | Successful revenge; `actorId`, `victimId`, actual `points`, epoch `serverTime`. Optional special flash/SFX; do not add points locally. |
| `GEM_SPAWN` | One live vault gem appeared; `x`, `y`, epoch `serverTime`. Optional cue; snapshot controls lifetime. |
| `GEM_TAKEN` | `actorId` collected the gem; `points` is 5 or 10, with pickup `x/y`. Optional personal flash/haptic. |
| `LAST_STAND` | Double scoring and contraction began; epoch `serverTime`. Optional phone banner/announcer line. Snapshot flags remain authoritative. |
| `DUEL_REPLAY` | Host presentation metadata only, using the existing `DuelReplay` shape. Phones may ignore it; do not restart a duel or award points. |
| `PLAY_OF_GAME` | Server-selected scoring moment emitted once before round results when evidence exists. Optional result embellishment. |
| `phone:state.wantedName` | Relevant player's current target name, or null on expiry/cleanup. The current Phase 5 phone already renders it. |

**Essential for Phase 6 protocol compatibility:** no phone code change is required. Continue using server score, holding, `inRange`, duel state and round results. Phase 5's current duel controller remains required when enabling `CROWNFALL_DUELS`.

**Optional polish owned by Aryan:** distinct revenge/gem/finale feedback, dynamic scoring hints, and new announcer lines. The existing announcer does not handle these six Phase 6 event names; its module and behavior are preserved. Existing early-yank fouls work. The previously proposed physical-stillness event remains unbound; this change does not claim new physical stillness detection or add an unapproved contract.

## Verification and limitations

Final local verification after integrating `034bac9`: **85 automated tests passed**, TypeScript typecheck passed, production build passed, and all four host browser flows passed. The Phase 6 replay flow also uses eight simultaneous sockets and checks that its panel fits beneath the eight-player scoreboard at 1280×720. These are simulated-client and desktop-browser results, not deployed or physical-phone results.

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:host`. Phase 6 deterministic suites cover both flags, Wanted boundaries and duel resolution expiry, gems/late updates, Last Stand boundary scoring and clamps, replay memory/cleanup, highlight selection, statistics, and independent eight-socket rooms. Existing Phase 3/4/Rush/Phase 5 tests remain in the full suite.

The browser suite covers the existing default and duel flows, eight different avatar picks with long names, gems/pickup, Wanted/revenge, Last Stand, final statistics, replay while other players move, and same-phone rematch. Layouts are checked at **1920×1080, 1280×720, 1024×768**, with eight roster rows on screen and one Phaser canvas. Ignored screenshots are under `dist/verification/phase6-*.png`. Arena labels use stable collision avoidance; QR/lobby and results remain usable at the compact sizes.

Automated socket clients and a desktop browser are not physical sensor verification. No Phase 6 deployment or real-phone playtest is claimed. Review on four or more real phones at the team's October 25 8:00 AM integration review, exercise a full round/rematch and consecutive duels, then decide enablement before the 9:30 AM code freeze. Existing clock-sync/network fairness limits and in-memory room persistence remain. Phaser still produces the existing large-chunk build warning.
