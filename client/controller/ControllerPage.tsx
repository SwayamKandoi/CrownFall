import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, JoinResult, PhoneState, ActionError, GameEnded, GameEvent } from '../../shared/events.js';
import { requestMotionPermission, onOrientation, onMotion, YankDetector, buzz, vibrate, type Orientation } from './sensors.js';
import { calibrate, tiltToMove, type Calibration } from './calibration.js';
import { ClockSync } from './clockSync.js';
import './controller.css';

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type Step = 'name' | 'joining' | 'motion' | 'calibrate' | 'ready' | 'in-game';
type Flash = null | 'gold' | 'red' | 'yank' | 'miss';

const SEND_HZ = 20;
const SMOOTHING = 0.35;        // EMA factor: 0 = frozen, 1 = raw
const YANK_THRESHOLD = 18;     // m/s²; real yanks ~40, tilting < 6 (5 iPhones tested)
const YANK_COOLDOWN_MS = 600;
const TILT_FREEZE_MS = 300;    // a yank jerks the phone; don't let it steer
const NAME_KEY = 'crownfall:name';

function readName(): string {
  try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; }
}
function saveName(n: string) {
  try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode */ }
}

export function ControllerPage() {
  const roomCode = (location.pathname.split('/')[2] ?? '').toUpperCase();
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState(readName);
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
      if (next.phase === 'playing' && prev?.phase === 'playing') {
        if (!prev.holding && next.holding) { showFlash('gold', '👑 GOT IT', 900); vibrate([40, 40, 80]); }
        if (prev.holding && !next.holding) { showFlash('red', 'STOLEN!', 1100); vibrate([120, 60, 120]); }
      }
      if (next.phase === 'countdown' && prev?.phase !== 'countdown') setEnded(undefined);
      if (next.phase === 'lobby' && prev && prev.phase !== 'lobby') { setEnded(undefined); setReadySent(false); } // rematch: ready up again
    });
    s.on('game:event', (e: GameEvent) => {
      window.dispatchEvent(new CustomEvent('crownfall:game-event', { detail: e }));
      const me = playerRef.current?.playerId;
      if (e.type === 'CROWN_STOLEN' && e.actorId === me) { showFlash('gold', '🫳 YOU STOLE IT', 1000); vibrate([40, 40, 80]); }
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
      if (!inGame || !yank.push(m)) return;
      lastYank.current = performance.now();
      const ps = phoneRef.current;
      if (ps?.phase !== 'playing') return;
      if (!ps.inRange) { showFlash('miss', 'Too far', 400); return; }
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
    setError(''); setStep('joining'); saveName(n);
    socket.current?.timeout(5000).emit('room:join', { roomCode, name: n }, (err: Error | null, res: JoinResult | ActionError) => {
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
        <span>CROWNFALL</span>
        <span className="ctl-room">{roomCode || '—'}</span>
        <span className={connected ? 'ctl-on' : 'ctl-off'}>{connected ? `● ${rtt ?? '…'}ms` : '● offline'}</span>
      </header>

      {banner && <div className="ctl-banner">{banner}</div>}

      {(step === 'name' || step === 'joining') && (
        <section>
          <h1>Join Crownfall</h1>
          <input className="ctl-name" value={name} maxLength={20} placeholder="Your name" autoFocus
            onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && join()} />
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

      {step === 'in-game' && !ended && (
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

function Pad({ move, small }: { move: { x: number; y: number }; small?: boolean }) {
  return (
    <div className={`ctl-pad ${small ? 'ctl-pad-sm' : ''}`}>
      <div className="ctl-dot" style={{ left: `${50 + move.x * 45}%`, top: `${50 + move.y * 45}%` }} />
    </div>
  );
}
