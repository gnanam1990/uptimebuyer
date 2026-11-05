// Resolve hook used only in built images (M14): a workspace source file `<pkg>/src/<path>.ts` (reached through a
// package export, or through a relative `.js` specifier that points into another package's `src/`) is replaced by its
// compiled `<pkg>/dist/<path>.js`. A source with no compiled counterpart fails loudly instead of being executed as
// TypeScript, and nothing outside a `src/` directory is touched.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

function compiledFor(file) {
  const i = file.lastIndexOf('/src/');
  if (i < 0) return null;
  const rest = file.slice(i + 5).replace(/\.(ts|js)$/, '');
  return `${file.slice(0, i)}/dist/${rest}.js`;
}

function toCompiled(file) {
  const compiled = compiledFor(file);
  if (compiled === null) return null;
  if (!existsSync(compiled)) {
    const e = new Error(`no compiled module for ${file} (expected ${compiled}); run the build`);
    e.code = 'ERR_MODULE_NOT_FOUND';
    throw e;
  }
  return { url: pathToFileURL(compiled).href, format: 'module', shortCircuit: true };
}

export async function resolve(specifier, context, next) {
  let r;
  try {
    r = await next(specifier, context);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.') || !context.parentURL) throw error;
    const mapped = toCompiled(fileURLToPath(new URL(specifier, context.parentURL)));
    if (mapped) return mapped;
    throw error;
  }
  if (!r.url.startsWith('file:') || !r.url.endsWith('.ts')) return r;
  return toCompiled(fileURLToPath(r.url)) ?? r;
}
