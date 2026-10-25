import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, JoinResult, PhoneState, ActionError, GameEnded, GameEvent } from '../../shared/events.js';
import { requestMotionPermission, onOrientation, onMotion, YankDetector, buzz, vibrate, type Orientation } from './sensors.js';
import { calibrate, tiltToMove, type Calibration } from './calibration.js';
import { ClockSync } from './clockSync.js';
import { AVATARS, DEFAULT_AVATAR, isAvatarId, type AvatarId } from '../../shared/constants.js';
import './controller.css';

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type Step = 'name' | 'joining' | 'motion' | 'calibrate' | 'ready' | 'in-game';
type Flash = null | 'gold' | 'red' | 'yank' | 'miss';

const SEND_HZ = 20;
const SMOOTHING = 0.6;         // EMA factor: higher = snappier. 0.35 took ~265 ms to reach 90% of a tilt; 0.6 takes ~125 ms
const YANK_THRESHOLD = 18;     // m/s²; real yanks ~40, tilting < 6 (5 iPhones tested)
const YANK_COOLDOWN_MS = 600;
const TILT_FREEZE_MS = 300;    // a yank jerks the phone; don't let it steer
const NAME_KEY = 'crownfall:name';
const AVATAR_KEY = 'crownfall:avatar';
const DUEL_ARM_MS = 800;        // ignore the tail of the yank that started the duel
const STILL_WARN = 4;           // m/s² during HOLD STILL that earns a (local-only) warning

interface DuelInfo { role: 'challenger' | 'holder'; myMs: number | null; oppMs: number | null; iFouled: boolean; oppFouled: boolean; winnerId?: string; resolved: boolean }

function readName(): string {
  try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; }
}
function saveName(n: string) {
  try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode */ }
}
function readAvatar(): AvatarId {
  try { const v = localStorage.getItem(AVATAR_KEY); return isAvatarId(v) ? v : DEFAULT_AVATAR; } catch { return DEFAULT_AVATAR; }
}
function saveAvatar(a: AvatarId) {
  try { localStorage.setItem(AVATAR_KEY, a); } catch { /* private mode */ }
}

export function ControllerPage() {
  const roomCode = (location.pathname.split('/')[2] ?? '').toUpperCase();
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState(readName);
  const [avatar, setAvatar] = useState<AvatarId>(readAvatar);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [player, setPlayer] = useState<JoinResult>();
  const [phone, setPhone] = useState<PhoneState>();
  const [ended, setEnded] = useState<GameEnded>();
  const [readySent, setReadySent] = useState(false);
  const [move, setMove] = useState({ x: 0, y: 0 });
  const [rtt, setRtt] = useState<number>();
  const [flash, setFlash] = useState<Flash>(null);
  const [banner, setBanner] = useState('');
  const [duelInfo, setDuelInfo] = useState<DuelInfo>();
  const [stillWarn, setStillWarn] = useState(false);

  const socket = useRef<GameSocket>();
  const clock = useRef<ClockSync>();
  const orient = useRef<Orientation>();
  const cal = useRef<Calibration>();
  const calBuffer = useRef<Orientation[] | null>(null);
  const smooth = useRef({ x: 0, y: 0 });
  const seq = useRef(0);
  const phoneRef = useRef<PhoneState>();
  const playerRef = useRef<JoinResult>();
  const lastYank = useRef(-Infinity);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>();
  const duelRef = useRef<{ startedAt: number; reacted: boolean } | null>(null);
  const duelInfoRef = useRef<DuelInfo>();
  const stillWarnRef = useRef(false);

  function showFlash(kind: Flash, text = '', ms = 700) {
    clearTimeout(flashTimer.current);
    setFlash(kind); setBanner(text);
    flashTimer.current = setTimeout(() => { setFlash(null); setBanner(''); }, ms);
  }

  // Socket lifetime = page lifetime.
  useEffect(() => {
    const s: GameSocket = io();
    socket.current = s;
    clock.current = new ClockSync(s);
    s.on('connect', () => { setConnected(true); clock.current?.start(); });
    s.on('disconnect', () => setConnected(false));
    s.on('phone:state', next => {
      const prev = phoneRef.current;
      phoneRef.current = next;
      setPhone(next);
      const pd = prev?.duel?.stage, nd = next.duel?.stage;
      if (nd === 'ready' && pd !== 'ready') {
        duelRef.current = { startedAt: performance.now(), reacted: false };
        stillWarnRef.current = false; setStillWarn(false);
        clearTimeout(flashTimer.current); setFlash(null); setBanner('');
        vibrate(40);
      }
      if (nd === 'cue' && pd !== 'cue') vibrate(120);
      if (nd === 'done' && pd !== 'done') vibrate(next.duel?.won ? [40, 40, 120] : [200]);
      if (!nd && pd) { duelRef.current = null; }
      if (next.phase === 'playing' && prev?.phase === 'playing' && !next.duel && !prev.duel) {
        if (!prev.holding && next.holding) { showFlash('gold', '👑 GOT IT', 900); vibrate([40, 40, 80]); }
        if (prev.holding && !next.holding) { showFlash('red', 'STOLEN!', 1100); vibrate([120, 60, 120]); }
      }
      if (next.phase === 'countdown' && prev?.phase !== 'countdown') setEnded(undefined);
      if (next.phase === 'lobby' && prev && prev.phase !== 'lobby') { setEnded(undefined); setReadySent(false); } // rematch: ready up again
    });
    s.on('game:event', (e: GameEvent) => {
      window.dispatchEvent(new CustomEvent('crownfall:game-event', { detail: e }));
      const me = playerRef.current?.playerId;
      const inDuel = Boolean(phoneRef.current?.duel) || e.type.startsWith('DUEL_');
      if (e.type === 'CROWN_STOLEN' && e.actorId === me && !inDuel) { showFlash('gold', '🫳 YOU STOLE IT', 1000); vibrate([40, 40, 80]); }
      if (!me) return;
      const updateDuel = (patch: Partial<DuelInfo>) => {
        if (!duelInfoRef.current) return;
        duelInfoRef.current = { ...duelInfoRef.current, ...patch };
        setDuelInfo(duelInfoRef.current);
      };
      if (e.type === 'DUEL_START' && (e.actorId === me || e.victimId === me)) {
        duelInfoRef.current = { role: e.actorId === me ? 'challenger' : 'holder', myMs: null, oppMs: null, iFouled: false, oppFouled: false, resolved: false };
        setDuelInfo(duelInfoRef.current);
      }
      if (e.type === 'DUEL_FOUL' && duelInfoRef.current && !duelInfoRef.current.resolved) {
        if (e.actorId === me) updateDuel({ iFouled: true });
        else if (e.victimId === me) updateDuel({ oppFouled: true });
      }
      if (e.type === 'DUEL_RESULT' && (e.actorId === me || e.victimId === me)) {
        const r = e.replay;
        const mine = r ? (r.a === me ? r.aMs : r.bMs) : null;
        const theirs = r ? (r.a === me ? r.bMs : r.aMs) : null;
        updateDuel({ myMs: mine, oppMs: theirs, winnerId: e.winnerId, resolved: true });
      }
    });
    s.on('game:ended', result => { clearTimeout(flashTimer.current); setFlash(null); setBanner(''); setEnded(result); vibrate(200); });
    const rttId = setInterval(() => clock.current && Number.isFinite(clock.current.rtt) && setRtt(clock.current.rtt), 1000);
    return () => { clearInterval(rttId); clock.current?.dispose(); s.disconnect(); clearTimeout(flashTimer.current); };
  }, []);

  // Sensors run from calibration onward; inputs only go out once in-game.
  const sensorsOn = step === 'calibrate' || step === 'ready' || step === 'in-game';
  useEffect(() => {
    if (!sensorsOn) return;
    const inGame = step === 'in-game';
    const offO = onOrientation(o => {
      orient.current = o;
      calBuffer.current?.push(o);
    });
    const yank = new YankDetector(YANK_THRESHOLD, YANK_COOLDOWN_MS);
    const offM = onMotion(m => {
      const fired = yank.push(m);
      if (!inGame) return;
      const duel = phoneRef.current?.duel;
      const d = duelRef.current;
      if (duel && (duel.stage === 'ready' || duel.stage === 'cue') && d) {
        const armed = performance.now() - d.startedAt > DUEL_ARM_MS;
        // Local-only nudge; the server judges fouls purely by yank timing.
        if (duel.stage === 'ready' && armed && m.magnitude > STILL_WARN && !stillWarnRef.current) { stillWarnRef.current = true; setStillWarn(true); }
        if (fired && (armed || duel.stage === 'cue') && !d.reacted) {
          d.reacted = true;
          lastYank.current = performance.now();
          socket.current?.emit('input:yank', { seq: ++seq.current, ts: clock.current?.serverNow() ?? Date.now() });
        }
        return;
      }
      if (!fired) return;
      lastYank.current = performance.now();
      const ps = phoneRef.current;
      if (ps?.phase !== 'playing') return;
      if (!ps.inRange) { if (!ps.holding) showFlash('miss', 'Not in range', 400); return; }
      socket.current?.emit('input:yank', { seq: ++seq.current, ts: clock.current?.serverNow() ?? Date.now() });
      showFlash('yank', 'YANK!', 300);
      vibrate(60);
    });
    const sendId = setInterval(() => {
      if (!orient.current || !cal.current) return;
      const sm = smooth.current;
      if (performance.now() - lastYank.current > TILT_FREEZE_MS) {
        const raw = tiltToMove(orient.current, cal.current);
        sm.x += (raw.x - sm.x) * SMOOTHING;
        sm.y += (raw.y - sm.y) * SMOOTHING;
      }
      const x = Math.abs(sm.x) < 0.01 ? 0 : +sm.x.toFixed(3);
      const y = Math.abs(sm.y) < 0.01 ? 0 : +sm.y.toFixed(3);
      setMove({ x, y });
      const phase = phoneRef.current?.phase;
      if (inGame && (phase === 'playing' || phase === 'lobby')) socket.current?.volatile.emit('input:move', { seq: ++seq.current, x, y });
    }, 1000 / SEND_HZ);
    return () => { offO(); offM(); clearInterval(sendId); };
  }, [sensorsOn, step]);

  function join() {
    const n = name.trim();
    if (!/^[A-Z2-9]{5}$/.test(roomCode)) return setError('This link has no valid room code. Scan the QR again.');
    if (!n || n.length > 20) return setError('Pick a name, 1–20 characters.');
    setError(''); setStep('joining'); saveName(n); saveAvatar(avatar);
    socket.current?.timeout(5000).emit('room:join', { roomCode, name: n, avatar }, (err: Error | null, res: JoinResult | ActionError) => {
      if (err) { setStep('name'); return setError('Server did not answer. Check your connection and try again.'); }
      if ('error' in res) { setStep('name'); return setError(res.error.message); }
      playerRef.current = res;
      setPlayer(res);
      setStep('motion');
    });
  }

  async function enableMotion() {
    const pending = requestMotionPermission(); // must start inside the tap
    buzz(30);
    const p = await pending;
    if (p === 'granted') { setError(''); return setStep('calibrate'); }
    setError(p === 'insecure' ? 'Motion needs HTTPS.'
      : p === 'unsupported' ? 'This browser has no motion sensors.'
      : 'Motion was blocked. On iPhone: close this tab, reopen the link and tap Allow.');
  }

  function doCalibrate() {
    buzz(30);
    calBuffer.current = [];
    setTimeout(() => {
      const buf = calBuffer.current ?? [];
      calBuffer.current = null;
      if (!buf.length) return setError('No tilt data yet. Move the phone a little and try again.');
      cal.current = calibrate(buf);
      smooth.current = { x: 0, y: 0 };
      setError('');
      setStep(readySent ? 'in-game' : 'ready');
    }, 800);
  }

  function ready() {
    buzz(30);
    socket.current?.emit('player:ready', { calibrated: true }, res => {
      if (res && 'error' in res && res.error.code !== 'NOT_IMPLEMENTED') setError(res.error.message);
    });
    setReadySent(true);
    setStep('in-game');
  }

  const color = player?.color ?? '#f6ce68';
  const me = player?.playerId;
  const phase = phone?.phase;
  const holding = phase === 'playing' && phone?.holding;
  const rank = ended ? [...ended.scores].sort((a, b) => b.score - a.score).findIndex(s => s.playerId === me) + 1 : 0;
  const myScore = ended?.scores.find(s => s.playerId === me)?.score ?? phone?.score ?? 0;

  return (
    <main className={`ctl ${holding ? 'ctl-holding' : ''} ${flash ? `ctl-flash-${flash}` : ''}`} style={{ ['--pc' as string]: color }}>
      <header className="ctl-top">
        <span>{step !== 'name' && step !== 'joining' ? <span aria-hidden="true">{AVATARS[avatar]} </span> : null}CROWNFALL</span>
        <span className="ctl-room">{roomCode || '—'}</span>
        <span className={connected ? 'ctl-on' : 'ctl-off'}>{connected ? `● ${rtt ?? '…'}ms` : '● offline'}</span>
      </header>

      {banner && <div className="ctl-banner">{banner}</div>}

      {(step === 'name' || step === 'joining') && (
        <section>
          <h1>Join Crownfall</h1>
          <label className="ctl-label" htmlFor="ctl-name">Your name</label>
          <input id="ctl-name" className="ctl-name" value={name} maxLength={20} placeholder="Your name"
            onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && join()} />
          <p className="ctl-label">Pick your character</p>
          <div className="ctl-avatars" role="radiogroup" aria-label="Character">
            {(Object.keys(AVATARS) as AvatarId[]).map(id => (
              <button key={id} type="button" role="radio" aria-checked={avatar === id} aria-label={id}
                className={`ctl-avatar ${avatar === id ? 'is-picked' : ''}`} onClick={() => setAvatar(id)}>
                {AVATARS[id]}
              </button>
            ))}
          </div>
          <button onClick={join} disabled={step === 'joining' || !connected}>{step === 'joining' ? 'Joining…' : 'Join'}</button>
        </section>
      )}

      {step === 'motion' && (
        <section>
          <h1>Hi {name.trim()}</h1>
          <p>Crownfall uses your phone's motion sensors. Tilt to move, yank to steal.</p>
          <button onClick={enableMotion}>Enable Motion</button>
        </section>
      )}

      {step === 'calibrate' && (
        <section>
          <h1>Calibrate</h1>
          <p>Hold your phone the way you'll play: flat-ish, screen up. Keep it still and tap.</p>
          <button onClick={doCalibrate}>Calibrate</button>
        </section>
      )}

      {step === 'ready' && (
        <section>
          <Pad move={move} />
          <p>Tilt to test. The dot should follow you.</p>
          <button onClick={ready}>I'm ready</button>
          <button className="ctl-ghost" onClick={() => setStep('calibrate')}>Recalibrate</button>
        </section>
      )}

      {step === 'in-game' && ended && (
        <section className="ctl-ended">
          <p className="ctl-kicker">ROUND OVER</p>
          <h1>{ended.winnerIds.includes(me ?? '') ? '👑 You win!' : rank ? `#${rank}` : 'Round over'}</h1>
          <p className="ctl-score">{myScore}<span> pts</span></p>
          <ol className="ctl-board">
            {[...ended.scores].sort((a, b) => b.score - a.score).map(s => (
              <li key={s.playerId} className={s.playerId === me ? 'ctl-me' : ''}><span>{s.name}</span><b>{s.score}</b></li>
            ))}
          </ol>
          <p>Waiting for the host to start a rematch…</p>
        </section>
      )}

      {step === 'in-game' && !ended && phone?.duel && (
        <DuelScreen stage={phone.duel.stage} won={phone.duel.won} info={duelInfo} stillWarn={stillWarn} />
      )}

      {step === 'in-game' && !ended && !phone?.duel && (
        <section>
          {phase === 'playing' ? (
            <>
              <p className="ctl-kicker">{holding ? 'YOU HAVE THE CROWN' : phone?.inRange ? 'IN RANGE' : 'HUNT'}</p>
              <h1 className="ctl-status">{holding ? '👑 Run!' : phone?.inRange ? 'YANK NOW' : 'Get the crown'}</h1>
              <p className="ctl-score">{phone?.score ?? 0}<span> pts</span></p>
              {phone?.wantedName && <p>Wanted: <b>{phone.wantedName}</b></p>}
              <Pad move={move} small />
            </>
          ) : phase === 'countdown' ? (
            <>
              <p className="ctl-kicker">GET READY</p>
              <h1 className="ctl-status">Starting…</h1>
              <p>Hold your phone how you calibrated.</p>
            </>
          ) : readySent ? (
            <>
              <p className="ctl-kicker">LOBBY</p>
              <h1 className="ctl-status">You're in</h1>
              <p>Waiting for the host to start. Tilt to warm up.</p>
              <Pad move={move} small />
            </>
          ) : (
            <>
              <p className="ctl-kicker">REMATCH</p>
              <h1 className="ctl-status">Ready again?</h1>
              <button onClick={ready}>I'm ready</button>
            </>
          )}
          <button className="ctl-ghost" onClick={() => setStep('calibrate')}>Recalibrate</button>
        </section>
      )}

      {error && <p className="ctl-err">{error}</p>}
    </main>
  );
}

function DuelScreen({ stage, won, info, stillWarn }: { stage: 'ready' | 'cue' | 'done'; won?: boolean; info?: DuelInfo; stillWarn: boolean }) {
  const role = info?.role;
  if (stage === 'ready') return (
    <section className="ctl-duel">
      <p className="ctl-kicker">{role === 'holder' ? 'YOU\u2019VE BEEN CHALLENGED' : 'DUEL'}</p>
      <h1 className="ctl-duel-big">HOLD STILL…</h1>
      <p>{role === 'holder' ? 'Defend the crown. Yank the instant DRAW! appears.' : 'Yank the instant DRAW! appears. Too early is a foul.'}</p>
      {stillWarn && <p className="ctl-duel-warn">Steady! Yanking before DRAW is a foul.</p>}
    </section>
  );
  if (stage === 'cue') return (
    <section className="ctl-duel ctl-duel-cue">
      <h1 className="ctl-duel-draw">DRAW!</h1>
      <p className="ctl-duel-sub">Yank now</p>
    </section>
  );
  const ms = (v: number | null | undefined) => (v == null ? null : `${Math.round(v)} ms`);
  let title: string, detail: string;
  if (won) {
    title = role === 'challenger' ? 'CROWN STOLEN' : 'DEFENDED';
    detail = info?.oppFouled ? 'They yanked too early.' : info?.oppMs != null ? `${ms(info.myMs)} vs ${ms(info.oppMs)}` : ms(info?.myMs) ? `${ms(info?.myMs)} · they were too slow` : 'You win the draw.';
  } else if (info?.iFouled) {
    title = 'FOUL'; detail = 'You yanked before DRAW!';
  } else if (info && !info.winnerId) {
    title = 'NO WINNER'; detail = info.oppFouled ? 'Both of you jumped the gun.' : 'Nobody drew in time. The holder keeps the crown.';
  } else if (info?.myMs == null) {
    title = 'TOO SLOW'; detail = info?.oppMs != null ? `They drew in ${ms(info.oppMs)}` : 'You didn\u2019t yank in time.';
  } else {
    title = 'BEATEN'; detail = `${ms(info.myMs)} vs ${ms(info.oppMs)}`;
  }
  return (
    <section className={`ctl-duel ${won ? 'ctl-duel-win' : 'ctl-duel-lose'}`}>
      <p className="ctl-kicker">DUEL RESULT</p>
      <h1 className="ctl-duel-big">{title}</h1>
      <p className="ctl-duel-sub">{detail}</p>
    </section>
  );
}

function Pad({ move, small }: { move: { x: number; y: number }; small?: boolean }) {
  return (
    <div className={`ctl-pad ${small ? 'ctl-pad-sm' : ''}`}>
      <div className="ctl-dot" style={{ left: `${50 + move.x * 45}%`, top: `${50 + move.y * 45}%` }} />
    </div>
  );
}
