// Initial contract proposal. Coordinate changes with Aryan before feature work.
export const RULES = {
  arenaWidth: 960, arenaHeight: 540, minPlayers: 2, maxPlayers: 8,
  playerSpeed: 210, holderSpeed: 175, holderSlowdown: 3, holderMinSpeed: 130,
  crownPickupRadius: 35, duelRange: 85, roundMs: 90_000, countdownMs: 3_000,
  rushMs: 15_000, lastStandMs: 15_000, lastStandScale: 0.7,
  duelReadyMinMs: 1_000, duelReadyMaxMs: 2_500, duelTimeoutMs: 1_500,
  immunityMs: 2_000, challengerCooldownMs: 2_500, revengeMs: 12_000,
  gemIntervalMs: 25_000, gemLifetimeMs: 8_000, gemPoints: 5,
  holdPointMs: 500, stealPoints: 3, revengePoints: 6, defendPoints: 2,
  replayMs: 2_000, replaySpeed: 0.4, disconnectDropMs: 2_000,
  simulationHz: 30, snapshotHz: 30, inputHz: 20,
} as const;
export const PLAYER_COLORS = ['#ff6b6b', '#5eead4', '#a78bfa', '#facc15', '#38bdf8', '#fb923c', '#f472b6', '#a3e635'] as const;
