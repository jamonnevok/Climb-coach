/** UI primitives: large touch targets, one accent colour, dark by default. */
import { useEffect, type ReactNode } from 'react';
import { references } from '../../config';
import type { EvidenceLevel, Scale5 } from '../../data/schema';

type Tone = 'primary' | 'ghost' | 'danger' | 'subtle';

export function Button({
  children,
  onClick,
  tone = 'primary',
  disabled,
  className = '',
  type = 'button',
  small,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: Tone;
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit';
  small?: boolean;
}) {
  const tones: Record<Tone, string> = {
    primary: 'bg-accent text-black font-semibold active:brightness-90',
    ghost: 'border border-line text-fg active:bg-line/40',
    danger: 'bg-bad text-white font-semibold active:brightness-90',
    subtle: 'bg-line/50 text-fg active:bg-line',
  };
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`${small ? 'min-h-[36px] px-3 text-sm' : 'min-h-[48px] px-4'} rounded-xl transition disabled:opacity-40 ${tones[tone]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = '', onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <div onClick={onClick} className={`bg-card border border-line rounded-2xl p-4 fade-in ${onClick ? 'cursor-pointer active:bg-line/30' : ''} ${className}`}>
      {children}
    </div>
  );
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Badge({ children, cls = 'bg-line text-muted' }: { children: ReactNode; cls?: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="sheet-in bg-card border border-line w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl p-5 safe-bottom"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button aria-label="Close" onClick={onClose} className="w-10 h-10 rounded-full text-muted active:bg-line/50 text-2xl leading-none">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function NumberInput({
  value,
  onChange,
  step = 1,
  min,
  max,
  placeholder,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
  min?: number;
  max?: number;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      step={step}
      min={min}
      max={max}
      placeholder={placeholder}
      value={value === null || Number.isNaN(value) ? '' : value}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    />
  );
}

export function Stepper({ value, onChange, step = 1, min = -Infinity, max = Infinity, unit }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; unit?: string }) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, Math.round(v * 100) / 100)));
  return (
    <div className="flex items-center gap-2">
      <button className="w-12 h-12 rounded-xl bg-line/60 text-xl active:bg-line" onClick={() => set(value - step)} type="button">
        −
      </button>
      <div className="flex-1 text-center text-xl font-semibold tabular">
        {value}
        {unit && <span className="text-sm text-muted ml-1">{unit}</span>}
      </div>
      <button className="w-12 h-12 rounded-xl bg-line/60 text-xl active:bg-line" onClick={() => set(value + step)} type="button">
        +
      </button>
    </div>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1 bg-line/40 p-1 rounded-xl">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex-1 min-h-[40px] px-2 rounded-lg text-sm transition ${o.value === value ? 'bg-card text-fg shadow font-semibold' : 'text-muted'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 1-5 picker (5 = best). */
export function Scale5Input({ value, onChange, low, high }: { value: Scale5 | undefined; onChange: (v: Scale5) => void; low: string; high: string }) {
  return (
    <div>
      <div className="flex gap-1">
        {([1, 2, 3, 4, 5] as Scale5[]).map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            className={`flex-1 h-11 rounded-lg font-semibold transition ${value === n ? 'bg-accent text-black' : 'bg-line/50 text-muted'}`}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted mt-1">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  );
}

/** 0-10 picker (RPE / pain). */
export function Scale10Input({ value, onChange, danger }: { value: number | undefined; onChange: (v: number) => void; danger?: boolean }) {
  const color = (n: number) => (!danger ? 'bg-accent text-black' : n <= 2 ? 'bg-ok text-black' : n <= 5 ? 'bg-warn text-black' : 'bg-bad text-white');
  return (
    <div className="grid grid-cols-11 gap-1">
      {Array.from({ length: 11 }, (_, n) => (
        <button key={n} type="button" onClick={() => onChange(n)} className={`h-10 rounded-md text-sm font-semibold ${value === n ? color(n) : 'bg-line/50 text-muted'}`}>
          {n}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex items-center justify-between w-full min-h-[44px]">
      <span>{label}</span>
      <span className={`w-12 h-7 rounded-full p-1 transition ${checked ? 'bg-accent' : 'bg-line'}`}>
        <span className={`block w-5 h-5 rounded-full bg-white transition ${checked ? 'translate-x-5' : ''}`} />
      </span>
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-center text-muted text-sm py-6">{children}</div>;
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="text-xl font-semibold tabular">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}

const EVIDENCE: Record<EvidenceLevel, { label: string; cls: string }> = {
  research: { label: 'Research', cls: 'bg-ok/15 text-ok' },
  coaching_practice: { label: 'Coaching practice', cls: 'bg-line text-muted' },
  experimental: { label: 'Experimental', cls: 'bg-warn/15 text-warn' },
};

export function EvidenceBadge({ level }: { level: EvidenceLevel }) {
  const e = EVIDENCE[level];
  return <Badge cls={e.cls}>{e.label}</Badge>;
}

export function ReferenceList({ ids }: { ids: string[] }) {
  if (!ids.length) return <p className="text-xs text-muted">No peer-reviewed reference: coaching practice.</p>;
  return (
    <ul className="space-y-1">
      {ids.map((id) => (
        <li key={id} className="text-xs text-muted">
          {references[id]?.citation ?? id}
        </li>
      ))}
    </ul>
  );
}

export function Disclaimer({ children }: { children: ReactNode }) {
  return <div className="text-xs text-muted border border-line rounded-xl p-3 bg-line/20">{children}</div>;
}

export function Toasts({ items }: { items: { id: number; text: string; tone: 'ok' | 'error' | 'info' }[] }) {
  return (
    <div className="fixed top-3 inset-x-3 z-[60] flex flex-col items-center gap-2 pointer-events-none">
      {items.map((t) => (
        <div
          key={t.id}
          className={`sheet-in pointer-events-auto max-w-md w-full rounded-xl px-4 py-3 text-sm shadow-lg ${t.tone === 'error' ? 'bg-bad text-white' : t.tone === 'info' ? 'bg-card border border-line' : 'bg-accent text-black'}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function confirmAction(text: string): boolean {
  return typeof window === 'undefined' ? true : window.confirm(text);
}
