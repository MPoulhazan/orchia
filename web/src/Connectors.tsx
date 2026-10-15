import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, Link2, Plug, Plus, Power, Sparkles, Trash2 } from 'lucide-react';
import { describeServer, parseMcpSource, type McpServerConfig } from '../../server/mcpSource';
import {
  api,
  type Connector,
  type ConnectorAuth,
  type ConnectorCatalogItem,
  type ConnectorSource,
  type SessionInfo,
  type SkillScope,
  type TokenChoice,
  type TokenHelp,
} from './api';
import { fuzzyScore } from './fuzzy';
import { ConfirmButton, InspectorSection } from './ui';

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

/** A connector of the session (in `detail`) changed outside the inspector. */
const CONNECTOR_CHANGED = 'agenthub:connector-changed';

/** Bumped by the add dialog, so the list refreshes and offers a restart. */
export type ConnectorsChange = number;

export function ConnectorsSection({ session, change, onAdd }: { session: SessionInfo; change: ConnectorsChange; onAdd: () => void }) {
  const [data, setData] = useState<({ id: string } & Awaited<ReturnType<typeof api.connectors>>) | null>(null);
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
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== session.id) return;
      setChanged(true);
      load();
    };
    window.addEventListener(CONNECTOR_CHANGED, onChanged);
    return () => window.removeEventListener(CONNECTOR_CHANGED, onChanged);
  }, [session.id]);
  useEffect(() => {
    if (change) setChanged(true);
  }, [change]);
  // A connector just added or turned on is checked in the background, and a sign-in waits on the
  // browser: ask again until they are done.
  const checking = data?.connectors.some((c) => c.state === 'unknown') || Object.values(data?.signIns ?? {}).some((s) => !s.done);
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

  async function signIn(connector: Connector) {
    setError('');
    try {
      await api.changeConnectors(session.id, { action: 'signin', name: connector.name });
      signingIn.current.add(connector.name);
    } catch (err) {
      setError((err as Error).message);
    }
    load();
  }

  // A sign-in that worked: the running session still has the old state.
  const signingIn = useRef(new Set<string>());
  useEffect(() => {
    for (const name of signingIn.current) {
      const state = data?.signIns[name];
      if (state && !state.done) continue;
      signingIn.current.delete(name);
      if (!state?.error) setChanged(true);
    }
  }, [data]);

  // The connector whose token form is open.
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  useEffect(() => setTokenFor(null), [session.id]);

  async function remove(connector: Connector) {
    setError('');
    try {
      await api.changeConnectors(session.id, { action: 'remove', name: connector.name });
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
              <div key={c.name} className="skill-row conn-row" data-enabled={on} data-state={c.state} title={`${c.label}\n${c.target}\n${c.detail}`}>
                <button
                  className="switch"
                  role="switch"
                  aria-checked={on}
                  aria-label={`${on ? 'Turn off' : 'Turn on'} ${c.label} in this project`}
                  onClick={() => toggle(c)}
                />
                <span className="skill-name">{c.label}</span>
                <span className="skill-meta">
                  {usedNow(c) ? (
                    <span className="skill-used">used just now</span>
                  ) : (
                    <ConnectorState
                      connector={c}
                      signIn={current.signIns[c.name]}
                      onSignIn={() => signIn(c)}
                      onToken={() => setTokenFor(tokenFor === c.name ? null : c.name)}
                    />
                  )}
                </span>
                {(c.source === 'user' || c.source === 'local') && (
                  <ConfirmButton
                    className="icon-btn conn-remove"
                    confirmLabel="Remove"
                    title={`Remove ${c.label}${c.source === 'user' ? ' from all projects' : ''}`}
                    onConfirm={() => remove(c)}
                  >
                    <Trash2 size={13} />
                  </ConfirmButton>
                )}
                {current.signIns[c.name]?.error && c.state !== 'needs-token' && (
                  <p className="skill-error conn-error">{current.signIns[c.name].error}</p>
                )}
                {tokenFor === c.name && c.state === 'needs-token' && (
                  <div className="conn-error">
                    <TokenPanel
                      sessionId={session.id}
                      name={c.name}
                      onDone={() => {
                        setTokenFor(null);
                        setChanged(true);
                        load();
                      }}
                    />
                  </div>
                )}
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

function ConnectorState({
  connector: c,
  signIn,
  onSignIn,
  onToken,
}: {
  connector: Connector;
  signIn?: { url: string | null; done: boolean };
  onSignIn: () => void;
  onToken: () => void;
}) {
  if (signIn && !signIn.done) {
    return signIn.url ? (
      <a className="conn-state is-wait" href={signIn.url} target="_blank" rel="noreferrer" title="If the browser didn't open, open the sign-in page from here">
        Finish in browser <ExternalLink size={11} />
      </a>
    ) : (
      <span className="conn-state is-wait">Opening browser…</span>
    );
  }
  if (c.duplicateOf) {
    return (
      <span className="conn-state" title={`${c.duplicateOf} already connects to ${c.target}: you can remove this one`}>
        Same as {c.duplicateOf}
      </span>
    );
  }
  switch (c.state) {
    case 'needs-auth':
      return (
        <button className="btn btn-secondary conn-signin" onClick={onSignIn} title={`Sign in to ${c.label} in your browser`}>
          Sign in
        </button>
      );
    case 'needs-token':
      return (
        <button className="btn btn-secondary conn-signin" onClick={onToken} title={`${c.label} takes an access token: Claude Code can't sign in to it`}>
          Add token
        </button>
      );
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

const TRUST = 'Claude can use its tools for you, so add only servers you trust.';

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
  // How it connects, asked before adding: so that adding ends with a connector that works.
  const [auth, setAuth] = useState<ConnectorAuth | null>(null);
  const validName = /^[\w.-]{1,64}$/.test(name.trim());

  useEffect(() => {
    api
      .probeConnector(session.id, choice.server)
      .then((r) => setAuth(r.auth))
      // Can't tell: add it the way it was, the connector says what it needs once added.
      .catch(() => setAuth({ kind: 'open' }));
  }, [session.id, choice.server]);

  /** Adds it, then opens the browser on the sign-in page when the service has one. Throws for the token form. */
  async function add(token?: TokenChoice) {
    const trimmed = name.trim();
    await api.changeConnectors(session.id, { action: 'add', name: trimmed, server: choice.server, scope, ...token });
    if (auth?.kind === 'browser') await api.changeConnectors(session.id, { action: 'signin', name: trimmed }).catch(() => {});
    onDone();
  }

  async function addClicked() {
    setBusy(true);
    setError('');
    try {
      await add();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const ready = !!auth && auth.kind !== 'token';
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Enter' || busy || !ready || !validName || (e.target as HTMLElement).tagName !== 'INPUT') return;
    e.preventDefault();
    addClicked();
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
      {!auth ? (
        <p className="skill-hint">Checking how it connects…</p>
      ) : auth.kind === 'local' ? (
        <p className="skill-hint">It runs on this computer. {TRUST}</p>
      ) : auth.kind === 'open' ? (
        <p className="skill-hint">No sign-in needed. {TRUST}</p>
      ) : auth.kind === 'browser' ? (
        <p className="skill-hint">Your browser opens to sign in to {choice.title} once it's added. {TRUST}</p>
      ) : auth.kind === 'unreachable' ? (
        <p className="skill-error">{auth.error} Add it anyway only if you know it works.</p>
      ) : (
        <>
          <p className="skill-hint">
            {auth.help.service ?? 'This service'} takes an access token: Claude Code can't sign in to it by itself. {TRUST}
          </p>
          <TokenForm help={auth.help} verb={`Add ${name.trim() || 'connector'}`} disabled={!validName} onSubmit={add} />
        </>
      )}
      {error && <p className="skill-error">{error}</p>}
      {auth?.kind !== 'token' && (
        <div className="skill-actions">
          <button className="btn btn-primary" autoFocus onClick={addClicked} disabled={busy || !ready || !validName}>
            {busy
              ? 'Adding…'
              : auth?.kind === 'browser'
                ? 'Add and sign in'
                : auth?.kind === 'unreachable'
                  ? 'Add anyway'
                  : `Add ${name.trim() || 'connector'}`}
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Tokens -------------------------------------------------------------------------

/** A token for a connector already added: asks where to get one, then saves it. */
export function TokenPanel({ sessionId, name, onDone }: { sessionId: string; name: string; onDone: () => void }) {
  const [help, setHelp] = useState<TokenHelp | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api
      .connectorTokenHelp(sessionId, name)
      .then((r) => setHelp(r.help))
      .catch((err) => setError(err.message));
  }, [sessionId, name]);
  if (error) return <p className="skill-error">{error}</p>;
  if (!help) return <p className="skill-hint">Looking for a token…</p>;
  return (
    <TokenForm
      help={help}
      verb="Connect"
      onSubmit={async (choice) => {
        await api.changeConnectors(sessionId, { action: 'token', name, ...choice });
        // The inspector too, when it is done from "Needs you": it offers the restart.
        window.dispatchEvent(new CustomEvent(CONNECTOR_CHANGED, { detail: sessionId }));
        onDone();
      }}
    />
  );
}

/**
 * Where a connector gets its access token: in one click from the service's CLI
 * when it is signed in on this computer, else pasted, with a link to create one.
 * The server checks it with the service before saving it.
 */
function TokenForm({
  help,
  verb,
  disabled,
  onSubmit,
}: {
  help: TokenHelp;
  verb: string;
  disabled?: boolean;
  onSubmit: (choice: TokenChoice) => Promise<void>;
}) {
  const [paste, setPaste] = useState(!help.cli);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(choice: TokenChoice) {
    setBusy(true);
    setError('');
    try {
      await onSubmit(choice);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }

  return (
    <div className="conn-token">
      {!paste ? (
        <div className="conn-token-row">
          <button className="btn btn-primary" autoFocus disabled={busy || disabled} onClick={() => submit({ useCli: true })}>
            {busy ? 'Checking…' : `${verb} with ${help.cli}`}
          </button>
          <button className="btn btn-ghost" onClick={() => setPaste(true)}>
            Paste a token instead
          </button>
        </div>
      ) : (
        <>
          <form
            className="conn-token-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (token.trim()) submit({ token: token.trim() });
            }}
          >
            <input
              className="conn-name conn-token-input"
              type="password"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder={`${help.service ?? 'Access'} token`}
              aria-label="Access token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button className="btn btn-primary" disabled={busy || disabled || !token.trim()}>
              {busy ? 'Checking…' : verb}
            </button>
          </form>
          <div className="conn-token-row">
            {help.createUrl && (
              <a className="conn-token-link" href={help.createUrl} target="_blank" rel="noreferrer">
                Create a token on {help.service ?? 'the service'} <ExternalLink size={11} />
              </a>
            )}
            {help.cli && (
              <button className="btn btn-ghost" onClick={() => setPaste(false)}>
                Use my {help.cli} sign-in
              </button>
            )}
          </div>
        </>
      )}
      {error && <p className="skill-error">{error}</p>}
    </div>
  );
}
