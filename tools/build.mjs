import { build } from 'vite';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
await build({ configFile: fileURLToPath(new URL('./vite.config.js', import.meta.url)) });
// Sites serves matching static assets before the Worker. Keep this compatibility
// URL dynamic so it cannot mask the latest R2 object with a bundled snapshot.
await rm(new URL('../dist/client/example.json', import.meta.url), { force: true });
await build({
  root: projectRoot, configFile: false, publicDir: false,
  build: {
    target: 'es2022', outDir: 'dist/server',
    lib: { entry: 'html/server/sites-worker.js', formats: ['es'], fileName: () => 'index.js' },
    rollupOptions: { external: ['cloudflare:workers'] },
    minify: false,
  },
});
await mkdir(new URL('../dist/.openai/', import.meta.url), { recursive: true });
await cp(new URL('../.openai/hosting.json', import.meta.url), new URL('../dist/.openai/hosting.json', import.meta.url));
