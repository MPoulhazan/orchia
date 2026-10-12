import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, Link2, Plug, Plus, Power, Sparkles } from 'lucide-react';
import { describeServer, parseMcpSource, type McpServerConfig } from '../../server/mcpSource';
import { api, type Connector, type ConnectorCatalogItem, type ConnectorSource, type SessionInfo, type SkillScope } from './api';
import { fuzzyScore } from './fuzzy';
import { InspectorSection } from './ui';

/**
 * Connectors (MCP servers) in the inspector, and the dialog that adds them. Like
 * skills, they are per project: turning one off only affects this project.
 * Claude Code connects to them when a session starts, so a change needs a
 * restart to reach the running session.
 */

const SOURCE_LABEL: Record<ConnectorSource, string> = {
  account: 'Claude account',
  user: 'All projects',
  local: 'This project',
  project: 'Shared in repo',
  plugin: 'Plugin',
};

const USED_MS = 10 * 60_000;

/** Bumped by the add dialog, so the list refreshes and offers a restart. */
export type ConnectorsChange = number;

export function ConnectorsSection({ session, change, onAdd }: { session: SessionInfo; change: ConnectorsChange; onAdd: () => void }) {
  const [data, setData] = useState<{ id: string; connectors: Connector[]; lastUsed: { toolPrefix: string; at: number } | null } | null>(null);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);

  const load = () =>
    api
      .connectors(session.id)
      .then((value) => setData({ id: session.id, ...value }))
      .catch((err) => setError(err.message));

  // Again when Claude starts or finishes a turn: that is when a connector gets used.
  useEffect(() => {
    load();
  }, [session.id, session.activity, change]);
  useEffect(() => setChanged(false), [session.id]);
  useEffect(() => {
    if (change) setChanged(true);
  }, [change]);
  // A connector just added or turned on is checked in the background; ask again until the check is done.
  const checking = data?.connectors.some((c) => c.state === 'unknown');
  useEffect(() => {
    if (!checking) return;
    const timer = setTimeout(load, 4000);
    return () => clearTimeout(timer);
  }, [data]);

  async function toggle(connector: Connector) {
    const on = connector.state === 'disabled';
    setError('');
    setData(
      (d) =>
        d && {
          ...d,
          connectors: d.connectors.map((c) => (c.name === connector.name ? { ...c, state: on ? 'unknown' : 'disabled' } : c)),
        },
    );
    try {
      await api.changeConnectors(session.id, { action: 'toggle', name: connector.name, on });
      setChanged(true);
    } catch (err) {
      setError((err as Error).message);
    }
    load();
  }

  async function restart() {
    try {
      await api.restartSession(session.id);
      setChanged(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const current = data?.id === session.id ? data : null;
  const connectors = [...(current?.connectors ?? [])].sort((a, b) => a.label.localeCompare(b.label));
  const usedNow = (c: Connector) => {
    const used = current?.lastUsed;
    return !!used && c.state !== 'disabled' && used.toolPrefix === c.toolPrefix && Date.now() - used.at < USED_MS;
  };

  return (
    <InspectorSection
      id="connectors"
      title="Connectors"
      hint="Connectors give Claude access to other apps and services. Claude uses their tools when a task calls for it."
      summary={current ? `${connectors.filter((c) => c.state !== 'disabled').length} on` : null}
      footer={
        <>
          {changed && (
            <div className="skill-reload">
              <span>Connectors load when the session starts. Restart it to use the change. The conversation is kept.</span>
              <button className="btn btn-secondary conn-restart" onClick={restart} disabled={session.activity === 'working'}>
                Restart session
              </button>
            </div>
          )}
          {error && <p className="skill-error">{error}</p>}
        </>
      }
    >
      {!current ? (
        <p className="insp-empty">Checking connectors…</p>
      ) : (
        <div className="skill-list">
          {connectors.length === 0 && <p className="insp-empty">None yet</p>}
          {connectors.map((c) => {
            const on = c.state !== 'disabled';
            return (
              <div key={c.name} className="skill-row conn-row" data-enabled={on} data-state={c.state} title={`${c.target}\n${c.detail}`}>
                <button
                  className="switch"
                  role="switch"
                  aria-checked={on}
                  aria-label={`${on ? 'Turn off' : 'Turn on'} ${c.label} in this project`}
                  onClick={() => toggle(c)}
                />
                <span className="skill-name">{c.label}</span>
                <span className="skill-meta">
                  {usedNow(c) ? <span className="skill-used">used just now</span> : <ConnectorState connector={c} />}
                </span>
              </div>
            );
          })}
          <button className="skill-add" onClick={onAdd}>
            <Plus size={13} /> Add connector
          </button>
        </div>
      )}
    </InspectorSection>
  );
}

function ConnectorState({ connector: c }: { connector: Connector }) {
  switch (c.state) {
    case 'needs-auth':
      return <span className="conn-state is-wait">Needs sign-in</span>;
    case 'failed':
      return <span className="conn-state is-bad">Can't connect</span>;
    case 'pending':
      return <span className="conn-state is-wait">Not approved</span>;
    case 'unknown':
      return <>Checking…</>;
    default:
      return <>{SOURCE_LABEL[c.source]}</>;
  }
}

// ---- Add dialog ---------------------------------------------------------------------

type Choice =
  | { kind: 'add'; name: string; title: string; summary: string; server: McpServerConfig; reason?: string; pasted?: boolean }
  | { kind: 'enable'; connector: Connector }
  | { kind: 'account' };

interface Item {
  key: string;
  group: string;
  choice: Choice;
}

const ACCOUNT_URL = 'https://claude.ai/settings/connectors';

export function ConnectorPicker({
  session,
  projectName,
  onClose,
  onDone,
}: {
  session: SessionInfo;
  projectName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [catalog, setCatalog] = useState<ConnectorCatalogItem[] | null>(null);
  const [off, setOff] = useState<Connector[]>([]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<Extract<Choice, { kind: 'add' }> | null>(null);
  const [error, setError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .availableConnectors(session.id)
      .then((r) => setCatalog(r.catalog))
      .catch((err) => setError(err.message));
    api
      .connectors(session.id)
      .then((r) => setOff(r.connectors.filter((c) => c.state === 'disabled')))
      .catch(() => {});
  }, [session.id]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim();
    const out: Item[] = [];
    const source = parseMcpSource(q);
    if (source) {
      out.push({
        key: `pasted:${q}`,
        group: 'From what you pasted',
        choice: { kind: 'add', name: source.name, title: source.name, summary: describeServer(source.server), server: source.server, pasted: true },
      });
      return out;
    }
    const rank = <T,>(list: T[], text: (t: T) => string) =>
      q
        ? list
            .map((t) => ({ t, score: fuzzyScore(q, text(t)) }))
            .filter((r) => r.score !== null)
            .sort((a, b) => (b.score as number) - (a.score as number))
            .map((r) => r.t)
        : list;
    for (const c of rank(off, (c) => c.label)) out.push({ key: `off:${c.name}`, group: 'Turned off in this project', choice: { kind: 'enable', connector: c } });
    for (const c of rank(catalog ?? [], (c) => `${c.title} ${c.summary}`)) {
      out.push({ key: `catalog:${c.name}`, group: c.reason && !q ? 'Suggested for this project' : 'Popular', choice: { kind: 'add', ...c } });
    }
    if (catalog) out.push({ key: 'account', group: 'More', choice: { kind: 'account' } });
    return out;
  }, [catalog, off, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [active]);

  async function choose(choice: Choice) {
    if (choice.kind === 'add') return setPicked(choice);
    if (choice.kind === 'account') return window.open(ACCOUNT_URL, '_blank', 'noreferrer');
    try {
      await api.changeConnectors(session.id, { action: 'toggle', name: choice.connector.name, on: true });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && items[active]) {
      e.preventDefault();
      choose(items[active].choice);
    }
  }

  let lastGroup = '';
  return (
    <div className="palette-backdrop" onMouseDown={onClose} onKeyDown={(e) => e.key === 'Escape' && (picked ? setPicked(null) : onClose())}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Add a connector">
        <div className="palette-crumb">
          <Plug size={13} />
          <span>Add a connector to {projectName}</span>
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
              placeholder="Search, or paste a server URL or the command that starts it…"
            />
            {error && <div className="palette-error">{error}</div>}
            <div className="palette-list" ref={listRef}>
              {!catalog && !error && !items.length && <div className="palette-empty">Checking this project's connectors…</div>}
              {catalog && !items.length && <div className="palette-empty">No match. Paste the server's URL or command to add it.</div>}
              {items.map((item, i) => {
                const header = item.group !== lastGroup ? <div className="palette-group">{item.group}</div> : null;
                lastGroup = item.group;
                const c = item.choice;
                return (
                  <div key={item.key}>
                    {header}
                    <div className="palette-item skill-item" data-active={i === active} onMouseMove={() => setActive(i)} onClick={() => choose(c)}>
                      <span className="palette-icon">
                        {c.kind === 'enable' ? <Power size={15} /> : c.kind === 'account' ? <ExternalLink size={15} /> : c.pasted ? <Link2 size={15} /> : c.reason ? <Sparkles size={15} /> : <Plug size={15} />}
                      </span>
                      <span className="skill-item-text">
                        <b>{c.kind === 'enable' ? c.connector.label : c.kind === 'account' ? 'Connect more apps to your Claude account' : c.title}</b>
                        <small>
                          {c.kind === 'enable'
                            ? `${SOURCE_LABEL[c.connector.source]} · Turn it on here`
                            : c.kind === 'account'
                              ? 'On claude.ai. They show up here in every project.'
                              : c.reason
                                ? `${c.reason} · ${c.summary}`
                                : c.summary}
                        </small>
                      </span>
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
  choice: Extract<Choice, { kind: 'add' }>;
  onBack: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(choice.name);
  const [scope, setScope] = useState<SkillScope>('project');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const validName = /^[\w.-]{1,64}$/.test(name.trim());

  async function add() {
    setBusy(true);
    setError('');
    try {
      await api.changeConnectors(session.id, { action: 'add', name: name.trim(), server: choice.server, scope });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Enter' || busy || !validName || (e.target as HTMLElement).tagName === 'BUTTON') return;
    e.preventDefault();
    add();
  }

  return (
    <div className="skill-confirm" onKeyDown={onKeyDown}>
      <button className="btn btn-ghost skill-back" onClick={onBack}>
        <ArrowLeft size={14} /> Back
      </button>
      <h4>{choice.title}</h4>
      {!choice.pasted && <p className="skill-desc">{choice.summary}</p>}
      <code className="conn-target">{describeServer(choice.server)}</code>
      {choice.pasted && (
        <>
          <label htmlFor="conn-name">Name</label>
          <input id="conn-name" className="conn-name" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
        </>
      )}
      <p className="skill-hint">
        {choice.server.type === 'stdio'
          ? 'It runs on this computer. Claude can use its tools for you, so add only servers you trust.'
          : 'Claude can use its tools for you, so add only servers you trust. If the service asks you to sign in, the connector says so once it is added.'}
      </p>
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
        <button className="btn btn-primary" autoFocus onClick={add} disabled={busy || !validName}>
          {busy ? 'Adding…' : `Add ${name.trim() || 'connector'}`}
        </button>
      </div>
    </div>
  );
}
