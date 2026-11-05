// Vite build of the operator web app. Production output only: no source maps (nothing internal in the bundle), no env
// variables exposed to client code (envPrefix is unique and unused), hashed assets under /assets, React automatic JSX.
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  envPrefix: 'UB_WEB_PUBLIC_UNUSED_',
  oxc: { jsx: { runtime: 'automatic' } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  server: { host: '127.0.0.1' },
});
