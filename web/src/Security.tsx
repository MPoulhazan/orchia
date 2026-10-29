import { ShieldAlert } from 'lucide-react';
import type { SecretExposure, SecurityNote } from './api';

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
