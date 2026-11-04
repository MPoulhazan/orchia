import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { HelpEntry } from './help';

const WIDTH = 280;
const OPEN_DELAY = 350;
const CLOSE_DELAY = 150;

/**
 * A word that explains itself: hover, focus or tap it for a short card on what it does and
 * when to use it. `term` draws the dotted underline and takes taps; leave it off to wrap
 * something already clickable (a tab, a chip), which then explains itself on hover and focus.
 */
export function Help({ entry, children, term = false, className = '' }: { entry: HelpEntry; children: ReactNode; term?: boolean; className?: string }) {
  const [at, setAt] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<number>(0);

  const show = () => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8));
    // Below the word, or above it when the bottom of the window is close.
    setAt(window.innerHeight - r.bottom < 180 ? { left, bottom: window.innerHeight - r.top + 6 } : { left, top: r.bottom + 6 });
  };
  const later = (fn: () => void, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(fn, ms);
  };

  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const onDown = (e: MouseEvent) => !anchor.current?.contains(e.target as Node) && close();
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('scroll', close, true);
    };
  }, [at]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <span
      ref={anchor}
      className={`${term ? 'help-term' : 'help-wrap'} ${className}`.trim()}
      tabIndex={term ? 0 : undefined}
      role={term ? 'button' : undefined}
      aria-expanded={term ? !!at : undefined}
      onMouseEnter={() => later(show, OPEN_DELAY)}
      onMouseLeave={() => later(() => setAt(null), CLOSE_DELAY)}
      onFocus={() => later(show, 0)}
      onBlur={() => later(() => setAt(null), CLOSE_DELAY)}
      onClick={term ? (e) => (e.stopPropagation(), at ? setAt(null) : show()) : undefined}
      onKeyDown={term ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), at ? setAt(null) : show()) : undefined}
    >
      {children}
      {at &&
        createPortal(
          <span className="help-card" role="tooltip" style={{ ...at, width: WIDTH }}>
            <b>{entry.label}</b>
            <span>{entry.text}</span>
            {entry.when && <span className="help-when">{entry.when}</span>}
            {entry.detail && <span className="help-detail">{entry.detail}</span>}
          </span>,
          document.body,
        )}
    </span>
  );
}
