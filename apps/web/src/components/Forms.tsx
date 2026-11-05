// Form primitives: keyboard-native radio groups (arrow keys move and select), an error summary that takes focus and
// links each problem to its field (UI-SPEC §11), and buttons whose disabled state always carries a visible reason.
import { useEffect, useId, useRef, type ReactNode } from 'react';

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

export function RadioGroup({
  legend,
  name,
  options,
  value,
  onChange,
  error,
  id,
}: {
  legend: string;
  name: string;
  options: Option[];
  value: string | null;
  onChange: (v: string) => void;
  error?: string | null;
  id: string;
}) {
  const legendId = `${id}-legend`;
  return (
    <fieldset
      className={`radio-group${error ? ' has-error' : ''}`}
      role="radiogroup"
      aria-labelledby={legendId}
      id={id}
      {...(error ? { 'aria-describedby': `${id}-error` } : {})}
    >
      <legend id={legendId}>{legend}</legend>
      {error ? (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
      {options.length === 0 ? <p className="muted">No options are available.</p> : null}
      {options.map((o) => {
        const oid = `${id}-${o.value}`;
        return (
          <div className="radio" key={o.value}>
            <input
              type="radio"
              id={oid}
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              {...(o.hint ? { 'aria-describedby': `${oid}-hint` } : {})}
            />
            <label htmlFor={oid}>{o.label}</label>
            {o.hint ? (
              <span className="muted radio-hint" id={`${oid}-hint`}>
                {o.hint}
              </span>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

export interface FieldProblem {
  fieldId: string;
  message: string;
}

export function ErrorSummary({ problems }: { problems: FieldProblem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (problems.length > 0) ref.current?.focus();
  }, [problems]);
  if (problems.length === 0) return null;
  return (
    <div className="error-summary" role="alert" tabIndex={-1} ref={ref} aria-labelledby="error-summary-title">
      <h3 id="error-summary-title">There is a problem</h3>
      <ul>
        {problems.map((p) => (
          <li key={p.fieldId}>
            <a
              href={`#${p.fieldId}`}
              onClick={(e) => {
                e.preventDefault();
                const target = document.getElementById(p.fieldId);
                const input = target?.querySelector<HTMLElement>('input:checked, input, textarea, button') ?? target;
                input?.focus();
              }}
            >
              {p.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A button that, when disabled, says why next to itself (never a silent disabled action). */
export function ActionButton({
  children,
  onClick,
  disabledReason,
  kind = 'secondary',
  describedBy,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabledReason?: string | null;
  kind?: 'primary' | 'secondary' | 'danger';
  describedBy?: string;
}) {
  const id = useId();
  const reasonId = `${id}-why`;
  const disabled = Boolean(disabledReason);
  const describe = [disabled ? reasonId : null, describedBy ?? null].filter(Boolean).join(' ');
  return (
    <span className="action">
      <button
        type="button"
        className={`btn btn-${kind}`}
        disabled={disabled}
        onClick={onClick}
        {...(describe ? { 'aria-describedby': describe } : {})}
      >
        {children}
      </button>
      {disabled ? (
        <span className="disabled-reason" id={reasonId}>
          {disabledReason}
        </span>
      ) : null}
    </span>
  );
}
