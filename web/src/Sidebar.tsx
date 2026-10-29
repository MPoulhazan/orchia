import { useState } from 'react';
import { Bell, ChevronRight, LayoutGrid, MoreHorizontal, PanelLeft, Plus, Search, Settings, Square, X } from 'lucide-react';
import { api, type ConfigNeeded, type Project, type SecretExposure, type SecurityNeeded, type SessionInfo, type SignInNeeded } from './api';
import { secretText, securityText } from './Security';
import { ConfirmButton, Menu, RenameInput } from './ui';
import { storage } from './storage';
import { PermissionButtons, PermissionText } from './Permission';
import { DoneSummary, StatusDot, initials, needsAttention, statusLabel, statusOf } from './status';
import type { RateLimits } from './api';
import { UsageMeters } from './Limits';
import { TokenPanel } from './Connectors';

export type View = 'focus' | 'grid';

interface Props {
  view: View;
  gridIds: string[];
  onSetView: (view: View) => void;
  onCollapse: () => void;
  projects: Project[];
  sessions: SessionInfo[];
  selectedId: string | null;
  connected: boolean;
  onSelect: (session: SessionInfo) => void;
  onNewSession: (project: Project) => void;
  onCloseSession: (session: SessionInfo) => void;
  onRenameSession: (session: SessionInfo, name: string) => void;
  onRemoveProject: (project: Project) => void;
  onOpenPalette: () => void;
  onAddProject: () => void;
  onOpenSettings: () => void;
  limits: RateLimits | null;
  signInNeeded: SignInNeeded[];
  securityNeeded: SecurityNeeded[];
  secretsExposed: SecretExposure[];
  configNeeded: ConfigNeeded[];
}

const COLLAPSED_KEY = 'orchia.collapsedProjects';
const DISMISSED_KEY = 'orchia.dismissedSignIns';
const DISMISSED_SECURITY_KEY = 'orchia.dismissedSecurity';
const DISMISSED_CONFIG_KEY = 'orchia.dismissedConfigRisks';

/** A risk in the user's settings is dismissed everywhere; a project's own, in that project only. */
const configKey = (c: ConfigNeeded) => (c.risk.shared ? c.risk.id : `${c.projectId}:${c.risk.id}`);

/** Dismissed until a new advisory appears for it. */
const securityKey = (c: SecurityNeeded) => `${c.shared ? c.name : `${c.projectId}:${c.name}`}:${c.note.ids.join(',')}`;

/** A sign-in shared by every project is dismissed everywhere; a project's own, in that project only. */
const signInKey = (c: SignInNeeded) => (c.shared ? c.name : `${c.projectId}:${c.name}`);

export function Sidebar(props: Props) {
  const { projects, sessions, selectedId } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(JSON.parse(storage.get(COLLAPSED_KEY) ?? '[]')),
  );

  const toggle = (id: string) => {
    const next = new Set(collapsed);
    next.has(id) ? next.delete(id) : next.add(id);
    setCollapsed(next);
    storage.set(COLLAPSED_KEY, JSON.stringify([...next]));
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="wordmark">
          <span className="glyph" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          Orchia
        </span>
        <span className="pane-spacer" />
        <ViewSwitch view={props.view} onSetView={props.onSetView} />
        <button className="icon-btn" title="Collapse sidebar" onClick={props.onCollapse}>
          <PanelLeft size={15} />
        </button>
      </div>

      <button className="search-btn" onClick={props.onOpenPalette}>
        <Search size={14} />
        <span>Search</span>
        <kbd>Ctrl K</kbd>
      </button>

      <Attention projects={projects} sessions={sessions} signIns={props.signInNeeded} security={props.securityNeeded} secrets={props.secretsExposed} config={props.configNeeded} selectedId={selectedId} onSelect={props.onSelect} />

      <div className="sidebar-section">
        <span>Projects</span>
        <button className="icon-btn" title="Add project" onClick={props.onAddProject}>
          <Plus size={14} />
        </button>
      </div>

      <nav className="tree">
        {projects.length === 0 && (
          <button className="tree-empty" onClick={props.onAddProject}>
            No projects yet. Add a folder and start a Claude Code session in it.
          </button>
        )}
        {projects.map((project) => {
          const own = sessions.filter((s) => s.projectId === project.id);
          const isCollapsed = collapsed.has(project.id);
          const running = own.filter((s) => s.status === 'running').length;
          return (
            <div key={project.id} className="tree-group">
              <div className="tree-project" onClick={() => toggle(project.id)} title={project.path}>
                <ChevronRight size={13} className={`chevron ${isCollapsed ? '' : 'is-open'}`} />
                <span className="tree-label">{project.name}</span>
                {isCollapsed && running > 0 && <span className="tree-count">{running}</span>}
                <span className="tree-actions">
                  <button
                    className="icon-btn"
                    title="New session"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onNewSession(project);
                    }}
                  >
                    <Plus size={14} />
                  </button>
                  <Menu
                    title="More"
                    trigger={<MoreHorizontal size={14} />}
                    items={[
                      { label: 'New session', onSelect: () => props.onNewSession(project) },
                      { label: 'Copy path', onSelect: () => navigator.clipboard.writeText(project.path) },
                      {
                        label: running ? `Remove project (ends ${running} session${running > 1 ? 's' : ''})` : 'Remove project',
                        danger: true,
                        onSelect: () => props.onRemoveProject(project),
                      },
                    ]}
                  />
                </span>
              </div>

              {!isCollapsed &&
                own.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    selected={session.id === selectedId}
                    inGrid={props.gridIds.includes(session.id)}
                    onSelect={() => props.onSelect(session)}
                    onClose={() => props.onCloseSession(session)}
                    onRename={(name) => props.onRenameSession(session, name)}
                  />
                ))}
              {!isCollapsed && own.length === 0 && (
                <button className="tree-new" onClick={() => props.onNewSession(project)}>
                  <Plus size={13} />
                  New session
                </button>
              )}
            </div>
          );
        })}
      </nav>

      <UsageMeters limits={props.limits} />

      <div className="sidebar-foot">
        {props.connected ? <span /> : <span className="offline">Server offline · reconnecting</span>}
        <span className="pane-spacer" />
        <button className="icon-btn" title="Settings" onClick={props.onOpenSettings}>
          <Settings size={14} />
        </button>
      </div>
    </aside>
  );
}

/** Sessions waiting on the user or finished unseen, above the project tree. */
function Attention(props: {
  projects: Project[];
  sessions: SessionInfo[];
  signIns: SignInNeeded[];
  security: SecurityNeeded[];
  secrets: SecretExposure[];
  config: ConfigNeeded[];
  selectedId: string | null;
  onSelect: (s: SessionInfo) => void;
}) {
  const waiting = props.sessions.filter((s) => statusOf(s) === 'waiting');
  const done = props.sessions.filter((s) => statusOf(s) === 'done');
  const list = [...waiting, ...done].filter(needsAttention);
  const [dismissed, setDismissed] = useState<string[]>(() => JSON.parse(storage.get(DISMISSED_KEY) ?? '[]'));
  const signIns = props.signIns.filter((c) => !dismissed.includes(signInKey(c)));
  const dismiss = (c: SignInNeeded) => {
    const next = [...dismissed, signInKey(c)];
    setDismissed(next);
    storage.set(DISMISSED_KEY, JSON.stringify(next));
  };
  const [dismissedSecurity, setDismissedSecurity] = useState<string[]>(() => JSON.parse(storage.get(DISMISSED_SECURITY_KEY) ?? '[]'));
  const security = props.security.filter((c) => !dismissedSecurity.includes(securityKey(c)));
  const dismissSecurity = (c: SecurityNeeded) => {
    const next = [...dismissedSecurity, securityKey(c)];
    setDismissedSecurity(next);
    storage.set(DISMISSED_SECURITY_KEY, JSON.stringify(next));
  };
  const secrets = props.secrets;
  const [dismissedConfig, setDismissedConfig] = useState<string[]>(() => JSON.parse(storage.get(DISMISSED_CONFIG_KEY) ?? '[]'));
  const config = props.config.filter((c) => !dismissedConfig.includes(configKey(c)));
  const dismissConfig = (c: ConfigNeeded) => {
    const next = [...dismissedConfig, configKey(c)];
    setDismissedConfig(next);
    storage.set(DISMISSED_CONFIG_KEY, JSON.stringify(next));
  };
  if (!list.length && !signIns.length && !security.length && !secrets.length && !config.length) return null;
  const projectName = (id: string) => props.projects.find((p) => p.id === id)?.name ?? '';

  return (
    <>
      <div className="sidebar-section">
        <span>Needs you</span>
        <span className="section-count">{list.length + signIns.length + security.length + secrets.length + config.length}</span>
      </div>
      <div className="attention">
        {list.map((s) => (
          // A plain "Done" has nothing more to say than its title: one line.
          <div key={s.id} className="attention-row" data-selected={s.id === props.selectedId} data-compact={statusOf(s) === 'done' && !s.detail && !s.summary}>
            <button className="attention-open" onClick={() => props.onSelect(s)}>
              <span className="attention-title">
                {s.permission ? (
                  <span className="mark">Permission</span>
                ) : statusOf(s) === 'waiting' ? (
                  <span className="mark">Needs you</span>
                ) : (
                  <span className="mark" data-tone="done">Done</span>
                )}
                <b>{s.name}</b>
                <span className="attention-project">· {projectName(s.projectId)}</span>
              </span>
              <span className="attention-detail">
                {s.permission ? (
                  <PermissionText permission={s.permission} />
                ) : statusOf(s) === 'waiting' ? (
                  (s.detail ?? 'Needs your input')
                ) : (
                  (s.detail ?? <DoneSummary session={s} />)
                )}
              </span>
            </button>
            <PermissionButtons session={s} small />
          </div>
        ))}
        {secrets.map((e) => (
          <div key={e.id} className="attention-row" data-selected={e.sessionId === props.selectedId}>
            <button
              className="attention-open"
              onClick={() => {
                const session = props.sessions.find((s) => s.id === e.sessionId);
                if (session) props.onSelect(session);
              }}
            >
              <span className="attention-title">
                <span className="mark" data-tone="danger">Secret</span>
                <b>{e.label}</b>
                <span className="attention-project">· {projectName(e.projectId)}</span>
              </span>
              <span className="attention-detail">{secretText(e)}</span>
            </button>
            <span className="perm-acts" data-small>
              {e.rotateUrl && (
                <a className="btn btn-secondary" href={e.rotateUrl} target="_blank" rel="noreferrer" title="Revoke it, then put a new one where it is used">
                  Revoke
                </a>
              )}
              <button className="btn btn-secondary" title="It is revoked, or it doesn't matter" onClick={() => api.resolveSecret(e.id)}>
                Done
              </button>
            </span>
          </div>
        ))}
        {config.map((c) => (
          <div key={configKey(c)} className="attention-row" data-selected={c.sessionId === props.selectedId}>
            <button
              className="attention-open"
              onClick={() => {
                const session = props.sessions.find((s) => s.id === c.sessionId);
                if (session) props.onSelect(session);
              }}
            >
              <span className="attention-title">
                <span className="mark" data-tone={c.risk.severity === 'high' ? 'danger' : undefined}>Config</span>
                <b>{c.risk.title}</b>
                <span className="attention-project">· {c.risk.shared ? 'All projects' : projectName(c.projectId)}</span>
              </span>
              <span className="attention-detail">{c.risk.detail}</span>
            </button>
            <span className="perm-acts" data-small>
              {c.risk.fix && (
                <button
                  className="btn btn-secondary"
                  title={c.risk.fix === 'deny-env' ? 'Adds Read(./.env) and Read(./.env.*) to the deny rules in .claude/settings.local.json' : `Removes ${c.risk.rule} from .claude/settings.local.json`}
                  onClick={() => api.fixConfigRisk(c.sessionId, c.risk.id)}
                >
                  {c.risk.fix === 'deny-env' ? 'Block reads' : 'Remove rule'}
                </button>
              )}
              <button className="icon-btn" title="Dismiss" onClick={() => dismissConfig(c)}>
                <X size={13} />
              </button>
            </span>
          </div>
        ))}
        {security.map((c) => (
          <div key={securityKey(c)} className="attention-row" data-selected={c.sessionId === props.selectedId}>
            <button
              className="attention-open"
              onClick={() => {
                const session = props.sessions.find((s) => s.id === c.sessionId);
                if (session) props.onSelect(session);
              }}
            >
              <span className="attention-title">
                <span className="mark" data-tone="danger">Security</span>
                <b>{c.label}</b>
                <span className="attention-project">· {c.shared ? 'All projects' : projectName(c.projectId)}</span>
              </span>
              <span className="attention-detail">{securityText(c.note)}</span>
            </button>
            <span className="perm-acts" data-small>
              <a className="btn btn-secondary" href={c.note.url} target="_blank" rel="noreferrer">
                Details
              </a>
              <button className="icon-btn" title="Dismiss until a new issue is found" onClick={() => dismissSecurity(c)}>
                <X size={13} />
              </button>
            </span>
          </div>
        ))}
        {signIns.map((c) => (
          <SignInRow
            key={signInKey(c)}
            signIn={c}
            projectName={c.shared ? 'All projects' : projectName(c.projectId)}
            onDismiss={() => dismiss(c)}
            selected={c.sessionId === props.selectedId}
            onOpen={() => {
              const session = props.sessions.find((s) => s.id === c.sessionId);
              if (session) props.onSelect(session);
            }}
          />
        ))}
      </div>
    </>
  );
}

/** A connector Claude can't use until the user signs in: opens the browser on the service's sign-in page. */
function SignInRow({
  signIn,
  projectName,
  selected,
  onOpen,
  onDismiss,
}: {
  signIn: SignInNeeded;
  projectName: string;
  selected: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const dismissBtn = (
    <button className="icon-btn" title="Dismiss: sign in later from Connectors" onClick={onDismiss}>
      <X size={13} />
    </button>
  );
  // Until the server reports the sign-in it just started.
  const [starting, setStarting] = useState(false);
  const busy = signIn.signingIn || starting;
  // A service Claude Code can't sign in to: the token form opens in the row.
  const [tokenOpen, setTokenOpen] = useState(false);
  const token = signIn.needs === 'token';
  // One line with the button beside the title, unless it is selected or has more to say.
  const compact = !selected && !busy && !signIn.error && !tokenOpen;
  return (
    <div className="attention-row" data-selected={selected} data-compact={compact}>
      <button className="attention-open" onClick={onOpen}>
        <span className="attention-title">
          <span className="mark">Sign in</span>
          <b>{signIn.label}</b>
          <span className="attention-project">· {projectName}</span>
        </span>
        <span className="attention-detail">
          {token
            ? `${signIn.label} takes an access token: Claude Code can't sign in to it.`
            : signIn.error && !busy
              ? signIn.error
              : `Claude can't use ${signIn.label} until you sign in.`}
        </span>
      </button>
      {token ? (
        tokenOpen ? (
          <TokenPanel sessionId={signIn.sessionId} name={signIn.name} onDone={() => setTokenOpen(false)} />
        ) : (
          <span className="perm-acts" data-small>
            <button className="btn btn-primary" onClick={() => setTokenOpen(true)}>
              Add token
            </button>
            {dismissBtn}
          </span>
        )
      ) : (
        <span className="perm-acts" data-small>
          <button
            className="btn btn-primary"
            disabled={busy}
            title={`Sign in to ${signIn.label} in your browser`}
            onClick={() => {
              setStarting(true);
              api
                .changeConnectors(signIn.sessionId, { action: 'signin', name: signIn.name })
                .catch(() => {})
                .finally(() => setStarting(false));
            }}
          >
            {busy ? 'Finish in browser' : signIn.error ? 'Try again' : 'Sign in'}
          </button>
          {dismissBtn}
        </span>
      )}
    </div>
  );
}

export function ViewSwitch({ view, onSetView, vertical }: { view: View; onSetView: (v: View) => void; vertical?: boolean }) {
  return (
    <div className="segmented" data-vertical={vertical} role="radiogroup" aria-label="Layout">
      <button role="radio" aria-checked={view === 'focus'} title="Focus view (Alt G)" onClick={() => onSetView('focus')}>
        <Square size={12} />
      </button>
      <button role="radio" aria-checked={view === 'grid'} title="Grid view (Alt G)" onClick={() => onSetView('grid')}>
        <LayoutGrid size={13} />
      </button>
    </div>
  );
}

/** Collapsed sidebar: one tile per session (initials + status), and what needs you. */
export function Rail(props: {
  view: View;
  projects: Project[];
  sessions: SessionInfo[];
  selectedId: string | null;
  gridIds: string[];
  onSetView: (v: View) => void;
  onExpand: () => void;
  onOpenPalette: () => void;
  onSelect: (s: SessionInfo) => void;
  onOpenSettings: () => void;
  limits: RateLimits | null;
}) {
  const projectName = (id: string) => props.projects.find((p) => p.id === id)?.name ?? '';
  const waiting = props.sessions.filter(needsAttention).sort((a, b) => Number(statusOf(b) === 'waiting') - Number(statusOf(a) === 'waiting'));

  return (
    <aside className="rail">
      <span className="glyph rail-glyph" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <button className="icon-btn" title="Expand sidebar" onClick={props.onExpand}>
        <PanelLeft size={15} />
      </button>
      <button className="icon-btn" title="Search (Ctrl K)" onClick={props.onOpenPalette}>
        <Search size={15} />
      </button>
      <button
        className="icon-btn rail-bell"
        title={waiting.length ? `${waiting.length} need${waiting.length > 1 ? '' : 's'} you · open ${waiting[0].name}` : 'Nothing needs you'}
        disabled={!waiting.length}
        onClick={() => waiting[0] && props.onSelect(waiting[0])}
      >
        <Bell size={15} />
        {waiting.length > 0 && <span className="rail-count">{waiting.length}</span>}
      </button>
      <ViewSwitch view={props.view} onSetView={props.onSetView} vertical />
      <div className="rail-sessions">
        {props.sessions.map((s, i) => (
          <button
            key={s.id}
            className="rail-session"
            data-selected={s.id === props.selectedId}
            data-in-grid={props.gridIds.includes(s.id)}
            title={`${s.name} · ${projectName(s.projectId)} · ${statusLabel[statusOf(s)]}${i < 9 ? `  (Alt ${i + 1})` : ''}`}
            onClick={() => props.onSelect(s)}
          >
            {initials(s.name)}
            <StatusDot session={s} />
          </button>
        ))}
      </div>
      <span className="pane-spacer" />
      <UsageMeters limits={props.limits} compact />
      <button className="icon-btn" title="Settings" onClick={props.onOpenSettings}>
        <Settings size={14} />
      </button>
    </aside>
  );
}

function SessionRow({
  session,
  selected,
  inGrid,
  onSelect,
  onClose,
  onRename,
}: {
  session: SessionInfo;
  selected: boolean;
  inGrid: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="tree-session" data-selected={selected} onClick={onSelect} onDoubleClick={() => setEditing(true)}>
      <StatusDot session={session} />
      {editing ? (
        <RenameInput
          name={session.name}
          onDone={(name) => {
            if (name) onRename(name);
            setEditing(false);
          }}
        />
      ) : (
        <span className="tree-label">{session.name}</span>
      )}
      {!editing && inGrid && (
        <span className="tree-grid-mark" title="In grid">
          <LayoutGrid size={11} />
        </span>
      )}
      {!editing && session.status === 'running' && (
        <ConfirmButton className="icon-btn tree-close" title="End session" confirmLabel="End" onConfirm={onClose}>
          <X size={13} />
        </ConfirmButton>
      )}
      {!editing && session.status === 'exited' && (
        <button
          className="icon-btn tree-close"
          title="Close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}
