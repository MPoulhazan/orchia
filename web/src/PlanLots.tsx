import { useEffect, useState } from 'react';
import { ListOrdered, X } from 'lucide-react';
import { api, type SessionInfo } from './api';

/** Shown under the terminal while Claude waits on a plan that splits into lots, or after an answer in lots. */
export function showPlanLots(session: SessionInfo): boolean {
  if (session.status !== 'running') return false;
  return (session.activity === 'waiting' && !!session.planLots) || (session.activity === 'idle' && !!session.answerLots);
}

/**
 * "Split into Up next": instead of approving the whole plan, start lot 1 now and queue
 * the others in Up next, sent one by one as Claude finishes. Approving in the terminal
 * still works as usual; the first answer wins.
 */
export function PlanLots({ session }: { session: SessionInfo }) {
  // A plan waiting for review takes precedence; otherwise an ordinary answer in lots.
  const fromPlan = session.activity === 'waiting' && !!session.planLots;
  const found = (fromPlan ? session.planLots : session.answerLots) ?? [];
  const [lots, setLots] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [between, setBetween] = useState<'compact' | 'clear'>('compact');
  const [commit, setCommit] = useState(true);
  // A new plan (Claude revised it) starts over.
  useEffect(() => {
    setLots(null);
    setError(null);
  }, [found.join('\n')]);

  if (!lots) {
    return (
      <div className="planlots" aria-label="Plan in lots">
        <div className="upnext-head">
          <ListOrdered size={13} />
          <b>{fromPlan ? 'This plan' : "Claude's answer"} has {found.length} lots.</b>
          <span className="upnext-hint">
            {fromPlan
              ? 'Run them one at a time, or answer in the terminal to approve it all.'
              : 'Run them one after another, each only once the previous one is done.'}
          </span>
          <button className="btn btn-secondary upnext-send" onClick={() => setLots(found)}>
            {fromPlan ? 'Split into Up next' : 'Run as a sequence'}
          </button>
        </div>
      </div>
    );
  }

  const start = () => {
    const chosen = lots.map((l) => l.trim()).filter(Boolean);
    if (!chosen.length) return;
    setSending(true);
    setError(null);
    api
      .splitPlan(session.id, chosen, { between, commit: between === 'clear' || commit })
      .catch((err) => setError((err as Error).message))
      .finally(() => setSending(false));
  };

  return (
    <div className="planlots" aria-label="Plan in lots">
      <div className="upnext-head">
        <ListOrdered size={13} />
        <b>Lot 1 starts now</b>
        <span className="upnext-hint">the others wait in Up next and go one at a time, when Claude finishes</span>
      </div>
      <div className="planlots-list">
        {lots.map((lot, i) => (
          <div key={i} className="planlots-item">
            <span className="upnext-n">{i + 1}</span>
            <textarea
              className="planlots-text"
              value={lot}
              rows={Math.min(4, lot.split('\n').length)}
              aria-label={`Lot ${i + 1}`}
              onChange={(e) => setLots(lots.map((l, j) => (j === i ? e.target.value : l)))}
            />
            {lots.length > 1 && (
              <button className="icon-btn" title="Leave this lot out" onClick={() => setLots(lots.filter((_, j) => j !== i))}>
                <X size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
      {error && <p className="skill-error">{error}</p>}
      <div className="planlots-actions">
        <div className="planlots-options">
          <span className="planlots-label">Between lots</span>
          <div className="segmented planlots-between" role="radiogroup" aria-label="Between lots">
            <button
              role="radio"
              aria-checked={between === 'compact'}
              title="Keep the conversation; compact it when the context is over the limit set in Settings"
              onClick={() => setBetween('compact')}
            >
              Compact when needed
            </button>
            <button
              role="radio"
              aria-checked={between === 'clear'}
              title="Each lot starts a fresh conversation with the whole plan in its prompt, and reads git log for what was done"
              onClick={() => setBetween('clear')}
            >
              Clear
            </button>
          </div>
          <label className="remember" title={between === 'clear' ? 'Clear needs each lot committed, so the next one finds the work in git' : undefined}>
            <input
              type="checkbox"
              checked={between === 'clear' || commit}
              disabled={between === 'clear'}
              onChange={(e) => setCommit(e.target.checked)}
            />
            Commit after each lot
          </label>
        </div>
        <button className="btn btn-ghost" onClick={() => setLots(null)}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={sending} onClick={start}>
          {lots.length > 1 ? `Start lot 1, queue ${lots.length - 1}` : 'Start'}
        </button>
      </div>
    </div>
  );
}
