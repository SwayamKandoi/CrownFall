// Optional real-browser check: npm run build && npm run test:host (requires Microsoft Edge).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, Snapshot } from '../shared/events.js';
import { success } from './support/socketHarness.js';

const launchEnv: NodeJS.ProcessEnv = { ...process.env, PORT: '0' };
delete launchEnv.PUBLIC_ORIGIN;
const server = spawn(process.execPath, ['dist/server/index.js'], { env: launchEnv, stdio: ['ignore', 'pipe', 'pipe'] });
const clients: Socket<ServerToClientEvents, ClientToServerEvents>[] = [];
const streams: ReturnType<typeof setInterval>[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const deadline = setTimeout(() => {
  console.error('Host browser smoke exceeded 90 seconds.');
  server.kill();
  void browser?.close();
}, 90_000);
try {
  const port = await new Promise<number>((resolve, reject) => {
    let output = '';
    server.stdout.on('data', data => { output += String(data); const match = output.match(/listening on port (\d+)/); if (match) resolve(Number(match[1])); });
    server.stderr.on('data', data => console.error(String(data)));
    server.once('error', reject);
    server.once('exit', code => reject(new Error('Server exited early: ' + code)));
  });
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
    if (i < 3) success(await socket.timeout(2000).emitWithAck('player:ready', { calibrated: true }));
  }
  await page.getByText('3 ready', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Start the arena' }).isDisabled(), true);
  success(await clients[3].timeout(2000).emitWithAck('player:ready', { calibrated: true }));
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
  clients[0].disconnect();
  await page.getByText('Offline', { exact: true }).waitFor();
  assert.equal(await page.locator('canvas').count(), 1);
  assert.deepEqual(errors, []);
  console.log('PASS: production health/routes, QR, one Phaser canvas, readiness gate, countdown, four independent players, responsive layout and disconnect; no browser runtime errors.');
  console.log('Screenshots: dist/verification/host-{lobby,playing,narrow}.png');
} finally {
  clearTimeout(deadline);
  streams.forEach(clearInterval);
  clients.forEach(client => client.disconnect());
  await browser?.close();
  server.kill();
}
