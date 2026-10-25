import type { GameEnded, GameEvent, Snapshot } from '../../shared/events.js';
import { RULES } from '../../shared/constants.js';
import { sfx } from '../audio/sfx.js';

/**
 * Big-screen announcer: speaks the big moments with the browser's built-in
 * speech synthesis and plays short synthesized sound effects. Presentation
 * only; it never decides anything. Browsers need one user click on the page
 * (Create room / Start) before audio is allowed, which the host flow provides.
 */
export class Announcer {
  muted = false;
  private names = new Map<string, string>();
  private lastPhase?: Snapshot['phase'];
  private rushCalled = false;
  private lastCallout = Number.POSITIVE_INFINITY;
  private voice?: SpeechSynthesisVoice;
  private readonly synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;

  constructor() {
    const pick = () => {
      const voices = this.synth?.getVoices() ?? [];
      this.voice = voices.find(v => /en-(US|GB)/i.test(v.lang) && /Google|Samantha|Daniel|Alex/i.test(v.name))
        ?? voices.find(v => /^en/i.test(v.lang));
    };
    pick();
    this.synth?.addEventListener?.('voiceschanged', pick);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    clearTimeout(this.pendingTimer);
    if (muted) this.synth?.cancel();
  }

  private name(id?: string): string { return (id && this.names.get(id)) || 'Someone'; }

  // Chrome quirks this works around:
  //  - an utterance that gets garbage-collected mid-speech never ends and wedges the queue,
  //    so we hold a reference to the current one;
  //  - speak() right after cancel() is sometimes dropped, so urgent lines wait a beat;
  //  - the engine can get stuck "speaking" or "paused" forever, so a watchdog resets it.
  private current?: SpeechSynthesisUtterance;
  private startedAt = 0;
  private pendingTimer?: ReturnType<typeof setTimeout>;

  /** urgent = interrupt whatever is being said (steals, duels, the winner). */
  say(text: string, urgent = false): void {
    const synth = this.synth;
    if (this.muted || !synth) return;
    const stuck = synth.speaking && performance.now() - this.startedAt > 6000;
    if (stuck || synth.paused) { synth.cancel(); synth.resume(); }
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.rate = 1.12; u.pitch = 1.05; u.volume = 1;
    u.onend = u.onerror = () => { if (this.current === u) this.current = undefined; };
    const go = () => {
      if (this.muted) return;
      this.current = u; this.startedAt = performance.now();
      synth.resume();
      synth.speak(u);
    };
    clearTimeout(this.pendingTimer);
    if (urgent && (synth.speaking || synth.pending)) {
      synth.cancel();
      this.pendingTimer = setTimeout(go, 80);
    } else if (synth.pending) {
      // Don't let a backlog build up: keep only the newest queued line.
      synth.cancel();
      this.pendingTimer = setTimeout(go, 80);
    } else go();
  }

  /** Call from a click so Chrome allows speech, and to un-wedge the engine before a new round. */
  prime(): void {
    if (!this.synth) return;
    this.synth.cancel(); this.synth.resume();
    this.current = undefined;
  }

  snapshot(state: Snapshot): void {
    for (const p of state.players) this.names.set(p.id, p.name);
    const phase = state.phase;
    if (phase !== this.lastPhase) {
      if (phase === 'countdown') { this.rushCalled = false; this.lastCallout = Number.POSITIVE_INFINITY; this.say('Three. Two. One.', true); if (!this.muted) sfx.countdown(); }
      if (phase === 'playing' && this.lastPhase === 'countdown') { this.say('Crownfall! Grab the crown!', true); if (!this.muted) sfx.start(); }
      this.lastPhase = phase;
    }
    if (phase !== 'playing') return;
    const elapsed = RULES.roundMs - state.remainingMs;
    if (!this.rushCalled && elapsed >= RULES.rushMs) { this.rushCalled = true; this.say('Steals unlocked. Hunt them down!'); }
    const seconds = Math.ceil(state.remainingMs / 1000);
    for (const mark of [30, 10]) {
      if (seconds <= mark && this.lastCallout > mark) { this.say(mark === 10 ? 'Ten seconds!' : 'Thirty seconds left!'); if (!this.muted) sfx.tick(); }
    }
    this.lastCallout = Math.min(this.lastCallout, seconds);
  }

  event(e: GameEvent): void {
    const quiet = this.muted;
    switch (e.type) {
      case 'CROWN_PICKUP': this.say(`${this.name(e.actorId)} has the crown!`); if (!quiet) sfx.pickup(); break;
      case 'CROWN_STOLEN': this.say(`${this.name(e.actorId)} steals the crown from ${this.name(e.victimId)}!`, true); if (!quiet) sfx.steal(); break;
      case 'CROWN_DROPPED': this.say('The crown is loose!'); if (!quiet) sfx.drop(); break;
      case 'DUEL_START': this.say(`Duel! ${this.name(e.actorId)} challenges ${this.name(e.victimId)}.`, true); if (!quiet) sfx.duel(); break;
      case 'DUEL_READY': this.say('Hold still.'); break;
      // Speech is too slow for the cue itself; the sound carries DRAW.
      case 'DUEL_CUE': if (!quiet) sfx.draw(); break;
      case 'DUEL_FOUL': this.say(`Foul by ${this.name(e.actorId)}!`, true); if (!quiet) sfx.foul(); break;
      case 'DUEL_RESULT':
        if (e.winnerId) this.say(`${this.name(e.winnerId)} wins the draw${e.reactionMs != null ? ` in ${Math.round(e.reactionMs)} milliseconds` : ''}!`, true);
        else this.say('No winner. The crown stays put.', true);
        break;
      case 'PLAYER_LEFT': break;
      default: break;
    }
  }

  ended(result: GameEnded): void {
    const winners = result.winnerIds.map(id => this.names.get(id) ?? result.scores.find(s => s.playerId === id)?.name ?? 'Someone');
    if (!this.muted) sfx.end();
    this.say(winners.length > 1 ? `Time! It's a tie between ${winners.join(' and ')}!` : `Time! ${winners[0] ?? 'Nobody'} wins Crownfall!`, true);
  }
}
