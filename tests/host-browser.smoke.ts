// Optional real-browser check: npm run build && npm run test:host (requires Microsoft Edge).
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, Snapshot } from '../shared/events.js';
import { success } from './support/socketHarness.js';
import { createApp } from '../server/app.js';
import { RULES } from '../shared/constants.js';
import { duelBrowserSmoke } from './support/duelBrowserSmoke.js';

let clockOffset = 0;
const now = () => performance.now() + clockOffset;
const server = createApp({ now, epochNow: () => Date.now() + clockOffset,
  clientDir: fileURLToPath(new URL('../dist/client/', import.meta.url)) });
const clients: Socket<ServerToClientEvents, ClientToServerEvents>[] = [];
const streams: ReturnType<typeof setInterval>[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const deadline = setTimeout(() => {
  console.error('Host browser smoke exceeded 90 seconds.');
  void server.io.close();
  void browser?.close();
}, 90_000);
try {
  server.http.listen(0, '127.0.0.1');
  await once(server.http, 'listening');
  const port = (server.http.address() as { port: number }).port;
  const origin = 'http://127.0.0.1:' + port;
  assert.ok((await (await fetch(origin + '/health')).json()).ok);
  for (const path of ['/host', '/play/ABCDE', '/sensor-test']) assert.equal((await fetch(origin + path)).status, 200);
  browser = await chromium.launch({ headless: true,
    ...(process.env.CROWNFALL_BROWSER_EXECUTABLE ? { executablePath: process.env.CROWNFALL_BROWSER_EXECUTABLE } : { channel: 'msedge' }),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(origin + '/host');
  await page.getByText('Server connected', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Create a room' }).click();
  const code = await page.locator('.cf-room-code strong').innerText();
  assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);
  await page.locator('canvas').waitFor();
  await page.getByRole('img', { name: 'QR join link for room ' + code }).waitFor();
  assert.equal(await page.locator('canvas').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Start the arena' }).isDisabled(), true);
  let latest: Snapshot | undefined;
  for (let i = 0; i < 4; i++) {
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(origin, { transports: ['websocket'], reconnection: false, timeout: 2000 });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    success(await socket.timeout(2000).emitWithAck('room:join', { roomCode: code, name: 'Browser Player ' + (i + 1) }));
    socket.on('state:snapshot', state => { latest = state; });
    if (i < RULES.minPlayers - 1) success(await socket.timeout(2000).emitWithAck('player:ready', { calibrated: true }));
  }
  await page.getByText((RULES.minPlayers - 1) + ' ready', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Start the arena' }).isDisabled(), true);
  for (const client of clients.slice(RULES.minPlayers - 1)) success(await client.timeout(2000).emitWithAck('player:ready', { calibrated: true }));
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.cf-start')?.disabled);
  await mkdir('dist/verification', { recursive: true });
  await page.screenshot({ path: 'dist/verification/host-lobby.png', fullPage: true });
  await page.getByRole('button', { name: 'Start the arena' }).click();
  await page.locator('.cf-countdown').waitFor();
  await page.getByRole('button', { name: 'Arena is live' }).waitFor();
  const initial = structuredClone(latest!);
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  clients.forEach((socket, i) => {
    let seq = 0;
    const send = () => socket.volatile.emit('input:move', { seq: seq++, x: directions[i][0], y: directions[i][1] });
    send(); streams.push(setInterval(send, 50));
  });
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.ok(latest!.players.every((p, i) => Math.hypot(p.x - initial.players[i].x, p.y - initial.players[i].y) > 40));
  await page.screenshot({ path: 'dist/verification/host-playing.png', fullPage: true });
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.screenshot({ path: 'dist/verification/host-narrow.png', fullPage: true });
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.width + 1, 'Narrow layout overflow: ' + JSON.stringify(dimensions));
  streams.forEach(clearInterval);
  for (const client of clients) success(await client.timeout(2000).emitWithAck('input:move', { seq: 10000, x: 0, y: 0 }));
  const room = server.rooms.rooms.get(code)!;
  const ids = latest!.players.map(p => p.id);
  // Arrange a close encounter without sensor emulation; exercise pickup and steal via the real server.
  Object.assign(room.players.get(ids[0])!, { x: 480, y: 270 });
  Object.assign(room.players.get(ids[1])!, { x: 520, y: 270 });
  await page.locator('.cf-game-banner').filter({ hasText: 'claimed the crown' }).waitFor();
  await page.locator('.cf-roster li.is-holder').filter({ hasText: 'Browser Player 1' }).waitFor();
  await page.getByRole('heading', { name: 'Live scoreboard' }).waitFor();
  assert.match(await page.locator('.cf-round-timer').innerText(), /^1:[0-5][0-9]$/);
  await page.setViewportSize({ width: 1440, height: 1000 });
  clockOffset += RULES.rushMs; // Advance past Rush without a real-time wait.
  success(await clients[1].timeout(2000).emitWithAck('input:yank', { seq: 10001, ts: Date.now() + clockOffset }));
  await page.locator('.cf-game-banner').filter({ hasText: 'stole the crown' }).waitFor();
  await page.locator('.cf-roster li.is-holder').filter({ hasText: 'Browser Player 2' }).waitFor();
  await page.screenshot({ path: 'dist/verification/host-steal.png', fullPage: true });
  clients[0].disconnect();
  await page.getByText('Offline', { exact: true }).waitFor();
  clockOffset += RULES.roundMs;
  await page.getByRole('heading', { name: 'Final rankings' }).waitFor();
  await page.locator('.cf-results h2').filter({ hasText: 'Browser Player 2' }).waitFor();
  assert.equal(await page.locator('.cf-round-timer').innerText(), '0:00');
  await page.screenshot({ path: 'dist/verification/host-results.png', fullPage: true });
  await page.getByRole('button', { name: 'Rematch - return to lobby' }).click();
  await page.getByText('0 ready', { exact: false }).waitFor();
  assert.equal(await page.locator('.cf-results').count(), 0);
  await page.getByRole('img', { name: 'QR join link for room ' + code }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Start the arena' }).isDisabled(), true);
  assert.ok(clients.slice(1).every(client => client.connected));
  for (const client of clients.slice(1)) success(await client.timeout(2000).emitWithAck('player:ready', { calibrated: true }));
  await page.getByRole('button', { name: 'Start the arena' }).click();
  await page.locator('.cf-countdown').waitFor();
  await page.getByRole('button', { name: 'Arena is live' }).waitFor();
  assert.equal(await page.locator('canvas').count(), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: built host routes, QR, two-player minimum, four independent players, pickup/steal banners, scoreboard, timer, winners, rematch, responsive layout and one Phaser canvas; no browser runtime errors.');
  console.log('Screenshots: dist/verification/host-{lobby,playing,narrow,steal,results}.png');
  await duelBrowserSmoke(browser);
} finally {
  clearTimeout(deadline);
  streams.forEach(clearInterval);
  clients.forEach(client => client.disconnect());
  await browser?.close();
  await new Promise<void>(resolve => server.io.close(() => resolve()));
}
