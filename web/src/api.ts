import type { McpServerConfig } from '../../server/mcpSource';

export interface Project {
  id: string;
  name: string;
  path: string;
  addedAt: number;
  /** Where a new session works while another one is busy in the folder; missing means ask. */
  copyMode?: CopyMode;
}

export type CopyMode = 'ask' | 'copy' | 'same';

/** A session working in its own git worktree. */
export interface SessionCopy {
  path: string;
  branch: string;
  /** The project branch it merges back into. */
  base: string;
}

/** What a copy changed, for the Changes tab. */
export interface CopyChanges {
  diff: string;
  files: { path: string; added: number | null; removed: number | null; isNew: boolean }[];
  commits: number;
  behind: number;
  conflicts: boolean;
  blocked: string | null;
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
  /**
   * A permission request that can be answered from Orchia: "Run" + `npm test`.
   * `always`: the rules "Always allow" saves, as Claude Code suggests them; may be empty.
   */
  /** The lots of a plan waiting for review, when it splits into some. */
  planLots: string[] | null;
  permission: { id: string; tool: string; verb: string; target: string; always: AllowRule[] } | null;
  /** What the last finished turn did, from Claude's final reply; null while a turn runs. */
  summary: { text: string; files: number; at: number } | null;
  /** Prompts sent one at a time when Claude finishes a turn. */
  queue: { id: string; text: string; lot?: { n: number; total: number } }[];
  /** Why the queue waits although Claude is idle: text in Claude's prompt, a stopped turn, or a lot not done. */
  queueHeld: 'typing' | 'stopped' | 'blocked' | null;
  /** A lot of a split plan that ended without `LOT n DONE`; `reason` is '' when Claude said neither. */
  lotBlocked: { n: number; total: number; reason: string } | null;
  /** Set when the session works in its own copy; `cwd` is then the copy. */
  copy: SessionCopy | null;
}

/** A project allow rule: "Run" + `npm test *`. `rule` is how settings spell it: `Bash(npm test:*)`. */
export interface AllowRule {
  rule: string;
  verb: string;
  target: string;
}

/** A connector that waits for the user to sign in, in a project with a running session. */
/** An advisory from the awesome-vetted-claude-code catalog that concerns a connector, skill or plugin. */
export interface SecurityNote {
  /** `affected`: the version in use is affected; `unfixed`: no fix yet; `check`: fixed in a version Orchia can't see. */
  level: 'affected' | 'unfixed' | 'check';
  severity: 'low' | 'moderate' | 'high' | 'critical';
  tool: string;
  summary: string;
  fixedIn: string | null;
  url: string;
  ids: string[];
}

/** A connector with a high or critical advisory that applies for sure, for "Needs you". */
export interface SecurityNeeded {
  sessionId: string;
  projectId: string;
  name: string;
  label: string;
  shared: boolean;
  note: SecurityNote;
}

export interface SignInNeeded {
  sessionId: string;
  projectId: string;
  name: string;
  label: string;
  /** Signs in once for every project (account, user or plugin connector): listed once. */
  shared: boolean;
  /** `token`: Claude Code can't sign in to it, it takes an access token. */
  needs: 'signin' | 'token';
  /** A sign-in runs: it waits for the browser. */
  signingIn: boolean;
  /** Why the last sign-in failed. */
  error: string | null;
}

/** `claude --permission-mode` values offered in Orchia. */
export type PermissionMode = 'manual' | 'acceptEdits' | 'plan' | 'auto';

/** What new sessions start with; null keeps Claude Code's own default. */
export interface Settings {
  model: string | null;
  effort: string | null;
  permissionMode: PermissionMode | null;
  compactBetweenTasks: boolean;
  restartAfterConnectorChange: boolean;
  /** Once paired with Orchia Cloud, send what needs you there (server/cloud.ts, RemoteNeed). */
  remoteNeeds: boolean;
  /** What a phone may answer: everything, everything but shell commands, or Deny only. */
  remoteAnswers: 'all' | 'no-shell' | 'deny-only';
}

/** The optional link to an Orchia Cloud account (server/cloud.ts). */
export type CloudStatus =
  | { state: 'off'; url: string; note: string | null }
  | { state: 'pairing'; url: string; userCode: string; verifyUrl: string; expiresAt: number }
  | { state: 'connecting' | 'connected'; url: string; name: string };

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

/** A fenced code block of Claude's last reply; `command` is set when Run can type it. */
export interface CodeBlock {
  lang: string;
  code: string;
  command: string | null;
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
  blocks: CodeBlock[];
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
  /** The project's own allow rules, from .claude/settings.local.json. */
  allowRules: AllowRule[];
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
  security?: SecurityNote | null;
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

/** An open issue of the project's GitHub repository. `team`: opened by the owner, a member or a collaborator. */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string;
  team: boolean;
  comments: number;
  url: string;
  updatedAt: string;
}

/**
 * `unavailable` says why there is no list (no gh, not signed in, no GitHub remote).
 * `dir`: the subfolder holding the repository when the project folder isn't one.
 */
export type IssuesResult = { issues: GitHubIssue[]; repo: string; dir: string | null } | { unavailable: string };

/** Where a connector is set up: the claude.ai account, every project, this project only, the repo's `.mcp.json`, or a plugin. */
export type ConnectorSource = 'account' | 'user' | 'local' | 'project' | 'plugin';

/** An MCP server the session's project can use, with the state of its last health check. */
export interface Connector {
  name: string;
  label: string;
  source: ConnectorSource;
  target: string;
  state: 'connected' | 'needs-auth' | 'needs-token' | 'failed' | 'disabled' | 'pending' | 'unknown';
  detail: string;
  toolPrefix: string;
  /** A connected connector that reaches the same server: this one needs no sign-in. */
  duplicateOf?: string;
  security?: SecurityNote | null;
}

/** A well-known server from the app's catalog; `reason` when it fits this project. */
export interface ConnectorCatalogItem {
  name: string;
  title: string;
  summary: string;
  server: McpServerConfig;
  reason?: string;
}

/** Where a connector gets a token: the service's CLI on this computer, or one pasted. */
export type TokenChoice = { useCli: true } | { token: string };

export type ConnectorChange =
  | { action: 'toggle'; name: string; on: boolean }
  | { action: 'signin'; name: string }
  | ({ action: 'add'; name: string; server: McpServerConfig; scope: SkillScope } & Partial<{ useCli: true; token: string }>)
  | ({ action: 'token'; name: string } & TokenChoice)
  | { action: 'remove'; name: string };

/** Where to get a token for a service that wants one. */
export interface TokenHelp {
  service: string | null;
  createUrl: string | null;
  /** A CLI on this computer, signed in to the service, that can lend its token. */
  cli: string | null;
}

/** How a server gets its access, found before adding it (server/mcpProbe.ts). */
export type ConnectorAuth =
  | { kind: 'local' }
  | { kind: 'open' }
  | { kind: 'browser' }
  | { kind: 'token'; help: TokenHelp }
  | { kind: 'unreachable'; error: string };

export type SkillChange =
  | { action: 'toggle'; id: string; on: boolean }
  | { action: 'copy'; path: string; scope: SkillScope }
  | { action: 'install'; id: string; scope: SkillScope }
  | { action: 'import'; source: string; names: string[]; scope: SkillScope }
  | { action: 'create'; description: string; scope: SkillScope }
  | { action: 'dismiss'; name: string }
  | { action: 'reload' };

async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    signal,
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
  /** Where a GitHub repository would be cloned, or the clone already there. */
  cloneTarget: (url: string) => request<{ repo: string; path: string; existing: boolean }>(`/api/projects/clone?url=${encodeURIComponent(url)}`),
  /** Aborting `signal` stops the clone and removes what it wrote. */
  cloneProject: (url: string, signal?: AbortSignal) => request<Project>('/api/projects/clone', 'POST', { url }, signal),

  /** Without `where`, the server may ask first: `{ choose }` lists the sessions already at work in the folder. */
  createSession: (projectId: string, where?: 'copy' | 'same', remember = false) =>
    request<SessionInfo | { choose: { busy: string[] } }>('/api/sessions', 'POST', { projectId, where, remember }),
  setCopyMode: (projectId: string, copyMode: CopyMode) => request(`/api/projects/${projectId}`, 'PATCH', { copyMode }),
  copyChanges: (id: string) => request<CopyChanges>(`/api/sessions/${id}/changes`),
  mergeCopy: (id: string) => request<{ ok: boolean; conflict?: string }>(`/api/sessions/${id}/merge`, 'POST'),
  discardCopy: (id: string) => request(`/api/sessions/${id}/discard`, 'POST'),
  resolveCopy: (id: string) => request(`/api/sessions/${id}/resolve`, 'POST'),
  renameSession: (id: string, name: string) => request(`/api/sessions/${id}`, 'PATCH', { name }),
  markSeen: (id: string) => request(`/api/sessions/${id}/seen`, 'POST'),
  configureSession: (id: string, model: string | null, effort: string | null) =>
    request(`/api/sessions/${id}/config`, 'POST', { model, effort }),
  resumeSession: (id: string) => request(`/api/sessions/${id}/resume`, 'POST'),
  /** Keeps the conversation unless `fresh`. */
  restartSession: (id: string, fresh = false) => request(`/api/sessions/${id}/restart`, 'POST', { fresh }),
  closeSession: (id: string) => request(`/api/sessions/${id}`, 'DELETE'),
  answerPermission: (id: string, permissionId: string, allow: boolean, always = false) =>
    request(`/api/sessions/${id}/permission`, 'POST', { id: permissionId, allow, always }),
  inspect: (id: string) => request<Inspection>(`/api/sessions/${id}/inspect`),
  removeAllowRule: (id: string, rule: string) => request(`/api/sessions/${id}/allow-rules`, 'DELETE', { rule }),
  enqueue: (id: string, text: string) => request(`/api/sessions/${id}/queue`, 'POST', { text }),
  dequeue: (id: string, queuedId: string) => request(`/api/sessions/${id}/queue/${queuedId}`, 'DELETE'),
  reorderQueue: (id: string, ids: string[]) => request(`/api/sessions/${id}/queue`, 'PUT', { ids }),
  sendQueuedNow: (id: string) => request(`/api/sessions/${id}/queue/send`, 'POST'),
  /** The repository's open issues, through the user's gh login. */
  issues: (id: string) => request<IssuesResult>(`/api/sessions/${id}/issues`),
  /** Closes it as not planned; GitHub can reopen it. */
  closeIssue: (id: string, n: number) => request(`/api/sessions/${id}/issues/${n}/close`, 'POST'),
  /** For good; GitHub lets only repository admins do it. */
  deleteIssue: (id: string, n: number) => request(`/api/sessions/${id}/issues/${n}`, 'DELETE'),
  runCommand: (id: string, command: string) => request(`/api/sessions/${id}/run`, 'POST', { command }),
  splitPlan: (id: string, lots: string[]) => request(`/api/sessions/${id}/plan`, 'POST', { lots }),
  skills: (id: string) => request<{ skills: Skill[]; lastUsed: { name: string; at: number } | null; suggested: number }>(`/api/sessions/${id}/skills`),
  availableSkills: (id: string) => request<AvailableSkills>(`/api/sessions/${id}/skills/available`),
  /** The skills in a pasted GitHub link. Slow the first time: the repository is fetched. */
  repoSkills: (id: string, source: string) =>
    request<RepoSkills>(`/api/sessions/${id}/skills/github?source=${encodeURIComponent(source)}`),
  changeSkills: (id: string, change: SkillChange) =>
    request<{ ok: true; reload?: boolean; sessionId?: string }>(`/api/sessions/${id}/skills`, 'POST', change),
  connectors: (id: string) =>
    request<{
      connectors: Connector[];
      checkedAt: number;
      lastUsed: { toolPrefix: string; at: number } | null;
      /** Sign-ins started from Orchia, by server name. */
      signIns: Record<string, { url: string | null; error: string | null; done: boolean }>;
    }>(`/api/sessions/${id}/connectors`),
  availableConnectors: (id: string) =>
    request<{ catalog: ConnectorCatalogItem[]; already: { title: string; summary: string; connector: Connector }[] }>(`/api/sessions/${id}/connectors/available`),
  changeConnectors: (id: string, change: ConnectorChange) => request<{ ok: true }>(`/api/sessions/${id}/connectors`, 'POST', change),
  probeConnector: (id: string, server: McpServerConfig) =>
    request<{ auth: ConnectorAuth }>(`/api/sessions/${id}/connectors/probe`, 'POST', { server }),
  connectorTokenHelp: (id: string, name: string) =>
    request<{ help: TokenHelp }>(`/api/sessions/${id}/connectors/token?name=${encodeURIComponent(name)}`),
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
  pairCloud: () => request<CloudStatus>('/api/cloud/pair', 'POST'),
  cancelCloudPairing: () => request<CloudStatus>('/api/cloud/cancel', 'POST'),
  disconnectCloud: () => request<CloudStatus>('/api/cloud', 'DELETE'),

  suggestions: () => request<Suggestion[]>('/api/suggestions'),
  /** No path: home folder. Empty path: drive list. */
  folders: (path?: string) =>
    request<FolderListing>(path === undefined ? '/api/folders' : `/api/folders?path=${encodeURIComponent(path)}`),

  eventsUrl: () => `${wsBase()}/api/events`,
  streamUrl: (id: string) => `${wsBase()}/api/sessions/${id}/stream`,
};
