import { useEffect, useState } from 'react';
import { api, type TokenDiet } from './api';
import { InspectorSection } from './ui';

/** Where this project's tokens go, worked out on this computer from its recent sessions. */
export function TokenDietSection({ projectId }: { projectId: string }) {
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
            </li>
          ))}
        </ul>
      )}
    </InspectorSection>
  );
}
