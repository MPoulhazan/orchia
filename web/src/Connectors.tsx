import { useEffect, useState } from 'react';
import { api, type Connector, type ConnectorSource, type SessionInfo } from './api';
import { InspectorSection } from './ui';

/**
 * Connectors (MCP servers) in the inspector. Like skills, they are per project:
 * turning one off only affects this project. Claude Code connects to them when a
 * session starts, so a change needs a restart to reach the running session.
 */

const SOURCE_LABEL: Record<ConnectorSource, string> = {
  account: 'Claude account',
  user: 'All projects',
  local: 'This project',
  project: 'Shared in repo',
  plugin: 'Plugin',
};

const USED_MS = 10 * 60_000;

export function ConnectorsSection({ session }: { session: SessionInfo }) {
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
  }, [session.id, session.activity]);
  useEffect(() => setChanged(false), [session.id]);
  // A connector just turned on is checked in the background; ask again until the check is done.
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
