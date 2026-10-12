import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { api, type SessionInfo } from './api';

export const MODELS = [
  { value: null, label: 'Default' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

export const EFFORTS = [
  { value: null, label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];

/** `claude-opus-5-5` -> `Opus 5.5`, `claude-sonnet-4-5-20250929` -> `Sonnet 4.5`. */
export function prettyModel(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?/);
  if (!m) return id;
  const family = m[1][0].toUpperCase() + m[1].slice(1);
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' 1M' : ''}`;
}

function modelText(s: SessionInfo): string {
  if (s.model) return prettyModel(s.model);
  return MODELS.find((m) => m.value === s.modelChoice)?.label ?? 'Default';
}

/** Shows the session's model and effort; changing them relaunches claude on the same conversation. */
export function ModelPicker({ session }: { session: SessionInfo }) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState(session.modelChoice);
  const [effort, setEffort] = useState(session.effortChoice);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const busy = session.status === 'running' && (session.activity === 'working' || session.activity === 'waiting');
  const changed = model !== session.modelChoice || effort !== session.effortChoice;

  useEffect(() => {
    if (!open) return;
    setModel(session.modelChoice);
    setEffort(session.effortChoice);
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
      await api.configureSession(session.id, model, effort);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const effortText = EFFORTS.find((e) => e.value === session.effortChoice);

  return (
    <div className="model-picker" ref={ref}>
      <button className="model-chip" data-open={open} title="Model and effort" onClick={() => setOpen(!open)}>
        <span>{modelText(session)}</span>
        {session.effortChoice && <span className="model-chip-effort">{effortText?.label}</span>}
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="model-popover" role="dialog" aria-label="Model and effort">
          <div className="model-group">Model</div>
          <div className="option-row">
            {MODELS.map((m) => (
              <button key={m.label} className="option" aria-pressed={model === m.value} onClick={() => setModel(m.value)}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="model-group">Effort</div>
          <div className="option-row">
            {EFFORTS.map((e) => (
              <button key={e.label} className="option" aria-pressed={effort === e.value} onClick={() => setEffort(e.value)}>
                {e.label}
              </button>
            ))}
          </div>
          <p className="model-note">
            {busy
              ? 'Claude is busy. You can apply this once it is idle.'
              : 'Relaunches this session and keeps the conversation. Your global Claude settings stay unchanged.'}
          </p>
          {error && <p className="model-error">{error}</p>}
          <div className="model-actions">
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!changed || busy} onClick={apply}>
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
