import Phaser from 'phaser';
import { RULES, AVATARS, isAvatarId } from '../../shared/constants.js';
import type { GameEvent, Snapshot } from '../../shared/events.js';
import { SnapshotBuffer } from './interpolation.js';
import { layoutPlayerLabels } from './labelLayout.js';

interface Avatar { root: Phaser.GameObjects.Container; label: Phaser.GameObjects.Text; ready: Phaser.GameObjects.Arc; halo: Phaser.GameObjects.Arc; color: number; bornAt: number }
/** Overshoot-then-settle curve for the join pop. */
const easeOutBack = (t: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2; };
export class ArenaScene extends Phaser.Scene {
  private buffer = new SnapshotBuffer();
  private avatars = new Map<string, Avatar>();
  private crown?: Phaser.GameObjects.Graphics;
  private crownGlow?: Phaser.GameObjects.Arc;
  private duelShade?: Phaser.GameObjects.Rectangle;
  private lastDuelStage?: string;
  private taunts = new Map<string, { text: Phaser.GameObjects.Text; until: number }>();
  private pendingTaunts: string[] = [];
  private finale?: Phaser.GameObjects.Graphics;
  private gem?: Phaser.GameObjects.Graphics;
  private sparkles = new Set<Phaser.GameObjects.Text>();
  private labelLines?: Phaser.GameObjects.Graphics;
  private spot?: Phaser.GameObjects.Graphics;
  private trail: { x: number; y: number; t: number }[] = [];
  private trailHolder?: string;
  private latest?: Snapshot;
  constructor() { super('CrownfallArena'); }
  accept(snapshot: Snapshot): void { this.buffer.push(snapshot); }
  create(): void {
    const graphics = this.add.graphics().setDepth(-2);
    this.spot = this.add.graphics().setDepth(-1);
    graphics.fillStyle(0x0b0d1a).fillRoundedRect(0, 0, 960, 540, 12);
    graphics.lineStyle(1, 0x1c2140, 0.6);
    for (let x = 60; x < 960; x += 60) graphics.lineBetween(x, 18, x, 522);
    for (let y = 60; y < 540; y += 60) graphics.lineBetween(18, y, 942, y);
    graphics.lineStyle(3, 0xf6ce68, 0.35).strokeRoundedRect(18, 18, 924, 504, 14);
    graphics.lineStyle(2, 0xf6ce68, 0.25).strokeCircle(480, 270, 62);
    graphics.lineStyle(1, 0xcaa65e, 0.15).strokeCircle(480, 270, 85);
    this.duelShade = this.add.rectangle(480, 270, 960, 540, 0x050a12, 0).setDepth(2);
    this.finale = this.add.graphics().setDepth(1);
    this.labelLines = this.add.graphics().setDepth(4);
    this.gem = this.add.graphics().setDepth(5).setVisible(false);
    this.gem.fillStyle(0x5eead4, 0.15).fillCircle(0, 0, 28);
    this.gem.fillStyle(0x6fffe5).fillPoints([new Phaser.Geom.Point(0, -18), new Phaser.Geom.Point(14, 0),
      new Phaser.Geom.Point(0, 18), new Phaser.Geom.Point(-14, 0)], true);
    this.gem.lineStyle(2, 0xffffff, 0.9).lineBetween(0, -14, -9, 0).lineBetween(-9, 0, 0, 12);
    this.crownGlow = this.add.circle(480, 270, 34, 0xf6ce68, 0.22).setDepth(9).setBlendMode(Phaser.BlendModes.ADD);
    this.crown = this.add.graphics().setDepth(10).setPosition(480, 270).setScale(1.35);
    this.crown.fillStyle(0xf6ce68).fillPoints([
      new Phaser.Geom.Point(-18, -12), new Phaser.Geom.Point(-9, -4), new Phaser.Geom.Point(0, -19),
      new Phaser.Geom.Point(9, -4), new Phaser.Geom.Point(18, -12), new Phaser.Geom.Point(14, 9),
      new Phaser.Geom.Point(-14, 9),
    ], true);
    this.crown.lineStyle(2, 0x7a5a10, 0.9).strokePoints([
      new Phaser.Geom.Point(-18, -12), new Phaser.Geom.Point(-9, -4), new Phaser.Geom.Point(0, -19),
      new Phaser.Geom.Point(9, -4), new Phaser.Geom.Point(18, -12), new Phaser.Geom.Point(14, 9),
      new Phaser.Geom.Point(-14, 9),
    ], true);
    this.crown.fillStyle(0xff6b6b).fillCircle(0, 2, 3);
    const onGameEvent = (e: Event) => {
      const detail = (e as CustomEvent<GameEvent>).detail;
      if (detail?.type === 'TAUNT' && detail.actorId) this.pendingTaunts.push(detail.actorId);
      const at = (id?: string) => this.latest?.players.find(p => p.id === id);
      if (detail?.type === 'CROWN_STOLEN' || detail?.type === 'REVENGE') {
        const thief = at(detail.actorId), victim = at(detail.victimId);
        if (victim) this.burst(victim.x, victim.y, 0xff6b6b, 14);
        if (thief) { this.burst(thief.x, thief.y, 0xf6ce68, 26); this.floatText(thief.x, thief.y - 40, `${detail.type === 'REVENGE' ? 'REVENGE ' : ''}+${detail.points ?? 3}`, detail.type === 'REVENGE' ? '#ff9db0' : '#f6ce68'); }
        this.cameras.main.shake(260, 0.012);
      }
      if (detail?.type === 'CROWN_PICKUP') { const p = at(detail.actorId); if (p) this.burst(p.x, p.y, 0xf6ce68, 12); }
      if (detail?.type === 'GEM_TAKEN' && detail.x !== undefined && detail.y !== undefined) {
        const sparkle = this.add.text(detail.x, detail.y, `✦ +${detail.points}`, { fontSize: '25px', color: '#8ffff0', fontFamily: 'system-ui', fontStyle: 'bold' }).setOrigin(0.5).setDepth(21);
        this.sparkles.add(sparkle);
        this.tweens.add({ targets: sparkle, y: detail.y - 50, alpha: 0, duration: 900,
          onComplete: () => { this.sparkles.delete(sparkle); sparkle.destroy(); } });
      }
    };
    window.addEventListener('crownfall:game-event', onGameEvent);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => { window.removeEventListener('crownfall:game-event', onGameEvent); this.buffer.clear(); this.avatars.clear(); this.taunts.clear(); this.pendingTaunts = []; this.lastDuelStage = undefined; this.trail = []; this.latest = undefined; });
  }
  private burst(x: number, y: number, color: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2, dist = 40 + Math.random() * 70;
      const dot = this.add.circle(x, y, 2 + Math.random() * 3.5, color, 1).setDepth(22).setBlendMode(Phaser.BlendModes.ADD);
      this.tweens.add({ targets: dot, x: x + Math.cos(angle) * dist, y: y + Math.sin(angle) * dist, alpha: 0, scale: 0.3,
        duration: 450 + Math.random() * 300, ease: 'Cubic.easeOut', onComplete: () => dot.destroy() });
    }
    const ring = this.add.circle(x, y, 20).setStrokeStyle(4, color, 0.9).setDepth(21);
    this.tweens.add({ targets: ring, scale: 3.2, alpha: 0, duration: 450, ease: 'Cubic.easeOut', onComplete: () => ring.destroy() });
  }
  private floatText(x: number, y: number, text: string, color: string): void {
    const label = this.add.text(x, y, text, { fontSize: '34px', fontFamily: 'Bungee, "Arial Black", Impact, sans-serif', color, stroke: '#0b0d1a', strokeThickness: 6 })
      .setOrigin(0.5).setDepth(23).setScale(0.4);
    this.tweens.add({ targets: label, scale: 1.15, duration: 180, ease: 'Back.easeOut' });
    this.tweens.add({ targets: label, y: y - 60, alpha: 0, delay: 650, duration: 600, ease: 'Cubic.easeIn', onComplete: () => label.destroy() });
  }
  private showTaunt(id: string, now: number): void {
    this.taunts.get(id)?.text.destroy();
    const lines = ['Too slow!', 'Catch me!', 'Nice try!', 'Come get it!', 'Yawn…', 'Is that all?'];
    const text = this.add.text(0, 0, lines[Math.floor(Math.random() * lines.length)], {
      fontSize: '15px', fontFamily: 'system-ui', fontStyle: 'bold', color: '#10202b', backgroundColor: '#f4f5fa', padding: { x: 8, y: 4 },
    }).setOrigin(0.5).setDepth(20);
    this.taunts.set(id, { text, until: now + 2200 });
  }
  /** Gold floor light under the crown holder plus a short fading trail behind them. */
  private drawHolderGlow(state: Snapshot): void {
    const g = this.spot; if (!g) return;
    g.clear();
    const holder = state.phase === 'playing' ? state.players.find(p => p.holding) : undefined;
    const now = this.time.now;
    if (!holder) { this.trail = []; this.trailHolder = undefined; return; }
    if (holder.id !== this.trailHolder) { this.trail = []; this.trailHolder = holder.id; }
    const last = this.trail[this.trail.length - 1];
    if (!last || now - last.t > 30) this.trail.push({ x: holder.x, y: holder.y, t: now });
    this.trail = this.trail.filter(p => now - p.t < 420);
    for (const p of this.trail) {
      const k = 1 - (now - p.t) / 420;
      g.fillStyle(0xf6ce68, 0.22 * k).fillCircle(p.x, p.y, 8 + 18 * k);
    }
    const pulse = 1 + 0.08 * Math.sin(now / 200);
    g.fillStyle(0xf6ce68, 0.10).fillCircle(holder.x, holder.y + 6, 72 * pulse);
    g.fillStyle(0xf6ce68, 0.16).fillCircle(holder.x, holder.y + 6, 50 * pulse);
    g.lineStyle(3, 0xf6ce68, 0.55).strokeCircle(holder.x, holder.y + 6, 40 * pulse);
  }
  update(): void {
    const state = this.buffer.sample();
    if (!state) return;
    this.latest = state;
    this.drawHolderGlow(state);
    this.finale?.clear();
    if (state.arenaScale < 1 || state.lastStand) {
      const left = RULES.arenaWidth * (1 - state.arenaScale) / 2;
      const top = RULES.arenaHeight * (1 - state.arenaScale) / 2;
      this.finale?.fillStyle(0x4c1020, 0.5).fillRect(0, 0, left, 540).fillRect(960 - left, 0, left, 540)
        .fillRect(left, 0, 960 - left * 2, top).fillRect(left, 540 - top, 960 - left * 2, top);
      this.finale?.lineStyle(4, 0xff657c, 0.75 + 0.2 * Math.sin(this.time.now / 240))
        .strokeRect(left + 2, top + 2, 956 - left * 2, 536 - top * 2);
    }
    this.gem?.setVisible(Boolean(state.gem && state.phase === 'playing'));
    if (state.gem) this.gem?.setPosition(state.gem.x, state.gem.y).setScale(1 + 0.08 * Math.sin(this.time.now / 180));
    if (state.phase !== 'playing') for (const sparkle of this.sparkles) { this.tweens.killTweensOf(sparkle); sparkle.destroy(); this.sparkles.delete(sparkle); }
    const active = state.duel && state.duel.stage !== 'done';
    this.duelShade?.setFillStyle(0x050a12, active ? 0.35 : 0);
    if (state.duel?.stage === 'cue' && this.lastDuelStage !== 'cue') this.cameras.main.flash(110, 255, 220, 150);
    this.lastDuelStage = state.duel?.stage;
    const crownY = state.crown.y - (state.crown.heldBy ? 24 : 0) + 3 * Math.sin(this.time.now / 260);
    const crownAlpha = state.phase === 'lobby' || state.phase === 'countdown' ? 0.4 : 1;
    this.crown?.setPosition(state.crown.x, crownY).setAlpha(crownAlpha).setScale(state.crown.heldBy ? 1.05 : 1.35);
    this.crownGlow?.setPosition(state.crown.x, crownY).setAlpha(crownAlpha)
      .setScale(1 + 0.15 * Math.sin(this.time.now / 300) + (state.crown.heldBy ? 0.25 : 0));
    const now = this.time.now;
    for (const id of this.pendingTaunts.splice(0)) this.showTaunt(id, now);
    const ids = new Set(state.players.map(p => p.id));
    for (const [id, avatar] of this.avatars) if (!ids.has(id)) { avatar.root.destroy(); this.avatars.delete(id); }
    for (const player of state.players) {
      let avatar = this.avatars.get(player.id);
      if (!avatar) {
        const color = Phaser.Display.Color.HexStringToColor(player.color).color;
        const shadow = this.add.ellipse(0, 29, 46, 12, 0x000000, 0.4);
        const halo = this.add.circle(0, 0, 31).setStrokeStyle(1, color, 0.4);
        const emoji = isAvatarId(player.avatar) ? AVATARS[player.avatar] : null;
        const body = emoji ? this.add.circle(0, 0, 26, 0x151935).setStrokeStyle(4, color, 1) : this.add.circle(0, 0, 24, color).setStrokeStyle(2, 0xffffff, 0.8);
        const eyes = emoji
          ? this.add.text(0, 2, emoji, { fontSize: '32px', fontFamily: '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif' }).setOrigin(0.5)
          : this.add.text(0, -3, '• •', { fontSize: '13px', fontFamily: 'system-ui', color: '#10202b' }).setOrigin(0.5);
        const label = this.add.text(0, -54, player.name, { fontSize: '15px', fontFamily: 'system-ui', fontStyle: 'bold', color: '#f4f1e8', backgroundColor: '#0b0d1acc', padding: { x: 5, y: 2 } }).setOrigin(0.5);
        const ready = this.add.circle(22, -21, 5, 0x78dab3).setStrokeStyle(1, 0x111c2a);
        avatar = { root: this.add.container(player.x, player.y, [shadow, halo, body, eyes, label, ready]), label, ready, halo, color, bornAt: now };
        this.avatars.set(player.id, avatar);
      }
      avatar.root.setPosition(player.x, player.y).setAlpha(player.connected ? 1 : 0.35);
      const taunt = this.taunts.get(player.id);
      if (taunt) {
        const left = taunt.until - now;
        if (left <= 0) { taunt.text.destroy(); this.taunts.delete(player.id); }
        else taunt.text.setPosition(player.x, player.y - 74 - (left < 500 ? (500 - left) / 25 : 0)).setAlpha(Math.min(1, left / 500));
      }
      const duelist = state.duel?.a === player.id || state.duel?.b === player.id;
      const born = Math.min(1, (now - avatar.bornAt) / 420);
      avatar.root.setDepth(duelist ? 3 : 0).setScale(easeOutBack(born) * (duelist && state.duel?.stage === 'ready' ? 1 + 0.035 * Math.sin(this.time.now / 170) : 1));
      avatar.label.setText(player.name + (player.connected ? '' : ' · offline'));
      avatar.ready.setVisible(Boolean(state.phase === 'lobby' && player.connected && player.ready));
      avatar.halo.setStrokeStyle(duelist || player.holding ? 4 : 1, player.holding ? 0xf6ce68 : duelist ? 0xffffff : avatar.color, duelist || player.holding ? 1 : 0.4);
    }
    const labels = layoutPlayerLabels(state.players.map(p => ({ ...p, width: this.avatars.get(p.id)!.label.width, height: this.avatars.get(p.id)!.label.height })));
    this.labelLines?.clear().lineStyle(1, 0x91a8c0, 0.4);
    for (const player of state.players) {
      const box = labels.get(player.id)!, x = box.x + box.width / 2, y = box.y + box.height / 2;
      this.avatars.get(player.id)!.label.setPosition(x - player.x, y - player.y);
      if (Math.abs(x - player.x) > 5 || Math.abs(y - player.y) > 60) this.labelLines?.lineBetween(player.x, player.y - 30, x, y + box.height / 2);
    }
  }
}

export function createArena(parent: HTMLElement) {
  const scene = new ArenaScene();
  const game = new Phaser.Game({
    type: Phaser.AUTO, parent, width: RULES.arenaWidth, height: RULES.arenaHeight,
    backgroundColor: '#0b0d1a', scene: [scene], banner: false,
    render: { antialias: true },
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    audio: { noAudio: true },
  });
  return { accept: (state: Snapshot) => scene.accept(state), destroy: () => game.destroy(true) };
}
