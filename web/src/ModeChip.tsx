import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, FilePen, Hand, ListChecks, Shield, Zap, type LucideIcon } from 'lucide-react';
import { api, type PermissionMode, type SessionInfo } from './api';
import { MODE_SHORTCUT, PERMISSION_HELP, permissionHelp } from './help';
import { DiscoveryDot, markDiscovered, useUndiscovered } from './discovery';

export const OFFERED: PermissionMode[] = ['manual', 'acceptEdits', 'plan', 'auto'];

// Sits next to the model chip, which can also read "Default": the icon tells them apart.
export const ICONS: Record<string, LucideIcon> = { manual: Hand, acceptEdits: FilePen, plan: ListChecks, auto: Zap };

/**
 * Shows the session's permission mode, as Claude Code last reported it (so Shift+Tab in the
 * terminal shows up here), explains each mode, and switches by relaunching on the same conversation.
 */
export function ModeChip({ session }: { session: SessionInfo }) {
  const current = session.liveMode ?? session.permissionMode;
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string | null>(current);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const busy = session.status === 'running' && (session.activity === 'working' || session.activity === 'waiting');
  const help = permissionHelp(current);
  const Icon = (current && ICONS[current]) || Shield;
  const fresh = useUndiscovered('mode');

  useEffect(() => {
    if (!open) return;
    markDiscovered('mode');
    setChoice(current);
    setError('');
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function apply() {
    try {
      await api.configureSession(session.id, session.modelChoice, session.effortChoice, choice as PermissionMode);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="model-picker" ref={ref}>
      <button
        className="model-chip"
        data-open={open}
        data-mode={current ?? 'default'}
        title={help.text ? `${help.label}: ${help.text}` : 'Permission mode'}
        onClick={() => setOpen(!open)}
      >
        <Icon size={13} className="mode-chip-icon" />
        <span>{current ? help.label : 'Default mode'}</span>
        <ChevronDown size={12} />
        {fresh && <DiscoveryDot />}
      </button>

      {open && (
        <div className="model-popover mode-popover" role="dialog" aria-label="Permission mode">
          <div className="model-group">What Claude may do without asking</div>
          {!current && <p className="model-note">Claude Code's own default applies. Orchia shows which mode that is after your first message.</p>}
          <div className="mode-list" role="radiogroup">
            {OFFERED.map((mode) => {
              const entry = PERMISSION_HELP[mode];
              const RowIcon = ICONS[mode];
              return (
                <button key={mode} role="radio" aria-checked={choice === mode} className="mode-option" onClick={() => setChoice(mode)}>
                  <span className="mode-check">{choice === mode && <Check size={13} />}</span>
                  <span className="mode-body">
                    <span className="mode-label">
                      <RowIcon size={13} className="mode-chip-icon" />
                      {entry.label}
                      {mode === current && <span className="mode-now">now</span>}
                    </span>
                    <span className="mode-text">{entry.text}</span>
                    <span className="mode-when">{entry.when}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="model-note">
            {busy ? 'Claude is busy. You can switch once it is idle.' : `Switching relaunches this session and keeps the conversation. ${MODE_SHORTCUT}`}
          </p>
          {error && <p className="model-error">{error}</p>}
          <div className="model-actions">
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!choice || choice === current || busy} onClick={apply}>
              Switch
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
