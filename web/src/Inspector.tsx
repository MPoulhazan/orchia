import { useEffect, useState } from 'react';
import { Check, GitBranch, X } from 'lucide-react';
import { api, type Inspection, type SessionInfo } from './api';
import { ConnectorsSection } from './Connectors';
import { SkillsSection, type SkillsChange } from './Skills';
import { InspectorSection } from './ui';

const POLL_MS = 3000;

/** Right-hand panel of the focus view: context, cost, skills, connectors, plan, uncommitted changes and branch. */
export function Inspector({
  session,
  onClose,
  skillsChange,
  onAddSkill,
}: {
  session: SessionInfo;
  onClose: () => void;
  skillsChange: SkillsChange;
  onAddSkill: () => void;
}) {
  const data = useInspection(session);
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

      <ConnectorsSection session={session} />

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
function useInspection(session: SessionInfo): Inspection | null {
  const [data, setData] = useState<{ id: string; value: Inspection } | null>(null);
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
  }, [session.id, session.activity, session.status]);
  return data?.id === session.id ? data.value : null;
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
