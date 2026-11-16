import { useState } from 'react';
import type { Project } from './api';

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
