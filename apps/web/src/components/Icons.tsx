// Decorative interface icons (navigation, brand mark, environment warning). Always aria-hidden beside visible text;
// one stroke style (1.8px, round caps) shared with the status-shape icons in AxisBadge.
import type { ReactNode } from 'react';

function Svg({ size = 20, className, children }: { size?: number; className?: string; children: ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** The product mark: a controller faceplate with its readout window and a thermal scale stopped short of the
 * threshold notch (the same scale the incident faceplate draws). Presentation attributes only (CSP). */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="#17323f" stroke="#3a5a6c" />
      <rect x="6" y="6.5" width="20" height="10" rx="2" fill="#0a1a23" />
      <path d="M9.5 11.5h7" stroke="#6fe0f2" strokeWidth="2.4" strokeLinecap="round" />
      <rect x="6" y="21" width="20" height="4" rx="2" fill="#0a1a23" />
      <rect x="6" y="21" width="12" height="4" rx="2" fill="#7cc8f0" />
      <path d="M21.5 19.5v7" stroke="#e6eef2" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export type NavIconName = 'command' | 'incidents' | 'ledger' | 'policies' | 'notifications';

export function NavIcon({ name }: { name: NavIconName }) {
  return (
    <Svg className="nav-icon">
      {name === 'command' ? (
        <>
          <rect x="2.5" y="3" width="15" height="10" rx="2" />
          <path d="M6 16.5h8M10 13v3.5" />
          <path d="M5.5 9.5l2.5-2.5 2 2 3.5-3.5" />
        </>
      ) : name === 'incidents' ? (
        <>
          <path d="M10 2.5l7.5 13.5h-15z" />
          <path d="M10 8v3.5M10 14v.2" />
        </>
      ) : name === 'ledger' ? (
        <>
          <rect x="4" y="2.5" width="12" height="15" rx="1.5" />
          <path d="M7 6.5h6M7 10h6M7 13.5h3.5" />
        </>
      ) : name === 'policies' ? (
        <>
          <path d="M10 2.5l6 2.5v4.5c0 4-2.7 6.6-6 8-3.3-1.4-6-4-6-8V5z" />
          <path d="M7.5 10l2 2 3.5-3.5" />
        </>
      ) : (
        <>
          <path d="M5 8a5 5 0 0 1 10 0c0 4 1.5 5.5 2 6H3c.5-.5 2-2 2-6z" />
          <path d="M8.5 17h3" />
        </>
      )}
    </Svg>
  );
}

export function WarningIcon() {
  return (
    <Svg size={18} className="env-icon">
      <path d="M10 2.5l7.5 13.5h-15z" />
      <path d="M10 8v3.5M10 14v.2" />
    </Svg>
  );
}
