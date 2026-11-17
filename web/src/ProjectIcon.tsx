import { useEffect, useState, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { api, type Project } from './api';
import { storage } from './storage';

// Project icons can be turned off in Settings › This browser; the choice stays in this browser.
const KEY = 'orchia.projectIcons';
const listeners = new Set<() => void>();
let iconsOn = storage.get(KEY) !== 'off';

function apply() {
  document.documentElement.toggleAttribute('data-no-project-icons', !iconsOn);
}
apply();

function setProjectIcons(on: boolean) {
  iconsOn = on;
  storage.set(KEY, on ? 'on' : 'off');
  apply();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether project icons are shown, and the switch for Settings. */
export function useProjectIcons() {
  return { on: useSyncExternalStore(subscribe, () => iconsOn), set: setProjectIcons };
}

/** Where the browser loads a project's own icon; undefined when the project has none. */
export function projectIconUrl(project: Pick<Project, 'id' | 'icon'> | null | undefined): string | undefined {
  return project?.icon ? `/api/projects/${project.id}/icon?v=${project.icon}` : undefined;
}

/** A steady hue per name, so a project without an icon keeps its color. */
function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

/** The project's icon or logo found in its folder, else its initial on a color of its own. */
export function ProjectIcon({ project, size }: { project: Pick<Project, 'id' | 'name' | 'icon'>; size: number }) {
  const url = projectIconUrl(project);
  const [broken, setBroken] = useState<string | null>(null);
  const style = { width: size, height: size, borderRadius: Math.max(3, Math.round(size * 0.22)) };

  if (url && broken !== url) {
    return <img className="project-icon" src={url} alt="" style={style} draggable={false} onError={() => setBroken(url)} />;
  }
  const letter = (project.name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
  return (
    <span
      className="project-icon project-icon-letter"
      aria-hidden="true"
      style={{ ...style, fontSize: Math.round(size * 0.55), background: `hsl(${hue(project.name)} 42% 34%)` }}
    >
      {letter}
    </span>
  );
}

interface Candidate {
  id: string;
  label: string;
  version: string;
}

/** Pick the project's icon among the ones found in its folder, its initial only, or Orchia's choice. */
export function IconPicker(props: { project: Project; onClose: () => void }) {
  const { project, onClose } = props;
  const [found, setFound] = useState<{ choice: string | null; candidates: Candidate[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.projectIcons(project.id).then(setFound, (err) => setError((err as Error).message));
  }, [project.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const choose = (choice: string | null) =>
    api.setProjectIcon(project.id, choice).then(onClose, (err) => setError((err as Error).message));

  const current = found?.choice ?? null;
  const auto = found?.candidates[0];

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="new-session icon-picker" role="dialog" aria-label={`Icon for ${project.name}`}>
        <header className="settings-head">
          <h2>Icon for {project.name}</h2>
          <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        <div className="new-session-body">
          {!found && !error && <p className="muted">Looking in the project folder…</p>}
          {found && (
            <>
              <p className="muted">
                {found.candidates.length
                  ? 'Images found in the project folder. Automatic uses the icon its web page or manifest declares, then the usual places.'
                  : 'No icon in the project folder. Add an icon.svg or icon.png at its root and it will show here.'}
              </p>
              <div className="icon-grid" role="radiogroup" aria-label="Project icon">
                <button className="icon-choice" role="radio" aria-checked={current === null} onClick={() => choose(null)}>
                  {auto ? <img src={`/api/projects/${project.id}/icon?c=${encodeURIComponent(auto.id)}&v=${auto.version}`} alt="" /> : <ProjectIcon project={{ id: project.id, name: project.name }} size={40} />}
                  <b>Automatic</b>
                  <span>Orchia's best find</span>
                </button>
                {found.candidates.map((c) => (
                  <button key={c.id} className="icon-choice" role="radio" aria-checked={current === c.id} title={c.id} onClick={() => choose(c.id)}>
                    <img src={`/api/projects/${project.id}/icon?c=${encodeURIComponent(c.id)}&v=${c.version}`} alt="" />
                    <b>{c.id.startsWith('inline:') ? 'Inline icon' : c.id.split('/').pop()}</b>
                    <span>{c.label}</span>
                  </button>
                ))}
                <button className="icon-choice" role="radio" aria-checked={current === 'none'} onClick={() => choose('none')}>
                  <ProjectIcon project={{ id: project.id, name: project.name }} size={40} />
                  <b>Initial only</b>
                  <span>No image</span>
                </button>
              </div>
            </>
          )}
          {error && <p className="model-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
