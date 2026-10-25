import { RULES } from '../../shared/constants.js';
interface LabelInput { id: string; x: number; y: number; width: number; height: number }
interface LabelBox { x: number; y: number; width: number; height: number }
/** Stable, bounded label placement for a crowded eight-player arena. */
export function layoutPlayerLabels(players: LabelInput[]): Map<string, LabelBox> {
  const placed = new Map<string, LabelBox>();
  for (const player of [...players].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const width = Math.min(RULES.arenaWidth - 12, player.width + 8), height = player.height + 4;
    let fallback: LabelBox | undefined;
    search: for (let row = 0; row < 18; row++) for (const side of [0, -1, 1]) {
      const offset = row % 2 ? 37 + Math.floor(row / 2) * height : -37 - row / 2 * height;
      const box = { x: Math.max(6, Math.min(RULES.arenaWidth - width - 6, player.x - width / 2 + side * (width + 6))),
        y: Math.max(4, Math.min(RULES.arenaHeight - height - 4, player.y + offset - height / 2)), width, height };
      fallback ??= box;
      const overlaps = [...placed.values()].some(other => box.x < other.x + other.width && box.x + box.width > other.x && box.y < other.y + other.height && box.y + box.height > other.y);
      if (!overlaps) { placed.set(player.id, box); break search; }
    }
    if (!placed.has(player.id)) placed.set(player.id, fallback!);
  }
  return placed;
}
