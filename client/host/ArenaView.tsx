import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../shared/events.js';
import type { createArena } from './ArenaScene.js';

export function ArenaView({ snapshot }: { snapshot?: Snapshot }) {
  const parent = useRef<HTMLDivElement>(null);
  const arena = useRef<ReturnType<typeof createArena>>();
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    // Load Phaser only when a host room is mounted, leaving sensor/controller entry light.
    void import('./ArenaScene.js').then(({ createArena }) => {
      if (cancelled || !parent.current) return;
      arena.current = createArena(parent.current);
      if (latest.current) arena.current.accept(latest.current);
    }).catch(() => { if (!cancelled) setError('The arena could not load. Refresh and try again.'); });
    return () => { cancelled = true; arena.current?.destroy(); arena.current = undefined; };
  }, []);
  useEffect(() => { if (snapshot) arena.current?.accept(snapshot); }, [snapshot]);
  return <div className="cf-canvas" ref={parent} role="img" aria-label="Live Crownfall arena showing player positions">{error && <p role="alert">{error}</p>}</div>;
}
