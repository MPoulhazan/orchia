import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type RefObject } from 'react';
import { ChevronDown } from 'lucide-react';
import { api, type AllowRule, type SessionInfo } from './api';

type Permission = NonNullable<SessionInfo['permission']>;

/** "Run `npm test -- scrapers/indeed`" */
export function PermissionText({ permission }: { permission: Permission }) {
  return (
    <>
      {permission.verb} {permission.target ? <code>{permission.target}</code> : permission.tool}
    </>
  );
}

/** "Run `npm test *`" */
export function RuleText({ rule }: { rule: AllowRule }) {
  return (
    <>
      {rule.verb} <code>{rule.target}</code>
    </>
  );
}

/**
 * Allow / Deny for the session's pending permission. Claude Code's own prompt stays answerable too.
 * When Claude Code suggests rules for the request, a menu on Allow offers to stop asking for them.
 */
export function PermissionButtons({ session, small }: { session: SessionInfo; small?: boolean }) {
  const permission = session.permission;
  const [sent, setSent] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const splitRef = useRef<HTMLSpanElement>(null);
  if (!permission) return null;
  const busy = sent === permission.id;
  const always = permission.always ?? [];

  const answer = (allow: boolean, rememberIt = false) => {
    setSent(permission.id);
    setMenuOpen(false);
    // A 409 means it was answered in the terminal first: the next state update clears it.
    api.answerPermission(session.id, permission.id, allow, rememberIt).catch(() => {});
  };
  const click = (allow: boolean) => (e: MouseEvent) => {
    e.stopPropagation();
    answer(allow);
  };

  return (
    <span className="perm-acts" data-small={small}>
      <span className="perm-split" ref={splitRef}>
        <button className="btn btn-primary" disabled={busy} title={`Allow ${permission.tool} once`} onClick={click(true)}>
          Allow
        </button>
        {always.length > 0 && (
          <button
            className="btn btn-primary perm-more"
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="More ways to allow"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(!menuOpen);
            }}
          >
            <ChevronDown size={13} />
          </button>
        )}
      </span>
      <button className="btn btn-secondary" disabled={busy} title="Deny and stop Claude's turn" onClick={click(false)}>
        Deny
      </button>
      {menuOpen && !busy && (
        <AllowMenu anchor={splitRef} rules={always} onClose={() => setMenuOpen(false)} onAllow={(rememberIt) => answer(true, rememberIt)} />
      )}
    </span>
  );
}

const MENU_WIDTH = 300;

/**
 * Fixed to the viewport, so the sidebar and grid cells don't clip it. Opens below
 * the Allow button, or above it when the button sits low (the grid's ask bar).
 */
function AllowMenu({
  anchor,
  rules,
  onClose,
  onAllow,
}: {
  anchor: RefObject<HTMLSpanElement | null>;
  rules: AllowRule[];
  onClose: () => void;
  onAllow: (rememberIt: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });

  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const height = ref.current?.offsetHeight ?? 0;
    if (!a) return;
    const left = Math.max(8, Math.min(a.left, window.innerWidth - MENU_WIDTH - 8));
    const below = a.bottom + 4 + height <= window.innerHeight - 8;
    setStyle({ left, width: MENU_WIDTH, top: below ? a.bottom + 4 : Math.max(8, a.top - 4 - height) });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: globalThis.MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchor.current?.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // A fixed menu would drift away from its button. Only scrolling around the
    // button counts: other terminals keep scrolling while they print.
    const onScroll = (e: Event) => e.target instanceof Node && e.target.contains(anchor.current) && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [anchor, onClose]);

  const pick = (rememberIt: boolean) => (e: MouseEvent) => {
    e.stopPropagation();
    onAllow(rememberIt);
  };

  return (
    <div className="allow-menu" role="menu" ref={ref} style={style} onClick={(e) => e.stopPropagation()}>
      <button className="allow-item" role="menuitem" onClick={pick(false)}>
        <b>Allow this time</b>
        <small>Claude asks again next time.</small>
      </button>
      <button className="allow-item" role="menuitem" onClick={pick(true)}>
        <b>Always allow in this project</b>
        <span className="allow-rules">
          {rules.map((r) => (
            <span key={r.rule}>
              <RuleText rule={r} />
            </span>
          ))}
        </span>
        <small>Like "don't ask again" in the terminal. Listed in the inspector, where you can remove it.</small>
      </button>
    </div>
  );
}
