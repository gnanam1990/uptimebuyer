// Modal dialog: native <dialog> with showModal (inert background), an accessible name, a focus trap that keeps Tab
// inside, Escape to cancel and focus returned to the trigger on close (UI-SPEC §13).
import { useEffect, useRef, type ReactNode } from 'react';

export function Dialog({
  title,
  open,
  onClose,
  children,
  describedBy,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  describedBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<Element | null>(null);
  const titleId = `dlg-${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnTo.current = document.activeElement;
      d.showModal();
      const first = d.querySelector<HTMLElement>('[data-autofocus], button, [href], input, select, textarea');
      first?.focus();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onClosed = () => {
      const el = returnTo.current as HTMLElement | null;
      if (el && typeof el.focus === 'function') el.focus();
    };
    d.addEventListener('close', onClosed);
    return () => d.removeEventListener('close', onClosed);
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      {...(describedBy ? { 'aria-describedby': describedBy } : {})}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Tab') return;
        const items = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])',
          ) ?? [],
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
    >
      {open ? (
        <div className="dialog-body">
          <h2 id={titleId}>{title}</h2>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}
