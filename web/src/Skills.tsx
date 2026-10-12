import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, FolderInput, Package, PenLine, Plus } from 'lucide-react';
import { api, type AvailableSkills, type SessionInfo, type Skill, type SkillChange, type SkillScope } from './api';
import { fuzzyScore } from './fuzzy';

/**
 * Skills in the inspector, and the dialog that adds them.
 *
 * Claude Code has no per-session skills, so all of this is per project: a skill
 * is either in this project or in every project, and turning one off only
 * affects this project.
 */

const SCOPE_LABEL: Record<SkillScope, string> = { project: 'This project', all: 'All projects' };

/** Changes made from the add dialog, so the list refreshes and can say when a reload is needed. */
export interface SkillsChange {
  n: number;
  reload: boolean;
}

export function SkillsSection({ session, change, onAdd }: { session: SessionInfo; change: SkillsChange; onAdd: () => void }) {
  const [data, setData] = useState<{ id: string; skills: Skill[]; lastUsed: { name: string; at: number } | null } | null>(null);
  const [error, setError] = useState('');
  const [needsReload, setNeedsReload] = useState(false);

  const load = () =>
    api
      .skills(session.id)
      .then((value) => setData({ id: session.id, ...value }))
      .catch((err) => setError(err.message));

  // Again when Claude finishes or starts a turn: that is when a skill gets used.
  useEffect(() => {
    load();
  }, [session.id, session.activity, change.n]);
  useEffect(() => setNeedsReload(false), [session.id]);
  useEffect(() => {
    if (change.reload) setNeedsReload(true);
  }, [change]);

  async function toggle(skill: Skill) {
    setError('');
    setData((d) => d && { ...d, skills: d.skills.map((s) => (s.id === skill.id ? { ...s, enabled: !s.enabled } : s)) });
    try {
      const res = await api.changeSkills(session.id, { action: 'toggle', id: skill.id, on: !skill.enabled });
      if (res.reload) setNeedsReload(true);
    } catch (err) {
      setError((err as Error).message);
    }
    load();
  }

  async function reload() {
    try {
      await api.changeSkills(session.id, { action: 'reload' });
      setNeedsReload(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const current = data?.id === session.id ? data : null;
  const skills = current?.skills ?? [];
  const usedNow = (s: Skill) => {
    const used = current?.lastUsed;
    if (!used || !s.enabled || Date.now() - used.at > 10 * 60_000) return false;
    return s.kind === 'plugin' ? used.name.startsWith(`${s.name}:`) || used.name === s.name : used.name === s.name;
  };

  return (
    <section className="insp-block">
      <h3 title="Claude uses a skill on its own when a task calls for it">
        Skills
        {current && <span>{skills.filter((s) => s.enabled).length} on</span>}
      </h3>
      {!current ? (
        <p className="insp-empty">Loading…</p>
      ) : (
        <div className="skill-list">
          {skills.length === 0 && <p className="insp-empty">None yet</p>}
          {skills.map((s) => (
            <div key={s.id} className="skill-row" data-enabled={s.enabled} title={s.description || undefined}>
              <button
                className="switch"
                role="switch"
                aria-checked={s.enabled}
                aria-label={`${s.enabled ? 'Turn off' : 'Turn on'} ${s.name} in this project`}
                onClick={() => toggle(s)}
              />
              <span className="skill-name">{s.name}</span>
              <span className="skill-meta">
                {usedNow(s) ? (
                  <span className="skill-used">used just now</span>
                ) : (
                  <>
                    {s.kind === 'plugin' && 'Plugin · '}
                    {SCOPE_LABEL[s.scope]}
                  </>
                )}
              </span>
            </div>
          ))}
          <button className="skill-add" onClick={onAdd}>
            <Plus size={13} /> Add skill
          </button>
        </div>
      )}
      {needsReload && (
        <div className="skill-reload">
          <span>Plugins load at start. Reload them to use the change in this session.</span>
          <button className="btn btn-secondary" onClick={reload} disabled={session.activity === 'working' || session.activity === 'waiting'}>
            Run /reload-plugins
          </button>
        </div>
      )}
      {error && <p className="skill-error">{error}</p>}
    </section>
  );
}

// ---- Add dialog ---------------------------------------------------------------------

type Choice =
  | { kind: 'copy'; name: string; description: string; path: string; project: string }
  | { kind: 'plugin'; name: string; description: string; id: string; installs: number }
  | { kind: 'new'; description: string };

interface Item {
  key: string;
  group: string;
  choice: Choice;
}

const PLUGINS_SHOWN = 8;

export function SkillPicker({
  session,
  projectName,
  onClose,
  onDone,
}: {
  session: SessionInfo;
  projectName: string;
  onClose: () => void;
  onDone: (result: { reload: boolean; openSession?: string }) => void;
}) {
  const [available, setAvailable] = useState<AvailableSkills | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<Choice | null>(null);
  const [error, setError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .availableSkills(session.id)
      .then(setAvailable)
      .catch((err) => setError(err.message));
  }, [session.id]);

  const items = useMemo<Item[]>(() => {
    if (!available) return [];
    const q = query.trim();
    const rank = <T,>(list: T[], text: (t: T) => string) =>
      q
        ? list
            .map((t) => ({ t, score: fuzzyScore(q, text(t)) }))
            .filter((r) => r.score !== null)
            .sort((a, b) => (b.score as number) - (a.score as number))
            .map((r) => r.t)
        : list;
    const out: Item[] = [];
    for (const s of rank(available.elsewhere, (s) => s.name)) {
      out.push({ key: `copy:${s.path}`, group: 'In your other projects', choice: { kind: 'copy', ...s } });
    }
    // Names first; descriptions catch the rest ("pdf" finds a plugin that only mentions PDFs).
    const plugins = q
      ? [
          ...rank(available.plugins, (p) => p.name),
          ...available.plugins.filter((p) => fuzzyScore(q, p.name) === null && p.description.toLowerCase().includes(q.toLowerCase())),
        ]
      : available.plugins;
    for (const p of plugins.slice(0, q ? 30 : PLUGINS_SHOWN)) {
      out.push({ key: `plugin:${p.id}`, group: q ? 'Plugins' : 'Popular plugins', choice: { kind: 'plugin', ...p } });
    }
    out.push({ key: 'new', group: 'New', choice: { kind: 'new', description: q } });
    return out;
  }, [available, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && items[active]) {
      e.preventDefault();
      setPicked(items[active].choice);
    }
  }

  let lastGroup = '';
  return (
    <div className="palette-backdrop" onMouseDown={onClose} onKeyDown={(e) => e.key === 'Escape' && (picked ? setPicked(null) : onClose())}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Add a skill">
        <div className="palette-crumb">
          <Package size={13} />
          <span>Add a skill to {projectName}</span>
        </div>
        {picked ? (
          <Confirm session={session} choice={picked} onBack={() => setPicked(null)} onDone={onDone} />
        ) : (
          <>
            <input
              className="palette-input"
              autoFocus
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search skills and plugins, or describe a new one…"
            />
            {error && <div className="palette-error">{error}</div>}
            <div className="palette-list" ref={listRef}>
              {!available && !error && <div className="palette-empty">Loading the plugin catalog…</div>}
              {items.map((item, i) => {
                const header = item.group !== lastGroup ? <div className="palette-group">{item.group}</div> : null;
                lastGroup = item.group;
                const c = item.choice;
                return (
                  <div key={item.key}>
                    {header}
                    <div
                      className="palette-item skill-item"
                      data-active={i === active}
                      onMouseMove={() => setActive(i)}
                      onClick={() => setPicked(c)}
                    >
                      <span className="palette-icon">
                        {c.kind === 'copy' ? <FolderInput size={15} /> : c.kind === 'plugin' ? <Package size={15} /> : <PenLine size={15} />}
                      </span>
                      <span className="skill-item-text">
                        <b>{c.kind === 'new' ? (c.description ? `Write a new skill: “${c.description}”` : 'Write a new skill…') : c.name}</b>
                        <small>
                          {c.kind === 'copy'
                            ? `From ${c.project}${c.description ? ` · ${c.description}` : ''}`
                            : c.kind === 'plugin'
                              ? c.description
                              : 'Describe it and a new session writes it for you'}
                        </small>
                      </span>
                      {c.kind === 'plugin' && <span className="palette-detail">{installs(c.installs)}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="palette-footer">
              <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
              <span><kbd>Enter</kbd> select</span>
              <span><kbd>Esc</kbd> close</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Confirm({
  session,
  choice,
  onBack,
  onDone,
}: {
  session: SessionInfo;
  choice: Choice;
  onBack: () => void;
  onDone: (result: { reload: boolean; openSession?: string }) => void;
}) {
  const [scope, setScope] = useState<SkillScope>('project');
  const [description, setDescription] = useState(choice.kind === 'new' ? choice.description : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function add() {
    const change: SkillChange =
      choice.kind === 'copy'
        ? { action: 'copy', path: choice.path, scope }
        : choice.kind === 'plugin'
          ? { action: 'install', id: choice.id, scope }
          : { action: 'create', description, scope };
    setBusy(true);
    setError('');
    try {
      const res = await api.changeSkills(session.id, change);
      onDone({ reload: !!res.reload, openSession: res.sessionId });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  // Enter adds; in the description box it takes Ctrl+Enter. Buttons keep their own Enter.
  function onKeyDown(e: React.KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (e.key !== 'Enter' || busy || tag === 'BUTTON' || (tag === 'TEXTAREA' && !e.ctrlKey)) return;
    if (choice.kind === 'new' && !description.trim()) return;
    e.preventDefault();
    add();
  }

  const title = choice.kind === 'new' ? 'Write a new skill' : choice.name;
  const label = choice.kind === 'new' ? 'Start writing it' : choice.kind === 'plugin' ? `Install ${choice.name}` : `Add ${choice.name}`;
  return (
    <div className="skill-confirm" onKeyDown={onKeyDown}>
      <button className="btn btn-ghost skill-back" onClick={onBack}>
        <ArrowLeft size={14} /> Back
      </button>
      <h4>{title}</h4>
      {choice.kind === 'new' ? (
        <>
          <label htmlFor="skill-desc">What should Claude know how to do?</label>
          <textarea
            id="skill-desc"
            autoFocus
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Write release notes from the commits since the last tag, in our changelog style"
          />
          <p className="skill-hint">A new session opens in this project and writes the skill. You can follow along and answer its questions.</p>
        </>
      ) : (
        <p className="skill-desc">{choice.description || 'No description.'}</p>
      )}
      {choice.kind === 'plugin' && <p className="skill-hint">A plugin can also bring commands, hooks or MCP servers. Install only what you trust.</p>}
      <div className="skill-scope">
        <span>Use it in</span>
        <div className="segmented segmented-text" role="radiogroup" aria-label="Where to add it">
          {(['project', 'all'] as const).map((s) => (
            <button key={s} role="radio" aria-checked={scope === s} onClick={() => setScope(s)}>
              {s === 'project' ? 'This project' : 'All my projects'}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="skill-error">{error}</p>}
      <div className="skill-actions">
        <button className="btn btn-primary" autoFocus={choice.kind !== 'new'} onClick={add} disabled={busy || (choice.kind === 'new' && !description.trim())}>
          {busy ? (choice.kind === 'plugin' ? 'Installing…' : 'Adding…') : label}
        </button>
      </div>
    </div>
  );
}

function installs(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M installs`;
  if (n >= 1000) return `${Math.round(n / 1000)}k installs`;
  return n ? `${n} installs` : '';
}
