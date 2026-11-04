/**
 * What Orchia's less obvious words mean, written once. Settings, the session header and
 * the help popovers all read from here, so an explanation never drifts between two places.
 */

export interface HelpEntry {
  label: string;
  /** One sentence: what it does. */
  text: string;
  /** When to reach for it. */
  when?: string;
  /** A path or name specific to where it shows, in monospace. */
  detail?: string;
  /** Other words people search for it with (Ctrl K). */
  keywords?: string;
}

export const PERMISSION_HELP = {
  default: {
    label: 'Default',
    text: 'Uses the permission mode from your Claude Code settings.',
  },
  manual: {
    label: 'Ask',
    keywords: 'ask manual default confirm approve every',
    text: 'Asks before every file edit and command.',
    when: 'When you want to see each change before it happens.',
  },
  acceptEdits: {
    label: 'Accept edits',
    keywords: 'accept edits write files',
    text: 'Edits files without asking. Still asks before running commands.',
    when: 'When you trust the task and review the diff at the end.',
  },
  plan: {
    label: 'Plan first',
    keywords: 'plan mode read only review',
    text: 'Reads and plans only. Changes nothing until you approve the plan.',
    when: 'For a bigger change, or to see the approach before any edit.',
  },
  auto: {
    label: 'Auto',
    keywords: 'auto mode autonomous safe',
    text: 'Claude runs what it judges safe and asks only for risky actions.',
    when: 'For longer tasks you want to leave running.',
  },
  // Reported by Claude Code but not offered in Orchia.
  bypassPermissions: {
    label: 'Bypass',
    text: 'Runs everything without asking, risky actions included.',
  },
  dontAsk: {
    label: "Don't ask",
    text: 'Denies anything not already allowed, without asking.',
  },
} satisfies Record<string, HelpEntry>;

export type PermissionHelpKey = keyof typeof PERMISSION_HELP;

/** Label and help for a mode as Claude Code names it; unknown modes keep their raw name. */
export function permissionHelp(mode: string | null): HelpEntry {
  if (!mode) return PERMISSION_HELP.default;
  return (PERMISSION_HELP as Record<string, HelpEntry>)[mode] ?? { label: mode, text: '' };
}

/** How to switch modes without Orchia: Claude Code's own shortcut. */
export const MODE_SHORTCUT = 'Shift+Tab in the terminal also cycles through the modes.';

/** The other words a new user meets in a session, each explained where it shows up. */
export const HELP = {
  effort: {
    label: 'Effort',
    keywords: 'effort thinking reasoning think harder speed',
    text: 'How hard Claude thinks before answering. Higher is slower and uses more of your plan.',
    when: 'Raise it for a tricky bug or a design question. Lower it for quick edits.',
  },
  ownCopy: {
    label: 'Own copy',
    keywords: 'own copy worktree branch isolate parallel same folder',
    text: 'This session works in its own copy of the repository, on its own branch. Your project folder stays untouched until you merge.',
    when: 'To run several sessions on one project without them overwriting each other.',
  },
  changes: {
    label: 'Changes',
    keywords: 'changes diff merge review copy',
    text: 'What this copy changed compared to your project, file by file. Merge brings those changes into your project folder.',
  },
  lots: {
    label: 'Lots',
    keywords: 'lots plan steps split sequence /lots',
    text: 'A plan cut into steps that Claude runs one at a time. Each lot starts once the previous one reports done, and a blocked lot holds the rest.',
    when: 'For a change too big for one go, so you can check each step.',
  },
  upNext: {
    label: 'Up next',
    keywords: 'up next queue later prompts waiting',
    text: 'Prompts waiting their turn. Orchia sends the next one as soon as Claude finishes the current task.',
    when: 'Type your next request while Claude is still working.',
  },
} satisfies Record<string, HelpEntry>;

/** Ctrl K: every word typed starts a word of the entry's name or keywords. */
export function matchesHelp(query: string, entry: HelpEntry): boolean {
  const words = `${entry.label} ${entry.keywords ?? ''}`.toLowerCase().split(/[\s/]+/).filter(Boolean);
  const typed = query.toLowerCase().split(/\s+/).filter(Boolean);
  return typed.length > 0 && typed.every((t) => words.some((w) => w.startsWith(t)));
}
