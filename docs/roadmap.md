# Roadmap

Ideas agreed on but not built yet.

## MCP connectors (in progress)

A **Connectors** section in the session inspector, under Skills, built like it.
Mockups: https://claude.ai/artifact/SFWthcC34G5Uigy3ZzDr1i (proposal 1, plus the
"Needs you" card from proposal 3).

1. **See them**: every MCP server the session's project can use (user, local, `.mcp.json`
   and claude.ai connectors), with its state (connected, needs sign-in, failed) and
   "used just now" from the `mcp__<server>__<tool>` hook events.
2. **Turn on and off** for this project only (`disabledMcpServers` in the project entry of
   `~/.claude.json`, `disabledMcpjsonServers` for `.mcp.json` servers). Servers load at
   start, so offer "Restart session", which keeps the conversation.
3. **Add**: the same picker as skills, with *Suggested for this project* (from local
   signals, like `skillCatalog.ts`), *From your Claude account*, *Popular* (Supabase,
   GitHub, Vercel, Playwright, Notion), and a pasted URL or command. Scope *This project*
   (local scope, private to this machine) or *All my projects* (user scope). Sharing
   through `.mcp.json` is left out for now.
4. **Sign in**: a Sign in button (`claude mcp login <name>`), a SIGN-IN card in
   "Needs you" when a connector of a running session needs it, and "Add connector…"
   in Ctrl K.

Later, if needed: a Connectors tab in Settings for an overview of accounts and projects,
or one "Tools" section for skills and connectors together.

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
