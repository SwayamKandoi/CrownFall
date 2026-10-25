import { RULES } from '../shared/constants.js';

export function holdPoints(heldMs: number): number {
  return Math.floor((heldMs + 1e-7) / RULES.holdPointMs);
}
export function holderSpeed(heldMs: number): number {
  return Math.max(RULES.holderMinSpeed, RULES.holderSpeed - RULES.holderSlowdown * heldMs / 1000);
}
