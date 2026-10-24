import React from 'react';
import { createRoot } from 'react-dom/client';
import { HostPage } from './host/HostPage.js';
import { SensorTestPage } from './sensor-test/SensorTestPage.js';
// Integration-owned router: Aryan will connect ControllerPage and SensorTestPage here.
function App() {
  if (location.pathname.startsWith('/play/')) return <main style={{ padding: 40, fontFamily: 'system-ui' }}><h1>Crownfall controller</h1><p>The server is ready. Phone controls will be connected by Aryan.</p><a href="/host">Open host</a></main>;
  if (location.pathname === '/sensor-test') return <SensorTestPage />;
  return <HostPage />;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
