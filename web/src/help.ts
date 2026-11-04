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
}

export const PERMISSION_HELP = {
  default: {
    label: 'Default',
    text: 'Uses the permission mode from your Claude Code settings.',
  },
  manual: {
    label: 'Ask',
    text: 'Asks before every file edit and command.',
    when: 'When you want to see each change before it happens.',
  },
  acceptEdits: {
    label: 'Accept edits',
    text: 'Edits files without asking. Still asks before running commands.',
    when: 'When you trust the task and review the diff at the end.',
  },
  plan: {
    label: 'Plan first',
    text: 'Reads and plans only. Changes nothing until you approve the plan.',
    when: 'For a bigger change, or to see the approach before any edit.',
  },
  auto: {
    label: 'Auto',
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
