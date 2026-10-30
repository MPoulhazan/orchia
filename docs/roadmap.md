# Roadmap

Ideas agreed on but not built yet.

## Next features (agreed 2026-10-20)

Built in this order, each kept as simple to use as the rest: no new page, shown only when it applies.

1. ~~**Tab names from the conversation.**~~ built. A new session is named from its first prompt right
   away, then from the title Claude Code writes in its transcript (`ai-title` entries, the
   title `/resume` shows). Never overwrites a name the user typed. Terminal titles (OSC) were
   tried first: Claude Code sends none on Windows.
2. ~~**Copy blocks from the last answer.**~~ built in the inspector (not yet in the Done card). Code blocks are plain text in the terminal, so they
   are read from the transcript's Markdown instead. "From the last answer" in the Done card
   and the inspector lists them, each with **Copy**. Not a second rendering of the
   conversation.
3. ~~**Run a command block.**~~ built; real Claude Code runs `!` commands and answers about the output. Shell blocks (bash, sh, PowerShell) also get **Run**, which types
   `! <command>` in Claude's prompt: it runs in the session's folder under Claude Code's own
   rules, and Claude sees the output. Command always shown in full; disabled while Claude
   works; one line at a time.
4. ~~**Plan to Up next.**~~ built (server/planLots.ts): the ExitPlanMode PermissionRequest is held and answered with `updatedInput.plan` = plan + "do lot 1 only"; verified on real Claude Code. The "Plan ready for review" card gets **Split into Up next**: the plan
   is cut by its own structure (numbered items, `##` headings, "Lot 1…"), with no model call,
   into an editable list of prompts ("Do lot 2 of the plan: …"). The Up next queue then sends
   them one by one. A plan with no clear structure gives one lot. Pairs with "Compact between
   tasks".
5. ~~**Security alerts from awesome-vetted-claude-code.**~~ built (server/advisories.ts); `npx pkg`, `@latest` and hosted servers count as up to date. Left: Needs you for skills and plugins (connectors only), OSV.dev. Match the project's connectors,
   plugins and skills against `tools.json` (`detect`: plugins, skills, npm, pypi, mcp_urls;
   `advisories`: affected and patched versions). A badge on the item ("Security issue, fixed
   in 1.7.0") with a link; unfixed high or critical ones also go to Needs you. Unknown
   installed version: "may be affected". Fetched once a day and cached: say so in the README
   Security section. Later: OSV.dev for every npm and pypi package.

## GitHub issues to Up next (agreed 2026-10-21)

~~Built~~ in the local app, not Orchia Cloud: it runs agents, and needs nothing but the user's
`gh` login. One picker (server/githubIssues.ts, web/src/Issues.tsx), opened from **From an
issue** in Up next or **Work on GitHub issues…** in the palette: list + preview of the text,
Tab to check, Enter to queue one prompt per issue ("read it with gh issue view, fix, commit
Fixes #N"). **Plan first** asks for a plan in lots, which goes through Split into Up next; its
lots now go ahead of what was already queued. Issues from outside the project
(author_association not OWNER/MEMBER/COLLABORATOR) are hidden until asked, with a warning.
A fresh session takes its first Up next prompt as soon as Claude's prompt is on screen.
Left out on purpose: LLM triage, labels or closing from Orchia, a Push button in the Done
card, sync with Orchia Cloud's `orchia:go` label.
Unverified on real Claude Code: that "plan it in plan mode" makes Claude enter plan mode.

## Delegate longer, in parallel

Agreed 2026-10-14. In this order:

1. ~~**Always allow**~~ built: a menu on Allow (inbox and grid) saves the rules Claude Code
   suggests in the PermissionRequest hook (`permission_suggestions`, answered with
   `updatedPermissions`, destination `localSettings`). The inspector lists the project's
   rules, each removable. Shown only when Claude Code suggests an allow rule.
2. ~~**Done summary**~~ built: the Stop hook's `last_assistant_message`, cut to its first
   meaningful sentences (server/summary.ts, no model call), plus the files edited in the turn.
   Shown in the inbox Done card, under grid cells, and in the desktop notification. Left for
   later: the palette (it lists no sessions yet) and "tests passed" (no reliable signal).
3. ~~**Up next**~~ built: a queue under the terminal (shown while Claude works or while prompts
   wait), sent one at a time ~1 s after a Stop. Holds while the user typed in the last 3 s or
   left a draft in Claude's prompt, and after an interrupted or failed turn; "Send now" lifts
   the hold. "+2" on the tab and grid cell. Not done: an Alt Q shortcut.
4. ~~**Own copy, then review and merge**~~ built (server/copies.ts): when another session is
   running in the folder, "+ New session" asks (per-project setting in Settings: Ask / Own copy /
   Same folder, or "Remember for this project"). Orchia runs `git worktree add` itself in
   `.claude/worktrees/<name>` on `worktree-<name>`, from the local HEAD, hides the folder in
   `.git/info/exclude`, copies root `.env*` files, and tells Claude at launch
   (`--append-system-prompt`) to stay in its copy, install dependencies and leave merging to the
   user. A **Changes** tab shows the diff since the copy was made (uncommitted and new files
   included); Merge commits leftovers, merges into the base branch and removes the copy; a
   conflict is aborted and "Ask Claude to resolve" types the merge request into the copy.
   Ending an untouched copy removes it; one with work keeps its branch.
   Not built: warning when a dev server port is taken; Claude Code's own `--worktree`
   isolation checks (we launch claude inside the worktree instead, see copies.ts).

Settings rule: a switch only for what Orchia does **on its own**. Features 1–3 and the review
start from a click, so they are always on, with no setting. The only new setting is per project,
for the own copy: *Ask when another session is busy* (default), *Always in its own copy*,
*Always in the same folder*, also reachable as "Remember for this project" in the New session
dialog. It replaces the Git workflow lot below (Branch per task and Main only are no longer
needed). Things that act alone get a switch: Compact between tasks (on), Restart by itself after
a connector change (on), Auto-commit (off).

## MCP connectors, next

The Connectors section in the inspector is built (see, turn off per project, add, sign in,
"Needs you" card, remove). Adding one checks first how it connects (server/mcpProbe.ts): browser
sign-in, none, or an access token (GitHub: taken from the gh CLI or pasted).
Next (lot 2 of the 2026-10-14 plan):

- ~~**Account first**~~ built: the catalog never offered a second one (sameConnector), and a
  search for a service the project already reaches now shows it under "Already set up"
  ("Claude account · Claude can already use it here") instead of finding nothing.
- ~~**Restart by itself**~~ built: toggle, add, token, remove or a finished sign-in queue every running session of the project; each restarts (`--resume`) once quiet (idle, nothing held, empty Up next, no draft, not typing for 3 s). Setting on by default.

Only if needed:

- **Share with the repo** (`.mcp.json`), left out on purpose for now.
- A **Connectors tab in Settings** for an overview of accounts and projects (proposal 3),
  or one **Tools** section for skills and connectors together (proposal 2).

## Skills library (sidebar)

Comes after the Skills section in the session inspector, and reuses its skill picker.
Based on proposal 2 of its mockups.

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
- ~~**Compact between tasks**~~ built, on by default: only right before an Up next prompt goes
  (not after every turn, which would surprise someone still chatting), when the status line
  says the context is over 60%. Typed like a queued prompt (never over a draft or while the
  user types); PostCompact (trigger manual) releases the queue; 3 min without it, the queue
  shows "Paused".
- **Suggest a fresh start** (only if the need shows up): when a prompt looks unrelated
  to the session, offer to send it to a new session. Never clears on its own.

## Lots that run on their own (agreed 2026-10-28)

Goal: start a plan in lots and walk away (lunch) without coming back to an unfinished lot
with the next ones piled on top. Builds on "Plan to Up next" and "Compact between tasks".
Permissions are not auto-approved: a lot waiting on one is safe, and it can be answered
from the phone (Orchia Cloud, "Needs you on your phone").

1. ~~**A lot only goes when the previous one is done.**~~ built (`lotNotDone` in server/planLots.ts, smoke-tested). Today the queue sends the next lot on
   any clean Stop, even when the lot failed or ended on a question. Each lot prompt now asks
   Claude to commit and end with `LOT n DONE`, or `LOT n BLOCKED: <reason>`. Without
   `DONE`, the rest of the queue holds and Up next says why, with **Resume** and **Drop the
   rest**. A later turn that ends with `LOT n DONE` (the user helped by hand) lifts the hold.
2. ~~**Lots outside plan mode.**~~ built (`splitAnswer`, smoke-tested; reuses POST /plan). The same bar when an ordinary answer is a plan in lots
   ("Lot N", "Phase N", "Step N" headings only, not any numbered list, so a summary doesn't
   trigger it). "Run as a sequence" types lot 1 and queues the rest.
3. ~~**Compact or clear between lots.**~~ built (smoke-tested with a fake SessionStart; /clear is confirmed by the `SessionStart` hook, source `clear`, else the lot goes after 4 s). An option in the lot editor: compact when needed
   (default) or clear. With clear, each lot prompt carries the whole plan and "lots 1..n-1
   are done and committed, see `git log`", with no 600-character cut. A "Commit after each
   lot, stop if one fails" box, on by default (clear depends on it).
4. ~~**Follow the run.**~~ built (`lotRun` in SessionInfo; desktop notifications and phone needs skip the "done" of a lot with more to come). "Lot 2/4" in Up next; a notification (desktop and phone) when the
   last lot is done or one blocks.

## Basic secret rules on every project (agreed 2026-10-29)

1. ~~**Block commits that add a secret.**~~ built (server/commitGuard.ts): PreToolUse on Bash/PowerShell,
   staged diff (plus what `git add` / `commit -a` stage; for a push, `git log -p @{u}..HEAD`),
   same fixed-prefix rules as secrets.ts, deny with the masked reason; alert source `commit`.
   Checked with the real claude CLI: the deny holds even with `Bash(git commit:*)` allowed.
2. ~~**Scan the project's tracked files**~~ built (server/repoScan.ts, background, cached a day per folder, rescanned after a fix): `.env` and private key files in git, `.env` missing
   from `.gitignore`, secrets in clear; on project open, then daily.
3. ~~**Broader .env read protection**~~ built (Read(**/.env*) rules, checked with the real claude CLI; shell commands that print a .env are refused once reads are blocked): subfolders, `cat`, skip `*.example`.
4. **GitHub secret scanning status**: check it per repo, offer to turn it on when free.
