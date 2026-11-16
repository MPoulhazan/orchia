import { statSync } from 'node:fs';
import { extname, join } from 'node:path';

/** Folders where a project usually keeps its icon, tried in this order for each name. */
const DIRS = ['', 'public', 'static', 'assets', 'app', 'src/app', 'src/assets', 'src/public', 'web/public', 'frontend/public', 'client/public', 'apps/web/public', 'landing', '.github'];

/** Square icons first, then logos, then the low-resolution favicon.ico. */
const NAMES = [
  'icon.svg',
  'favicon.svg',
  'apple-touch-icon.png',
  'apple-icon.png',
  'icon.png',
  'android-chrome-512x512.png',
  'android-chrome-192x192.png',
  'logo192.png',
  'logo.svg',
  'logo.png',
  'favicon.png',
  'favicon.ico',
];

export const ICON_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Bigger files are not icons, and are not worth sending on every page load. */
const MAX_BYTES = 1024 * 1024;

export interface FoundIcon {
  file: string;
  /** Changes when the file does, so the browser fetches it again. */
  version: string;
}

const cache = new Map<string, { at: number; icon: FoundIcon | null }>();
const TTL = 60_000;

function look(root: string): FoundIcon | null {
  for (const name of NAMES) {
    for (const dir of DIRS) {
      const file = join(root, dir, name);
      try {
        const st = statSync(file);
        if (st.isFile() && st.size > 0 && st.size <= MAX_BYTES) {
          return { file, version: `${Math.round(st.mtimeMs).toString(36)}${st.size.toString(36)}` };
        }
      } catch {
        // Not there: try the next place.
      }
    }
  }
  return null;
}

/** The project's own icon or logo, if it has one; checked again at most once a minute. */
export function projectIcon(root: string): FoundIcon | null {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < TTL) return hit.icon;
  const icon = look(root);
  cache.set(root, { at: Date.now(), icon });
  return icon;
}

export function iconMime(file: string): string {
  return ICON_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}
