# Roadmap

Ideas agreed on but not built yet.

## Delegate longer, in parallel

Mockups: https://claude.ai/artifact/YZyd6hf5zo5KLTZWkWEKHy (agreed 2026-10-14). In this order:

1. ~~**Always allow**~~ built: a menu on Allow (inbox and grid) saves the rules Claude Code
   suggests in the PermissionRequest hook (`permission_suggestions`, answered with
   `updatedPermissions`, destination `localSettings`). The inspector lists the project's
   rules, each removable. Shown only when Claude Code suggests an allow rule.
2. **Done summary**: one line from Claude's last reply under a finished session, reused by the
   inbox card, the desktop notification and the palette.
3. **Up next**: a queue of prompts under the terminal, sent one at a time on Stop, never while
   the user types or while Claude waits for an answer. Shown as "+2" on the tab.
4. **Own copy, then review and merge**: when another session is already changing files in the
   folder, "+ New session" offers its own copy (a git worktree on an `agenthub/…` branch).
   A **Changes** tab next to the terminal shows the diff, then Merge into main / Keep working /
   Discard; on conflict, "Ask Claude to resolve". The copy sets itself up: copies `.env*`,
   installs dependencies, warns when a dev server port is taken.

Settings rule: a switch only for what AgentHub does **on its own**. Features 1–3 and the review
start from a click, so they are always on, with no setting. The only new setting is per project,
for the own copy: *Ask when another session is busy* (default), *Always in its own copy*,
*Always in the same folder*, also reachable as "Remember for this project" in the New session
dialog. It replaces the Git workflow lot below (Branch per task and Main only are no longer
needed). Things that act alone get a switch: Compact between tasks (on), Restart by itself after
a connector change (on), Auto-commit (off).

## MCP connectors, next

The Connectors section in the inspector is built (see, turn off per project, add, sign in,
"Needs you" card, remove). Adding one checks first how it connects (server/mcpProbe.ts): browser
sign-in, none, or an access token (GitHub: taken from the gh CLI or pasted). Mockups:
https://claude.ai/artifact/SFWthcC34G5Uigy3ZzDr1i. Next (lot 2 of the 2026-10-14 plan):

- **Account first**: when the claude.ai account already has the service (Supabase, Vercel…),
  say so in the catalog instead of offering a second one.
- **Restart by itself** once the session is idle after a connector change (conversation kept).

Only if needed:

- **Share with the repo** (`.mcp.json`), left out on purpose for now.
- A **Connectors tab in Settings** for an overview of accounts and projects (proposal 3),
  or one **Tools** section for skills and connectors together (proposal 2).

## Skills library (sidebar)

Comes after the Skills section in the session inspector, and reuses its skill picker.
Mockups: https://claude.ai/artifact/33SN8zsCpe6svQYQJ3iMKd (proposal 2).

- A **Skills** entry under the projects in the sidebar opens a library page.
- Every skill on the machine as a card: name, one-line description, the projects that use it
  (or "All projects", or "Not used").
- Filters: All, In use, Plugins.
- "Use in…" on a card: a checklist of projects plus "All my projects". No folder paths.
- Create, rename and delete skills from here. "+ Describe a new skill" opens a session
  that writes the SKILL.md in the right folder.
- A **Discover** tab with the whole suggestion catalog (`server/skillCatalog.ts`) by category;
  sorting by popularity makes sense there, since the user is browsing.
- Worth it once there are enough skills to need an overview of what is used where.

## Settings, next lots

The Settings dialog has defaults for new sessions (model, effort, permission mode),
notifications and theme. Next, in this order:

- **Git workflow**: replaced by the own copy setting (see "Delegate longer, in parallel").
  **Auto-commit** (commit after each finished task) stays, off by default.
- **Compact between tasks**: when a turn ends (Stop hook) and the context is over ~60%
  (status line), type `/compact` while the session is idle, instead of Claude Code's
  own auto-compact firing mid-task. Never while the user is typing in that terminal.
- **Suggest a fresh start** (only if the need shows up): when a prompt looks unrelated
  to the session, offer to send it to a new session. Never clears on its own.
