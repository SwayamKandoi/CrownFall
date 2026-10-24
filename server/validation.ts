export function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
export function roomCode(value: unknown): value is string { return typeof value === 'string' && /^[A-HJ-NP-Z2-9]{5}$/.test(value); }
/** Independent per-connection budgets keep movement from blocking clock sync. */
export class RateLimit {
  private tokens: number;
  private updatedAt: number;
  constructor(private rate: number, private capacity: number, now = performance.now()) {
    this.tokens = capacity; this.updatedAt = now;
  }
  take(now = performance.now()): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.updatedAt) * this.rate / 1000);
    this.updatedAt = now;
    if (this.tokens < 1) return false;
    this.tokens--; return true;
  }
}
