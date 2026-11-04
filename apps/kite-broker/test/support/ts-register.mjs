// Registers ts-resolve-hooks.mjs for a child process started with --import (M09 separate-process broker tests).
import { register } from 'node:module';

register('./ts-resolve-hooks.mjs', import.meta.url);
