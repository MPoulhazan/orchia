import { useSyncExternalStore } from 'react';
import { storage } from './storage';

export type SmoothScrollPref = 'system' | 'on' | 'off';

/** How long a mouse-wheel step takes to scroll a terminal when smooth scrolling is on. */
export const SMOOTH_SCROLL_MS = 120;

const KEY = 'orchia.smoothScroll';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const listeners = new Set<() => void>();

let pref: SmoothScrollPref = (storage.get(KEY) as SmoothScrollPref) ?? 'system';
let snapshot = resolve();

function resolve() {
  const enabled = pref === 'system' ? !reducedMotion.matches : pref === 'on';
  document.documentElement.toggleAttribute('data-smooth-scroll', enabled);
  return { pref, enabled };
}

function changed() {
  snapshot = resolve();
  listeners.forEach((listener) => listener());
}

reducedMotion.addEventListener('change', changed);

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setPref(next: SmoothScrollPref) {
  pref = next;
  storage.set(KEY, next);
  changed();
}

/** Shared by every terminal and the Settings dialog; System follows the computer's reduce-motion setting. */
export function useSmoothScroll() {
  return { ...useSyncExternalStore(subscribe, () => snapshot), setPref };
}
