// Live-region announcements (UI-SPEC §13): one polite status region for outcomes and one assertive alert region for
// critical changes. Each message replaces the previous one so a screen reader hears it once; telemetry samples are
// never announced one by one.
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

const Ctx = createContext<(text: string, opts?: { assertive?: boolean }) => void>(() => {});

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  const announce = useCallback((text: string, opts: { assertive?: boolean } = {}) => {
    if (opts.assertive) setAssertive(text);
    else setPolite(text);
  }, []);
  return (
    <Ctx.Provider value={announce}>
      {children}
      <div id="announcer" className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {polite}
      </div>
      <div id="alerter" className="sr-only" aria-live="assertive" aria-atomic="true">
        {assertive}
      </div>
    </Ctx.Provider>
  );
}

export const useAnnounce = () => useContext(Ctx);
