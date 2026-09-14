import { defineConfig } from 'vite';

// Keep the same build usable at the Site origin and under a preview directory.
export default defineConfig({
  base: './',
  build: { outDir: 'dist/client' },
  server: { proxy: { '/api/model-pool': 'http://127.0.0.1:5174' } },
});
