import React from 'react';
import { createRoot } from 'react-dom/client';
import { HostPage } from './host/HostPage.js';
import { SensorTestPage } from './sensor-test/SensorTestPage.js';
import { ControllerPage } from './controller/ControllerPage.js';
// Integration-owned router: Aryan will connect ControllerPage and SensorTestPage here.
function App() {
  if (location.pathname.startsWith('/play/')) return <ControllerPage />;
  if (location.pathname === '/sensor-test') return <SensorTestPage />;
  return <HostPage />;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
