// Resolve hook used only in built images (M14): a resolved workspace source file `<pkg>/src/<path>.ts` is replaced by
// its compiled `<pkg>/dist/<path>.js`. A source with no compiled counterpart fails loudly instead of being executed as
// TypeScript, and nothing outside a `src/` directory is touched.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (!r.url.startsWith('file:') || !r.url.endsWith('.ts')) return r;
  const file = fileURLToPath(r.url);
  const i = file.lastIndexOf('/src/');
  if (i < 0) return r;
  const compiled = `${file.slice(0, i)}/dist/${file.slice(i + 5, -3)}.js`;
  if (!existsSync(compiled)) {
    const e = new Error(`no compiled module for ${file} (expected ${compiled}); run the build`);
    e.code = 'ERR_MODULE_NOT_FOUND';
    throw e;
  }
  return { ...r, url: pathToFileURL(compiled).href, format: 'module' };
}
