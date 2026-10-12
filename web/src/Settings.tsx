import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun, X } from 'lucide-react';
import { api, type PermissionMode, type Settings } from './api';
import { EFFORTS, MODELS } from './ModelPicker';
import type { ThemePref } from './theme';
import type { NotifyState } from './notifications';

const PERMISSION_MODES: { value: PermissionMode | null; label: string; description: string }[] = [
  { value: null, label: 'Default', description: 'Uses the permission mode from your Claude Code settings.' },
  { value: 'manual', label: 'Ask', description: 'Asks before every file edit and command.' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'Edits files without asking. Still asks before running commands.' },
  { value: 'plan', label: 'Plan first', description: 'Reads and plans only. Changes nothing until you approve the plan.' },
  { value: 'auto', label: 'Auto', description: 'Claude runs what it judges safe and asks only for risky actions.' },
];

const THEMES: [ThemePref, typeof Monitor, string][] = [
  ['system', Monitor, 'System'],
  ['light', Sun, 'Light'],
  ['dark', Moon, 'Dark'],
];

/** App-wide settings: defaults for new sessions (kept by the server), notifications and theme (kept in this browser). */
export function SettingsDialog(props: {
  settings: Settings;
  themePref: ThemePref;
  onSetTheme: (pref: ThemePref) => void;
  notify: NotifyState;
  onToggleNotify: () => void;
  onClose: () => void;
}) {
  const { settings } = props;
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Saved at once; the new state comes back through the events socket.
  async function change(patch: Partial<Settings>) {
    setError('');
    try {
      await api.updateSettings(patch);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const mode = PERMISSION_MODES.find((m) => m.value === settings.permissionMode) ?? PERMISSION_MODES[0];

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="settings" role="dialog" aria-label="Settings">
        <header className="settings-head">
          <h2>Settings</h2>
          <button className="icon-btn" title="Close (Esc)" onClick={props.onClose}>
            <X size={15} />
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <h3>New sessions</h3>
            <p className="settings-note">Applies to sessions you start from now on. Running sessions keep what they have.</p>

            <Field label="Model" description="Model new sessions start with. You can still change it per session.">
              <Options items={MODELS} value={settings.model} onChange={(model) => change({ model })} />
            </Field>
            <Field label="Effort" description="How hard Claude thinks before answering. Higher is slower and uses more of your plan.">
              <Options items={EFFORTS} value={settings.effort} onChange={(effort) => change({ effort })} />
            </Field>
            <Field label="Permissions" description={mode.description}>
              <Options items={PERMISSION_MODES} value={settings.permissionMode} onChange={(permissionMode) => change({ permissionMode })} />
            </Field>
            {error && <p className="model-error">{error}</p>}
          </section>

          <section className="settings-section">
            <h3>This browser</h3>
            <Field
              label="Notifications"
              description={
                props.notify === 'blocked'
                  ? 'Blocked in the browser settings. Allow notifications for this site to turn them on.'
                  : 'Desktop notification when a session needs you or finishes while AgentHub is in the background.'
              }
            >
              <div className="option-row">
                <button className="option" aria-pressed={props.notify === 'on'} disabled={props.notify === 'blocked'} onClick={props.onToggleNotify}>
                  {props.notify === 'on' ? 'On' : 'Off'}
                </button>
              </div>
            </Field>
            <Field label="Theme" description="System follows your computer's light or dark setting.">
              <div className="option-row">
                {THEMES.map(([value, Icon, label]) => (
                  <button key={value} className="option option-icon" aria-pressed={props.themePref === value} onClick={() => props.onSetTheme(value)}>
                    <Icon size={13} />
                    {label}
                  </button>
                ))}
              </div>
            </Field>
          </section>
        </div>
      </div>
    </div>
  );
}

function Field(props: { label: string; description: string; children: React.ReactNode }) {
  return (
    <div className="settings-field">
      <div className="settings-label">{props.label}</div>
      <div>
        {props.children}
        <p className="settings-desc">{props.description}</p>
      </div>
    </div>
  );
}

function Options<T extends string | null>(props: { items: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return (
    <div className="option-row">
      {props.items.map((item) => (
        <button key={item.label} className="option" aria-pressed={props.value === item.value} onClick={() => props.onChange(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}
