// Module resolution hook for T-036's second Node process: the workspace sources use NodeNext `.js` specifiers for
// `.ts` files, so a relative `.js` import that does not exist is retried as `.ts` (type stripping is Node's own).
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js'))
      return next(`${specifier.slice(0, -3)}.ts`, context);
    throw error;
  }
}
