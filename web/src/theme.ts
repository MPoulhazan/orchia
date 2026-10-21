import { useEffect, useState } from 'react';
import type { ITheme } from '@xterm/xterm';
import { storage } from './storage';

export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const KEY = 'orchia.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(() => (storage.get(KEY) as ThemePref) ?? 'system');
  const [systemDark, setSystemDark] = useState(media.matches);

  useEffect(() => {
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const resolved: ResolvedTheme = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const update = (next: ThemePref) => {
    setPref(next);
    storage.set(KEY, next);
  };

  return { pref, resolved, setPref: update };
}

// Terminal palettes match the panel background of each UI theme. Yellow stays dark
// enough on white to read; blue matches the focus color used for Claude's selections.
export const terminalThemes: Record<ResolvedTheme, ITheme> = {
  dark: {
    background: '#161a1e',
    foreground: '#dce1e6',
    cursor: '#dce1e6',
    cursorAccent: '#161a1e',
    selectionBackground: '#2b3a66',
    black: '#1c2127',
    red: '#f07b72',
    green: '#4fc58e',
    yellow: '#e9cd33',
    blue: '#8da2ff',
    magenta: '#c9a2f0',
    cyan: '#6fcbd1',
    white: '#c3cad2',
    brightBlack: '#66707b',
    brightRed: '#f6a199',
    brightGreen: '#7fd7ad',
    brightYellow: '#f2dd6b',
    brightBlue: '#b1c0ff',
    brightMagenta: '#dcc0f6',
    brightCyan: '#97dde1',
    brightWhite: '#f1f3f5',
  },
  light: {
    background: '#ffffff',
    foreground: '#1a1e23',
    cursor: '#1a1e23',
    cursorAccent: '#ffffff',
    selectionBackground: '#cdd8f6',
    black: '#1a1e23',
    red: '#a92f28',
    green: '#106a45',
    yellow: '#8a6a00',
    blue: '#2446c7',
    magenta: '#7d3fb0',
    cyan: '#16707a',
    white: '#7e8792',
    brightBlack: '#5d6670',
    brightRed: '#c2362f',
    brightGreen: '#18865a',
    brightYellow: '#a07d00',
    brightBlue: '#3a5ad8',
    brightMagenta: '#9152c4',
    brightCyan: '#1d8791',
    brightWhite: '#535c66',
  },
};
