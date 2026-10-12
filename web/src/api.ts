export interface Project {
  id: string;
  name: string;
  path: string;
  addedAt: number;
}

export interface SessionInfo {
  id: string;
  projectId: string;
  name: string;
  cwd: string;
  status: 'running' | 'exited' | 'suspended';
  exitCode: number | null;
  endedAt: number | null;
  createdAt: number;
  activity: 'starting' | 'working' | 'waiting' | 'idle';
  detail: string | null;
  unseen: boolean;
  model: string | null;
  modelChoice: string | null;
  effortChoice: string | null;
  permissionMode: PermissionMode | null;
  /** A permission request that can be answered from AgentHub: "Run" + `npm test`. */
  permission: { id: string; tool: string; verb: string; target: string } | null;
}

/** `claude --permission-mode` values offered in AgentHub. */
export type PermissionMode = 'manual' | 'acceptEdits' | 'plan' | 'auto';

/** What new sessions start with; null keeps Claude Code's own default. */
export interface Settings {
  model: string | null;
  effort: string | null;
  permissionMode: PermissionMode | null;
}

/** One plan usage window, in whole percents; resetsAt is ms since epoch. */
export interface LimitWindow {
  usedPct: number;
  resetsAt: number | null;
}

/** The account's 5-hour and weekly plan limits; null until a session reports them (Pro and Max only). */
export interface RateLimits {
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
}

export interface Inspection {
  /** From Claude Code's status line; null until it first reports. */
  usage: {
    costUsd: number | null;
    contextUsed: number | null;
    contextSize: number | null;
    apiMs: number | null;
    linesAdded: number | null;
    linesRemoved: number | null;
  } | null;
  plan: { id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }[];
  turns: number;
  /** null outside a git repository. */
  git: {
    branch: string | null;
    ahead: number | null;
    behind: number | null;
    files: { path: string; added: number | null; removed: number | null; isNew: boolean }[];
    fileCount: number;
    added: number;
    removed: number;
  } | null;
}

export interface Suggestion {
  name: string;
  path: string;
  lastUsed: number;
}

export interface FolderListing {
  path: string | null;
  parent: string | null;
  dirs: { name: string; path: string }[];
}

/** "project": this project only; "all": every project. */
export type SkillScope = 'project' | 'all';

/** A skill or a plugin the session's project has. */
export interface Skill {
  id: string;
  kind: 'skill' | 'plugin';
  name: string;
  description: string;
  scope: SkillScope;
  enabled: boolean;
  skillCount?: number;
}

/** A skill from the app's catalog; `source` is a GitHub link the import reads. */
export interface CatalogSkill {
  name: string;
  summary: string;
  repo: string;
  source: string;
}

export interface AvailableSkills {
  /** Up to three catalog skills that fit the project, with why. */
  suggested: (CatalogSkill & { reason: string; stars?: number })[];
  /** The rest of the catalog, for searching. */
  catalog: CatalogSkill[];
  /** Skills in other projects, which can be copied over. */
  elsewhere: { name: string; description: string; project: string; path: string }[];
  /** Plugins from Claude Code's marketplaces, most installed first. */
  plugins: { id: string; name: string; description: string; installs: number }[];
}

/** What a GitHub repository holds; `added` when the project already has a skill by that name. */
export interface RepoSkills {
  repo: string;
  skills: { name: string; description: string; path: string; url: string; added: boolean }[];
  picked: string[];
}

export type SkillChange =
  | { action: 'toggle'; id: string; on: boolean }
  | { action: 'copy'; path: string; scope: SkillScope }
  | { action: 'install'; id: string; scope: SkillScope }
  | { action: 'import'; source: string; names: string[]; scope: SkillScope }
  | { action: 'create'; description: string; scope: SkillScope }
  | { action: 'dismiss'; name: string }
  | { action: 'reload' };

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

const wsBase = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

export const api = {
  addProject: (path: string) => request<Project>('/api/projects', 'POST', { path }),
  removeProject: (id: string) => request('/api/projects/' + id, 'DELETE'),

  createSession: (projectId: string) => request<SessionInfo>('/api/sessions', 'POST', { projectId }),
  renameSession: (id: string, name: string) => request(`/api/sessions/${id}`, 'PATCH', { name }),
  markSeen: (id: string) => request(`/api/sessions/${id}/seen`, 'POST'),
  configureSession: (id: string, model: string | null, effort: string | null) =>
    request(`/api/sessions/${id}/config`, 'POST', { model, effort }),
  resumeSession: (id: string) => request(`/api/sessions/${id}/resume`, 'POST'),
  /** Keeps the conversation unless `fresh`. */
  restartSession: (id: string, fresh = false) => request(`/api/sessions/${id}/restart`, 'POST', { fresh }),
  closeSession: (id: string) => request(`/api/sessions/${id}`, 'DELETE'),
  answerPermission: (id: string, permissionId: string, allow: boolean) =>
    request(`/api/sessions/${id}/permission`, 'POST', { id: permissionId, allow }),
  inspect: (id: string) => request<Inspection>(`/api/sessions/${id}/inspect`),
  skills: (id: string) => request<{ skills: Skill[]; lastUsed: { name: string; at: number } | null; suggested: number }>(`/api/sessions/${id}/skills`),
  availableSkills: (id: string) => request<AvailableSkills>(`/api/sessions/${id}/skills/available`),
  /** The skills in a pasted GitHub link. Slow the first time: the repository is fetched. */
  repoSkills: (id: string, source: string) =>
    request<RepoSkills>(`/api/sessions/${id}/skills/github?source=${encodeURIComponent(source)}`),
  changeSkills: (id: string, change: SkillChange) =>
    request<{ ok: true; reload?: boolean; sessionId?: string }>(`/api/sessions/${id}/skills`, 'POST', change),
  /** Saves an image for the session's Claude and returns where it went. */
  pasteImage: async (id: string, image: Blob) => {
    const res = await fetch(`/api/sessions/${id}/paste`, {
      method: 'POST',
      headers: { 'content-type': image.type },
      body: image,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return data as { path: string };
  },

  updateSettings: (patch: Partial<Settings>) => request<Settings>('/api/settings', 'PATCH', patch),

  suggestions: () => request<Suggestion[]>('/api/suggestions'),
  /** No path: home folder. Empty path: drive list. */
  folders: (path?: string) =>
    request<FolderListing>(path === undefined ? '/api/folders' : `/api/folders?path=${encodeURIComponent(path)}`),

  eventsUrl: () => `${wsBase()}/api/events`,
  streamUrl: (id: string) => `${wsBase()}/api/sessions/${id}/stream`,
};
