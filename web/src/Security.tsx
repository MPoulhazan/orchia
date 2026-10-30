import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ExternalLink, ShieldAlert, X } from 'lucide-react';
import { api, type ConfigNeeded, type SecretExposure, type SecurityNeeded, type SecurityNote, type TriageChoice } from './api';
import { Menu } from './ui';

/**
 * A security alert in "Needs you": what happened, where, and one main action. It stays until it
 * is decided under Resolve: fixed (on its own for a CVE or a setting; "I revoked it" for a secret),
 * an accepted risk (with a note, back in 90 days) or a false positive.
 */
export function SecurityAlertRow(props: {
  alertKey: string;
  mark: string;
  danger: boolean;
  title: string;
  where: string;
  detail: ReactNode;
  /** The full story, on hover: the command or file where it was seen. */
  detailTitle?: string;
  selected: boolean;
  onOpen: () => void;
  /** The alert's own fix, its one main action: Revoke on GitHub, Block reads, Details. */
  actions?: ReactNode;
  /** A secret can be marked revoked by hand ("I revoked it"); anything else is fixed once Orchia no longer sees it. */
  revocable?: boolean;
  /** ✕ in Needs you: put it off, no decision. */
  onLater?: () => void;
  /** In the Security list, for one put off: back to Needs you. */
  onBack?: () => void;
}) {
  const [accepting, setAccepting] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const decide = async (status: TriageChoice, text = '') => {
    setError(null);
    try {
      await api.triageFinding(props.alertKey, status, text);
      setAccepting(false);
      setNote('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="attention-row" data-selected={props.selected}>
      <button className="attention-open" onClick={props.onOpen}>
        <span className="attention-title">
          <span className="mark" data-tone={props.danger ? 'danger' : undefined}>
            {props.mark}
          </span>
          <b>{props.title}</b>
          <span className="attention-project">· {props.where}</span>
        </span>
        <span className="attention-detail" title={props.detailTitle}>
          {props.detail}
        </span>
      </button>
      {accepting ? (
        <form
          className="triage-form"
          onSubmit={(e) => {
            e.preventDefault();
            decide('accepted', note);
          }}
        >
          <input
            autoFocus
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setAccepting(false)}
            placeholder="Why is this acceptable? Back in 90 days."
            aria-label="Why the risk is accepted"
          />
          <button className="btn btn-secondary" type="submit" disabled={!note.trim()}>
            Accept
          </button>
          <button className="btn btn-secondary" type="button" onClick={() => setAccepting(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <span className="perm-acts" data-small>
          {props.actions}
          <Menu
            button
            title="Decide what to do with this alert"
            trigger={
              <>
                Resolve <ChevronDown size={12} />
              </>
            }
            items={[
              ...(props.revocable ? [{ label: 'I revoked it', onSelect: () => decide('fixed') }] : []),
              { label: props.revocable ? 'Not a real secret' : 'Not a real issue', onSelect: () => decide('false-positive') },
              { label: 'Accept the risk…', onSelect: () => setAccepting(true) },
            ]}
          />
          {props.onBack && (
            <button className="btn btn-ghost" title="Show it in Needs you again" onClick={props.onBack}>
              Back to Needs you
            </button>
          )}
          {props.onLater && (
            <button className="icon-btn" title="Later: out of Needs you, no decision. It stays in Security, and open on Orchia Cloud" onClick={props.onLater}>
              <X size={13} />
            </button>
          )}
        </span>
      )}
      {error && <span className="triage-error">{error}</span>}
    </div>
  );
}

/**
 * Needs you only gets what can't wait: a secret that reached the model or a commit, a serious
 * CVE, permissions left wide open, a secret in git. Moderate settings (readable .env files, a
 * .env git would commit, GitHub's scanning off) can wait in the Security list.
 */
export function isUrgent(c: ConfigNeeded): boolean {
  return c.risk.severity === 'high';
}

/** Open: not decided yet (Later or not). */
export const isOpen = (a: { triage: unknown }) => !a.triage;

type Fix = NonNullable<ConfigNeeded['risk']['fix']>;

const FIX_LABEL: Record<Fix, string> = {
  'deny-env': 'Block reads',
  'remove-allow': 'Remove rule',
  'ignore-env': 'Add to .gitignore',
  'github-secret-scanning': 'Turn on',
};

const FIX_TITLE: Record<Fix, (risk: ConfigNeeded['risk']) => string> = {
  'deny-env': () =>
    'Adds Read(**/.env) and Read(**/.env.*) to the deny rules in .claude/settings.local.json; Orchia then also refuses shell commands that print a .env file',
  'remove-allow': (risk) => `Removes ${risk.rule} from .claude/settings.local.json`,
  'ignore-env': (risk) => `Adds ${risk.files?.join(', ') ?? 'the .env files'} to the project's .gitignore`,
  'github-secret-scanning': () => 'Turns on secret scanning and push protection in the repository settings on GitHub, with your gh login',
};

interface RowProps<T> {
  item: T;
  projectName: string;
  selected: boolean;
  onOpen: () => void;
  /** Given: a ✕ that puts the alert off (Needs you). */
  onLater?: (key: string) => void;
  /** Given: "Back to Needs you" (the Security list, for one put off). */
  onBack?: (key: string) => void;
}

export function SecretRow({ item: e, projectName, selected, onOpen, onLater, onBack }: RowProps<SecretExposure>) {
  return (
    <SecurityAlertRow
      alertKey={e.key}
      mark="Secret"
      danger
      title={secretTitle(e)}
      where={projectName}
      detail={secretLine(e)}
      detailTitle={secretText(e)}
      selected={selected}
      onOpen={onOpen}
      revocable
      onLater={onLater && (() => onLater(e.key))}
      onBack={onBack && (() => onBack(e.key))}
      actions={
        e.rotateUrl && (
          <a className="btn btn-secondary" href={e.rotateUrl} target="_blank" rel="noreferrer" title="Revoke it, then put a new one where it is used">
            {revokeLabel(e)} <ExternalLink size={12} />
          </a>
        )
      }
    />
  );
}

export function ConfigRow({ item: c, projectName, selected, onOpen, onLater, onBack }: RowProps<ConfigNeeded>) {
  return (
    <SecurityAlertRow
      alertKey={c.key}
      mark="Config"
      danger={c.risk.severity === 'high'}
      title={c.risk.title}
      where={c.risk.shared ? 'All projects' : projectName}
      detail={c.risk.detail}
      selected={selected}
      onOpen={onOpen}
      onLater={onLater && (() => onLater(c.key))}
      onBack={onBack && (() => onBack(c.key))}
      actions={
        c.risk.fix && (
          <button className="btn btn-secondary" title={FIX_TITLE[c.risk.fix](c.risk)} onClick={() => api.fixConfigRisk(c.sessionId, c.risk.id)}>
            {FIX_LABEL[c.risk.fix]}
          </button>
        )
      }
    />
  );
}

export function CveRow({ item: c, projectName, selected, onOpen, onLater, onBack }: RowProps<SecurityNeeded>) {
  return (
    <SecurityAlertRow
      alertKey={c.key}
      mark="Security"
      danger
      title={c.label}
      where={c.shared ? 'All projects' : projectName}
      detail={securityText(c.note)}
      selected={selected}
      onOpen={onOpen}
      onLater={onLater && (() => onLater(c.key))}
      onBack={onBack && (() => onBack(c.key))}
      actions={
        <a className="btn btn-secondary" href={c.note.url} target="_blank" rel="noreferrer">
          Details
        </a>
      }
    />
  );
}

/** Where each kind of secret is revoked, for "Revoke on GitHub". */
const PROVIDER: Record<string, string> = {
  github: 'GitHub',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  aws: 'AWS',
  stripe: 'Stripe',
  gitlab: 'GitLab',
  slack: 'Slack',
  npm: 'npm',
  google: 'Google Cloud',
};

export function revokeLabel(e: SecretExposure): string {
  return PROVIDER[e.kind] ? `Revoke on ${PROVIDER[e.kind]}` : 'Revoke';
}

/** What happened, in words: "Stripe live key sent to Claude". */
export function secretTitle(e: SecretExposure): string {
  return e.source === 'commit' ? `${e.label} in a commit Orchia blocked` : `${e.label} sent to Claude`;
}

/** Where, in a few words: "In a command Claude ran · Fix auth · sk_…uvwx". The full story is secretText, on hover. */
export function secretLine(e: SecretExposure): string {
  const where =
    e.source === 'prompt'
      ? 'In your prompt'
      : e.source === 'tool-output'
        ? "In a command's output"
        : e.source === 'commit'
          ? 'Refused before it reached git'
          : e.where?.startsWith('Run ')
            ? 'In a command Claude ran'
            : `In ${e.where ?? 'a tool call'}`;
  // A private key's masked form is its BEGIN line: the title says enough.
  const key = e.kind === 'private-key' ? null : e.masked;
  return [where, e.sessionName, key, e.count > 1 ? `seen ${e.count}×` : null].filter(Boolean).join(' · ');
}

/** "ghp_…a41f in the output of Run cat .env.local, in Fix auth. It reached the model: revoke it." */
export function secretText(e: SecretExposure): string {
  if (e.source === 'commit') {
    return `${e.masked} in ${e.where ?? 'a commit'}, in ${e.sessionName}. Orchia refused it and told Claude to take the secret out. It also reached the model: revoke it if it is real.`;
  }
  const where =
    e.source === 'prompt' ? 'in a prompt' : e.source === 'tool-output' ? `in the output of ${e.where ?? 'a tool'}` : `in ${e.where ?? 'a tool call'}`;
  const again = e.count > 1 ? ` Seen ${e.count} times.` : '';
  return `${e.masked} ${where}, in ${e.sessionName}. It reached the model and stays in the transcript: revoke it.${again}`;
}

/** "High security issue in Serena: …. Fixed in 2.0.0." */
export function securityText(note: SecurityNote): string {
  const fix =
    note.level === 'unfixed'
      ? 'No fix yet.'
      : note.level === 'affected'
        ? `The version in use is affected. Fixed in ${note.fixedIn}.`
        : `Fixed in ${note.fixedIn}: check you have it or later.`;
  return `${capitalize(note.severity)} security issue in ${note.tool}: ${note.summary} ${fix}`;
}

/**
 * A shield next to a connector, skill or plugin that has an advisory, linking to its review in
 * awesome-vetted-claude-code. Red when it applies for sure, grey when only a version check is needed.
 */
export function SecurityBadge({ note }: { note: SecurityNote | null | undefined }) {
  if (!note) return null;
  return (
    <a
      className="security-badge"
      data-level={note.level}
      href={note.url}
      target="_blank"
      rel="noreferrer"
      title={`${securityText(note)}\nOpens its review in awesome-vetted-claude-code.`}
      aria-label={securityText(note)}
      onClick={(e) => e.stopPropagation()}
    >
      <ShieldAlert size={13} />
    </a>
  );
}

const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Everything the user decided, newest first, for the Security list's history. */
interface Decided {
  key: string;
  title: string;
  where: string;
  how: string;
  at: number;
}

function decision(t: { status: 'accepted' | 'false-positive'; note: string; expiresAt: number | null }): string {
  if (t.status === 'false-positive') return t.note ? `Not a real issue: ${t.note}` : 'Not a real issue';
  const back = t.expiresAt ? `, back on ${new Date(t.expiresAt).toLocaleDateString()}` : '';
  return `Risk accepted: ${t.note}${back}`;
}

/**
 * Every security alert of this computer in one place, from the Security line under the
 * projects: what Needs you shows, what was put off with Later, what can wait, and what was
 * decided (with Reopen).
 */
export function SecurityPanel(props: {
  secrets: SecretExposure[];
  secretsResolved: SecretExposure[];
  security: SecurityNeeded[];
  config: ConfigNeeded[];
  projectName: (id: string) => string;
  selectedId: string | null;
  onOpenSession: (id: string) => void;
  onClose: () => void;
}) {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const later = (key: string) => api.laterFinding(key, true).catch(() => {});
  const back = (key: string) => api.laterFinding(key, false).catch(() => {});
  const secrets = props.secrets.filter(isOpen);
  const security = props.security.filter(isOpen);
  const config = props.config.filter(isOpen);
  const row = (put: 'needs' | 'later' | 'wait') => ({ onLater: put === 'later' ? undefined : later, onBack: put === 'later' ? back : undefined });
  const common = (a: { sessionId: string; projectId: string }) => ({
    projectName: props.projectName(a.projectId),
    selected: a.sessionId === props.selectedId,
    onOpen: () => props.onOpenSession(a.sessionId),
  });
  const sections: { title: string; hint: string; rows: ReactNode[] }[] = [
    {
      title: 'Needs you',
      hint: 'Can’t wait: a secret that got out, a serious CVE, permissions left wide open.',
      rows: [
        ...secrets.filter((e) => !e.later).map((e) => <SecretRow key={e.key} item={e} {...common(e)} {...row('needs')} />),
        ...security.filter((c) => !c.later).map((c) => <CveRow key={c.key} item={c} {...common(c)} {...row('needs')} />),
        ...config.filter((c) => !c.later && isUrgent(c)).map((c) => <ConfigRow key={c.key} item={c} {...common(c)} {...row('needs')} />),
      ],
    },
    {
      title: 'Later',
      hint: 'Put off with ✕. Back in Needs you if it happens again. Still open on Orchia Cloud.',
      rows: [
        ...secrets.filter((e) => e.later).map((e) => <SecretRow key={e.key} item={e} {...common(e)} {...row('later')} />),
        ...security.filter((c) => c.later).map((c) => <CveRow key={c.key} item={c} {...common(c)} {...row('later')} />),
        ...config.filter((c) => c.later).map((c) => <ConfigRow key={c.key} item={c} {...common(c)} {...row('later')} />),
      ],
    },
    {
      title: 'Can wait',
      hint: 'Worth fixing, not urgent: these never go to Needs you.',
      rows: config.filter((c) => !c.later && !isUrgent(c)).map((c) => <ConfigRow key={c.key} item={c} {...common(c)} {...row('wait')} />),
    },
  ];

  const decided: Decided[] = [
    ...props.secrets.filter((e) => e.triage).map((e) => ({ key: e.key, title: secretTitle(e), where: props.projectName(e.projectId), how: decision(e.triage!), at: e.triage!.at })),
    ...props.secretsResolved.map((e) => ({ key: e.key, title: secretTitle(e), where: props.projectName(e.projectId), how: 'Revoked', at: e.resolvedAt ?? 0 })),
    ...props.security.filter((c) => c.triage).map((c) => ({ key: c.key, title: c.label, where: c.shared ? 'All projects' : props.projectName(c.projectId), how: decision(c.triage!), at: c.triage!.at })),
    ...props.config.filter((c) => c.triage).map((c) => ({ key: c.key, title: c.risk.title, where: c.risk.shared ? 'All projects' : props.projectName(c.projectId), how: decision(c.triage!), at: c.triage!.at })),
  ].sort((a, b) => b.at - a.at);

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="settings security-panel" role="dialog" aria-label="Security">
        <header className="settings-head">
          <h2>Security</h2>
          <button className="icon-btn" title="Close (Esc)" onClick={props.onClose}>
            <X size={15} />
          </button>
        </header>
        <div className="settings-body">
          {sections.map((s) => (
            <section key={s.title} className="security-section">
              <h3>
                {s.title} {s.rows.length > 0 && <span className="section-count">{s.rows.length}</span>}
              </h3>
              <p className="security-hint">{s.hint}</p>
              {s.rows.length ? <div className="attention">{s.rows}</div> : <p className="security-empty">Nothing here.</p>}
            </section>
          ))}
          <section className="security-section">
            <h3>
              Decided {decided.length > 0 && <span className="section-count">{decided.length}</span>}
            </h3>
            <p className="security-hint">The last 90 days. Reopen one to look at it again.</p>
            {decided.length ? (
              <ul className="security-decided">
                {decided.map((d) => (
                  <li key={`${d.key}:${d.how}`}>
                    <span>
                      <b>{d.title}</b> <span className="attention-project">· {d.where}</span>
                      <br />
                      <span className="security-how">{d.how}</span>
                    </span>
                    <button className="btn btn-ghost" onClick={() => api.triageFinding(d.key, 'open').catch(() => {})}>
                      Reopen
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="security-empty">Nothing decided yet.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
