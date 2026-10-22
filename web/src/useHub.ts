import { useEffect, useState } from 'react';
import { api, type Project, type RateLimits, type SessionInfo, type SecurityNeeded, type Settings, type SignInNeeded, type CloudStatus } from './api';

export interface HubState {
  projects: Project[];
  sessions: SessionInfo[];
  limits: RateLimits | null;
  settings: Settings;
  cloud: CloudStatus;
  signInNeeded: SignInNeeded[];
  securityNeeded: SecurityNeeded[];
}

const NO_SETTINGS: Settings = { model: null, effort: null, permissionMode: null, compactBetweenTasks: true, restartAfterConnectorChange: true };

const NO_CLOUD: CloudStatus = { state: 'off', url: '', note: null };

/** Live projects + sessions pushed by the server; reconnects if the server restarts. */
export function useHub() {
  const [state, setState] = useState<HubState | null>(null);
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(api.eventsUrl());
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.t === 'state') setState({ projects: msg.projects, sessions: msg.sessions, limits: msg.limits ?? null, settings: msg.settings ?? NO_SETTINGS, cloud: msg.cloud ?? NO_CLOUD, signInNeeded: msg.signInNeeded ?? [], securityNeeded: msg.securityNeeded ?? [] });
      };
      ws.onclose = () => {
        if (closed) return;
        setConnected(false);
        retry = setTimeout(connect, 1500);
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      ws.close();
    };
  }, []);

  return { state, connected };
}
