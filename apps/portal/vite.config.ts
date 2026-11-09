import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * In development the portal calls the API gateway through the Vite proxy at /api, so the
 * browser only ever talks to one origin — the same model nginx provides in the container.
 */
const gateway = process.env.ATLAS_GATEWAY_URL ?? 'http://127.0.0.1:4000';

/**
 * GitHub Codespaces forwards ports under its own domain and preserves that Host header, which Vite
 * rejects by default (DNS-rebinding protection). Allow only the Codespaces forwarding domain, and
 * only when actually running inside a Codespace.
 */
const codespacesDomain =
  process.env.CODESPACES === 'true'
    ? process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
    : undefined;
const allowedHosts = codespacesDomain ? [`.${codespacesDomain}`] : [];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ['@atlas/source'] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    allowedHosts,
    proxy: {
      '/api': {
        target: gateway,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, allowedHosts },
  build: { sourcemap: true, target: 'es2022' },
});
