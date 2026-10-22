import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleDot, ExternalLink, TriangleAlert } from 'lucide-react';
import { api, type GitHubIssue, type IssuesResult, type SessionInfo } from './api';
import { fuzzyScore } from './fuzzy';

/** The Up next prompt for an issue, on one line. Claude reads the issue itself, comments included. */
export function issuePrompt(issue: GitHubIssue, planFirst: boolean): string {
  const n = issue.number;
  const title = issue.title.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  const read = `read it with gh issue view ${n} --comments`;
  return planFirst
    ? `Work on GitHub issue #${n} "${title}": ${read}, then plan it in plan mode as numbered lots before changing anything. The last lot ends with a commit whose message ends with "Fixes #${n}".`
    : `Work on GitHub issue #${n} "${title}": ${read}, fix it and check that it works, then commit with a message that ends with "Fixes #${n}".`;
}

/** An Up next prompt made by issuePrompt, read back to show it short: "#12 Title". */
export function queuedIssue(text: string): { number: number; title: string; planFirst: boolean } | null {
  const m = text.match(/^Work on GitHub issue #(\d+) "(.*?)": read it with gh issue view \d+ --comments, (then plan)?/);
  return m ? { number: Number(m[1]), title: m[2], planFirst: !!m[3] } : null;
}

const queuedNumbers = (session: SessionInfo) =>
  new Set(session.queue.map((q) => queuedIssue(q.text)?.number).filter((n): n is number => n !== undefined));

/**
 * "From an issue": picks open GitHub issues and queues them in Up next, one prompt each.
 * Issues from people outside the project are hidden until asked: their text goes to Claude.
 */
export function IssuePicker({ session, projectName, onClose }: { session: SessionInfo; projectName: string; onClose: () => void }) {
  const [result, setResult] = useState<IssuesResult | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<number[]>([]);
  const [planFirst, setPlanFirst] = useState<Set<number>>(new Set());
  const [showOutside, setShowOutside] = useState(false);
  const [error, setError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const queued = useMemo(() => queuedNumbers(session), [session.queue]);

  useEffect(() => {
    api.issues(session.id).then(setResult, (err) => setError(err.message));
  }, [session.id]);

  const all = result && 'issues' in result ? result.issues : [];
  const outside = all.filter((i) => !i.team);
  const items = useMemo(() => {
    const q = query.trim();
    const rank = (list: GitHubIssue[]) =>
      q
        ? list
            .map((i) => ({ i, s: fuzzyScore(q, `#${i.number} ${i.title} ${i.labels.join(' ')}`) }))
            .filter((r) => r.s !== null)
            .sort((a, b) => b.s! - a.s!)
            .map((r) => r.i)
        : list;
    return [...rank(all.filter((i) => i.team)), ...(showOutside ? rank(outside) : [])];
  }, [result, query, showOutside]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [active]);

  const current = items[active];
  const toggle = (n: number) => setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));
  const togglePlan = (n: number) =>
    setPlanFirst((s) => {
      const next = new Set(s);
      if (!next.delete(n)) next.add(n);
      return next;
    });

  // The checked issues in the order they were checked, else the one under the cursor.
  const toQueue = (picked.length ? picked : current ? [current.number] : []).filter((n) => !queued.has(n));

  async function queue() {
    if (!toQueue.length) return;
    try {
      for (const n of toQueue) {
        const issue = all.find((i) => i.number === n)!;
        await api.enqueue(session.id, issuePrompt(issue, planFirst.has(n)));
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Tab' && current) {
      e.preventDefault();
      if (!queued.has(current.number)) toggle(current.number);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      queue();
    }
  }

  const unavailable = result && 'unavailable' in result ? result.unavailable : '';
  let lastGroup = '';
  return (
    <div className="palette-backdrop" onMouseDown={onClose} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="palette issue-picker" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Queue GitHub issues">
        <div className="palette-crumb">
          <CircleDot size={13} />
          <span>
            GitHub issues of {projectName}
            {result && !unavailable && ` · ${all.length} open`}
          </span>
        </div>
        <input
          className="palette-input"
          autoFocus
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Filter issues by number, title or label…"
        />
        {(error || unavailable) && <div className="palette-error">{error || unavailable}</div>}
        <div className="issue-cols">
          <div className="palette-list" ref={listRef}>
            {!result && !error && <div className="palette-empty">Asking GitHub…</div>}
            {result && !unavailable && !items.length && (
              <div className="palette-empty">{all.length ? 'No match' : 'No open issues'}</div>
            )}
            {items.map((issue, i) => {
              const group = issue.team ? 'From you and the project' : 'From outside the project';
              const header = group !== lastGroup && (outside.length > 0 || !issue.team) ? <div className="palette-group">{group}</div> : null;
              lastGroup = group;
              const isQueued = queued.has(issue.number);
              return (
                <div key={issue.number}>
                  {header}
                  <div
                    className="palette-item issue-item"
                    data-active={i === active}
                    onMouseMove={() => setActive(i)}
                    onClick={() => !isQueued && toggle(issue.number)}
                  >
                    <input
                      type="checkbox"
                      tabIndex={-1}
                      aria-label={`Select #${issue.number}`}
                      checked={isQueued || picked.includes(issue.number)}
                      disabled={isQueued}
                      onChange={() => toggle(issue.number)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className="issue-n">#{issue.number}</span>
                    <span className="issue-title">{issue.title}</span>
                    {isQueued ? (
                      <span className="issue-tag">queued</span>
                    ) : planFirst.has(issue.number) ? (
                      <span className="issue-tag">plan first</span>
                    ) : (
                      issue.labels[0] && <span className="issue-label">{issue.labels[0]}</span>
                    )}
                  </div>
                </div>
              );
            })}
            {outside.length > 0 && !showOutside && (
              <button className="issue-outside" onClick={() => setShowOutside(true)}>
                <TriangleAlert size={13} />
                Show {outside.length} from outside the project
              </button>
            )}
          </div>

          {current && (
            <div className="issue-preview">
              <div className="issue-preview-head">
                <b>
                  #{current.number} {current.title}
                </b>
                <a href={current.url} target="_blank" rel="noreferrer" title="Open on GitHub">
                  <ExternalLink size={13} />
                </a>
              </div>
              <small>
                @{current.author}
                {current.comments > 0 && ` · ${current.comments} comment${current.comments > 1 ? 's' : ''}`}
                {current.labels.length > 0 && ` · ${current.labels.join(', ')}`}
              </small>
              {!current.team && (
                <div className="issue-warning">
                  <TriangleAlert size={13} />
                  <span>@{current.author} is not on the project. Claude will read this text: check it doesn't ask for anything you don't want.</span>
                </div>
              )}
              <div className="issue-body">{current.body.trim() || 'No description.'}</div>
              <label className="issue-plan">
                <input type="checkbox" checked={planFirst.has(current.number)} onChange={() => togglePlan(current.number)} />
                Plan first, then split it into lots
              </label>
            </div>
          )}
        </div>
        <div className="palette-footer">
          <span><kbd>Tab</kbd> select</span>
          <span>
            <kbd>Enter</kbd>{' '}
            {toQueue.length > 1 ? `queue ${toQueue.length} in Up next` : toQueue.length ? `queue #${toQueue[0]} in Up next` : 'queue'}
          </span>
          <span><kbd>Esc</kbd> close</span>
          <span className="issue-footer-note">Each one ends with a “Fixes #N” commit</span>
        </div>
      </div>
    </div>
  );
}
