# Roadmap

Ideas agreed on but not built yet.

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

- **Git workflow**, per project: *Main only*, *Branch per task* (merged into main when
  done) or *Worktree per session* (each session in its own copy of the repo, so parallel
  sessions never touch each other's files). Sent as an instruction at launch that
  overrides git rules in CLAUDE.md; a PreToolUse hook can block commits on main in
  branch mode. Goes with **Auto-commit** (commit after each finished task).
- **Compact between tasks**: when a turn ends (Stop hook) and the context is over ~60%
  (status line), type `/compact` while the session is idle, instead of Claude Code's
  own auto-compact firing mid-task. Never while the user is typing in that terminal.
- **Suggest a fresh start** (only if the need shows up): when a prompt looks unrelated
  to the session, offer to send it to a new session. Never clears on its own.
