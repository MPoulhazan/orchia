import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Project } from './api';

export type Where = 'copy' | 'same';

/**
 * Asked only when another session is already at work in the project folder
 * (and the project is set to ask): start in its own copy, or in the same folder.
 */
export function NewSessionDialog(props: {
  project: Project;
  busy: string[];
  onStart: (where: Where, remember: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [where, setWhere] = useState<Where>('copy');
  const [remember, setRemember] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    props.onStart(where, remember).catch((err) => {
      setError((err as Error).message);
      setStarting(false);
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
      if (e.key === 'Enter') start();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="new-session" role="dialog" aria-label={`New session in ${props.project.name}`}>
        <header className="settings-head">
          <h2>New session in {props.project.name}</h2>
          <button className="icon-btn" title="Cancel (Esc)" onClick={props.onClose}>
            <X size={15} />
          </button>
        </header>
        <div className="new-session-body">
          <p className="new-session-busy">
            <b>{listNames(props.busy)}</b> {props.busy.length > 1 ? 'are' : 'is'} already working in this folder.
          </p>
          <div className="where-list" role="radiogroup" aria-label="Where the new session works">
            <button className="where" role="radio" aria-checked={where === 'copy'} onClick={() => setWhere('copy')}>
              <span className="where-dot" />
              <span className="where-text">
                <b>In its own copy</b>
                <span>Its changes stay apart until you merge them. Sessions never edit the same files.</span>
              </span>
            </button>
            <button className="where" role="radio" aria-checked={where === 'same'} onClick={() => setWhere('same')}>
              <span className="where-dot" />
              <span className="where-text">
                <b>In the same folder</b>
                <span>Quicker for a question. Sessions may overwrite each other's edits.</span>
              </span>
            </button>
          </div>
          {error && <p className="model-error">{error}</p>}
        </div>
        <footer className="new-session-foot">
          <label className="remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember for this project
          </label>
          <button className="btn btn-ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={starting} onClick={start}>
            {starting && where === 'copy' ? 'Making the copy…' : 'Start session'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** "Session 1", "Session 1 and Scraper fix", "Session 1, Session 2 and Scraper fix". */
function listNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? 'Another session') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
