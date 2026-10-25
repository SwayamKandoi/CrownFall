import { createApp } from './app.js';
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535.');
const publicOrigin = process.env.PUBLIC_ORIGIN;
if (publicOrigin && !/^https?:\/\/[^/]+$/.test(publicOrigin)) throw new Error('PUBLIC_ORIGIN must be an origin without a trailing slash.');
// Explicit opt-in only. Keep unset in production until the phone duel contract is integrated.
const { http, io } = createApp({ publicOrigin, duelsEnabled: process.env.CROWNFALL_DUELS === '1' });
http.listen(port, '0.0.0.0', () => console.log(`Crownfall listening on port ${(http.address() as { port: number }).port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { io.close(); http.close(); });
