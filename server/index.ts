import { createApp } from './app.js';
const port = Number(process.env.PORT ?? 3000);
const publicOrigin = process.env.PUBLIC_ORIGIN;
if (publicOrigin && !/^https?:\/\/[^/]+$/.test(publicOrigin)) throw new Error('PUBLIC_ORIGIN must be an origin without a trailing slash.');
const { http, io } = createApp({ publicOrigin });
http.listen(port, '0.0.0.0', () => console.log(`Crownfall listening on port ${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { io.close(); http.close(); });
