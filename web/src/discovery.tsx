import { useEffect, useSyncExternalStore } from 'react';
import { storage } from './storage';

/**
 * Which features this browser has already opened once. One unseen feature on screen at a
 * time carries a small dot until it is opened, then the next one does: a new user is led
 * from one to the next, and someone used to Orchia stops seeing dots after a few clicks.
 */
const KEY = 'orchia.discovered';

/** Which dot goes first when several unseen features are on screen. */
const ORDER = ['mode', 'upNext', 'lots', 'ownCopy', 'changes'];

// Without storage the dots would come back on every load: show none instead.
const available = (() => {
  storage.set(`${KEY}.probe`, '1');
  const ok = storage.get(`${KEY}.probe`) === '1';
  storage.set(`${KEY}.probe`, null);
  return ok;
})();

let seen: Set<string> = (() => {
  try {
    return new Set<string>(JSON.parse(storage.get(KEY) ?? '[]'));
  } catch {
    return new Set<string>();
  }
})();
const mounted = new Map<string, number>();
let leader: string | null = null;

const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn));

function update() {
  const next = available ? (ORDER.find((id) => mounted.get(id) && !seen.has(id)) ?? null) : null;
  if (next === leader) return;
  leader = next;
  listeners.forEach((fn) => fn());
}

export function markDiscovered(id: string) {
  if (seen.has(id)) return;
  seen = new Set(seen).add(id);
  storage.set(KEY, JSON.stringify([...seen]));
  update();
}

/** True while this feature is the one on screen that carries the dot. */
export function useUndiscovered(id: string | undefined): boolean {
  useEffect(() => {
    if (!id) return;
    mounted.set(id, (mounted.get(id) ?? 0) + 1);
    update();
    return () => {
      mounted.set(id, (mounted.get(id) ?? 1) - 1);
      update();
    };
  }, [id]);
  return useSyncExternalStore(subscribe, () => leader) === id && !!id;
}

export function DiscoveryDot() {
  return <span className="discover-dot" aria-label="New" />;
}
