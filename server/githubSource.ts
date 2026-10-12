/**
 * Reads a GitHub repository out of what people paste: a repository or folder URL,
 * `owner/repo`, or the `npx skills add …` line a README shows.
 *
 * No Node imports: the web app uses it too, to offer the import while typing.
 */

export interface GitHubSource {
  owner: string;
  repo: string;
  /** Branch, tag or commit; the default branch when missing. */
  ref?: string;
  /** A folder inside the repository the skills are under. */
  path?: string;
  /** Skills named with `--skill`, to pick first. */
  skills: string[];
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[\w.-]{1,100}$/;
const SAFE = /^[\w.\-/]+$/;

export function parseGitHubSource(text: string): GitHubSource | null {
  let input = text.trim();
  const skills: string[] = [];

  const command = input.match(/^(?:npx\s+(?:-y\s+|--yes\s+)?)?skills\s+(?:add|install|i)\s+(.+)$/i);
  if (command) {
    const words = command[1].match(/"[^"]*"|'[^']*'|\S+/g)?.map((w) => w.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
    let source = '';
    for (let i = 0; i < words.length; i++) {
      if (words[i] === '--skill' || words[i] === '-s') {
        // `--skill a b` and `--skill a --skill b` both work.
        while (words[i + 1] && !words[i + 1].startsWith('-')) skills.push(words[++i]);
      } else if (!words[i].startsWith('-') && !source) {
        source = words[i];
      }
    }
    input = source;
  }

  input = input
    .replace(/^git@github\.com:/i, 'github.com/')
    .replace(/^(?:https?:\/\/)?(?:www\.)?/i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');

  let parts: string[];
  if (/^github\.com\//i.test(input)) parts = input.slice('github.com/'.length).split('/');
  else if (/^[^/\s]+\/[^/\s]+$/.test(input)) parts = input.split('/');
  else return null;

  const owner = parts[0];
  const repo = (parts[1] ?? '').replace(/\.git$/, '');
  if (!OWNER.test(owner) || !REPO.test(repo) || /^\.+$/.test(repo)) return null;

  const source: GitHubSource = { owner, repo, skills };
  if ((parts[2] === 'tree' || parts[2] === 'blob') && parts[3]) {
    source.ref = parts[3];
    let path = parts.slice(4).join('/');
    if (parts[2] === 'blob') path = path.replace(/\/?[^/]+$/, ''); // A file: its folder.
    if (path) source.path = path;
  }
  if ([source.ref, source.path].some((v) => v !== undefined && (!SAFE.test(v) || v.split('/').includes('..')))) return null;
  return source;
}
