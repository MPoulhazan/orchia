# Roadmap

Ideas agreed on but not built yet.

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
- Worth it once there are enough skills to need an overview of what is used where.

## Suggested skills

Up to 3 skills suggested in the Add skill palette, each saying why ("Because it uses
Playwright"), with a ✕ to dismiss it for that project. Builds on the GitHub import in
the palette.

- **Catalog**: a hand-picked JSON file shipped with the app (10–15 entries, frozen, no
  remote updates). Each entry: repo, a pinned commit, the skills to add, a one-line
  summary, a category, the signals that make it relevant, and the reason shown.
- **Ranking**: relevance to the project, from local signals only (dependencies, files,
  MCP servers configured). Popularity is never the ranking, only shown.
- **Exclusions**: skills already there, skills whose category is already covered (two
  frontend-design skills fight over the same tasks), and dismissed ones. No suggestion
  beats a wrong one, so signals stay conservative.
- **Popularity**: GitHub stars beside a suggestion, cached 24 h, hidden if the call fails.
- **Inspector**: only when a project has no skills, one quiet line ("2 suggestions for
  this project"). No badges.
- Later, the Skills library gets a Discover tab with the whole catalog by category.

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
