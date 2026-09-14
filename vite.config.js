import { defineConfig } from 'vite';
import { readFile } from 'node:fs/promises';

// Keep the same build usable at the Site origin and under a preview directory.
export default defineConfig({
  base: './',
  build: { outDir: 'dist/client' },
  plugins: [{
    name: 'local-preview-model-seed',
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        if (new URL(request.url, 'http://preview.local').pathname !== '/example.json' || !['GET', 'HEAD'].includes(request.method)) return next();
        readFile(new URL('./public/example.json', import.meta.url)).then(content => {
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end(request.method === 'HEAD' ? undefined : content);
        }).catch(next);
      });
    },
  }],
  server: { proxy: { '/api/model-pool': 'http://127.0.0.1:5174' } },
});
