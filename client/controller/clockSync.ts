import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/events.js';

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Estimates server-clock offset with clock:ping / clock:pong.
 * offset = serverTime - localTime, taken from the lowest-RTT sample in a burst
 * (least affected by network jitter). Duels use serverNow() for fair timestamps.
 */
export class ClockSync {
  offset = 0;
  rtt = Infinity;
  private samples: { rtt: number; offset: number }[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private readonly onPong = ({ t0, ts }: { t0: number; ts: number }) => {
    const now = Date.now();
    const rtt = now - t0;
    if (rtt < 0 || rtt > 5000) return;
    this.samples.push({ rtt, offset: ts - (t0 + rtt / 2) });
    if (this.samples.length > 12) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset;
    this.rtt = best.rtt;
  };

  constructor(private socket: GameSocket) {
    socket.on('clock:pong', this.onPong);
  }

  /** Fire a burst of pings now, then one every `everyMs` to track drift. */
  start(everyMs = 3000): void {
    this.stop();
    for (let i = 0; i < 6; i++) setTimeout(() => this.ping(), i * 120);
    this.timer = setInterval(() => this.ping(), everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.stop();
    this.socket.off('clock:pong', this.onPong);
  }

  /** Current time in server epoch milliseconds. */
  serverNow(): number {
    return Date.now() + this.offset;
  }

  private ping(): void {
    if (this.socket.connected) this.socket.emit('clock:ping', { t0: Date.now() });
  }
}
