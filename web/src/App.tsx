import { useEffect, useMemo, useRef, useState } from 'react';
import { Folder, FolderPlus } from 'lucide-react';
import { api, type Project, type SessionInfo, type Suggestion } from './api';
import { useHub } from './useHub';
import { terminalThemes, useTheme } from './theme';
import { storage } from './storage';
import { Rail, Sidebar, type View } from './Sidebar';
import { CommandPalette, type PaletteMode } from './CommandPalette';
import { SessionPane } from './SessionPane';
import { SessionTabs } from './SessionTabs';
import { Inspector } from './Inspector';
import { SkillPicker, type SkillsChange } from './Skills';
import { SettingsDialog } from './Settings';
import { needsAttention, statusOf, timeAgo } from './status';
import { setFavicon } from './favicon';
import { pageActive, useNotifications } from './notifications';
import { LimitBanner, LimitToasts, topLevel, useLimitAlerts } from './Limits';

const SELECTED_KEY = 'agenthub.selectedSession';
const SIDEBAR_KEY = 'agenthub.sidebar';
const VIEW_KEY = 'agenthub.view';
const GRID_KEY = 'agenthub.grid';
const LAYOUT_KEY = 'agenthub.gridLayout';
const INSPECTOR_KEY = 'agenthub.inspector';
type GridLayout = '2x2' | '3x2';
const GRID_CAPACITY: Record<GridLayout, number> = { '2x2': 4, '3x2': 6 };

function readGrid(): string[] {
  try {
    const value = JSON.parse(storage.get(GRID_KEY) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function App() {
  const { state, connected } = useHub();
  const theme = useTheme();
  const [selectedId, setSelectedId] = useState<string | null>(() => storage.get(SELECTED_KEY));
  const [sidebarOpen, setSidebarOpen] = useState(() => storage.get(SIDEBAR_KEY) !== 'closed');
  const [view, setViewState] = useState<View>(() => (storage.get(VIEW_KEY) === 'grid' ? 'grid' : 'focus'));
  const [gridIds, setGridIds] = useState<string[]>(readGrid);
  const [layout, setLayoutState] = useState<GridLayout>(() => (storage.get(LAYOUT_KEY) === '3x2' ? '3x2' : '2x2'));
  // 3×2 needs the width, so the sidebar folds to the rail unless asked back for this time.
  const [wideSidebar, setWideSidebar] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(() => storage.get(INSPECTOR_KEY) !== 'closed');
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  const [skillPicker, setSkillPicker] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsChange, setSkillsChange] = useState<SkillsChange>({ n: 0, reload: false });
  const pendingId = useRef<string | null>(null);
  const lastProjectId = useRef<string | null>(null);

  const projects = state?.projects ?? [];
  // Sessions in sidebar order, which is also the Alt+1..9 order.
  const sessions = useMemo(() => {
    const order = new Map(projects.map((p, i) => [p.id, i]));
    return [...(state?.sessions ?? [])].sort(
      (a, b) => (order.get(a.projectId) ?? 0) - (order.get(b.projectId) ?? 0) || a.createdAt - b.createdAt,
    );
  }, [state]);

  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  const selectedProject = projects.find((p) => p.id === selected?.projectId) ?? null;
  if (selectedProject) lastProjectId.current = selectedProject.id;
  if (selected && selected.id === pendingId.current) pendingId.current = null;
  // The selected session's tab row, remembered so closing it can land on a neighbour.
  const lastTabs = useRef<string[]>([]);
  if (selected) lastTabs.current = sessions.filter((s) => s.projectId === selected.projectId).map((s) => s.id);
  const projectOf = (s: SessionInfo) => projects.find((p) => p.id === s.projectId) ?? null;

  const gridMax = GRID_CAPACITY[layout];
  const gridSessions = gridIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter((s): s is SessionInfo => !!s)
    .slice(0, gridMax);
  const railForced = view === 'grid' && layout === '3x2' && !wideSidebar;
  const showSidebar = sidebarOpen && !railForced;
  const terminalTheme = terminalThemes[theme.resolved];

  const refocus = () => setFocusKey((k) => k + 1);

  const select = (id: string | null) => {
    setSelectedId(id);
    storage.set(SELECTED_KEY, id);
  };

  const saveGrid = (ids: string[]) => {
    setGridIds(ids);
    storage.set(GRID_KEY, JSON.stringify(ids));
  };

  // Drop sessions that no longer exist from the saved grid once state is known.
  useEffect(() => {
    if (!state) return;
    const alive = gridIds.filter((id) => state.sessions.some((s) => s.id === id) || id === pendingId.current);
    if (alive.length !== gridIds.length) saveGrid(alive);
  }, [state]);

  // When the selected session disappears, fall back to the tab before it (or after it) in the same project.
  useEffect(() => {
    if (!state || selected || !selectedId || selectedId === pendingId.current) return;
    const tabs = lastTabs.current;
    const at = tabs.indexOf(selectedId);
    const alive = (id: string) => sessions.some((s) => s.id === id);
    const before = tabs.slice(0, Math.max(at, 0)).reverse().find(alive);
    const after = tabs.slice(at + 1).find(alive);
    const sibling = before ?? after ?? sessions.filter((s) => s.projectId === lastProjectId.current).at(-1)?.id;
    select(sibling ?? null);
  }, [state, selected, selectedId]);

  const notify = useNotifications(sessions, projects, (id) => open(id));
  const limits = state?.limits ?? null;
  const limitAlerts = useLimitAlerts(limits, notify.state);

  // Sessions on screen while the tab is in front count as seen.
  const visibleIds = view === 'grid' ? gridSessions.map((s) => s.id) : selected ? [selected.id] : [];
  const [pageTick, setPageTick] = useState(0);
  useEffect(() => {
    const bump = () => setPageTick((t) => t + 1);
    window.addEventListener('focus', bump);
    document.addEventListener('visibilitychange', bump);
    return () => {
      window.removeEventListener('focus', bump);
      document.removeEventListener('visibilitychange', bump);
    };
  }, []);
  useEffect(() => {
    if (!pageActive()) return;
    for (const s of sessions) if (s.unseen && visibleIds.includes(s.id)) api.markSeen(s.id).catch(() => {});
  }, [state, visibleIds.join(), pageTick]);

  // Paused sessions (restored after a server restart) come back when they are shown.
  const resumed = useRef(new Set<string>());
  useEffect(() => {
    for (const s of sessions) {
      if (s.status !== 'suspended' || !visibleIds.includes(s.id) || resumed.current.has(s.id)) continue;
      resumed.current.add(s.id);
      api.resumeSession(s.id).catch(() => resumed.current.delete(s.id));
    }
  }, [state, visibleIds.join()]);

  // Tab title and icon: what is on screen, plus how many sessions want the user.
  const attentionCount = sessions.filter(needsAttention).length;
  const anyWaiting = sessions.some((s) => statusOf(s) === 'waiting');
  const limitLevel = topLevel(limits);
  const nearLimit = limitLevel === 'high' || limitLevel === 'full';
  const shown = view === 'grid' ? 'Grid' : selected ? [selected.name, selectedProject?.name].filter(Boolean).join(' · ') : '';
  useEffect(() => {
    document.title = (attentionCount ? `(${attentionCount}) ` : '') + (shown ? `${shown} — AgentHub` : 'AgentHub');
  }, [attentionCount, shown]);
  useEffect(() => {
    setFavicon(anyWaiting ? 'waiting' : nearLimit ? 'limit' : attentionCount ? 'done' : 'none');
  }, [anyWaiting, nearLimit, attentionCount > 0]);

  function setView(next: View) {
    // First time in an empty grid: show what is running instead of a blank screen.
    if (next === 'grid' && gridSessions.length === 0) {
      const running = sessions.filter((s) => s.status === 'running');
      const pick = selected ? [selected, ...running.filter((s) => s.id !== selected.id)] : running;
      saveGrid(pick.slice(0, gridMax).map((s) => s.id));
    }
    setViewState(next);
    storage.set(VIEW_KEY, next);
    refocus();
  }

  function toggleGrid(id: string) {
    if (gridIds.includes(id)) saveGrid(gridIds.filter((x) => x !== id));
    else if (gridSessions.length < gridMax) saveGrid([...gridSessions.map((s) => s.id), id]);
  }

  /** Show a session: in grid view it joins the grid (if there is room), otherwise it takes the focus view. */
  function open(id: string) {
    select(id);
    if (view === 'grid' && !gridIds.includes(id)) {
      if (gridSessions.length < gridMax) saveGrid([...gridSessions.map((s) => s.id), id]);
      else setView('focus');
    }
    refocus();
  }

  function maximize(id: string) {
    select(id);
    setView('focus');
  }

  function setLayout(next: GridLayout) {
    setLayoutState(next);
    storage.set(LAYOUT_KEY, next);
    setWideSidebar(false);
    // Fill the new room with running sessions not shown yet.
    const room = GRID_CAPACITY[next] - gridSessions.length;
    const extra = sessions.filter((s) => s.status === 'running' && !gridIds.includes(s.id)).slice(0, Math.max(room, 0));
    if (extra.length) saveGrid([...gridSessions.map((s) => s.id), ...extra.map((s) => s.id)]);
    refocus();
  }

  const toggleSidebar = () => {
    if (railForced) return setWideSidebar(true);
    if (wideSidebar) return setWideSidebar(false);
    setSidebarOpen((isOpen) => {
      storage.set(SIDEBAR_KEY, isOpen ? 'closed' : 'open');
      return !isOpen;
    });
  };

  const toggleInspector = () => {
    setInspectorOpen((isOpen) => {
      storage.set(INSPECTOR_KEY, isOpen ? 'closed' : 'open');
      return !isOpen;
    });
    refocus();
  };

  async function newSession(project: Project) {
    const session = await api.createSession(project.id);
    pendingId.current = session.id;
    open(session.id);
  }

  function openProject(project: Project) {
    const latest = sessions.filter((s) => s.projectId === project.id).at(-1);
    if (latest) open(latest.id);
    else newSession(project);
  }

  async function addPath(path: string) {
    const project = await api.addProject(path);
    openProject(project);
  }

  function closePalette() {
    setPalette(null);
    refocus();
  }

  // Global shortcuts, captured before the terminal sees the keystroke.
  const shortcuts = useRef<(e: KeyboardEvent) => void>(() => {});
  shortcuts.current = (e) => {
    const key = e.key.toLowerCase();
    const alt = e.altKey && !e.ctrlKey && !e.metaKey;
    let handled = true;
    if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 'k') {
      palette ? closePalette() : setPalette('root');
    } else if (alt && key === 'n') {
      const project = selectedProject ?? projects.find((p) => p.id === lastProjectId.current);
      project ? newSession(project) : setPalette('root');
    } else if (alt && key === 'g') {
      setView(view === 'grid' ? 'focus' : 'grid');
    } else if (alt && key === 'i' && view === 'focus') {
      toggleInspector();
    } else if (alt && /^Digit[1-9]$/.test(e.code)) {
      const target = sessions[Number(e.code.slice(5)) - 1];
      if (target) open(target.id);
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => shortcuts.current(e);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="app">
      {showSidebar ? (
        <Sidebar
          view={view}
          gridIds={view === 'grid' ? gridIds : []}
          onSetView={setView}
          onCollapse={toggleSidebar}
          projects={projects}
          sessions={sessions}
          selectedId={selected?.id ?? null}
          connected={connected}
          onSelect={(s) => open(s.id)}
          onNewSession={newSession}
          onCloseSession={(s) => api.closeSession(s.id)}
          onRenameSession={(s, name) => api.renameSession(s.id, name)}
          onRemoveProject={(p) => api.removeProject(p.id)}
          onOpenPalette={() => setPalette('root')}
          onAddProject={() => setPalette('root')}
          onOpenSettings={() => setSettingsOpen(true)}
          limits={limits}
        />
      ) : (
        <Rail
          view={view}
          projects={projects}
          sessions={sessions}
          selectedId={selected?.id ?? null}
          gridIds={view === 'grid' ? gridIds : []}
          onSetView={setView}
          onExpand={toggleSidebar}
          onOpenPalette={() => setPalette('root')}
          onSelect={(s) => open(s.id)}
          onOpenSettings={() => setSettingsOpen(true)}
          limits={limits}
        />
      )}

      <div className="main-col">
        <LimitBanner limits={limits} />
        <main className="main">
          {!state ? null : view === 'grid' ? (
            <div className="grid-view">
              <header className="grid-head">
                <h2>Grid</h2>
                <span className="grid-hint">
                  {gridSessions.length} of {sessions.length} session{sessions.length === 1 ? '' : 's'}
                  {gridSessions.length < Math.min(gridMax, sessions.length)
                    ? ' · click a session to add it'
                    : sessions.length > gridMax
                      ? ' · grid is full, remove one to add another'
                      : ''}
                </span>
                <span className="pane-spacer" />
                <span className="grid-hint">Layout</span>
                <div className="segmented segmented-text" role="radiogroup" aria-label="Grid layout">
                  {(['2x2', '3x2'] as const).map((value) => (
                    <button key={value} role="radio" aria-checked={layout === value} onClick={() => setLayout(value)}>
                      {value.replace('x', ' × ')}
                    </button>
                  ))}
                </div>
              </header>
            {gridSessions.length ? (
              <div className="grid" data-count={gridSessions.length}>
                {gridSessions.map((s) => (
                  <SessionPane
                    key={s.id}
                    compact
                    session={s}
                    project={projectOf(s)}
                    theme={terminalTheme}
                    active={s.id === selected?.id}
                    focusKey={s.id === selected?.id ? focusKey : undefined}
                    onActivate={() => s.id !== selectedId && select(s.id)}
                    onMaximize={() => maximize(s.id)}
                    onToggleGrid={() => toggleGrid(s.id)}
                  />
                ))}
              </div>
            ) : (
              <div className="empty">
                <div className="empty-body">
                  <h1>Nothing in the grid yet</h1>
                  <p className="muted">
                    Click sessions in the sidebar to add them here, up to {gridMax}. Start a new one with <kbd>Alt N</kbd>.
                  </p>
                </div>
              </div>
            )}
            </div>
          ) : selected ? (
            <>
              <div className="focus-view">
                <SessionTabs
                  sessions={sessions.filter((s) => s.projectId === selected.projectId)}
                  selectedId={selected.id}
                  onSelect={(s) => open(s.id)}
                  onClose={(s) => api.closeSession(s.id)}
                  onRename={(s, name) => api.renameSession(s.id, name)}
                  onNew={() => selectedProject && newSession(selectedProject)}
                />
                <SessionPane
                  tabbed
                  session={selected}
                  project={selectedProject}
                  theme={terminalTheme}
                  focusKey={focusKey}
                  inGrid={gridIds.includes(selected.id)}
                  onToggleGrid={() => toggleGrid(selected.id)}
                  inspectorOpen={inspectorOpen}
                  onToggleInspector={toggleInspector}
                />
              </div>
              {inspectorOpen && (
                <Inspector session={selected} onClose={toggleInspector} skillsChange={skillsChange} onAddSkill={() => setSkillPicker(true)} />
              )}
            </>
          ) : (
            projects.length ? (
              <EmptyState projects={projects} onOpenPalette={() => setPalette('root')} onOpenProject={openProject} />
            ) : (
              <Welcome onOpenPalette={() => setPalette('root')} onAddPath={addPath} />
            )
          )}
        </main>
      </div>

      <LimitToasts toasts={limitAlerts.toasts} onDismiss={limitAlerts.dismiss} />

      {palette && (
        <CommandPalette
          initialMode={palette}
          projects={projects}
          currentProject={selectedProject}
          view={view}
          onClose={closePalette}
          onOpenProject={openProject}
          onAddPath={addPath}
          onNewSession={newSession}
          onSetTheme={theme.setPref}
          onOpenSettings={() => {
            setPalette(null);
            setSettingsOpen(true);
          }}
          onSetView={setView}
          onToggleSidebar={toggleSidebar}
          onToggleInspector={view === 'focus' && selected ? toggleInspector : undefined}
          onAddSkill={
            selected
              ? () => {
                  // Not closePalette(): its refocus would pull focus back to the terminal.
                  setPalette(null);
                  setSkillPicker(true);
                }
              : undefined
          }
        />
      )}

      {settingsOpen && state && (
        <SettingsDialog
          settings={state.settings}
          themePref={theme.pref}
          onSetTheme={theme.setPref}
          notify={notify.state}
          onToggleNotify={notify.toggle}
          onClose={() => {
            setSettingsOpen(false);
            refocus();
          }}
        />
      )}

      {skillPicker && selected && (
        <SkillPicker
          session={selected}
          projectName={selectedProject?.name ?? 'this project'}
          onClose={() => {
            setSkillPicker(false);
            refocus();
          }}
          onDone={({ reload, openSession }) => {
            setSkillPicker(false);
            setSkillsChange((c) => ({ n: c.n + 1, reload }));
            if (openSession) {
              pendingId.current = openSession;
              open(openSession);
            } else refocus();
          }}
        />
      )}
    </div>
  );
}

function EmptyState(props: { projects: Project[]; onOpenPalette: () => void; onOpenProject: (p: Project) => void }) {
  return (
    <div className="empty">
      <div className="empty-body">
        <h1>Pick up where you left off</h1>
        <p className="muted">
          Each project runs its own Claude Code sessions. Open one, or search with <kbd>Ctrl K</kbd>.
        </p>
        <div className="empty-list">
          {props.projects.map((p) => (
            <button key={p.id} className="empty-item" onClick={() => props.onOpenProject(p)}>
              <span className="empty-item-name">{p.name}</span>
              <span className="empty-item-path">{p.path}</span>
            </button>
          ))}
        </div>
        <button className="btn btn-primary" onClick={props.onOpenPalette}>
          Open another project
        </button>
      </div>
    </div>
  );
}

/** First launch: what AgentHub does, and the folders Claude Code already knows about. */
function Welcome(props: { onOpenPalette: () => void; onAddPath: (path: string) => Promise<void> }) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.suggestions().then((list) => setSuggestions(list.slice(0, 6))).catch(() => {});
  }, []);
  const when = (t: number) => (new Date(t).toDateString() === new Date().toDateString() ? 'today' : timeAgo(t));

  return (
    <div className="welcome">
      <div className="welcome-body">
        <h1>
          Run all your Claude Code sessions <span className="hl">in one place</span>
        </h1>
        <p className="welcome-lead">
          Add a project folder, then start sessions in it. AgentHub shows which sessions are working, which ones need
          you, and which ones are done.
        </p>
        <div className="welcome-cta">
          <button className="btn btn-primary btn-large" onClick={props.onOpenPalette}>
            <FolderPlus size={16} />
            Add a project folder
          </button>
          <span className="muted">
            or press <kbd>Ctrl K</kbd>
          </span>
        </div>
        {error && <p className="welcome-error">{error}</p>}
        {suggestions.length > 0 && (
          <div className="welcome-list">
            <div className="welcome-list-head">
              <b>Folders you used with Claude Code</b>
              <span>found in ~/.claude/projects</span>
            </div>
            {suggestions.map((s) => (
              <div key={s.path} className="welcome-item">
                <Folder size={16} className="welcome-item-icon" />
                <span className="welcome-item-text">
                  <span className="welcome-item-name">{s.name}</span>
                  <span className="welcome-item-path">{s.path}</span>
                </span>
                <span className="welcome-item-when">{when(s.lastUsed)}</span>
                <button
                  className="btn btn-secondary"
                  onClick={() => props.onAddPath(s.path).catch((err: Error) => setError(err.message))}
                >
                  Add
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="welcome-keys">
          <span>
            <kbd>Alt N</kbd> new session
          </span>
          <span>
            <kbd>Alt G</kbd> focus or grid
          </span>
          <span>
            <kbd>Alt I</kbd> inspector
          </span>
          <span>
            <kbd>Alt 1…9</kbd> jump to a session
          </span>
        </div>
      </div>
    </div>
  );
}

