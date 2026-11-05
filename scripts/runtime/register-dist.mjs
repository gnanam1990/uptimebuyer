// Production module resolution (M14): registers dist-resolve.mjs so compiled entry points (apps/*/dist/main.js) load
// the compiled workspace packages. Workspace packages export their TypeScript sources (`./src/index.ts`) for
// development and tests; in a built image the hook maps each such source to its tsc output under `dist/`.
// Usage: node --import <path>/register-dist.mjs apps/api/dist/main.js
import { register } from 'node:module';

register('./dist-resolve.mjs', import.meta.url);
