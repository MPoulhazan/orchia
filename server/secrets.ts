import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './projects.ts';

/**
 * Secrets that reached the model: a token in a prompt, in a tool's input (Claude wrote it)
 * or in its output (`cat .env` printed it). The model provider has it, and Claude Code's
 * transcript keeps it in clear. Only formats with a fixed prefix are looked for, so a hit
 * is almost always real. The secret itself is never kept: its kind, the first and last
 * characters to recognize it, and a hash to tell the same secret seen twice.
 */

export type SecretSeverity = 'high' | 'critical';

interface Rule {
  kind: string;
  label: string;
  pattern: RegExp;
  severity: SecretSeverity;
  /** Where to revoke it; null when it depends on where the key is used. */
  rotateUrl: string | null;
}

const RULES: Rule[] = [
  { kind: 'github', label: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{80,})\b/g, severity: 'critical', rotateUrl: 'https://github.com/settings/tokens' },
  { kind: 'anthropic', label: 'Anthropic API key', pattern: /\bsk-ant-(?:api|admin)\d\d-[A-Za-z0-9_-]{80,}/g, severity: 'critical', rotateUrl: 'https://console.anthropic.com/settings/keys' },
  { kind: 'openai', label: 'OpenAI API key', pattern: /\bsk-[A-Za-z0-9_-]{16,}T3BlbkFJ[A-Za-z0-9_-]{16,}/g, severity: 'critical', rotateUrl: 'https://platform.openai.com/api-keys' },
  { kind: 'aws', label: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, severity: 'critical', rotateUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials' },
  { kind: 'stripe', label: 'Stripe live key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g, severity: 'critical', rotateUrl: 'https://dashboard.stripe.com/apikeys' },
  { kind: 'gitlab', label: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, severity: 'critical', rotateUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens' },
  { kind: 'private-key', label: 'Private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{20,}?-----END/g, severity: 'critical', rotateUrl: null },
  { kind: 'slack', label: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, severity: 'high', rotateUrl: 'https://api.slack.com/apps' },
  { kind: 'npm', label: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, severity: 'high', rotateUrl: 'https://docs.npmjs.com/revoking-access-tokens' },
  { kind: 'google', label: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, severity: 'high', rotateUrl: 'https://console.cloud.google.com/apis/credentials' },
];

const EXAMPLE_VALUE = /EXAMPLE/;

/** Tool outputs can be large; a secret further in than this is not looked for. */
const MAX_SCAN = 2_000_000;

export interface SecretHit {
  kind: string;
  label: string;
  severity: SecretSeverity;
  /** `ghp_…a41f`: enough to recognize it, not to use it. */
  masked: string;
  fingerprint: string;
  rotateUrl: string | null;
}

export function findSecrets(text: string): SecretHit[] {
  const hits = new Map<string, SecretHit>();
  const scanned = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  for (const rule of RULES) {
    for (const m of scanned.matchAll(rule.pattern)) {
      const value = m[0];
      // Documentation values (AWS's AKIAIOSFODNN7EXAMPLE) are not secrets.
      if (EXAMPLE_VALUE.test(value)) continue;
      const fingerprint = createHash('sha256').update(value).digest('hex').slice(0, 16);
      if (hits.has(fingerprint)) continue;
      hits.set(fingerprint, { kind: rule.kind, label: rule.label, severity: rule.severity, masked: mask(rule.kind, value), fingerprint, rotateUrl: rule.rotateUrl });
    }
  }
  return [...hits.values()];
}

/** `text` with every secret it holds replaced by its masked form: `echo AKIA…Y777`. */
export function redactSecrets(text: string): string {
  return RULES.reduce((out, rule) => out.replace(rule.pattern, (value) => mask(rule.kind, value)), text);
}

function mask(kind: string, value: string): string {
  if (kind === 'private-key') return value.match(/^-----BEGIN [A-Z ]+-----/)?.[0] ?? 'PRIVATE KEY';
  const prefix = value.match(/^(?:github_pat_|[a-z]+[_-](?:ant-)?|AKIA|ASIA|AIza)/)?.[0] ?? value.slice(0, 4);
  return `${prefix}…${value.slice(-4)}`;
}

/** "GitHub token reached the model" / "in a commit Orchia blocked", and where, as alerts word it. */
export function exposureText(e: Pick<SecretExposure, 'label' | 'masked' | 'source' | 'where'>): { title: string; detail: string } {
  if (e.source === 'commit') return { title: `${e.label} in a commit Orchia blocked`, detail: `${e.masked} in ${e.where ?? 'a commit'}` };
  const where = e.source === 'prompt' ? 'in a prompt' : e.source === 'tool-output' ? `in the output of ${e.where ?? 'a tool'}` : `in ${e.where ?? 'a tool call'}`;
  return { title: `${e.label} reached the model`, detail: `${e.masked} ${where}` };
}

/** Where a secret showed up: `Your prompt`, `Output of Run cat .env.local`; `commit`, in a commit or push Orchia blocked. */
export type SecretSource = 'prompt' | 'tool-input' | 'tool-output' | 'commit';

export interface SecretSighting {
  hit: SecretHit;
  source: SecretSource;
}

/** The secrets in a hook payload: the prompt the user sent, or a tool call's input and output. */
export function secretsInHook(payload: any): SecretSighting[] {
  const event = payload?.hook_event_name;
  const text = (v: unknown) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  const sightings = (value: unknown, source: SecretSource) => findSecrets(text(value)).map((hit) => ({ hit, source }));
  if (event === 'UserPromptSubmit') return sightings(payload.prompt, 'prompt');
  if (event === 'PostToolUse') {
    const output = sightings(payload.tool_response, 'tool-output');
    const seen = new Set(output.map((s) => s.hit.fingerprint));
    // A secret Claude passes back in (writes it to a file, uses it in a command) is the same exposure.
    return [...output, ...sightings(payload.tool_input, 'tool-input').filter((s) => !seen.has(s.hit.fingerprint))];
  }
  return [];
}

export interface SecretExposure {
  id: string;
  kind: string;
  label: string;
  severity: SecretSeverity;
  masked: string;
  fingerprint: string;
  rotateUrl: string | null;
  source: SecretSource;
  /** The tool call, as the UI words it: `Run cat .env.local`; null for a prompt. */
  where: string | null;
  projectId: string;
  sessionId: string;
  sessionName: string;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Sightings, in this session or others, since it was first seen. */
  count: number;
  /** Set when the user says the secret was revoked or doesn't matter. */
  resolvedAt: number | null;
}

const STORE_FILE = join(CONFIG_DIR, 'secrets.json');
/** Resolved exposures are kept this long, for the history. */
const KEEP_RESOLVED_MS = 90 * 24 * 60 * 60 * 1000;

/** Exposures, one per secret: seeing it again counts, it doesn't add a row. Kept across restarts. */
export class SecretStore {
  private exposures: SecretExposure[] = [];

  constructor(private file = STORE_FILE) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(saved?.exposures)) this.exposures = saved.exposures;
    } catch {}
    // Orchia 0c70fc6 to 18b24b6 kept the command as it ran, secret included: clean those up.
    let cleaned = false;
    for (const e of this.exposures) {
      const where = e.where === null ? null : redactSecrets(e.where);
      if (where !== e.where) {
        e.where = where;
        cleaned = true;
      }
    }
    if (cleaned) this.save();
  }

  list(): SecretExposure[] {
    return this.exposures;
  }

  open(): SecretExposure[] {
    return this.exposures.filter((e) => !e.resolvedAt);
  }

  /** Records what a hook payload exposed; true when something new needs the user. */
  record(sightings: SecretSighting[], at: { projectId: string; sessionId: string; sessionName: string; where: string | null }): boolean {
    let changed = false;
    const now = Date.now();
    for (const { hit, source } of sightings) {
      const known = this.exposures.find((e) => e.fingerprint === hit.fingerprint);
      if (known) {
        known.lastSeenAt = now;
        known.count++;
        // About to be committed is worse than seen by the model: say so, and open it again if it was closed.
        if (source === 'commit' && known.source !== 'commit') {
          Object.assign(known, { source, where: at.where === null ? null : redactSecrets(at.where), resolvedAt: null });
          changed = true;
        }
        continue;
      }
      // The command or file that showed it often holds the secret itself: `echo $TOKEN` expanded.
      const where = at.where === null ? null : redactSecrets(at.where);
      this.exposures.push({ id: randomUUID(), ...hit, source, ...at, where, firstSeenAt: now, lastSeenAt: now, count: 1, resolvedAt: null });
      changed = true;
    }
    if (sightings.length) this.save();
    return changed;
  }

  resolve(id: string) {
    const exposure = this.exposures.find((e) => e.id === id);
    if (!exposure) throw new Error('Unknown exposure');
    exposure.resolvedAt = Date.now();
    this.save();
  }

  /** Revoked (fixed) or open again, by the secret's fingerprint, as triage knows it. */
  setResolved(fingerprint: string, resolved: boolean) {
    const exposure = this.exposures.find((e) => e.fingerprint === fingerprint);
    if (!exposure) throw new Error('Unknown secret');
    exposure.resolvedAt = resolved ? Date.now() : null;
    this.save();
  }

  private save() {
    const cutoff = Date.now() - KEEP_RESOLVED_MS;
    this.exposures = this.exposures.filter((e) => !e.resolvedAt || e.resolvedAt > cutoff);
    try {
      writeFileSync(this.file, JSON.stringify({ exposures: this.exposures }, null, 2));
    } catch (err) {
      console.warn(`Could not save ${this.file}: ${(err as Error).message}`);
    }
  }
}
