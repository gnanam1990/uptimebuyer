// Registers ts-resolve-hooks.mjs for a child process started with --import (T-036 cross-process determinism).
import { register } from 'node:module';

register('./ts-resolve-hooks.mjs', import.meta.url);
