// Vite config for the locus-harness package.
//
// The package is plain ESM (no framework, no classic scripts). The build
// exists for one gate: the standalone harness host page
// (tests/harness-host.html) is a REAL build input so the browser gate
// runs the packaged entry chunk — the same discipline the source
// repository applied to its standalone hosts (M2a/M2b).
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    rollupOptions: {
      input: {
        harnessHost: 'tests/harness-host.html',
      },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
