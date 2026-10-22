import type { ITheme } from '@xterm/xterm';
import { CircleDot, GitBranch, LayoutGrid, Maximize2, PanelRight, RotateCcw, SquareTerminal, X } from 'lucide-react';
import { api, type Project, type SessionInfo } from './api';
import { TerminalView } from './TerminalView';
import { useState } from 'react';
import { ConfirmButton } from './ui';
import { StatusDot, filesChanged, statusLabel, statusOf, timeAgo } from './status';
import { ModelPicker } from './ModelPicker';
import { PermissionButtons, PermissionText } from './Permission';
import { PlanLots, showPlanLots } from './PlanLots';
import { QueueBadge, UpNext, showUpNext } from './UpNext';
import { ChangesView, useCopyChanges } from './Changes';

interface Props {
  session: SessionInfo;
  project: Project | null;
  theme: ITheme;
  /** Grid cell: tighter header, smaller font, actions to maximize or leave the grid. */
  compact?: boolean;
  /** Focus view under session tabs: the tab names the session and closes it. */
  tabbed?: boolean;
  active?: boolean;
  focusKey?: number;
  inGrid?: boolean;
  onActivate?: () => void;
  onMaximize?: () => void;
  onToggleGrid?: () => void;
  /** Focus view only: the inspector button. */
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
  /** Focus view only: queue GitHub issues, whether Claude works or waits. */
  onPickIssues?: () => void;
}

export function SessionPane(props: Props) {
  const { session, project, theme, compact, tabbed, active, focusKey, inGrid, onActivate, onMaximize, onToggleGrid } = props;
  const exited = session.status === 'exited';
  const paused = session.status === 'suspended';
  // A session in its own copy has a Changes tab next to its terminal (focus view only).
  const [changesFor, setChangesFor] = useState<string | null>(null);
  const showChanges = !compact && !!session.copy && changesFor === session.id;
  const changes = useCopyChanges(session, !compact);

  return (
    <section className="pane" data-compact={compact} data-tabbed={tabbed} data-active={active} data-status={statusOf(session)} onFocusCapture={onActivate} onMouseDown={onActivate}>
      <header className="pane-bar" onDoubleClick={compact ? onMaximize : undefined}>
        {compact && <StatusDot session={session} />}
        {tabbed ? (
          <div className="crumbs">
            <span className="crumb-session">{project?.name}</span>
          </div>
        ) : (
          <div className="crumbs">
            <span className="crumb-project">{project?.name}</span>
            <span className="crumb-sep">/</span>
            <span className="crumb-session">{session.name}</span>
          </div>
        )}
        {!compact &&
          (session.copy ? (
            <span className="pane-path pane-copy" title={`Works in its own copy: ${session.cwd}`}>
              <GitBranch size={13} />
              {session.copy.branch}
            </span>
          ) : (
            <span className="pane-path" title={session.cwd}>
              {session.cwd}
            </span>
          ))}
        {!compact && session.copy && <ViewToggle count={changes.data?.files.length ?? 0} showChanges={showChanges} onChange={(on) => setChangesFor(on ? session.id : null)} />}
        <ModelPicker session={session} />
        <StatusText session={session} compact={compact} />
        {compact && <QueueBadge session={session} />}
        <span className="pane-spacer" />

        {props.onPickIssues && session.status === 'running' && (
          <button className="icon-btn" title="Work on GitHub issues" onClick={props.onPickIssues}>
            <CircleDot size={14} />
          </button>
        )}
        <button className="icon-btn" title="Restart (keeps the conversation)" onClick={() => api.restartSession(session.id)}>
          <RotateCcw size={14} />
        </button>
        {compact ? (
          <>
            <button className="icon-btn" title="Focus this session" onClick={onMaximize}>
              <Maximize2 size={14} />
            </button>
            <button className="icon-btn" title="Remove from grid" onClick={onToggleGrid}>
              <X size={15} />
            </button>
          </>
        ) : (
          <>
            <button
              className="icon-btn"
              title={inGrid ? 'Remove from grid' : 'Add to grid'}
              data-on={inGrid}
              onClick={onToggleGrid}
            >
              <LayoutGrid size={14} />
            </button>
            {props.onToggleInspector && (
              <button
                className="icon-btn"
                title={props.inspectorOpen ? 'Hide inspector (Alt I)' : 'Show inspector (Alt I)'}
                data-on={props.inspectorOpen}
                onClick={props.onToggleInspector}
              >
                <PanelRight size={14} />
              </button>
            )}
            {tabbed ? null : exited ? (
              <button className="icon-btn" title="Close" onClick={() => api.closeSession(session.id)}>
                <X size={15} />
              </button>
            ) : (
              <ConfirmButton
                className="icon-btn"
                title="End session"
                confirmLabel="End session"
                onConfirm={() => api.closeSession(session.id)}
              >
                <X size={15} />
              </ConfirmButton>
            )}
          </>
        )}
      </header>

      <div className="pane-stage">
        <TerminalView
          sessionId={session.id}
          theme={theme}
          focusKey={focusKey}
          fontSize={compact ? 12 : 13}
          autoFocus={!compact || active}
        />
        {showChanges && <ChangesView session={session} changes={changes} onBack={() => setChangesFor(null)} />}
      </div>

      {compact && statusOf(session) === 'waiting' && (
        <div className="ask-bar">
          <span className="ask-text" title={session.permission ? `${session.permission.verb} ${session.permission.target}` : (session.detail ?? undefined)}>
            {session.permission ? <PermissionText permission={session.permission} /> : (session.detail ?? 'Needs your input')}
          </span>
          {session.permission ? (
            <PermissionButtons session={session} small />
          ) : (
            <button className="btn btn-secondary" onClick={onMaximize}>
              Answer in the terminal
            </button>
          )}
        </div>
      )}

      {!compact && showPlanLots(session) && <PlanLots session={session} />}
      {!compact && showUpNext(session) && <UpNext session={session} />}

      {compact && session.summary &&(statusOf(session) === 'done' || statusOf(session) === 'idle') && (
        <div className="done-bar" data-status={statusOf(session)} title={session.summary.text}>
          <span className="done-text">
            <b>Done.</b> {session.summary.text}
          </span>
          <span className="done-meta">
            {[filesChanged(session.summary.files), timeAgo(session.summary.at)].filter(Boolean).join(' · ')}
          </span>
        </div>
      )}

      {(exited || paused) && (
        <div className="ended-bar" data-compact={compact}>
          <StatusDot session={session} />
          <span className="ended-text">
            <b>
              {paused
                ? 'Paused after Orchia restarted'
                : `Claude exited${session.endedAt ? ` ${timeAgo(session.endedAt)}` : ''}${session.exitCode ? ` (code ${session.exitCode})` : ''}`}
            </b>
            {!compact && <span>The conversation is saved. Restart picks it up where it stopped.</span>}
          </span>
          <span className="pane-spacer" />
          <button className="btn btn-primary" onClick={() => api.resumeSession(session.id)}>
            <RotateCcw size={compact ? 12 : 14} />
            {compact ? 'Restart' : 'Restart, keep the conversation'}
          </button>
          <button className="btn btn-secondary" onClick={() => api.restartSession(session.id, true)}>
            New conversation
          </button>
          {!compact && (
            <button className="btn btn-ghost" onClick={() => api.closeSession(session.id)}>
              Close
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function StatusText({ session, compact }: { session: SessionInfo; compact?: boolean }) {
  const status = statusOf(session);
  if (status === 'idle' || status === 'starting') return null;
  const text = !compact && session.detail && status === 'waiting' ? `${statusLabel[status]} · ${session.detail}` : statusLabel[status];
  return (
    <span className="pane-status" data-status={status} title={session.detail ?? undefined}>
      {text}
    </span>
  );
}

/** Terminal | Changes, for a session in its own copy. The count comes from the copy's diff. */
function ViewToggle({ count, showChanges, onChange }: { count: number; showChanges: boolean; onChange: (changes: boolean) => void }) {
  return (
    <div className="view-toggle" role="tablist" aria-label="Terminal or changes">
      <button role="tab" aria-selected={!showChanges} onClick={() => onChange(false)}>
        <SquareTerminal size={13} />
        Terminal
      </button>
      <button role="tab" aria-selected={showChanges} title="What this copy changed, and merging it" onClick={() => onChange(true)}>
        Changes
        {count > 0 && <span className="view-count">{count}</span>}
      </button>
    </div>
  );
}
