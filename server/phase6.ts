import { randomUUID } from 'node:crypto';
import { RULES } from '../shared/constants.js';
import type { GameEvent, PlayerState, Snapshot } from '../shared/events.js';

export const GEM_PICKUP_RADIUS = 28;
export function arenaBounds(scale: number, radius = 18) {
  const x = RULES.arenaWidth * (1 - scale) / 2, y = RULES.arenaHeight * (1 - scale) / 2;
  return { left: x + radius, right: RULES.arenaWidth - x - radius, top: y + radius, bottom: RULES.arenaHeight - y - radius };
}
export function clampPosition(position: { x: number; y: number }, scale: number, radius = 18): void {
  const b = arenaBounds(scale, radius);
  position.x = Math.max(b.left, Math.min(b.right, position.x));
  position.y = Math.max(b.top, Math.min(b.bottom, position.y));
}

/** Optional per-room rules. Deadlines are monotonic, with no independent timers. */
export class Phase6 {
  private wanted = new Map<string, { target: string; until: number }>();
  private gem: { x: number; y: number; until: number } | null = null;
  private spawnIndex = 0;
  lastStand = false;
  scale = 1;
  constructor(private players: Map<string, PlayerState>, private random: () => number) {}
  advance(now: number, playingAt: number, epoch: number, emit: (event: GameEvent) => void): void {
    for (const [id, wanted] of this.wanted) if (now >= wanted.until) this.clearWanted(id);
    const elapsed = now - playingAt;
    if (!this.lastStand && elapsed >= RULES.roundMs - RULES.lastStandMs) {
      this.lastStand = true;
      emit({ eventId: randomUUID(), type: 'LAST_STAND', serverTime: epoch });
    }
    const progress = Math.max(0, Math.min(1, (elapsed - (RULES.roundMs - RULES.lastStandMs)) / RULES.lastStandMs));
    this.scale = 1 - progress * (1 - RULES.lastStandScale);
    for (const player of this.players.values()) clampPosition(player, this.scale);
    if (this.gem && now >= this.gem.until) this.gem = null;
    // Skip expired spawns after a stall; preserve the original 25/50/75-second schedule.
    const index = Math.floor(elapsed / RULES.gemIntervalMs);
    if (index > this.spawnIndex) {
      this.spawnIndex = index;
      const scheduledAt = playingAt + index * RULES.gemIntervalMs;
      if (elapsed < RULES.roundMs && now < scheduledAt + RULES.gemLifetimeMs) {
        const bounds = arenaBounds(this.scale, GEM_PICKUP_RADIUS);
        const unit = () => { const n = this.random(); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5; };
        this.gem = { x: bounds.left + unit() * (bounds.right - bounds.left),
          y: bounds.top + unit() * (bounds.bottom - bounds.top), until: scheduledAt + RULES.gemLifetimeMs };
        emit({ eventId: randomUUID(), type: 'GEM_SPAWN', x: this.gem.x, y: this.gem.y, serverTime: epoch });
      }
    }
    if (this.gem) clampPosition(this.gem, this.scale, GEM_PICKUP_RADIUS);
  }
  collect(): { player: PlayerState; x: number; y: number } | undefined {
    if (!this.gem) return;
    const gem = this.gem;
    const distance = (p: PlayerState) => Math.hypot(p.x - gem.x, p.y - gem.y);
    const candidates = [...this.players.values()].filter(p => p.connected && !p.inDuel && distance(p) <= GEM_PICKUP_RADIUS);
    candidates.sort((a, b) => distance(a) - distance(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (!candidates[0]) return;
    this.gem = null;
    return { player: candidates[0], x: gem.x, y: gem.y };
  }
  steal(thief: string, victim: string, now: number): boolean {
    const wanted = this.wanted.get(thief);
    const revenge = wanted?.target === victim && now < wanted.until;
    if (revenge) this.clearWanted(thief);
    this.wanted.set(victim, { target: thief, until: now + RULES.revengeMs });
    this.players.get(victim)!.wantedId = thief;
    return revenge;
  }
  private clearWanted(id: string): void {
    this.wanted.delete(id);
    const player = this.players.get(id); if (player) player.wantedId = null;
  }
  clearPlayer(id: string): void {
    this.clearWanted(id);
    for (const [owner, wanted] of this.wanted) if (wanted.target === id) this.clearWanted(owner);
  }
  gemSnapshot(now: number): Snapshot['gem'] {
    return this.gem ? { x: this.gem.x, y: this.gem.y, expiresMs: Math.max(0, this.gem.until - now) } : null;
  }
  finish(): void {
    for (const id of this.wanted.keys()) this.clearWanted(id);
    this.gem = null; this.lastStand = false;
  }
  clear(): void { this.finish(); this.scale = 1; this.spawnIndex = 0; }
}
