import { useState, type ReactNode } from 'react';
import { MoreHorizontal, ShieldAlert } from 'lucide-react';
import { api, type SecretExposure, type SecurityNote, type TriageChoice } from './api';
import { Menu } from './ui';

/**
 * A security alert in "Needs you". It stays until it is decided: fixed (on its own for a CVE or a
 * setting; "Revoked" for a secret), an accepted risk (with a note, back in 90 days) or a false
 * positive. There is no plain dismiss: an alert you can hide without a reason is an alert you stop reading.
 */
export function SecurityAlertRow(props: {
  alertKey: string;
  mark: string;
  danger: boolean;
  title: string;
  where: string;
  detail: ReactNode;
  selected: boolean;
  onOpen: () => void;
  /** The alert's own fix: Revoke, Block reads, Details. */
  actions?: ReactNode;
  /** A secret can be marked revoked by hand; anything else is fixed once Orchia no longer sees it. */
  revocable?: boolean;
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
        <span className="attention-detail">{props.detail}</span>
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
          {props.revocable && (
            <button className="btn btn-secondary" title="You revoked it: it can't be used any more" onClick={() => decide('fixed')}>
              Revoked
            </button>
          )}
          <Menu
            title="Decide"
            trigger={<MoreHorizontal size={14} />}
            items={[
              { label: 'Accept the risk…', onSelect: () => setAccepting(true) },
              { label: 'Not a real issue (false positive)', onSelect: () => decide('false-positive') },
            ]}
          />
        </span>
      )}
      {error && <span className="triage-error">{error}</span>}
    </div>
  );
}

/** "ghp_…a41f in the output of Run cat .env.local, in Fix auth. It reached the model: revoke it." */
export function secretText(e: SecretExposure): string {
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
