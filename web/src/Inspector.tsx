import { useEffect, useRef, useState } from 'react';
import { Check, Copy, GitBranch, Play, X } from 'lucide-react';
import { api, type AllowRule, type CodeBlock, type Inspection, type SessionInfo } from './api';
import { ConnectorsSection, type ConnectorsChange } from './Connectors';
import { SkillsSection, type SkillsChange } from './Skills';
import { InspectorSection } from './ui';

const POLL_MS = 3000;

/** Right-hand panel of the focus view: last answer's code, context, cost, skills, connectors, allow rules, plan, uncommitted changes and branch. */
export function Inspector({
  session,
  onClose,
  skillsChange,
  onAddSkill,
  connectorsChange,
  onAddConnector,
  autoRestart,
}: {
  session: SessionInfo;
  onClose: () => void;
  skillsChange: SkillsChange;
  onAddSkill: () => void;
  connectorsChange: ConnectorsChange;
  onAddConnector: () => void;
  /** Settings: Orchia restarts the session by itself after a connector change. */
  autoRestart: boolean;
}) {
  const [data, reload] = useInspection(session);
  const usage = data?.usage ?? null;
  const git = data?.git;

  return (
    <aside className="inspector" aria-label="Session inspector">
      <header className="insp-head">
        <span>This session</span>
        <button className="icon-btn" title="Hide inspector (Alt I)" onClick={onClose}>
          <X size={15} />
        </button>
      </header>

      {data && <AnswerBlocksSection session={session} blocks={data.blocks} />}

      <InspectorSection
        id="context"
        title="Context"
        summary={usage?.contextUsed != null && usage.contextSize ? `${tokens(usage.contextUsed)} / ${tokens(usage.contextSize)}` : null}
      >
        <ContextMeter used={usage?.contextUsed ?? null} size={usage?.contextSize ?? null} />
        <dl className="insp-kv">
          <dt title="Estimated by Claude Code at list price. Starts over with a new conversation.">Cost so far</dt>
          <dd>{usage?.costUsd != null ? dollars(usage.costUsd) : '—'}</dd>
          <dt title="Time spent waiting for the model">Model time</dt>
          <dd>{usage?.apiMs != null ? duration(usage.apiMs) : '—'}</dd>
          <dt>Turns</dt>
          <dd>{data ? data.turns : '—'}</dd>
        </dl>
      </InspectorSection>

      <SkillsSection session={session} change={skillsChange} onAdd={onAddSkill} />

      <ConnectorsSection session={session} change={connectorsChange} onAdd={onAddConnector} autoRestart={autoRestart} />

      {data && <AllowRulesSection session={session} rules={data.allowRules} onChange={reload} />}

      {data && data.plan.length > 0 && (
        <InspectorSection id="plan" title="Plan" summary={`${data.plan.filter((p) => p.status === 'completed').length} / ${data.plan.length}`}>
          <ul className="insp-plan">
            {data.plan.map((item) => (
              <li key={item.id} data-status={item.status}>
                <span className="insp-box">{item.status === 'completed' && <Check size={11} strokeWidth={3} />}</span>
                {item.text}
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}

      {git !== undefined && (
        <InspectorSection
          id="changes"
          title="Uncommitted changes"
          hint="Changes in the project folder since the last commit, made by any session or by you"
          summary={
            git && git.fileCount > 0 ? (
              <>
                <span className="insp-add">+{git.added}</span> <span className="insp-del">−{git.removed}</span>
              </>
            ) : null
          }
        >
          {!git ? (
            <p className="insp-empty">Not a git repository</p>
          ) : git.fileCount === 0 ? (
            <p className="insp-empty">None</p>
          ) : (
            <div className="insp-files">
              {git.files.map((f) => (
                <div key={f.path} title={f.path}>
                  <span className="insp-path">{f.path}</span>
                  {f.isNew ? (
                    <span className="insp-new">new</span>
                  ) : f.added === null ? (
                    <span className="insp-new">binary</span>
                  ) : (
                    <>
                      <span className="insp-add">+{f.added}</span>
                      <span className="insp-del">−{f.removed}</span>
                    </>
                  )}
                </div>
              ))}
              {git.fileCount > git.files.length && <p className="insp-empty">and {git.fileCount - git.files.length} more</p>}
            </div>
          )}
        </InspectorSection>
      )}

      {git && (
        <InspectorSection id="branch" title="Branch" summary={git.branch ?? 'detached HEAD'} foldedOnly>
          <div className="insp-branch">
            <GitBranch size={14} />
            <span className="insp-path">{git.branch ?? 'detached HEAD'}</span>
            <small>{remoteState(git.ahead, git.behind)}</small>
          </div>
        </InspectorSection>
      )}
    </aside>
  );
}

/** Fetches the inspection now, on every status change, and every few seconds while shown. */
function useInspection(session: SessionInfo): [Inspection | null, () => void] {
  const [data, setData] = useState<{ id: string; value: Inspection } | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .inspect(session.id)
        .then((value) => live && setData({ id: session.id, value }))
        .catch(() => {});
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [session.id, session.activity, session.status, nonce]);
  return [data?.id === session.id ? data.value : null, () => setNonce((n) => n + 1)];
}

const COPIED_MS = 1500;

/**
 * The code blocks of Claude's last reply, read from its Markdown (the terminal only has
 * them as plain text). Copy for each; Run for a block that is one shell command, which
 * types it after `!` in Claude's prompt so it runs in the session and Claude sees the output.
 */
function AnswerBlocksSection({ session, blocks }: { session: SessionInfo; blocks: CodeBlock[] }) {
  const [done, setDone] = useState<{ index: number; what: 'copied' | 'sent' } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [done]);
  useEffect(() => setError(null), [session.id, blocks]);

  if (!blocks.length) return null;
  const busy = session.status !== 'running' || session.activity !== 'idle' || !!session.permission;

  const copy = (index: number) => {
    navigator.clipboard.writeText(blocks[index].code).then(
      () => setDone({ index, what: 'copied' }),
      () => setError("Couldn't copy: the browser blocked the clipboard"),
    );
  };
  const run = (index: number) => {
    setError(null);
    api
      .runCommand(session.id, blocks[index].command!)
      .then(() => setDone({ index, what: 'sent' }))
      .catch((err) => setError((err as Error).message));
  };

  return (
    <InspectorSection
      id="answer-blocks"
      title="From the last answer"
      hint="Code from Claude's last reply"
      summary={blocks.length}
      footer={error && <p className="skill-error">{error}</p>}
    >
      <div className="code-blocks">
        {blocks.map((b, i) => (
          <div key={i} className="code-block">
            <div className="code-block-head">
              <span className="code-lang">{b.lang || 'text'}</span>
              {b.command && (
                <button
                  className="btn btn-ghost code-btn"
                  disabled={busy}
                  title={busy ? 'Available once Claude is waiting for you' : `Runs ${b.command} here, like typing ! in Claude's prompt. Claude sees the output.`}
                  onClick={() => run(i)}
                >
                  {done?.index === i && done.what === 'sent' ? <Check size={13} /> : <Play size={13} />}
                  {done?.index === i && done.what === 'sent' ? 'Sent' : 'Run'}
                </button>
              )}
              <button className="btn btn-ghost code-btn" title="Copy to the clipboard" onClick={() => copy(i)}>
                {done?.index === i && done.what === 'copied' ? <Check size={13} /> : <Copy size={13} />}
                {done?.index === i && done.what === 'copied' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="code-body">
              <code>{b.code}</code>
            </pre>
          </div>
        ))}
      </div>
    </InspectorSection>
  );
}

const NEW_RULE_MS = 4000;

/**
 * What Claude Code runs in this project without asking, from .claude/settings.local.json.
 * Hidden until there is one. A rule that shows up while the panel is open is
 * highlighted for a moment, so "Always allow" shows where it went.
 */
function AllowRulesSection({ session, rules, onChange }: { session: SessionInfo; rules: AllowRule[]; onChange: () => void }) {
  // Rules already seen for this session, and when they appeared (0: there from the start).
  const seen = useRef<{ id: string; at: Map<string, number> } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (seen.current?.id !== session.id) seen.current = { id: session.id, at: new Map(rules.map((r) => [r.rule, 0])) };
  const at = seen.current.at;
  for (const r of rules) if (!at.has(r.rule)) at.set(r.rule, Date.now());
  const isNew = (rule: string) => Date.now() - (at.get(rule) ?? 0) < NEW_RULE_MS;

  if (!rules.length) return null;

  const remove = (rule: string) => {
    setRemoving(rule);
    setError(null);
    api
      .removeAllowRule(session.id, rule)
      .then(() => {
        at.delete(rule);
        onChange();
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setRemoving(null));
  };

  return (
    <InspectorSection
      id="allow-rules"
      title="Allowed without asking"
      hint="Claude Code does these in this project without asking. Saved in .claude/settings.local.json"
      summary={rules.length}
      footer={error && <p className="skill-error">{error}</p>}
    >
      <div className="allow-list">
        {rules.map((r) => (
          <div key={r.rule} className="allow-row" data-new={isNew(r.rule)} title={r.rule}>
            <span className="allow-verb">{r.verb}</span>
            <code className="allow-target">{r.target}</code>
            <button
              className="icon-btn allow-remove"
              disabled={removing === r.rule}
              title="Remove: Claude asks again"
              aria-label={`Remove ${r.rule}: Claude asks again`}
              onClick={() => remove(r.rule)}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </InspectorSection>
  );
}

function ContextMeter({ used, size }: { used: number | null; size: number | null }) {
  if (used == null || !size) return <p className="insp-empty">Shown after Claude's first reply</p>;
  const pct = Math.min(100, (used / size) * 100);
  return (
    <>
      <div className="insp-meter" data-level={pct >= 80 ? 'high' : undefined} role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <p className="insp-note">{Math.round(pct)}% used</p>
    </>
  );
}

function remoteState(ahead: number | null, behind: number | null): string {
  if (ahead === null || behind === null) return 'no upstream';
  const parts = [ahead ? `${ahead} ahead` : '', behind ? `${behind} behind` : ''].filter(Boolean);
  return parts.length ? parts.join(', ') : 'up to date';
}

const tokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

const dollars = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
