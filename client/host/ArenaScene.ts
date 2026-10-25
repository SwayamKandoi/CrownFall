import Phaser from 'phaser';
import { RULES } from '../../shared/constants.js';
import type { Snapshot } from '../../shared/events.js';
import { SnapshotBuffer } from './interpolation.js';

interface Avatar { root: Phaser.GameObjects.Container; label: Phaser.GameObjects.Text; ready: Phaser.GameObjects.Arc; halo: Phaser.GameObjects.Arc; color: number }
export class ArenaScene extends Phaser.Scene {
  private buffer = new SnapshotBuffer();
  private avatars = new Map<string, Avatar>();
  private crown?: Phaser.GameObjects.Graphics;
  constructor() { super('CrownfallArena'); }
  accept(snapshot: Snapshot): void { this.buffer.push(snapshot); }
  create(): void {
    const graphics = this.add.graphics();
    graphics.fillStyle(0x111c2a).fillRoundedRect(0, 0, 960, 540, 12);
    graphics.lineStyle(1, 0x243449, 0.5);
    for (let x = 60; x < 960; x += 60) graphics.lineBetween(x, 18, x, 522);
    for (let y = 60; y < 540; y += 60) graphics.lineBetween(18, y, 942, y);
    graphics.lineStyle(2, 0x5b7087).strokeRoundedRect(18, 18, 924, 504, 14);
    graphics.lineStyle(1, 0xcaa65e, 0.25).strokeCircle(480, 270, 62);
    graphics.lineStyle(1, 0xcaa65e, 0.15).strokeCircle(480, 270, 85);
    this.crown = this.add.graphics().setDepth(10).setPosition(480, 270);
    this.crown.fillStyle(0xf2ca78).fillPoints([
      new Phaser.Geom.Point(-18, -12), new Phaser.Geom.Point(-9, -4), new Phaser.Geom.Point(0, -19),
      new Phaser.Geom.Point(9, -4), new Phaser.Geom.Point(18, -12), new Phaser.Geom.Point(14, 9),
      new Phaser.Geom.Point(-14, 9),
    ], true);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => { this.buffer.clear(); this.avatars.clear(); });
  }
  update(): void {
    const state = this.buffer.sample();
    if (!state) return;
    this.crown?.setPosition(state.crown.x, state.crown.y - (state.crown.heldBy ? 22 : 0))
      .setAlpha(state.phase === 'lobby' || state.phase === 'countdown' ? 0.4 : 1);
    const ids = new Set(state.players.map(p => p.id));
    for (const [id, avatar] of this.avatars) if (!ids.has(id)) { avatar.root.destroy(); this.avatars.delete(id); }
    for (const player of state.players) {
      let avatar = this.avatars.get(player.id);
      if (!avatar) {
        const color = Phaser.Display.Color.HexStringToColor(player.color).color;
        const shadow = this.add.ellipse(0, 21, 34, 10, 0x000000, 0.35);
        const halo = this.add.circle(0, 0, 24).setStrokeStyle(1, color, 0.4);
        const body = this.add.circle(0, 0, 18, color).setStrokeStyle(2, 0xffffff, 0.8);
        const eyes = this.add.text(0, -3, '• •', { fontSize: '13px', fontFamily: 'system-ui', color: '#10202b' }).setOrigin(0.5);
        const label = this.add.text(0, -37, player.name, { fontSize: '13px', fontFamily: 'system-ui', color: '#f4f5fa', backgroundColor: '#111c2a' }).setOrigin(0.5);
        const ready = this.add.circle(18, -16, 4, 0x78dab3).setStrokeStyle(1, 0x111c2a);
        avatar = { root: this.add.container(player.x, player.y, [shadow, halo, body, eyes, label, ready]), label, ready, halo, color };
        this.avatars.set(player.id, avatar);
      }
      avatar.root.setPosition(player.x, player.y).setAlpha(player.connected ? 1 : 0.35);
      avatar.label.setText(player.name + (player.connected ? '' : ' · offline'));
      const halfLabel = avatar.label.width / 2 + 6;
      avatar.label.setPosition(
        Math.max(halfLabel, Math.min(RULES.arenaWidth - halfLabel, player.x)) - player.x,
        player.y < 54 ? 37 : -37,
      );
      avatar.ready.setVisible(Boolean(state.phase === 'lobby' && player.connected && player.ready));
      avatar.halo.setStrokeStyle(player.holding ? 4 : 1, player.holding ? 0xf2ca78 : avatar.color, player.holding ? 1 : 0.4);
    }
  }
}

export function createArena(parent: HTMLElement) {
  const scene = new ArenaScene();
  const game = new Phaser.Game({
    type: Phaser.AUTO, parent, width: RULES.arenaWidth, height: RULES.arenaHeight,
    backgroundColor: '#111c2a', scene: [scene], banner: false,
    render: { antialias: true },
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    audio: { noAudio: true },
  });
  return { accept: (state: Snapshot) => scene.accept(state), destroy: () => game.destroy(true) };
}
