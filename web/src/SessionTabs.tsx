import { useState } from 'react';
import { GitBranch, Plus, X } from 'lucide-react';
import type { SessionInfo } from './api';
import { ConfirmButton, RenameInput } from './ui';
import { StatusDot, statusLabel, statusOf } from './status';
import { QueueBadge } from './UpNext';

interface Props {
  /** Sessions of the current project, oldest first. */
  sessions: SessionInfo[];
  selectedId: string;
  onSelect: (session: SessionInfo) => void;
  onClose: (session: SessionInfo) => void;
  onRename: (session: SessionInfo, name: string) => void;
  onNew: () => void;
}

/** One tab per session of the project shown in focus view. */
export function SessionTabs({ sessions, selectedId, onSelect, onClose, onRename, onNew }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="tabs" role="tablist" aria-label="Sessions in this project">
      {sessions.map((s) => {
        const on = s.id === selectedId;
        const status = statusOf(s);
        const editing = editingId === s.id;
        return (
          <div
            key={s.id}
            className="tab"
            role="tab"
            aria-selected={on}
            data-on={on}
            data-status={status}
            title={editing ? undefined : `${s.name} · ${s.detail ?? statusLabel[status]} (double-click to rename)`}
            onClick={() => !on && onSelect(s)}
            onDoubleClick={() => setEditingId(s.id)}
          >
            <StatusDot session={s} />
            {editing ? (
              <RenameInput
                name={s.name}
                onDone={(name) => {
                  if (name) onRename(s, name);
                  setEditingId(null);
                }}
              />
            ) : (
              <span className="tab-label">{s.name}</span>
            )}
            {!editing && s.copy && (
              <span className="tab-copy" title={`Works in its own copy, on ${s.copy.branch}`}>
                <GitBranch size={12} />
              </span>
            )}
            {!editing && <QueueBadge session={s} />}
            {!editing && !on && status === 'waiting' && <span className="tab-mark">Needs you</span>}
            {!editing && on && (s.status === 'exited' ? (
              <button className="icon-btn tab-close" title="Close" onClick={(e) => (e.stopPropagation(), onClose(s))}>
                <X size={13} />
              </button>
            ) : (
              <ConfirmButton className="icon-btn tab-close" title="End session" confirmLabel="End" onConfirm={() => onClose(s)}>
                <X size={13} />
              </ConfirmButton>
            ))}
          </div>
        );
      })}
      <button className="tab tab-add" title="New session in this project (Alt N)" onClick={onNew}>
        <Plus size={15} />
      </button>
    </div>
  );
}
