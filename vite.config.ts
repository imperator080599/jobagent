import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Interface web : racine dans web/, build statique dans dist/ (servi par le serveur Node ou par Vercel).
export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://localhost:${process.env.PORT ?? 4000}`, changeOrigin: false } },
  },
});
