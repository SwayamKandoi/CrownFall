import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import type { ActionError, ClientToServerEvents, CreateResult, JoinResult, ServerToClientEvents, Snapshot } from '../../shared/events.js';
import { createApp } from '../../server/app.js';

export type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function success<T>(result: T | ActionError): T {
  assert.ok(!('error' in (result as object)), JSON.stringify(result));
  return result as T;
}
export function errorCode(result: unknown): string | undefined {
  return (result as ActionError)?.error?.code;
}
export function rawAck(socket: Client, event: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Ack timeout: ' + event)), 1500);
    const emit = socket.emit.bind(socket) as unknown as (event: string, payload: unknown, ack: (result: unknown) => void) => void;
    emit(event, payload, result => { clearTimeout(timeout); resolve(result); });
  });
}
export function waitSnapshot(socket: Client, predicate: (state: Snapshot) => boolean, timeoutMs = 5000): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('state:snapshot', receive); reject(new Error('Snapshot condition timed out.')); }, timeoutMs);
    function receive(state: Snapshot) {
      if (predicate(state)) { clearTimeout(timer); socket.off('state:snapshot', receive); resolve(state); }
    }
    socket.on('state:snapshot', receive);
  });
}
export async function harness(t: TestContext, options: Parameters<typeof createApp>[0] = {}) {
  const server = createApp(options);
  const clients: Client[] = [];
  t.after(async () => {
    clients.forEach(socket => socket.disconnect());
    await new Promise<void>(resolve => server.io.close(() => resolve()));
  });
  server.http.listen(0, '127.0.0.1');
  await once(server.http, 'listening');
  const origin = 'http://127.0.0.1:' + (server.http.address() as { port: number }).port;
  async function connect() {
    const socket: Client = io(origin, { transports: ['websocket'], reconnection: false, timeout: 1500 });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve); socket.once('connect_error', reject);
    });
    return socket;
  }
  async function room(count = 4) {
    const host = await connect();
    const created: CreateResult = success(await host.timeout(1500).emitWithAck('room:create'));
    const players: { socket: Client; identity: JoinResult }[] = [];
    for (let i = 0; i < count; i++) {
      const socket = await connect();
      const identity = success(await socket.timeout(1500).emitWithAck('room:join', { roomCode: created.roomCode, name: 'Player ' + i }));
      players.push({ socket, identity });
    }
    return { host, created, players };
  }
  return { ...server, clients, origin, connect, room };
}
