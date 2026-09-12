import { defineConfig } from 'vite';

// Keep the same build usable at the Site origin and under a preview directory.
export default defineConfig({ base: './' });
