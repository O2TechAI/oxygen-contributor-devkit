import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';

// Full local review app for hosts that cannot execute Cloudflare's workerd.
export default defineConfig({
  plugins: [vinext()],
  css: { postcss: { plugins: [tailwindcss()] } },
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./lib/local-runtime.ts', import.meta.url),
      ),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    watch: { ignored: ['**/.wrangler/**'] },
  },
});
