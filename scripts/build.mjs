import { build } from 'vite';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
await build();
await build({
  configFile: false, publicDir: false,
  build: {
    target: 'es2022', outDir: 'dist/server',
    lib: { entry: 'server/sites-worker.js', formats: ['es'], fileName: () => 'index.js' },
    rollupOptions: { external: ['cloudflare:workers'] },
    minify: false,
  },
});
await mkdir(new URL('../dist/.openai/', import.meta.url), { recursive: true });
await cp(new URL('../.openai/hosting.json', import.meta.url), new URL('../dist/.openai/hosting.json', import.meta.url));
