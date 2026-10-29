import { useState, type DragEvent, type KeyboardEvent } from 'react';
import { GripVertical, ListOrdered, Plus, X } from 'lucide-react';
import { api, type SessionInfo } from './api';
import { queuedIssue } from './Issues';

/** Shown under the terminal while Claude works, or while prompts wait. */
export function showUpNext(session: SessionInfo): boolean {
  return session.status === 'running' && (session.activity === 'working' || session.queue.length > 0);
}

const HELD: Record<NonNullable<SessionInfo['queueHeld']>, string> = {
  typing: "Waiting: Claude's prompt has text in it. Send it or clear it, or send the next one anyway.",
  stopped: 'Paused: the last turn was stopped before it finished.',
  blocked: 'Paused: the last lot ended without saying it was done.',
};

/**
 * "Up next": prompts typed while Claude works, sent one at a time when it
 * finishes a turn. The server never sends while the user types in the terminal
 * or while Claude waits for an answer.
 */
export function UpNext({ session }: { session: SessionInfo }) {
  const [draft, setDraft] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const queue = session.queue;
  const run = session.lotRun;

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    api.enqueue(session.id, text).catch(() => setDraft(text));
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    } else if (e.key === 'Escape') {
      e.currentTarget.blur();
    }
  };

  const drop = (targetId: string) => (e: DragEvent) => {
    e.preventDefault();
    if (!dragId || dragId === targetId) return;
    const ids = queue.map((q) => q.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    setDragId(null);
    api.reorderQueue(session.id, ids).catch(() => {});
  };

  return (
    <div className="upnext" aria-label="Up next">
      {(queue.length > 0 || run?.state === 'running') && (
        <div className="upnext-head">
          <ListOrdered size={13} />
          <b>Up next</b>
          {run?.state === 'running' && (
            <span className="issue-tag" title={`Running a plan in ${run.total} lots`}>
              Lot {run.n}/{run.total}
            </span>
          )}
          {!queue.length ? (
            <span className="upnext-hint">last lot of the plan</span>
          ) : session.queueHeld === 'blocked' && session.lotBlocked ? (
            <LotHeld session={session} />
          ) : session.queueHeld ? (
            <>
              <span className="upnext-held">{HELD[session.queueHeld]}</span>
              <button className="btn btn-secondary upnext-send" onClick={() => api.sendQueuedNow(session.id).catch(() => {})}>
                Send now
              </button>
            </>
          ) : (
            <span className="upnext-hint">sent one at a time when Claude finishes, never while you type</span>
          )}
        </div>
      )}
      {queue.map((q, i) => (
        <div
          key={q.id}
          className="upnext-item"
          data-dragging={dragId === q.id}
          draggable={queue.length > 1}
          onDragStart={() => setDragId(q.id)}
          onDragEnd={() => setDragId(null)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={drop(q.id)}
        >
          <span className="upnext-n">{i + 1}</span>
          {q.lot ? <QueuedLot text={q.text} lot={q.lot} /> : <QueuedText text={q.text} />}
          {queue.length > 1 && <GripVertical size={13} className="upnext-grip" aria-hidden />}
          <button className="icon-btn" title="Remove from the queue" onClick={() => api.dequeue(session.id, q.id).catch(() => {})}>
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="upnext-row">
        <label className="upnext-input">
          <Plus size={14} />
          <input
            value={draft}
            placeholder={queue.length ? 'Then…' : 'Queue a prompt for when Claude is done'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
          />
          {draft.trim() && <kbd>Enter</kbd>}
        </label>
      </div>
    </div>
  );
}

/** Lot n of a split plan ended without saying it was done: the next lots wait. */
function LotHeld({ session }: { session: SessionInfo }) {
  const { n, total, reason } = session.lotBlocked!;
  const dropRest = () => {
    for (const q of session.queue) if (q.lot) api.dequeue(session.id, q.id).catch(() => {});
  };
  return (
    <>
      <span className="upnext-held">
        Lot {n}/{total} {reason ? `blocked: ${reason}` : "ended without saying it was done"}. The next lots wait.
      </span>
      <button className="btn btn-ghost upnext-send" onClick={dropRest}>
        Drop the rest
      </button>
      <button className="btn btn-secondary" onClick={() => api.sendQueuedNow(session.id).catch(() => {})}>
        Resume
      </button>
    </>
  );
}

/** A queued lot shows as "Lot 3/4" and its own text, without the instructions around it. */
function QueuedLot({ text, lot }: { text: string; lot: { n: number; total: number; clear?: boolean } }) {
  // A cleared lot's prompt carries the whole plan first: show only "Lot n is: …".
  const own =
    text.match(/ Lot \d+ is: (.*?) When lot \d+ is finished and checked/)?.[1] ??
    text.replace(/^Continue the plan with lot \d+ of \d+ only, then stop: /, '').replace(/ When lot \d+ is finished and checked.*$/, '');
  return (
    <>
      <span className="issue-tag">
        Lot {lot.n}/{lot.total}
      </span>
      {lot.clear && (
        <span className="issue-tag" title="Starts with /clear: a fresh conversation with the whole plan">
          clear
        </span>
      )}
      <span className="upnext-text" title={text}>
        {own}
      </span>
    </>
  );
}

/** A queued prompt; one made from a GitHub issue reads "#12 Title". */
function QueuedText({ text }: { text: string }) {
  const issue = queuedIssue(text);
  return (
    <>
      <span className="upnext-text" title={text}>
        {issue ? (
          <>
            <span className="issue-n">#{issue.number}</span> {issue.title}
          </>
        ) : (
          text
        )}
      </span>
      {issue?.planFirst && <span className="issue-tag">plan first</span>}
    </>
  );
}

/** "+2" on a tab or grid cell when prompts wait. */
export function QueueBadge({ session }: { session: SessionInfo }) {
  const n = session.queue.length;
  if (!n) return null;
  return (
    <span className="queue-badge" title={`${n} prompt${n > 1 ? 's' : ''} up next`}>
      +{n}
    </span>
  );
}
