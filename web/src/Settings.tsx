import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun, X } from 'lucide-react';
import { api, type CloudStatus, type CopyMode, type PermissionMode, type Project, type Settings } from './api';
import { EFFORTS, MODELS } from './ModelPicker';
import type { ThemePref } from './theme';
import type { NotifyState } from './notifications';
import { useSmoothScroll, type SmoothScrollPref } from './smoothScroll';

const PERMISSION_MODES: { value: PermissionMode | null; label: string; description: string }[] = [
  { value: null, label: 'Default', description: 'Uses the permission mode from your Claude Code settings.' },
  { value: 'manual', label: 'Ask', description: 'Asks before every file edit and command.' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'Edits files without asking. Still asks before running commands.' },
  { value: 'plan', label: 'Plan first', description: 'Reads and plans only. Changes nothing until you approve the plan.' },
  { value: 'auto', label: 'Auto', description: 'Claude runs what it judges safe and asks only for risky actions.' },
];

const COPY_MODES: { value: CopyMode; label: string; description: string }[] = [
  { value: 'ask', label: 'Ask', description: 'When another session is already working in this folder, a new session asks whether to work in its own copy.' },
  { value: 'copy', label: 'Own copy', description: 'Every new session works in its own copy of the repository. You review and merge its changes from its Changes tab.' },
  { value: 'same', label: 'Same folder', description: 'New sessions always work in the project folder, even when another session is busy there.' },
];

const THEMES: [ThemePref, typeof Monitor, string][] = [
  ['system', Monitor, 'System'],
  ['light', Sun, 'Light'],
  ['dark', Moon, 'Dark'],
];

const ON_OFF: { value: 'on' | 'off'; label: string }[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

const REMOTE_ANSWERS: { value: Settings['remoteAnswers']; label: string; description: string }[] = [
  { value: 'all', label: 'Allow and Deny', description: 'Allow and Deny both work from your phone. "Always allow" stays on this computer.' },
  { value: 'no-shell', label: 'No shell commands', description: 'Shell commands (Bash, PowerShell) can only be allowed here. Everything else, and Deny, works from your phone.' },
  { value: 'deny-only', label: 'Deny only', description: 'Your phone can only deny, which stops the turn. Allowing stays on this computer.' },
];

const SMOOTH_SCROLL:{ value: SmoothScrollPref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

/** App-wide settings: defaults for new sessions (kept by the server), notifications, theme and scrolling (kept in this browser). */
export function SettingsDialog(props: {
  settings: Settings;
  cloud: CloudStatus;
  /** The project shown when Settings opened, for its own settings. */
  project: Project | null;
  themePref: ThemePref;
  onSetTheme: (pref: ThemePref) => void;
  notify: NotifyState;
  onToggleNotify: () => void;
  onClose: () => void;
}) {
  const { settings } = props;
  const [error, setError] = useState('');
  const smoothScroll = useSmoothScroll();

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
            <h3>Up next</h3>
            <Field
              label="Compact between tasks"
              description="Before sending the next queued prompt, Orchia types /compact when the conversation fills more than 60% of the context, so Claude Code doesn't compact in the middle of a task."
            >
              <Options
                items={ON_OFF}
                value={settings.compactBetweenTasks ? 'on' : 'off'}
                onChange={(v) => change({ compactBetweenTasks: v === 'on' })}
              />
            </Field>
          </section>

          <section className="settings-section">
            <h3>Connectors</h3>
            <Field
              label="Restart by itself"
              description="Connectors load when a session starts. After you add, remove, turn on or sign in to one, Orchia restarts the project's sessions as soon as Claude is free. The conversation is kept."
            >
              <Options
                items={ON_OFF}
                value={settings.restartAfterConnectorChange ? 'on' : 'off'}
                onChange={(v) => change({ restartAfterConnectorChange: v === 'on' })}
              />
            </Field>
          </section>

          {props.project && (
            <section className="settings-section">
              <h3>{props.project.name}</h3>
              <Field label="New sessions" description={(COPY_MODES.find((m) => m.value === (props.project!.copyMode ?? 'ask')) ?? COPY_MODES[0]).description}>
                <Options
                  items={COPY_MODES}
                  value={props.project.copyMode ?? 'ask'}
                  onChange={(copyMode) => api.setCopyMode(props.project!.id, copyMode).catch((err) => setError((err as Error).message))}
                />
              </Field>
            </section>
          )}

          <CloudSection cloud={props.cloud} settings={settings} onChange={change} />

          <section className="settings-section">
            <h3>This browser</h3>
            <Field
              label="Notifications"
              description={
                props.notify === 'blocked'
                  ? 'Blocked in the browser settings. Allow notifications for this site to turn them on.'
                  : 'Desktop notification when a session needs you or finishes while Orchia is in the background.'
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
            <Field label="Smooth scrolling" description="Animates scrolling in terminals and panels. System follows your computer's reduce-motion setting.">
              <Options items={SMOOTH_SCROLL} value={smoothScroll.pref} onChange={smoothScroll.setPref} />
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

/** Optional pairing with an Orchia Cloud account. Says exactly what leaves this machine before it does. */
function CloudSection(props: { cloud: CloudStatus; settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const { cloud, settings } = props;
  const paired = cloud.state === 'connected' || cloud.state === 'connecting';
  const answers = REMOTE_ANSWERS.find((a) => a.value === settings.remoteAnswers) ?? REMOTE_ANSWERS[0];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const host = cloud.url.replace(/^https?:\/\//, '');

  return (
    <section className="settings-section">
      <h3>Orchia Cloud</h3>
      <p className="settings-note">
        Optional. Pairs this computer with your account on {host || 'Orchia Cloud'}. Off unless you turn it on.
      </p>
      <Field
        label="Connection"
        description={
          cloud.state === 'off'
            ? cloud.note ?? 'Orchia opens a connection to the cloud. The cloud never connects to this computer.'
            : cloud.state === 'pairing'
              ? 'Check that the browser shows the same code, then approve it there.'
              : cloud.state === 'connected'
                ? `Paired as "${cloud.name}". Unpair here or from Devices on ${host}.`
                : `Paired as "${cloud.name}". Reaching ${host}…`
        }
      >
        <div className="option-row">
          {cloud.state === 'off' && (
            <button className="option" disabled={busy} onClick={() => run(api.pairCloud)}>
              Connect to Orchia Cloud
            </button>
          )}
          {cloud.state === 'pairing' && (
            <>
              <span className="cloud-code">{cloud.userCode}</span>
              <a className="option" href={cloud.verifyUrl} target="_blank" rel="noreferrer">
                Open {host}
              </a>
              <button className="option" disabled={busy} onClick={() => run(api.cancelCloudPairing)}>
                Cancel
              </button>
            </>
          )}
          {(cloud.state === 'connected' || cloud.state === 'connecting') && (
            <>
              <span className={`cloud-dot${cloud.state === 'connected' ? ' on' : ''}`} aria-hidden />
              <span className="cloud-state">{cloud.state === 'connected' ? 'Connected' : 'Connecting'}</span>
              <button className="option" disabled={busy} onClick={() => run(api.disconnectCloud)}>
                Disconnect
              </button>
            </>
          )}
        </div>
        {error && <p className="model-error">{error}</p>}
      </Field>
      {paired && (
        <Field
          label="Needs you on your phone"
          description="Shows the sessions that need you on Orchia Cloud, with a notification, so you can allow or deny a waiting request from your phone. The phone can only answer a request Claude already made: it can't start one or type in a session."
        >
          <Options items={ON_OFF} value={settings.remoteNeeds ? 'on' : 'off'} onChange={(v) => props.onChange({ remoteNeeds: v === 'on' })} />
        </Field>
      )}
      {paired && settings.remoteNeeds && (
        <Field label="From your phone" description={answers.description}>
          <Options items={REMOTE_ANSWERS} value={settings.remoteAnswers} onChange={(remoteAnswers) => props.onChange({ remoteAnswers })} />
        </Field>
      )}
      {paired && (
        <Field
          label="Security alerts in Orchia Cloud"
          description="Lists this computer's open security issues on Orchia Cloud's Security page, next to your other computers': known CVEs in your connectors, secrets that reached the model, risky permission settings. A secret's value is never sent."
        >
          <Options items={ON_OFF} value={settings.remoteSecurity ? 'on' : 'off'} onChange={(v) => props.onChange({ remoteSecurity: v === 'on' })} />
        </Field>
      )}
      <Field
        label="What is sent"
        description={
          settings.remoteNeeds || settings.remoteSecurity
            ? 'Your code, prompts and terminal output never leave this computer.'
            : 'Your code, prompts, terminal output, file and project names never leave this computer.'
        }
      >
        <ul className="cloud-sent">
          <li>This computer's name ("{cloud.state === 'off' || cloud.state === 'pairing' ? 'its hostname' : cloud.name}")</li>
          <li>Orchia's version and your operating system</li>
          <li>When this computer is online</li>
          {settings.remoteNeeds && (
            <>
              <li>For each session that needs you: its name and its project's name</li>
              <li>Why it waits, and a permission request's tool and target (the command, file or URL, cut at 300 characters)</li>
              <li>The summary of a finished turn you haven't looked at yet</li>
            </>
          )}
          {settings.remoteSecurity && (
            <>
              <li>For each open security issue: its kind, severity, a short description, and the project and session names</li>
              <li>What you decided about it: an accepted risk with your note, or a false positive</li>
              <li>For a secret that reached the model: its kind and first and last characters (ghp_…a41f), never its value</li>
            </>
          )}
        </ul>
      </Field>
    </section>
  );
}
