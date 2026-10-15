import { defineConfig } from 'vite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const htmlRoot = fileURLToPath(new URL('../html/', import.meta.url));

// Keep the same build usable at the Site origin and under a preview directory.
export default defineConfig({
  root: htmlRoot,
  base: './',
  envDir: projectRoot,
  publicDir: false,
  build: { outDir: fileURLToPath(new URL('../dist/client/', import.meta.url)), emptyOutDir: true },
  plugins: [{
    name: 'local-preview-model-seed',
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        if (new URL(request.url, 'http://preview.local').pathname !== '/example.json' || !['GET', 'HEAD'].includes(request.method)) return next();
        readFile(new URL('../html/example.json', import.meta.url)).then(content => {
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end(request.method === 'HEAD' ? undefined : content);
        }).catch(next);
      });
    },
  }],
  server: {
    proxy: { '/api/model-pool': 'http://127.0.0.1:5174' },
    fs: {
      allow: [projectRoot],
      // Server code and local storage live beside the page but are never static assets.
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/html/server/**'],
    },
  },
});
