import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright-core';
import { io } from 'socket.io-client';
import { RULES } from '../../shared/constants.js';
import { createApp } from '../../server/app.js';
import { success, waitSnapshot, type Client } from './socketHarness.js';

/** Built host + real sockets, with a controllable server clock and no sensor emulation. */
export async function duelBrowserSmoke(browser: Browser, phase6Enabled = false): Promise<void> {
  let now = 0;
  const epoch = 1_800_000_000_000;
  const server = createApp({ duelsEnabled: true, phase6Enabled, random: () => 1, now: () => now, epochNow: () => epoch + now,
    clientDir: fileURLToPath(new URL('../../dist/client/', import.meta.url)) });
  const clients: Client[] = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    server.http.listen(0, '127.0.0.1'); await once(server.http, 'listening');
    const origin = 'http://127.0.0.1:' + (server.http.address() as { port: number }).port;
    await page.goto(origin + '/host');
    await page.getByText('Server connected', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Create a room' }).click();
    const code = await page.locator('.cf-room-code strong').innerText();
    const room = server.rooms.rooms.get(code)!;
    const ids: string[] = [];
    for (const name of (phase6Enabled ? ['Ruby', 'Mint', 'Violet', 'Gold', 'Sky', 'Ember', 'Rose', 'Lime'] : ['Ruby', 'Mint', 'Violet', 'Gold'])) {
      const socket: Client = io(origin, { transports: ['websocket'], reconnection: false });
      clients.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
      const joined = success(await socket.timeout(1500).emitWithAck('room:join', { roomCode: code, name }));
      ids.push(joined.playerId);
      success(await socket.timeout(1500).emitWithAck('player:ready', { calibrated: true }));
    }
    ids.forEach((id, i) => Object.assign(room.players.get(id)!, { x: [480, 550, 700, 800, 180, 320, 640, 780][i], y: i < 4 ? 270 : 420 }));
    await page.getByRole('button', { name: 'Start the arena' }).click();
    await page.locator('.cf-countdown').waitFor();
    let update = waitSnapshot(clients[0], s => s.phase === 'playing'); now = phase6Enabled ? 16000 : 3000 + RULES.rushMs; await update;
    await page.getByRole('button', { name: 'Arena is live' }).waitFor();
    if (phase6Enabled) {
      // Record a real two-second authoritative approach, sampled while the simulated phone moves.
      for (let i = 0; i < 20; i++) {
        success(await clients[1].timeout(1500).emitWithAck('input:move', { seq: 100 + i, x: -0.1, y: 0 }));
        const tick = room.game.tick; update = waitSnapshot(clients[0], state => state.tick > tick); now += 100; await update;
      }
    }
    const challengerX = room.players.get(ids[1])!.x;
    success(await clients[2].timeout(1500).emitWithAck('input:move', { seq: 1, x: 1, y: 0 }));
    success(await clients[1].timeout(1500).emitWithAck('input:yank', { seq: 1, ts: epoch + now }));
    await page.locator('.cf-duel h2').filter({ hasText: 'HOLD STILL' }).waitFor();
    update = waitSnapshot(clients[0], s => s.players[2].x > 700); now = 3100 + RULES.rushMs;
    const ready = await update;
    assert.equal(ready.players[0].x, 480); assert.equal(ready.players[1].x, challengerX);
    assert.equal(ready.players.filter(p => p.inDuel).length, 2);
    assert.ok((await page.locator('.cf-duel-rivals').innerText()).includes('Mint'));
    await page.screenshot({ path: 'dist/verification/host-duel-ready.png', fullPage: true });
    update = waitSnapshot(clients[0], s => s.duel?.stage === 'cue'); now = 5500 + RULES.rushMs; await update;
    await page.locator('.cf-duel h2').filter({ hasText: 'DRAW!' }).waitFor();
    await page.screenshot({ path: 'dist/verification/host-duel-cue.png', fullPage: true });
    now = 5800 + RULES.rushMs;
    success(await clients[0].timeout(1500).emitWithAck('input:yank', { seq: 1, ts: epoch + 5750 + RULES.rushMs }));
    success(await clients[1].timeout(1500).emitWithAck('input:yank', { seq: 2, ts: epoch + 5600 + RULES.rushMs }));
    update = waitSnapshot(clients[0], s => s.duel?.stage === 'done'); now = 7250 + RULES.rushMs; await update;
    await page.locator('.cf-duel h2').filter({ hasText: 'Mint wins!' }).waitFor();
    assert.deepEqual(await page.locator('.cf-duel-times span').allTextContents(), ['100 ms', '250 ms']);
    assert.match(await page.locator('.cf-duel p').innerText(), /Mint takes the crown.*\+3/);
    await page.locator('.cf-roster li.is-holder').filter({ hasText: 'Mint' }).waitFor();
    if (phase6Enabled) {
      await page.locator('.cf-replay').filter({ hasText: 'SLOW MOTION' }).waitFor();
      assert.match(await page.locator('.cf-replay').innerText(), /100 ms/);
      await page.setViewportSize({ width: 1280, height: 720 });
      assert.equal(await page.locator('.cf-roster li').count(), 8);
      const replayBox = await page.locator('.cf-replay').boundingBox();
      assert.ok(replayBox && replayBox.y + replayBox.height <= 720, 'eight-player replay fits below scoreboard');
      await page.screenshot({ path: 'dist/verification/phase6-replay.png', fullPage: true });
      success(await clients[2].timeout(1500).emitWithAck('input:move', { seq: 2, x: 1, y: 0 }));
      const x = room.players.get(ids[2])!.x; update = waitSnapshot(clients[0], state => state.players[2].x > x); now += 100; await update;
    }
    await page.screenshot({ path: 'dist/verification/host-duel-result.png', fullPage: true });
    await page.setViewportSize({ width: 760, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: 'dist/verification/host-duel-narrow.png', fullPage: true });
    update = waitSnapshot(clients[0], s => s.duel === null); now = 8250 + RULES.rushMs; await update;
    await page.locator('.cf-duel').waitFor({ state: 'detached' });
    // Consecutive duel: a premature yank fouls, and the holder defends without a reaction.
    now = 9250 + RULES.rushMs;
    success(await clients[0].timeout(1500).emitWithAck('input:yank', { seq: 2, ts: epoch + now }));
    await page.locator('.cf-duel h2').filter({ hasText: 'HOLD STILL' }).waitFor();
    if (phase6Enabled) assert.equal(await page.locator('.cf-replay').count(), 0, 'live duel takes priority');
    now = 9350 + RULES.rushMs; success(await clients[0].timeout(1500).emitWithAck('input:yank', { seq: 3, ts: epoch + now }));
    update = waitSnapshot(clients[0], s => s.duel?.stage === 'cue'); now = 11750 + RULES.rushMs; await update;
    update = waitSnapshot(clients[0], s => s.duel?.stage === 'done'); now = 13500 + RULES.rushMs; await update;
    await page.locator('.cf-duel-times').filter({ hasText: 'FOUL' }).waitFor();
    assert.match(await page.locator('.cf-duel p').innerText(), /Mint keeps the crown.*\+2/);
    assert.match(await page.locator('.cf-duel-times').innerText(), /TOO SLOW/);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: 'dist/verification/host-duel-foul.png', fullPage: true });
    // Third duel cancels on a challenger disconnect; no frozen/display state survives.
    now = 15500 + RULES.rushMs;
    success(await clients[0].timeout(1500).emitWithAck('input:yank', { seq: 4, ts: epoch + now }));
    await page.locator('.cf-duel h2').filter({ hasText: 'HOLD STILL' }).waitFor();
    update = waitSnapshot(clients[1], s => s.duel === null && !s.players[0].connected);
    clients[0].disconnect(); const cancelled = await update;
    assert.ok(cancelled.players.every(p => !p.inDuel));
    await page.locator('.cf-duel').waitFor({ state: 'detached' });
    update = waitSnapshot(clients[1], s => s.phase === 'ended'); now = 93000; await update;
    await page.locator('.cf-results h2').filter({ hasText: 'Mint' }).waitFor();
    if (phase6Enabled) {
      assert.match(await page.locator('.cf-end-stats').innerText(), /100 ms/);
      assert.match(await page.locator('.cf-play-of-game').innerText(), /Mint/);
      assert.equal(await page.locator('.cf-replay').count(), 0);
    }
    await page.getByRole('button', { name: 'Rematch - return to lobby' }).click();
    await page.getByText('0 ready', { exact: false }).waitFor();
    assert.equal(await page.locator('.cf-duel').count(), 0);
    assert.equal(await page.locator('canvas').count(), 1);
    assert.deepEqual(errors, []);
    console.log('PASS: ' + (phase6Enabled ? 'Phase 6 replay and statistics; ' : '') + 'opt-in duel host READY/CUE/DONE, reaction times, foul/timeout labels, crown transfer/defense, moving outsiders, cancellation, round ending and rematch; one canvas, no browser errors.');
  } finally {
    clients.forEach(client => client.disconnect());
    await page.close();
    await new Promise<void>(resolve => server.io.close(() => resolve()));
  }
}
