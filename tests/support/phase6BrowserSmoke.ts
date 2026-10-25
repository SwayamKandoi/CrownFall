import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright-core';
import { io } from 'socket.io-client';
import { createApp } from '../../server/app.js';
import { AVATARS } from '../../shared/constants.js';
import { success, waitSnapshot, type Client } from './socketHarness.js';

export async function phase6BrowserSmoke(browser: Browser): Promise<void> {
  let now = 0;
  const epoch = 1_800_000_000_000;
  const server = createApp({ phase6Enabled: true, random: () => 0.8, now: () => now, epochNow: () => epoch + now,
    clientDir: fileURLToPath(new URL('../../dist/client/', import.meta.url)) });
  const clients: Client[] = [], ids: string[] = [];
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const sizes = [[1920, 1080], [1280, 720], [1024, 768]];
  async function layouts(stage: string) {
    for (const [width, height] of sizes) {
      const refreshed = waitSnapshot(clients[0], () => true); now += 50; await refreshed;
      await page.setViewportSize({ width, height });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow');
      assert.equal(await page.locator('.cf-roster li').count(), 8);
      for (const row of await page.locator('.cf-roster li').all()) {
        assert.ok(await row.isVisible());
        const box = await row.boundingBox(); assert.ok(box && box.y >= 0 && box.y + box.height <= height, 'all eight roster rows fit the screen');
      }
      assert.equal(await page.locator('canvas').count(), 1);
      await page.screenshot({ path: `dist/verification/phase6-${stage}-${width}.png`, fullPage: true });
    }
    const refreshed = waitSnapshot(clients[0], () => true); now += 50; await refreshed;
    await page.getByText('Server connected', { exact: true }).waitFor();
  }
  try {
    server.http.listen(0, '127.0.0.1'); await once(server.http, 'listening');
    const origin = 'http://127.0.0.1:' + (server.http.address() as { port: number }).port;
    await page.goto(origin + '/host');
    await page.getByText('Server connected', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Create a room' }).click();
    const code = await page.locator('.cf-room-code strong').innerText();
    const room = server.rooms.rooms.get(code)!;
    for (const [i, avatar] of Object.keys(AVATARS).entries()) {
      const socket: Client = io(origin, { transports: ['websocket'], reconnection: false }); clients.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
      const joined = success(await socket.timeout(1500).emitWithAck('room:join', { roomCode: code, name: ['Alexandra the Fox', 'Frederick the Frog', 'Penelope the Panda', 'Leonardo the Lion', 'Olivia the Octopus', 'Theodore the Tiger', 'Robert the Robot', 'Gabriella the Ghost'][i], avatar }));
      ids.push(joined.playerId);
      success(await socket.timeout(1500).emitWithAck('player:ready', { calibrated: true }));
    }
    await page.getByText('8 ready', { exact: false }).waitFor();
    await layouts('lobby');
    const startedAt = now;
    ids.forEach((id, i) => Object.assign(room.players.get(id)!, { x: i < 2 ? 480 + i * 40 : 160 + (i - 2) * 125, y: i < 2 ? 270 : 420 }));
    await page.getByRole('button', { name: 'Start the arena' }).click();
    let update = waitSnapshot(clients[0], s => s.phase === 'playing'); now = startedAt + 18000; await update;
    success(await clients[1].timeout(1500).emitWithAck('input:yank', { seq: 1, ts: epoch + now }));
    await page.locator('.cf-wanted').filter({ hasText: 'Frederick the Frog' }).waitFor();
    now = startedAt + 20500; success(await clients[0].timeout(1500).emitWithAck('input:yank', { seq: 1, ts: epoch + now }));
    await page.locator('.cf-revenge-banner').filter({ hasText: '+6' }).waitFor();
    update = waitSnapshot(clients[0], s => Boolean(s.gem)); now = startedAt + 28000; const gem = (await update).gem!;
    await page.locator('.cf-gem-status').waitFor();
    await layouts('gem-wanted');
    Object.assign(room.players.get(ids[2])!, { x: gem.x, y: gem.y });
    update = waitSnapshot(clients[0], s => s.gem === null); now += 50; await update;
    await page.locator('.cf-game-banner').filter({ hasText: '+5' }).waitFor();
    update = waitSnapshot(clients[0], s => s.lastStand); now = startedAt + 78000; await update;
    await page.locator('.cf-last-stand').filter({ hasText: '2× POINTS' }).waitFor();
    update = waitSnapshot(clients[0], s => s.arenaScale <= 0.96); now = startedAt + 80000; await update;
    await layouts('last-stand');
    update = waitSnapshot(clients[0], s => s.phase === 'ended'); now = startedAt + 93000; await update;
    await page.getByRole('heading', { name: 'Final rankings' }).waitFor();
    await layouts('results');
    await page.getByRole('button', { name: 'Rematch - return to lobby' }).click();
    await page.getByText('0 ready', { exact: false }).waitFor();
    assert.equal(await page.locator('.cf-wanted,.cf-gem-status,.cf-last-stand,.cf-results').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: Phase 6 eight avatars, Wanted/revenge, gem/pickup, Last Stand contraction, results and rematch at 1920x1080, 1280x720, 1024x768; no browser errors.');
  } finally {
    clients.forEach(client => client.disconnect()); await page.close();
    await new Promise<void>(resolve => server.io.close(() => resolve()));
  }
}
