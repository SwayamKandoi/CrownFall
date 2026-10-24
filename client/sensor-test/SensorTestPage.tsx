import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/events.js';
import {
  requestMotionPermission, onOrientation, onMotion, YankDetector, StillnessCheck,
  vibrate, iosHapticTap, type MotionPermission, type Orientation,
} from '../controller/sensors.js';
import { calibrate, tiltToMove, type Calibration } from '../controller/calibration.js';
import './sensor-test.css';

const GRAPH_POINTS = 150;
const GRAPH_MAX = 40; // m/s² at top of graph

export function SensorTestPage() {
  const [perm, setPerm] = useState<MotionPermission | 'idle'>('idle');
  const [orient, setOrient] = useState<Orientation>();
  const [cal, setCal] = useState<Calibration>();
  const [calibrating, setCalibrating] = useState(false);
  const [still, setStill] = useState(false);
  const [threshold, setThreshold] = useState(18);
  const [yanks, setYanks] = useState(0);
  const [peak, setPeak] = useState(0);
  const [flash, setFlash] = useState(false);
  const [nativeAccel, setNativeAccel] = useState<boolean>();
  const [rate, setRate] = useState(0);
  const [rtt, setRtt] = useState<number>();
  const [transport, setTransport] = useState('connecting…');
  const [hapticNote, setHapticNote] = useState('');

  const canvas = useRef<HTMLCanvasElement>(null);
  const samples = useRef<number[]>([]);
  const detector = useRef(new YankDetector(threshold));
  const stillness = useRef(new StillnessCheck());
  const calBuffer = useRef<Orientation[] | null>(null);
  const motionCount = useRef(0);
  const thresholdRef = useRef(threshold);

  useEffect(() => { detector.current.threshold = threshold; thresholdRef.current = threshold; }, [threshold]);

  // WebSocket round-trip check against the server's clock:ping.
  useEffect(() => {
    const s: Socket<ServerToClientEvents, ClientToServerEvents> = io();
    s.on('connect', () => {
      const set = () => setTransport(s.io.engine.transport.name);
      set(); s.io.engine.on('upgrade', set);
    });
    s.on('disconnect', () => setTransport('disconnected'));
    s.on('clock:pong', ({ t0 }) => setRtt(Math.round(performance.now() - t0)));
    const id = setInterval(() => s.connected && s.emit('clock:ping', { t0: performance.now() }), 1000);
    return () => { clearInterval(id); s.disconnect(); };
  }, []);

  // Sensor streams, once permission is granted.
  useEffect(() => {
    if (perm !== 'granted') return;
    const offO = onOrientation(o => {
      setOrient(o);
      if (calBuffer.current) calBuffer.current.push(o);
    });
    const offM = onMotion(m => {
      motionCount.current++;
      setNativeAccel(m.native);
      setStill(stillness.current.push(m.magnitude));
      samples.current.push(m.magnitude);
      if (samples.current.length > GRAPH_POINTS) samples.current.shift();
      setPeak(p => Math.max(p, m.magnitude));
      if (detector.current.push(m)) {
        setYanks(n => n + 1);
        setFlash(true); setTimeout(() => setFlash(false), 250);
        vibrate(60); // Android only; iOS can't buzz outside a tap
      }
    });
    const rateId = setInterval(() => { setRate(motionCount.current); motionCount.current = 0; }, 1000);
    let raf = 0;
    const draw = () => { drawGraph(canvas.current, samples.current, thresholdRef.current); raf = requestAnimationFrame(draw); };
    raf = requestAnimationFrame(draw);
    return () => { offO(); offM(); clearInterval(rateId); cancelAnimationFrame(raf); };
  }, [perm]);

  async function enable() {
    const pending = requestMotionPermission(); // start inside the gesture, before anything else
    iosHapticTap();
    setPerm(await pending);
  }

  function startCalibration() {
    calBuffer.current = [];
    setCalibrating(true);
    setTimeout(() => {
      const buf = calBuffer.current ?? [];
      calBuffer.current = null;
      setCalibrating(false);
      if (buf.length) setCal(calibrate(buf));
    }, 1000);
  }

  const move = orient && cal ? tiltToMove(orient, cal) : undefined;

  return (
    <main className={`st ${flash ? 'st-flash' : ''}`}>
      <h1>Sensor test</h1>
      <p className="st-ua">{navigator.userAgent}</p>

      <section>
        <h2>1 · Permission</h2>
        {perm !== 'granted' && <button onClick={enable}>Enable Motion</button>}
        <p>Status: <b>{perm}</b>{perm === 'insecure' && ' (needs HTTPS)'}{perm === 'denied' && ' (iOS: close the tab and reopen to be asked again)'}</p>
      </section>

      <section>
        <h2>2 · Tilt</h2>
        <p>beta (front/back): <b>{orient ? orient.beta.toFixed(1) : '–'}°</b> · gamma (left/right): <b>{orient ? orient.gamma.toFixed(1) : '–'}°</b></p>
        <button onClick={startCalibration} disabled={perm !== 'granted' || calibrating}>
          {calibrating ? 'Hold still…' : cal ? 'Recalibrate' : 'Calibrate (hold phone how you will play)'}
        </button>
        <p>Still: <b>{still ? 'yes' : 'no'}</b>{cal && <> · baseline β {cal.beta.toFixed(1)}° γ {cal.gamma.toFixed(1)}°</>}</p>
        <div className="st-pad">
          <div className="st-dot" style={{ left: `${50 + (move?.x ?? 0) * 45}%`, top: `${50 + (move?.y ?? 0) * 45}%` }} />
        </div>
        <p>move: x <b>{move ? move.x.toFixed(2) : '–'}</b> · y <b>{move ? move.y.toFixed(2) : '–'}</b></p>
      </section>

      <section>
        <h2>3 · Yank</h2>
        <canvas ref={canvas} width={600} height={160} className="st-graph" />
        <p>Yanks: <b className="st-big">{yanks}</b> · peak <b>{peak.toFixed(1)}</b> m/s² <button className="st-small" onClick={() => { setYanks(0); setPeak(0); }}>reset</button></p>
        <label>Threshold: <b>{threshold}</b> m/s²
          <input type="range" min={6} max={40} value={threshold} onChange={e => setThreshold(Number(e.target.value))} />
        </label>
        <p>Motion rate: <b>{rate}</b> Hz · accel source: <b>{nativeAccel == null ? '–' : nativeAccel ? 'native' : 'high-pass fallback'}</b></p>
      </section>

      <section>
        <h2>4 · Haptics</h2>
        <button onClick={() => setHapticNote(vibrate(80) ? 'navigator.vibrate fired' : 'navigator.vibrate unsupported')}>navigator.vibrate</button>
        <button onClick={() => { iosHapticTap(); setHapticNote('iOS switch toggled. Did you feel it?'); }}>iOS haptic switch</button>
        <p>{hapticNote}</p>
      </section>

      <section>
        <h2>5 · Network</h2>
        <p>Transport: <b>{transport}</b> · round trip: <b>{rtt ?? '–'}</b> ms</p>
      </section>
    </main>
  );
}

function drawGraph(c: HTMLCanvasElement | null, data: number[], threshold: number) {
  const ctx = c?.getContext('2d');
  if (!c || !ctx) return;
  const { width: w, height: h } = c;
  ctx.clearRect(0, 0, w, h);
  const y = (v: number) => h - Math.min(v, GRAPH_MAX) / GRAPH_MAX * h;
  ctx.strokeStyle = '#f6ce68'; ctx.setLineDash([6, 6]); ctx.beginPath();
  ctx.moveTo(0, y(threshold)); ctx.lineTo(w, y(threshold)); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = '#79dfbc'; ctx.lineWidth = 2; ctx.beginPath();
  data.forEach((v, i) => { const x = i / (GRAPH_POINTS - 1) * w; i ? ctx.lineTo(x, y(v)) : ctx.moveTo(x, y(v)); });
  ctx.stroke();
}
