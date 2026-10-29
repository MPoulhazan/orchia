import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, platform } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

// Optional link to an Orchia Cloud account. Off until the user turns it on in Settings; pairing
// works like `gh auth login`: Orchia shows a code, the user approves it in the browser.
// The connection is outbound only: the cloud never reaches into this machine.
// Always sent: this computer's name, Orchia's version and the OS. With "Needs you on your phone"
// turned on, also what needs you (RemoteNeed below); with "Security alerts in Orchia Cloud", the
// open security issues (RemoteFinding). Never prompts, code, terminal output or a secret's value.
// The cloud can only answer a permission request that is already waiting: never start one, never type.

const CLOUD_URL = (process.env.ORCHIA_CLOUD_URL ?? 'https://app.orchia.app').replace(/\/$/, '');
/** Close code the cloud sends when this device was unpaired there. */
const CLOSE_REVOKED = 4401;
/** Another Orchia with this same pairing connected after us: retrying would kick it off in turn. */
const CLOSE_REPLACED = 4409;
const RECONNECT_MAX_MS = 60_000;

const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

export type CloudStatus =
  | { state: 'off'; url: string; note: string | null }
  | { state: 'pairing'; url: string; userCode: string; verifyUrl: string; expiresAt: number }
  | { state: 'connecting' | 'connected'; url: string; name: string };

interface Saved {
  url: string;
  token: string;
  name: string;
}

/** One session that needs you, as the phone shows it. Settings lists these fields as what is sent. */
export interface RemoteNeed {
  sessionId: string;
  session: string;
  project: string;
  /** `permission` can be answered from the phone; `waiting` (a question, a plan) and `done` cannot. */
  kind: 'permission' | 'waiting' | 'done';
  detail: string | null;
  permission: { id: string; tool: string; verb: string; target: string } | null;
  /** The end-of-turn summary, for `done`. */
  summary: string | null;
}

/**
 * One open security issue, as Orchia Cloud's Security page shows it. Settings lists these fields
 * as what is sent. A secret is only named by its kind and first and last characters (`ghp_…a41f`).
 */
export interface RemoteFinding {
  /** Stable while the issue lasts, so the cloud can tell when it was resolved. */
  id: string;
  category: 'cve' | 'secret' | 'config';
  severity: 'low' | 'moderate' | 'high' | 'critical';
  title: string;
  detail: string;
  /** Null when it concerns every project (the user's settings, a shared connector). */
  project: string | null;
  session: string | null;
  /** Where to fix it: the advisory's review, the page to revoke a token. */
  fixUrl: string | null;
  since: number;
}

export interface CloudHooks {
  onChange: () => void;
  /** What needs you right now; null while "Needs you on your phone" is off. */
  needs: () => RemoteNeed[] | null;
  /** Open security issues; null while "Security alerts in Orchia Cloud" is off. */
  security: () => RemoteFinding[] | null;
  /** Applies an Allow or Deny from the phone; returns why it was refused, or null once applied. */
  answer: (sessionId: string, permissionId: string, allow: boolean) => string | null;
}

export class CloudLink {
  private readonly file: string;
  private saved: Saved | null = null;
  private status: CloudStatus = { state: 'off', url: CLOUD_URL, note: null };
  private ws: WebSocket | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  /** The needs last sent on the current connection, to send only changes. */
  private sentNeeds: string | null = null;
  private sentSecurity: string | null = null;

  constructor(dir: string, private readonly hooks: CloudHooks) {
    this.file = join(dir, 'cloud.json');
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof raw?.token === 'string' && raw.url === CLOUD_URL) {
        this.saved = { url: raw.url, token: raw.token, name: String(raw.name ?? hostname()) };
        // Once the server is fully set up: connecting reports its status through onChange.
        setImmediate(() => this.connect());
      }
    } catch (err) {
      console.error(`Could not read ${this.file}:`, err);
    }
  }

  get(): CloudStatus {
    return this.status;
  }

  private set(status: CloudStatus) {
    this.status = status;
    this.hooks.onChange();
  }

  /** Sends what needs you when it changed. Called on every state change; cheap when nothing moved. */
  report() {
    const ws = this.ws;
    if (!ws || this.status.state !== 'connected' || ws.readyState !== ws.OPEN) return;
    const items = this.hooks.needs() ?? [];
    const json = JSON.stringify(items);
    if (json !== this.sentNeeds) {
      this.sentNeeds = json;
      ws.send(JSON.stringify({ type: 'needs', items }));
    }
    // null tells the cloud to forget this computer's issues: the switch was turned off.
    const findings = this.hooks.security();
    const security = JSON.stringify(findings);
    if (security !== this.sentSecurity) {
      this.sentSecurity = security;
      ws.send(JSON.stringify({ type: 'security', items: findings }));
    }
  }

  /** Asks the cloud for a code; the user approves it in the browser while Orchia polls. */
  async pair(): Promise<CloudStatus> {
    if (this.saved) {
      // Still paired, just disconnected (taken over by another copy): reconnect, no new code.
      if (this.status.state === 'off') this.connect();
      return this.status;
    }
    this.stopPolling();
    const name = hostname();
    const res = await fetch(`${CLOUD_URL}/api/device-auth/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Orchia Cloud answered ${res.status}. Try again in a minute.`);
    const code = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    };
    const expiresAt = Date.now() + code.expires_in * 1000;
    this.set({ state: 'pairing', url: CLOUD_URL, userCode: code.user_code, verifyUrl: code.verification_uri_complete, expiresAt });

    const poll = async () => {
      if (Date.now() > expiresAt) return this.set({ state: 'off', url: CLOUD_URL, note: 'The code expired before it was approved. Try again.' });
      try {
        const r = await fetch(`${CLOUD_URL}/api/device-auth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ device_code: code.device_code }),
        });
        const body = r.ok ? ((await r.json()) as { status: string; token?: string }) : { status: 'pending' };
        if (this.status.state !== 'pairing') return; // cancelled meanwhile
        if (body.status === 'approved' && body.token) {
          this.pollTimer = null;
          this.save({ url: CLOUD_URL, token: body.token, name });
          this.connect();
          return;
        }
        if (body.status === 'denied') return this.set({ state: 'off', url: CLOUD_URL, note: 'Pairing was denied in the browser.' });
        if (body.status === 'expired') return this.set({ state: 'off', url: CLOUD_URL, note: 'The code expired before it was approved. Try again.' });
      } catch {
        // Offline for a moment: keep polling until the code expires.
      }
      this.pollTimer = setTimeout(poll, code.interval * 1000);
    };
    this.pollTimer = setTimeout(poll, code.interval * 1000);
    return this.status;
  }

  cancelPairing() {
    this.stopPolling();
    if (this.status.state === 'pairing') this.set({ state: 'off', url: CLOUD_URL, note: null });
  }

  /** Unpairs on the cloud too when it can be reached; forgets the token either way. */
  async disconnect() {
    const saved = this.saved;
    this.forget(null);
    if (!saved) return;
    await fetch(`${saved.url}/api/device-auth/device`, { method: 'DELETE', headers: { authorization: `Bearer ${saved.token}` } }).catch(() => {});
  }

  private connect() {
    const saved = this.saved;
    if (!saved) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.set({ state: 'connecting', url: saved.url, name: saved.name });

    const ws = new WebSocket(`${saved.url.replace(/^http/, 'ws')}/device`, { headers: { authorization: `Bearer ${saved.token}` } });
    this.ws = ws;
    ws.on('open', () => {
      this.retries = 0;
      ws.send(JSON.stringify({ type: 'hello', version: VERSION, platform: platform() }));
    });
    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (this.ws !== ws) return;
      if (msg.type === 'ready') {
        this.sentNeeds = null;
        this.sentSecurity = null;
        this.set({ state: 'connected', url: saved.url, name: saved.name });
        this.report();
      }
      if (msg.type === 'answer' && typeof msg.requestId === 'string') {
        const ok = typeof msg.sessionId === 'string' && typeof msg.permissionId === 'string' && typeof msg.allow === 'boolean';
        const error = ok ? this.hooks.answer(msg.sessionId, msg.permissionId, msg.allow) : 'Malformed answer';
        ws.send(JSON.stringify({ type: 'answered', requestId: msg.requestId, error }));
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401) this.forget('This computer was unpaired from Orchia Cloud.');
      ws.terminate();
    });
    ws.on('error', () => {}); // followed by 'close', which retries
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (code === CLOSE_REVOKED) return this.forget('This computer was unpaired from Orchia Cloud.');
      if (!this.saved) return;
      if (code === CLOSE_REPLACED) {
        return this.set({ state: 'off', url: saved.url, note: 'Another Orchia using this pairing took over the connection. Connect again to take it back.' });
      }
      // Back off up to a minute: the cloud may be restarting or the laptop offline.
      const delay = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** this.retries++);
      this.set({ state: 'connecting', url: saved.url, name: saved.name });
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private forget(note: string | null) {
    this.stopPolling();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.saved = null;
    rmSync(this.file, { force: true });
    this.set({ state: 'off', url: CLOUD_URL, note });
  }

  private save(saved: Saved) {
    this.saved = saved;
    const tmp = `${this.file}.tmp`;
    // The token is a credential for this account: readable by this user only.
    writeFileSync(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private stopPolling() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
}
