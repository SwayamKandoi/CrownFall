import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client' },
  server: { proxy: {
    '/socket.io': { target: 'http://localhost:3000', ws: true },
    '/health': 'http://localhost:3000',
  } },
});
