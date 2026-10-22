/**
 * "Done summary": one line about what a finished turn did, taken from the
 * last_assistant_message of the Stop hook. No model call: Claude's final reply
 * usually opens with the gist, so this keeps its first meaningful sentences.
 */

export interface TurnSummary {
  text: string;
  /** Files Claude edited or wrote during the turn. */
  files: number;
  at: number;
}

const MAX = 180;

/** Markdown-free text of the first paragraph that says something, cut at a sentence. */
export function summarize(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const paragraphs = message
    .replace(/```[\s\S]*?(```|$)/g, '\n\n')
    .split(/\n\s*\n/)
    .map(plain)
    .filter(Boolean);
  // "Here's what I changed:" announces a list; the list says more.
  const useful = paragraphs.find((p) => !(p.endsWith(':') && p.length < 100)) ?? paragraphs[0];
  return useful ? shorten(useful.replace(/:$/, '')) : null;
}

const HEADING = /^\s{0,3}(#{1,6}\s+.*|\*\*[^*]+\*\*:?|__[^_]+__:?)\s*$/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;

/**
 * One paragraph as plain text: no list markers, emphasis, code ticks or link
 * targets; list items joined with "; ". Empty for a lone heading like "## Summary".
 */
function plain(paragraph: string): string {
  const lines = paragraph.split('\n').filter((l) => l.trim());
  if (lines.length === 1 && HEADING.test(lines[0])) return '';
  let out = '';
  for (const line of lines) {
    const text = line
      .replace(/^\s{0,3}(#{1,6}\s+|>\s?)/, '')
      .replace(LIST_ITEM, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|\*|_|`)(\S(?:.*?\S)?)\1/g, '$2')
      .trim();
    if (!text) continue;
    out += !out ? text : LIST_ITEM.test(line) ? `${/[.!?:;]$/.test(out) ? '' : ';'} ${text}` : ` ${text}`;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Whole sentences up to MAX characters, or a cut at a word with an ellipsis. */
function shorten(text: string): string {
  if (text.length <= MAX) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let out = '';
  for (const s of sentences) {
    if ((out + s).trim().length > MAX) break;
    out += s;
  }
  if (out.trim()) return out.trim();
  const cut = text.slice(0, MAX - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), MAX / 2)).replace(/[\s,;:]+$/, '') + '…';
}

/** A fenced code block from Claude's last reply, for Copy (and Run when it is one shell command). */
export interface CodeBlock {
  lang: string;
  code: string;
  /** The command Run types, for a shell block holding exactly one; null otherwise. */
  command: string | null;
}

const MAX_BLOCKS = 8;
const MAX_BLOCK_CHARS = 10_000;
const MAX_COMMAND_CHARS = 500;
const SHELLS = new Set(['sh', 'bash', 'shell', 'zsh', 'console', 'terminal', 'powershell', 'ps1', 'pwsh', 'cmd', 'bat']);
const FENCE = /^ {0,3}(`{3,}|~{3,})([^\n`]*)\n([\s\S]*?)\n {0,3}\1[ \t]*$/gm;

/** The fenced blocks of a reply, in order. An unclosed last fence is left out. */
export function codeBlocks(message: unknown): CodeBlock[] {
  if (typeof message !== 'string') return [];
  const blocks: CodeBlock[] = [];
  for (const [, , info, body] of message.replace(/\r\n/g, '\n').matchAll(FENCE)) {
    const code = body.replace(/\s+$/, '');
    if (!code.trim() || code.length > MAX_BLOCK_CHARS) continue;
    const lang = info.trim().split(/\s+/)[0].toLowerCase();
    blocks.push({ lang, code, command: SHELLS.has(lang) ? singleCommand(code, lang) : null });
    if (blocks.length === MAX_BLOCKS) break;
  }
  return blocks;
}

/** The one command a shell block runs, without prompts and comments; null for several. */
function singleCommand(code: string, lang: string): string | null {
  // Line continuations: `\` in sh, a backtick in PowerShell.
  let lines = code.replace(/[ \t]*(\\|`)\n[ \t]*/g, ' ').split('\n');
  // A console transcript: commands start with a prompt, the rest is output.
  if (lang === 'console' || lang === 'terminal' || lines.some((l) => /^\s*\$ /.test(l))) {
    lines = lines.filter((l) => /^\s*[$>] /.test(l));
  }
  const commands = lines.map((l) => l.replace(/^\s*[$>] /, '').trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('REM '));
  return commands.length === 1 && commands[0].length <= MAX_COMMAND_CHARS ? commands[0] : null;
}
