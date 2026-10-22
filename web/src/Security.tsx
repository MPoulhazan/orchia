import { ShieldAlert } from 'lucide-react';
import type { SecurityNote } from './api';

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
