import { useEffect, useState } from 'react';
import { api, type TokenDiet } from './api';
import { CONNECTOR_CHANGED } from './Connectors';
import { InspectorSection } from './ui';

type Unused = NonNullable<TokenDiet['findings'][number]['connectors']>;

/** Where this project's tokens go, worked out on this computer from its recent sessions. */
export function TokenDietSection({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const [diet, setDiet] = useState<TokenDiet | null>(null);

  useEffect(() => {
    let current = true;
    setDiet(null);
    api
      .tokenDiet(projectId)
      .then((result) => current && setDiet(result))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [projectId]);

  if (!diet) return null;
  const count = diet.findings.length;
  return (
    <InspectorSection
      id="token-diet"
      title="Token diet"
      hint="Fixed rules over this project's last 30 days of sessions. Worked out on this computer, nothing is sent."
      summary={count ? String(count) : null}
    >
      {count === 0 ? (
        <p className="insp-empty">{diet.sessions ? `Nothing to trim in the last ${diet.sessions} sessions` : 'No sessions to look at yet'}</p>
      ) : (
        <ul className="diet-list">
          {diet.findings.map((f) => (
            <li key={f.id}>
              <strong>{f.title}</strong>
              <p>{f.detail}</p>
              <p className="diet-action">{f.action}</p>
              {f.connectors && <TurnOffConnectors key={projectId} sessionId={sessionId} connectors={f.connectors} />}
            </li>
          ))}
        </ul>
      )}
    </InspectorSection>
  );
}

const weight = (tokens: number) => (tokens >= 1000 ? `~${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k tokens` : `~${tokens} tokens`);

/** The unused connectors, all ticked, turned off for this project in one click, with an undo. */
function TurnOffConnectors({ sessionId, connectors }: { sessionId: string; connectors: Unused }) {
  const [picked, setPicked] = useState(() => new Set(connectors.map((c) => c.name)));
  const [turnedOff, setTurnedOff] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function change(names: string[], on: boolean) {
    setBusy(true);
    setError('');
    try {
      await api.changeConnectors(sessionId, { action: 'toggle-many', names, on });
      setTurnedOff(on ? null : names);
      // The Connectors section shows the change and offers the restart.
      window.dispatchEvent(new CustomEvent(CONNECTOR_CHANGED, { detail: sessionId }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (turnedOff) {
    const saved = connectors.filter((c) => turnedOff.includes(c.name)).reduce((sum, c) => sum + (c.tokens ?? 0), 0);
    return (
      <div className="diet-done">
        <span>
          {turnedOff.length} turned off for this project{saved ? `, ${weight(saved)} less per session` : ''}.
        </span>
        <button className="btn btn-ghost" disabled={busy} onClick={() => change(turnedOff, true)}>
          Undo
        </button>
        {error && <p className="skill-error">{error}</p>}
      </div>
    );
  }

  const toggle = (name: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  const names = connectors.filter((c) => picked.has(c.name)).map((c) => c.name);
  return (
    <div className="diet-connectors">
      <ul>
        {connectors.map((c) => (
          <li key={c.name}>
            <label>
              <input type="checkbox" checked={picked.has(c.name)} onChange={() => toggle(c.name)} />
              <span className="diet-conn-name">{c.label}</span>
              {c.tokens !== null && (
                <span className="diet-conn-weight" title={`${c.tools} tools: their names and the connector's instructions are sent with every session`}>
                  {c.tools} tools · {weight(c.tokens)}
                </span>
              )}
            </label>
          </li>
        ))}
      </ul>
      <button className="btn btn-secondary" disabled={busy || !names.length} onClick={() => change(names, false)}>
        Turn off {names.length} for this project
      </button>
      {error && <p className="skill-error">{error}</p>}
    </div>
  );
}
