import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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

/** Room a menu needs below its trigger; with less, it opens upward. */
const MENU_ROOM = 180;
/** The popover's min-width in styles.css. */
const MENU_WIDTH = 200;

/**
 * Small dropdown anchored to its trigger. Drawn over the whole page (a scrolling list would
 * clip it), and upward when the trigger is near the bottom of the window.
 */
export function Menu({ trigger, items, title, button }: { trigger: ReactNode; items: MenuItem[]; title?: string; button?: boolean }) {
  const [open, setOpen] = useState<CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => ref.current?.contains(t as Node) || popover.current?.contains(t as Node);
    const onDown = (e: MouseEvent) => !inside(e.target) && setOpen(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    // Anchored once: scrolling or resizing would leave it floating away from its trigger.
    const close = () => setOpen(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const toggle = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (open) return setOpen(null);
    const r = e.currentTarget.getBoundingClientRect();
    // Lined up with the trigger's right edge, or its left one when that would run off the window.
    const x = r.right < MENU_WIDTH + 8 ? { left: r.left } : { right: window.innerWidth - r.right };
    const y = window.innerHeight - r.bottom < MENU_ROOM ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 };
    setOpen({ ...x, ...y });
  };

  return (
    <div className="menu" ref={ref}>
      <button className={button ? 'btn btn-secondary' : 'icon-btn'} title={title} data-open={!!open} onClick={toggle}>
        {trigger}
      </button>
      {open &&
        createPortal(
        <div className="menu-popover" role="menu" ref={popover} style={open}>
          {items.map((item) => (
            <button
              key={item.label}
              className={`menu-item ${item.danger ? 'is-danger' : ''}`}
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(null);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>,
          document.body,
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
