// Read at the moment of the action so a changed OS preference takes effect
// without reloading. Unsupported environments use the gentler fallback.
export function preferredScrollBehavior(target = globalThis.window) {
  return typeof target?.matchMedia === 'function'
    && target.matchMedia('(prefers-reduced-motion: no-preference)').matches
    ? 'smooth' : 'instant';
}
