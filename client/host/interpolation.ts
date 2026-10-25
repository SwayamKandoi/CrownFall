import type { Snapshot } from '../../shared/events.js';

/** Render ~50 ms behind receipt time, interpolate only positions, never predict game decisions. */
export class SnapshotBuffer {
  private frames: { at: number; state: Snapshot }[] = [];
  push(state: Snapshot, at = performance.now()): void {
    if (this.frames.length && state.tick < this.frames.at(-1)!.state.tick) return;
    if (state.phase === 'lobby' && this.frames.at(-1)?.state.phase !== 'lobby') this.clear();
    this.frames.push({ at, state });
    if (this.frames.length > 30) this.frames.shift();
  }
  sample(now = performance.now()): Snapshot | undefined {
    if (!this.frames.length) return undefined;
    const target = now - 50;
    let before = this.frames[0], after = this.frames.at(-1)!;
    for (const frame of this.frames) {
      if (frame.at <= target) before = frame;
      if (frame.at >= target) { after = frame; break; }
    }
    const amount = after.at > before.at ? Math.max(0, Math.min(1, (target - before.at) / (after.at - before.at))) : 1;
    const latest = this.frames.at(-1)!.state;
    const players = latest.players.map(player => {
      const from = before.state.players.find(p => p.id === player.id);
      const to = after.state.players.find(p => p.id === player.id);
      if (!from || !to) return { ...player };
      return { ...player, x: from.x + (to.x - from.x) * amount, y: from.y + (to.y - from.y) * amount };
    });
    // Ownership is always the latest server decision; attach its visual to the smoothed holder.
    const holder = players.find(p => p.id === latest.crown.heldBy);
    return { ...latest, players, crown: { ...latest.crown, ...(holder ? { x: holder.x, y: holder.y } : {}) } };
  }
  clear(): void { this.frames = []; }
}
