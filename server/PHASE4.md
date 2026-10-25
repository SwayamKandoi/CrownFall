# Phase 4: opt-in draw-off duels

Server and host integration work lives on `swayam/server`. **Duels are disabled by default.** The existing Phase 3 direct-steal path and shared contract stay intact. Do not enable production duels until Aryan approves the foul proposal, integrates his phone duel flow, and the team verifies it on real phones. No deployment is performed by this change.

## Feature flag

The Node entry point enables duels only when `CROWNFALL_DUELS=1`. Unset it (or use any other value) for Phase 3 direct steals. Restart the server after changing the flag; there is no client-controlled switch. `createApp({duelsEnabled:true})` and `GameRoom` options provide the equivalent test/integration configuration. Tests can inject monotonic `now`, `epochNow` and `random`; production defaults to `performance.now()`, `Date.now()` and `Math.random()`.

This flag permits server/host testing with simulated clients. It does **not** make the current phone controller compatible: it still gates all yanks on `inRange`, which is intentionally false during a duel, and it has no physical-stillness reporting path.

## State machine and eligibility

`IDLE → READY → CUE → DONE → IDLE`, driven by the existing room update loop, with no timers per duel.

An eligible connected challenger within 85 arena units yanks at a connected crown holder. The server checks the playing phase, distinct identities, no existing duel, expired holder immunity and expired challenger cooldown. It consumes the initiation yank once, starts the existing 2,500 ms cooldown, marks the two participants `inDuel`, and emits `DUEL_START` followed by `DUEL_READY`. Crown ownership and steal points do not change at initiation. Outsiders cannot challenge the occupied crown; they keep moving normally.

READY freezes only the two avatars and pauses connected crown-hold accumulation (including slowdown progression). The randomized wait is 1,000–2,500 ms; neither the future cue timestamp nor the chosen delay is exposed in snapshots/events. The first update reaching the wait deadline enters CUE and emits `DUEL_CUE` with `cueAt` in server-epoch milliseconds. After an event-loop stall, the actual cue is issued at the current update time, never backdated to an unseen cue.

During CUE, validated reaction timestamps determine `reactionMs = ts - cueAt`. All responses are collected until **1,500 ms after the cue plus a 250 ms receive grace**. The 1,500 ms timestamp window is inclusive; receipt must be strictly before the 1,750 ms monotonic deadline. Even if both reactions arrive earlier, resolution waits for this bounded deadline, allowing delayed READY foul reports to supersede a reaction. The grace extends receipt time, not valid reaction time.

At resolution, gameplay resumes immediately: `inDuel` clears, stored duelist movement is zeroed, passive scoring resumes without catch-up, and the resulting holder gains 2,000 ms immunity. Fresh movement inputs work during the **1,000 ms DONE display**. No new duel starts while DONE remains visible. Its expiry removes the result state. Existing fractional hold time is preserved on defense; transfer resets it as in Phase 3.

## Result rules

| Responses | Result | Bonus |
| --- | --- | --- |
| Both valid | Lower reaction timestamp wins | Challenger +3 or holder +2 |
| Exact tie | Lexically smaller player ID wins | Challenger +3 or holder +2 |
| Only one valid | Responding player wins | Challenger +3 or holder +2 |
| Challenger fouls, holder does not | Holder wins, even without a reaction | +2 defense |
| Holder fouls, challenger does not | Challenger wins, even without a reaction | +3 steal |
| Both foul | No duel winner; holder retains crown | None |
| Neither responds | No duel winner; holder retains crown | None |

An additional yank received during READY is a foul. A yank whose validated timestamp precedes the actual cue is also a foul even when received after DRAW. The initiation yank is never reused as a reaction. A duelist gets one reaction; fresh sequence numbers cannot replace a recorded reaction with a faster one. A separately reported READY stillness violation can override that reaction before resolution. Fouled players cannot recover by reacting later.

## Input validation and network limits

The existing `input:yank {seq,ts}` initiates a duel when idle and submits a response when that socket's player is a participant. Identity comes from socket membership. Exact payload shape, connected membership, phase, safe nonnegative integer sequence and finite nonnegative epoch timestamp are required. Movement and yank sequence histories remain independent: global phone sequence skips and a yank arriving behind a newer movement packet are valid; duplicates/replays are not. Histories survive rematches.

The Phase 3 timestamp bounds remain: at most 1,000 ms old and at most 150 ms in the future relative to server receipt. Duel responses must also be timestamped at or after this duel's start, and comply with its reaction/receive windows. An out-of-window or malformed packet is rejected, not promoted to a valid win. Already-consumed sequences cannot be retried. `clock:ping/pong` continues to synchronize server-epoch timestamps.

Fairness assumes honest phones with reasonably synchronized clocks. Clients can misreport their physical motion or timestamps; clock sync is not proof of either. Downlink cue delay, asymmetric latency, clock-estimation error and network stalls still affect results. The bounded grace lets a slower-arriving packet with an earlier valid action timestamp win, but packets outside the validation/receive windows cannot be recovered. Validate these tolerances on actual cellular/Wi-Fi connections before enabling the feature.

## Existing outputs reused

- `Snapshot.duel`: `{a,b,stage}`; **a is the challenger, b is the original holder**. It exposes no timing schedule.
- `PlayerState.inDuel`: true only during READY/CUE, false during DONE.
- `PhoneState.duel`: participants only; `{stage,foul}` while active and `{stage:'done',foul,won}` for results. Outsiders receive `null`. `won` is false for both in a no-winner result. Ordinary `inRange` is false for everyone while the duel/result occupies the crown.
- `DUEL_START`, `DUEL_READY`, `DUEL_CUE`: `actorId=a`, `victimId=b`, unique `eventId`, and current `serverTime`. Only CUE reveals `cueAt`.
- `DUEL_FOUL`: `actorId` is the fouler, `victimId` the opponent. It does not itself award points.
- Successful challenger win: `CROWN_STOLEN` before `DUEL_RESULT`.
- `DUEL_RESULT`: original `actorId=a` and `victimId=b`, optional `winnerId`, `points`, `cueAt`, and optional winner `reactionMs`. The existing `replay` field carries a **timing summary**, `{a,b,aMs,bMs,frames:[]}`; there is no animated replay feature. Missing reactions/fouls have null timing. Track `DUEL_FOUL` to distinguish FOUL from TOO SLOW. Double fouls/inactivity have no `winnerId`, zero points and this timing summary.
- Cancellation: a single `DUEL_RESULT` with no winner, zero points and **no replay summary**, then `duel:null`. No bonus is awarded.

All gameplay outcomes are applied once by GameRoom. The existing broadcaster drains event queues and publishes phone/snapshot state. For an end/reset in the same update, old queued outputs precede the new lobby state. The host uses results for presentation only; it does not determine winners or scores.

## Proposed additive contract — Aryan approval required

**Proposal only; not added to `shared/events.ts` and not registered on Socket.IO:**

```ts
// Add to ClientToServerEvents only after agreement:
'input:duel:foul': (
  payload: { seq: number; ts: number },
  ack?: Ack<{ ok: true }>
) => void;
```

The phone reports its **own physical-stillness violation during READY**, once per violation/duel. `seq` comes from the same global action counter; `ts` is `ClockSync.serverNow()` at the violation, never the sensor sample's `performance.now()` value. Do not send another player ID or claim a violation on another phone.

The internal `GameRoom.reportDuelFoul` already validates shape, membership, enabled flag, phase, an independent increasing foul sequence history, the same epoch freshness bounds, active participation and this duel's timestamp bounds. During CUE it accepts a delayed report only if its timestamp was before the cue and receipt is before resolution. A repeated foul is rejected. It emits `DUEL_FOUL` and participates in the same result matrix. This handler is tested through direct server calls only; **physical stillness is not currently delivered over the network**. A zero movement vector never counts as proof of stillness.

After approval, the socket binding must derive identity from the existing membership map, pass server monotonic/epoch clocks, preserve optional acknowledgments, and route to that handler. No raw/untyped socket listener has been installed as a workaround.

### Aryan's phone changes

1. Render HOLD STILL / DRAW / DONE from participant `phone:state.duel` and the existing duel events.
2. During READY/CUE allow participant yanks despite `inRange:false`; otherwise retain the ordinary steal gate. Keep the initiating sensor spike from becoming an accidental second yank.
3. Use `DUEL_CUE.cueAt` and synchronized epoch timestamps. Submit only actual new reaction gestures; never manufacture a reaction from local elapsed time or the initiation gesture.
4. Integrate the agreed physical-stillness detector and proposed self-foul signal. Keep READY sensor history bounded and clear it on DONE, cancellation, disconnect and rematch.
5. Use `won`/`foul`, the result timing summary and cancellation semantics. Review the timing-summary reuse of `replay` as part of the handoff. Audio/haptics remain phone-owned.
6. Test four real phones, offset/jitter tolerance, early yanks/stillness violations, disconnects, a full round/rematch and at least ten consecutive duels before opting into production.

## Disconnects, round deadline and cleanup

A participant disconnect during READY/CUE cancels the duel, clears both frozen inputs and awards no automatic defense/steal points. A holder disconnect then follows the existing two-second crown-drop policy; a challenger disconnect preserves the connected holder's crown. No ownership is awarded to a disconnected player. Nonparticipant disconnects do not cancel the duel.

The 90-second timer continues throughout. If the round ends before resolution is processed, it cancels the duel and finalizes existing scores once, even if a reaction was already received. Late inputs are rejected. Rematch removes active/DONE state, frozen flags, duel displays, cooldowns and pending duel output while preserving sequence replay history. Disposal clears all duel state/output, and there are no duel timers to leak. Existing lobby cleanup, room expiration and host authorization remain in place.

## Verification

`tests/duel-engine.test.ts` covers the outcome matrix, private bounded READY timing, actual cue timestamps, receive grace, ties, delayed fouls, response bounds and cancellation. `tests/duel-gameplay.test.ts` covers the feature-off path, eligibility, freezes/continued movement, scoring, timestamp/sequence validation, immunity/cooldowns, disconnects in READY/CUE, deadline/rematch cleanup, isolation/disposal and ten consecutive resolutions. `tests/duel-sockets.test.ts` uses four real Socket.IO clients with controlled clocks to verify event ordering, state, timestamp-based results, match continuation and rematch. It also confirms the proposed foul socket event remains unbound.

Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:host`. Automated clocks and protocol clients do not constitute real-phone sensor or deployment verification. Keep Phase 3 enabled in production until the handoff blockers are resolved; review and merge through the team's normal workflow only after integration review.
