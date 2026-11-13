// Position and size values for drawn graphics (the faceplate thermal scale, the fleet signal-mix bar) are CSS custom
// properties set through the CSSOM from a callback ref. The strict CSP forbids style attributes in markup; CSSOM writes
// are allowed and keep every visual rule in styles.css, where transitions and prefers-reduced-motion apply to them.
export function cssVars(vars: Record<string, string | number>) {
  return (el: HTMLElement | null) => {
    if (!el) return;
    for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, String(value));
  };
}
