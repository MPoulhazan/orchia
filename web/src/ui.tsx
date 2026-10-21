import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { storage } from './storage';

/** A button that needs a second click within a few seconds to fire. */
export function ConfirmButton({
  onConfirm,
  confirmLabel,
  className = '',
  title,
  children,
}: {
  onConfirm: () => void;
  confirmLabel: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <button
      className={`${className} ${armed ? 'is-armed' : ''}`}
      title={armed ? undefined : title}
      onClick={(e) => {
        e.stopPropagation();
        if (armed) onConfirm();
        setArmed(!armed);
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}

/** Inline name editor: Enter or blur saves, Escape cancels. Reports null when nothing changed. */
export function RenameInput({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  return (
    <input
      className="rename-input"
      autoFocus
      defaultValue={name}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        const next = e.target.value.trim();
        onDone(next && next !== name ? next : null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.currentTarget.value = name;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

/** Small dropdown anchored to its trigger. */
export function Menu({ trigger, items, title }: { trigger: ReactNode; items: MenuItem[]; title?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button
        className="icon-btn"
        title={title}
        data-open={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        {trigger}
      </button>
      {open && (
        <div className="menu-popover" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              className={`menu-item ${item.danger ? 'is-danger' : ''}`}
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

const FOLDED_KEY = 'orchia.inspectorFolded';

function readFolded(): string[] {
  try {
    const value = JSON.parse(storage.get(FOLDED_KEY) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/**
 * An inspector section whose title folds it. The summary next to the title stays
 * visible when folded. Folding is remembered for every session, not per session.
 */
export function InspectorSection(props: {
  id: string;
  title: string;
  hint?: string;
  summary?: ReactNode;
  /** Only shown while folded, when the open section already says the same. */
  foldedOnly?: boolean;
  children: ReactNode;
  /** Shown even when folded, e.g. a notice that needs action. */
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(() => !readFolded().includes(props.id));

  const toggle = () => {
    const folded = readFolded().filter((id) => id !== props.id);
    if (open) folded.push(props.id);
    storage.set(FOLDED_KEY, JSON.stringify(folded));
    setOpen(!open);
  };

  return (
    <section className="insp-block" data-open={open}>
      <h3>
        <button className="insp-toggle" aria-expanded={open} title={props.hint} onClick={toggle}>
          <ChevronRight size={12} className={`chevron ${open ? 'is-open' : ''}`} />
          {props.title}
          {props.summary != null && (!open || !props.foldedOnly) && <span className="insp-sum">{props.summary}</span>}
        </button>
      </h3>
      {open && props.children}
      {props.footer}
    </section>
  );
}
