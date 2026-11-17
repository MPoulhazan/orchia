import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Finding a project's icon: read what the project declares first (its web page, its web
// manifest, its framework's icon file, the logo at the top of its README), then look for
// files named like an icon. Whatever is found, the user can pick another one or none.

export const ICON_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

/** Bigger files are not icons, and are not worth sending on every page load. */
const MAX_BYTES = 1024 * 1024;

/** Folders that hold dependencies, build output or user data, never the project's own icon. */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'vendor', 'tmp', 'temp', 'cache',
  'data', 'uploads', 'storage', 'logs', 'test', 'tests', '__tests__', 'fixtures', 'e2e', 'examples',
  '__pycache__', 'venv', 'env', 'site-packages', 'Pods', 'DerivedData', 'bower_components',
]);

/** Folders that often hold the app itself, even without a package.json of their own. */
const APP_DIRS = ['web', 'frontend', 'client', 'app', 'site', 'www', 'landing', 'website', 'ui'];

/** Icon files at the usual places of web, mobile and desktop stacks, best first. */
const KNOWN_FILES = [
  'icon.svg', 'favicon.svg', 'public/icon.svg', 'public/favicon.svg', 'static/favicon.svg', 'assets/icon.svg',
  'app/icon.svg', 'src/app/icon.svg',
  'public/apple-touch-icon.png', 'apple-touch-icon.png', 'app/apple-icon.png', 'src/app/apple-icon.png',
  'app/icon.png', 'src/app/icon.png', 'public/icon.png', 'icon.png', 'assets/icon.png', 'static/icon.png',
  'public/android-chrome-512x512.png', 'public/android-chrome-192x192.png', 'public/logo192.png',
  'src-tauri/icons/icon.png', 'build/icon.png', 'resources/icon.png', 'web/icons/Icon-512.png', 'web/favicon.png',
  'logo.svg', 'public/logo.svg', 'assets/logo.svg', 'src/assets/logo.svg', 'logo.png', 'public/logo.png', 'assets/logo.png',
  'public/favicon.png', 'favicon.png', 'public/favicon.ico', 'app/favicon.ico', 'src/app/favicon.ico', 'static/favicon.ico', 'favicon.ico',
  '.github/logo.svg', '.github/logo.png', '.github/icon.png', 'docs/logo.svg', 'docs/logo.png',
];

/** One possible icon: a file in the project, or an image written inline in one of its files. */
export interface IconCandidate {
  /** Stable within the project: the file's path from its root, or `inline:<file>`. */
  id: string;
  /** Where it was found, for the picker. */
  label: string;
  mime: string;
  file?: string;
  data?: Buffer;
  /** Changes when the image does, so the browser fetches it again. */
  version: string;
}

function fileCandidate(root: string, file: string, label: string): IconCandidate | null {
  const mime = ICON_MIME[extname(file).toLowerCase()];
  if (!mime) return null;
  const full = resolve(file);
  // Never outside the project, whatever a page or manifest points at.
  const rel = relative(resolve(root), full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  try {
    const st = statSync(full);
    if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) return null;
    return { id: rel.split(sep).join('/'), label, mime, file: full, version: `${Math.round(st.mtimeMs).toString(36)}${st.size.toString(36)}` };
  } catch {
    return null;
  }
}

function readText(file: string, max = 512 * 1024): string | null {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The folder itself, the app folders inside it, and its sub-projects (monorepos, a site next to an API). */
function appRoots(root: string): string[] {
  const roots = [root];
  const add = (dir: string) => {
    if (roots.length < 16 && !roots.includes(dir) && isDir(dir)) roots.push(dir);
  };
  for (const name of APP_DIRS) add(join(root, name));
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return roots;
  }
  for (const name of entries) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const dir = join(root, name);
    if (['package.json', 'pubspec.yaml', 'app.json', 'index.html'].some((f) => statOk(join(dir, f)))) add(dir);
  }
  for (const group of ['apps', 'packages']) {
    try {
      for (const name of readdirSync(join(root, group))) add(join(root, group, name));
    } catch {
      // No such folder.
    }
  }
  return roots;
}

function statOk(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A whole HTML tag, quotes respected: an inline SVG often holds `>` or the other quote. */
const TAG = (name: string) => new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi');

/** An attribute's value, in double, single or no quotes; empty when missing. */
function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
}

/** `<link rel="icon" href="…">` and friends in a web page. */
function htmlIcons(root: string, html: string, htmlFile: string, appRoot: string, out: IconCandidate[]) {
  const rel = relative(root, htmlFile).split(sep).join('/');
  for (const tag of html.match(TAG('link')) ?? []) {
    const relAttr = attr(tag, 'rel').toLowerCase();
    if (!/\b(icon|apple-touch-icon)\b/.test(relAttr) || relAttr.includes('mask-icon')) continue;
    const href = attr(tag, 'href').trim();
    if (!href) continue;
    if (href.startsWith('data:')) {
      const inline = dataUri(href);
      if (inline) out.push({ id: `inline:${rel}`, label: `${rel} (inline)`, ...inline });
      continue;
    }
    if (/^[a-z]+:|^\/\//i.test(href)) continue; // Hosted elsewhere: Orchia never fetches it.
    const path = decodeURIComponent(href.replace(/[?#].*$/, '').replace(/%PUBLIC_URL%|\{\{\s*base_url\s*\}\}|<%=\s*BASE_URL\s*%>/g, ''));
    const tries = path.startsWith('/')
      ? [join(appRoot, 'public', path), join(appRoot, 'static', path), join(appRoot, path), join(dirname(htmlFile), path)]
      : [join(dirname(htmlFile), path), join(appRoot, 'public', path)];
    for (const file of tries) {
      const found = fileCandidate(root, file, rel);
      if (found) {
        out.push(found);
        break;
      }
    }
  }
}

function dataUri(uri: string): Pick<IconCandidate, 'mime' | 'data' | 'version'> | null {
  const m = uri.match(/^data:(image\/(?:svg\+xml|png|x-icon|vnd\.microsoft\.icon|webp|jpeg|gif))(;base64)?,(.*)$/is);
  if (!m) return null;
  try {
    const data = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    if (!data.length || data.length > MAX_BYTES) return null;
    const mime = m[1].toLowerCase() === 'image/vnd.microsoft.icon' ? 'image/x-icon' : m[1].toLowerCase();
    return { mime, data, version: createHash('sha1').update(data).digest('hex').slice(0, 10) };
  } catch {
    return null;
  }
}

/** The largest icon of a web app manifest or a browser extension manifest. */
function manifestIcons(root: string, file: string, out: IconCandidate[]) {
  const text = readText(file, 256 * 1024);
  if (!text) return;
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return;
  }
  const label = relative(root, file).split(sep).join('/');
  const srcs: { src: string; size: number }[] = [];
  if (Array.isArray(json?.icons)) {
    for (const icon of json.icons) {
      if (typeof icon?.src !== 'string' || String(icon.purpose ?? '').includes('maskable')) continue;
      srcs.push({ src: icon.src, size: Math.max(0, ...String(icon.sizes ?? '0').split(/\s+/).map((s) => parseInt(s, 10) || 0)) });
    }
  } else if (json?.icons && typeof json.icons === 'object') {
    for (const [size, src] of Object.entries(json.icons)) if (typeof src === 'string') srcs.push({ src, size: parseInt(size, 10) || 0 });
  }
  srcs.sort((a, b) => b.size - a.size);
  for (const { src } of srcs) {
    if (/^[a-z]+:|^\/\//i.test(src)) continue;
    const path = src.replace(/[?#].*$/, '');
    const dir = dirname(file);
    const found = fileCandidate(root, path.startsWith('/') ? join(dir, path) : join(dir, path), label);
    if (found) return void out.push(found);
  }
}

/** The logo many open-source projects put at the top of their README. */
function readmeLogo(root: string, out: IconCandidate[]) {
  const name = ['README.md', 'readme.md', 'Readme.md', 'README.MD'].find((n) => statOk(join(root, n)));
  const text = name && readText(join(root, name), 256 * 1024);
  if (!text) return;
  const head = text.split('\n').slice(0, 30).join('\n');
  const images = [
    ...[...head.matchAll(TAG('img'))].map((m) => ({ src: attr(m[0], 'src'), alt: attr(m[0], 'alt') })),
    ...[...head.matchAll(/!\[([^\]]*)\]\(([^)\s]+)/g)].map((m) => ({ src: m[2], alt: m[1] })),
  ];
  for (const { src, alt } of images) {
    if (!src || /^[a-z]+:|^\/\//i.test(src)) continue; // Badges and hosted images.
    if (!/logo|icon/i.test(`${alt} ${src}`)) continue;
    const found = fileCandidate(root, join(root, src.replace(/[?#].*$/, '')), name!);
    if (found) return void out.push(found);
  }
}

/** Files named logo, icon or favicon a few folders down, for projects that declare nothing. */
function namedFiles(root: string, out: IconCandidate[]) {
  const found: { file: string; depth: number; score: number }[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > 4000) return;
      if (e.isDirectory()) {
        if (depth < 3 && !SKIP_DIRS.has(e.name) && (!e.name.startsWith('.') || e.name === '.github')) walk(join(dir, e.name), depth + 1);
        continue;
      }
      const ext = extname(e.name).toLowerCase();
      if (!['.svg', '.png', '.ico', '.webp'].includes(ext)) continue;
      const stem = e.name.slice(0, -ext.length).toLowerCase();
      if (!/^(logo|icon|favicon|app-?icon|apple-touch-icon)(\b|[-_.])/.test(stem)) continue;
      // Square icons and vector files first, shallow before deep.
      const score = (stem.startsWith('logo') ? 1 : 0) + (ext === '.svg' ? 0 : ext === '.png' ? 1 : 2) + depth * 2 + (/(white|dark|light|mono|black|small|16|32)/.test(stem) ? 2 : 0);
      found.push({ file: join(dir, e.name), depth, score });
    }
  };
  walk(root, 0);
  found.sort((a, b) => a.score - b.score);
  for (const { file } of found.slice(0, 8)) {
    const c = fileCandidate(root, file, 'Found in the folder');
    if (c) out.push(c);
  }
}

function look(root: string): IconCandidate[] {
  const out: IconCandidate[] = [];
  const roots = appRoots(root);
  for (const appRoot of roots) {
    // 1. What the project's web page declares.
    for (const page of ['index.html', 'public/index.html', 'src/index.html', 'src/app.html', 'app/index.html']) {
      const html = readText(join(appRoot, page));
      if (html) htmlIcons(root, html, join(appRoot, page), appRoot, out);
    }
    // 2. Its web app or extension manifest.
    for (const m of ['public/manifest.json', 'public/site.webmanifest', 'public/manifest.webmanifest', 'static/manifest.json', 'site.webmanifest', 'manifest.webmanifest', 'manifest.json', 'web/manifest.json']) {
      if (statOk(join(appRoot, m))) manifestIcons(root, join(appRoot, m), out);
    }
    // 3. Icons named in package.json (VS Code and Electron apps) or app.json (Expo).
    const pkg = readText(join(appRoot, 'package.json'), 256 * 1024);
    const app = readText(join(appRoot, 'app.json'), 256 * 1024);
    for (const [text, pick] of [
      [pkg, (j: any) => [j?.icon, j?.build?.icon]],
      [app, (j: any) => [j?.expo?.icon, j?.icon]],
    ] as const) {
      if (!text) continue;
      try {
        for (const p of pick(JSON.parse(text))) {
          const c = typeof p === 'string' && fileCandidate(root, join(appRoot, p), relative(root, join(appRoot, pkg === text ? 'package.json' : 'app.json')).split(sep).join('/'));
          if (c) out.push(c);
        }
      } catch {
        // Not valid JSON: nothing declared.
      }
    }
  }
  // 4. The usual places of each stack.
  for (const appRoot of roots) {
    for (const name of KNOWN_FILES) {
      const c = fileCandidate(root, join(appRoot, name), 'Usual place');
      if (c) out.push(c);
    }
  }
  // 5. The README's logo, then any file named like an icon.
  readmeLogo(root, out);
  namedFiles(root, out);

  const unique: IconCandidate[] = [];
  for (const c of out) if (!unique.some((u) => u.id === c.id)) unique.push(c);
  return unique.slice(0, 12);
}

const cache = new Map<string, { at: number; list: IconCandidate[] }>();
const TTL = 5 * 60_000;

const pending = new Set<string>();
let onChange: () => void = () => {};

/** Called when a look in the background finds different icons, to send the new state. */
export function onIconsChange(listener: () => void) {
  onChange = listener;
}

function find(root: string): IconCandidate[] {
  try {
    return look(root);
  } catch (err) {
    console.warn(`Could not look for an icon in ${root}: ${(err as Error).message}`);
    return [];
  }
}

const fingerprint = (list: IconCandidate[]) => list.map((c) => `${c.id}@${c.version}`).join();

/**
 * What was found last for the project, best first. A look takes up to a few hundred
 * milliseconds in a big folder, so it never runs while building the state: it runs on
 * its own turn, one project at a time, and the state is sent again if it changed.
 */
export function iconCandidates(root: string): IconCandidate[] {
  const hit = cache.get(root);
  if ((!hit || Date.now() - hit.at >= TTL) && !pending.has(root)) {
    pending.add(root);
    setImmediate(() => {
      pending.delete(root);
      const list = find(root);
      const before = cache.get(root);
      cache.set(root, { at: Date.now(), list });
      if (fingerprint(list) !== fingerprint(before?.list ?? [])) onChange();
    });
  }
  return hit?.list ?? [];
}

/** Looks now, for the picker, which shows what is in the folder at this moment. */
export function iconCandidatesNow(root: string): IconCandidate[] {
  const list = find(root);
  const before = cache.get(root);
  cache.set(root, { at: Date.now(), list });
  if (fingerprint(list) !== fingerprint(before?.list ?? [])) onChange();
  return list;
}

/**
 * The icon to show: the one the user picked, none if they chose the initial,
 * else the best one found.
 */
export function projectIcon(root: string, choice?: string): IconCandidate | null {
  if (choice === 'none') return null;
  const list = iconCandidates(root);
  return (choice && list.find((c) => c.id === choice)) || list[0] || null;
}
