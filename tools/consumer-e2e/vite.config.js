import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    // Two pages, ONE public-entry dependency graph: the acceptance page
    // (gates A–J+K) and the lifecycle fault self-proof page. The key
    // 'index' keeps the entry chunk name assets/index-[hash].js — the J
    // resource verdict matches that exact shape.
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        faults: resolve(root, 'faults.html'),
      },
    },
  },
  preview: {
    port: 4931,
    strictPort: true,
  },
});
