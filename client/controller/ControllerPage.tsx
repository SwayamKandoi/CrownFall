import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, JoinResult, PhoneState, ActionError } from '../../shared/events.js';
import { requestMotionPermission, onOrientation, onMotion, YankDetector, buzz, vibrate, type Orientation } from './sensors.js';
import { calibrate, tiltToMove, type Calibration } from './calibration.js';
import { ClockSync } from './clockSync.js';
import './controller.css';

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type Step = 'name' | 'joining' | 'motion' | 'calibrate' | 'ready' | 'waiting';

const SEND_HZ = 20;
const SMOOTHING = 0.35; // 0 = frozen, 1 = raw; exponential moving average
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
  const [move, setMove] = useState({ x: 0, y: 0 });
  const [rtt, setRtt] = useState<number>();
  const [yankFlash, setYankFlash] = useState(false);

  const socket = useRef<GameSocket>();
  const clock = useRef<ClockSync>();
  const orient = useRef<Orientation>();
  const cal = useRef<Calibration>();
  const calBuffer = useRef<Orientation[] | null>(null);
  const smooth = useRef({ x: 0, y: 0 });
  const seq = useRef(0);

  // Socket lifetime = page lifetime.
  useEffect(() => {
    const s: GameSocket = io();
    socket.current = s;
    clock.current = new ClockSync(s);
    s.on('connect', () => { setConnected(true); clock.current?.start(); });
    s.on('disconnect', () => setConnected(false));
    s.on('phone:state', setPhone);
    s.on('game:event', e => window.dispatchEvent(new CustomEvent('crownfall:game-event', { detail: e })));
    const rttId = setInterval(() => clock.current && Number.isFinite(clock.current.rtt) && setRtt(clock.current.rtt), 1000);
    return () => { clearInterval(rttId); clock.current?.dispose(); s.disconnect(); };
  }, []);

  // Sensors run once motion is granted; inputs only go out after Ready.
  const sensorsOn = step === 'calibrate' || step === 'ready' || step === 'waiting';
  useEffect(() => {
    if (!sensorsOn) return;
    const offO = onOrientation(o => {
      orient.current = o;
      calBuffer.current?.push(o);
    });
    const yank = new YankDetector();
    const offM = onMotion(m => {
      if (step !== 'waiting' || !yank.push(m)) return;
      socket.current?.emit('input:yank', { seq: ++seq.current, ts: clock.current?.serverNow() ?? Date.now() });
      vibrate(60);
      setYankFlash(true); setTimeout(() => setYankFlash(false), 200);
    });
    const sendId = setInterval(() => {
      if (!orient.current || !cal.current) return;
      const raw = tiltToMove(orient.current, cal.current);
      const sm = smooth.current;
      sm.x += (raw.x - sm.x) * SMOOTHING;
      sm.y += (raw.y - sm.y) * SMOOTHING;
      const x = Math.abs(sm.x) < 0.01 ? 0 : +sm.x.toFixed(3);
      const y = Math.abs(sm.y) < 0.01 ? 0 : +sm.y.toFixed(3);
      setMove({ x, y });
      if (step === 'waiting') socket.current?.volatile.emit('input:move', { seq: ++seq.current, x, y });
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
      setPlayer(res);
      setStep('motion');
    });
  }

  async function enableMotion() {
    const pending = requestMotionPermission(); // must start inside the tap
    buzz(30);
    const p = await pending;
    if (p === 'granted') return setStep('calibrate');
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
      setStep('ready');
    }, 800);
  }

  function ready() {
    buzz(30);
    socket.current?.emit('player:ready', { calibrated: true }, res => {
      // Scaffold server answers NOT_IMPLEMENTED until Phase 2 lands; still move on.
      if (res && 'error' in res && res.error.code !== 'NOT_IMPLEMENTED') setError(res.error.message);
    });
    setStep('waiting');
  }

  const color = player?.color ?? '#f6ce68';
  return (
    <main className={`ctl ${yankFlash ? 'ctl-flash' : ''}`} style={{ ['--pc' as string]: color }}>
      <header className="ctl-top">
        <span>CROWNFALL</span>
        <span className="ctl-room">{roomCode || '—'}</span>
        <span className={connected ? 'ctl-on' : 'ctl-off'}>{connected ? `● ${rtt ?? '…'}ms` : '● offline'}</span>
      </header>

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

      {(step === 'ready' || step === 'waiting') && (
        <section>
          <div className="ctl-pad">
            <div className="ctl-dot" style={{ left: `${50 + move.x * 45}%`, top: `${50 + move.y * 45}%` }} />
          </div>
          {step === 'ready' ? (
            <>
              <p>Tilt to test. Dot should follow you.</p>
              <button onClick={ready}>I'm ready</button>
              <button className="ctl-ghost" onClick={() => setStep('calibrate')}>Recalibrate</button>
            </>
          ) : (
            <>
              <h2>{phone?.phase === 'playing' ? (phone.holding ? '👑 You have the crown' : 'Go get the crown') : 'Waiting for host…'}</h2>
              <p>Score <b>{phone?.score ?? 0}</b>{phone?.wantedName && <> · Wanted: <b>{phone.wantedName}</b></>}</p>
              <button className="ctl-ghost" onClick={() => setStep('calibrate')}>Recalibrate</button>
            </>
          )}
        </section>
      )}

      {error && <p className="ctl-err">{error}</p>}
    </main>
  );
}
