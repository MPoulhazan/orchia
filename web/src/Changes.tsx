import { useEffect, useMemo, useState } from 'react';
import { Check, GitBranch, GitMerge, Trash2, TriangleAlert } from 'lucide-react';
import { api, type CopyChanges, type SessionInfo } from './api';
import { ConfirmButton } from './ui';

const POLL_MS = 4000;

/** What the copy changed, refreshed while shown (and kept fresh for the tab's count). */
export function useCopyChanges(session: SessionInfo, enabled = true): { data: CopyChanges | null; error: string | null; reload: () => void } {
  const [state, setState] = useState<{ id: string; data: CopyChanges | null; error: string | null }>({ id: session.id, data: null, error: null });
  const [nonce, setNonce] = useState(0);
  const isCopy = !!session.copy && enabled;

  useEffect(() => {
    if (!isCopy) return;
    let live = true;
    const load = () =>
      api
        .copyChanges(session.id)
        .then((data) => live && setState({ id: session.id, data, error: null }))
        .catch((err) => live && setState((s) => ({ id: session.id, data: s.id === session.id ? s.data : null, error: (err as Error).message })));
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [session.id, isCopy, session.activity, nonce]);

  const current = state.id === session.id ? state : { data: null, error: null };
  return { data: current.data, error: current.error, reload: () => setNonce((n) => n + 1) };
}

interface FileDiff {
  path: string;
  lines: string[];
}

/** Splits a unified diff into files, keeping the lines from the first hunk on. */
function splitDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  for (const part of diff.split(/^diff --git /m).slice(1)) {
    const lines = part.split('\n');
    const header = lines[0].match(/^a\/(.*) b\/(.*)$/);
    const start = lines.findIndex((l) => l.startsWith('@@') || l.startsWith('Binary files'));
    files.push({ path: header ? header[2] : lines[0], lines: start < 0 ? [] : lines.slice(start).filter((l, i, all) => i < all.length - 1 || l !== '') });
  }
  return files;
}

/**
 * The Changes tab of a session in its own copy: the diff since the copy was made,
 * then Merge into the base branch, Keep working, or Discard.
 */
export function ChangesView({ session, changes, onBack }: { session: SessionInfo; changes: ReturnType<typeof useCopyChanges>; onBack: () => void }) {
  const copy = session.copy!;
  const { data, error } = changes;
  const files = useMemo(() => splitDiff(data?.diff ?? ''), [data?.diff]);
  const [selected, setSelected] = useState<string | null>(null);
  const [action, setAction] = useState<'merge' | 'discard' | 'resolve' | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const shown = files.find((f) => f.path === selected) ?? files[0];
  const working = session.status === 'running' && (session.activity === 'working' || session.activity === 'waiting');

  const run = (kind: 'merge' | 'discard' | 'resolve') => {
    setAction(kind);
    setFailure(null);
    const call =
      kind === 'merge'
        ? api.mergeCopy(session.id).then((r) => {
            if (!r.ok) setConflict(r.conflict ?? 'Conflicts');
          })
        : kind === 'discard'
          ? api.discardCopy(session.id)
          : api.resolveCopy(session.id).then(() => {
              setConflict(null);
              onBack();
            });
    call.catch((err) => setFailure((err as Error).message)).finally(() => setAction(null));
  };

  const conflicts = conflict ?? (data?.conflicts ? `${copy.base} changed the same lines as this copy.` : null);

  return (
    <div className="changes" aria-label="Changes in this copy">
      {!data ? (
        <p className="changes-empty">{error ?? 'Reading the changes…'}</p>
      ) : data.files.length === 0 ? (
        <p className="changes-empty">No changes in this copy yet.</p>
      ) : (
        <div className="changes-main">
          <nav className="changes-files" aria-label="Changed files">
            <div className="changes-files-head">
              {data.files.length} file{data.files.length > 1 ? 's' : ''}
              {data.commits > 0 && ` · ${data.commits} commit${data.commits > 1 ? 's' : ''}`}
            </div>
            {data.files.map((f) => (
              <button key={f.path} className="changes-file" aria-current={shown?.path === f.path} title={f.path} onClick={() => setSelected(f.path)}>
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
              </button>
            ))}
          </nav>
          <div className="changes-diff">
            <div className="changes-diff-head">{shown?.path}</div>
            <pre className="diff">
              {shown?.lines.map((line, i) => (
                <span key={i} className={line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : undefined}>
                  {line || ' '}
                </span>
              ))}
            </pre>
          </div>
        </div>
      )}

      <div className="merge-bar">
        <GitBranch size={15} className="merge-icon" />
        <div className="merge-text">
          {data?.blocked ? (
            <>
              <b>Can't merge right now</b>
              <span>{data.blocked}</span>
            </>
          ) : conflicts ? (
            <>
              <b className="merge-warn">
                <TriangleAlert size={13} /> Conflicts with {copy.base}
              </b>
              <span>{conflicts} Ask Claude to merge them in this copy, then merge here.</span>
            </>
          ) : (
            <>
              <b>
                {copy.branch} → {copy.base}
              </b>
              <span>
                {data && data.files.length > 0 && (
                  <span className="merge-ok">
                    <Check size={12} strokeWidth={3} /> No conflicts
                  </span>
                )}
                {data && data.behind > 0 && ` · ${copy.base} moved ${data.behind} commit${data.behind > 1 ? 's' : ''} since this copy was made`}
                {working ? ' · Claude is still working' : data && data.files.length > 0 ? ' · Uncommitted work is committed when you merge' : ''}
              </span>
            </>
          )}
          {failure && <span className="merge-fail">{failure}</span>}
        </div>
        {conflicts && !data?.blocked ? (
          <button className="btn btn-primary" disabled={working || action !== null} onClick={() => run('resolve')}>
            Ask Claude to resolve
          </button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={!data || data.files.length === 0 || !!data.blocked || working || action !== null}
            title={`Merge into ${copy.base}, then remove this copy and its session`}
            onClick={() => run('merge')}
          >
            <GitMerge size={14} />
            {action === 'merge' ? 'Merging…' : `Merge into ${copy.base}`}
          </button>
        )}
        <button className="btn btn-secondary" onClick={onBack}>
          Keep working
        </button>
        <ConfirmButton className="btn btn-ghost" title="Delete this copy, its branch and its session" confirmLabel="Discard all changes" onConfirm={() => run('discard')}>
          <Trash2 size={14} />
          Discard
        </ConfirmButton>
      </div>
    </div>
  );
}
