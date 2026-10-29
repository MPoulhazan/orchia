# Orchia

**Run five Claude Code sessions at once without babysitting five terminals.**

Orchia is a local dashboard for all your Claude Code sessions, organized by project. See at
a glance which ones are working, which ones need you and which ones are done, and allow or
deny their permission requests straight from the grid.

```sh
npx orchia
```

Then open http://127.0.0.1:4317. Orchia starts the real `claude` CLI in terminals it hosts
and listens to it through Claude Code hooks: your settings, skills and subscription stay as
they are, and nothing leaves your machine.

[![npm](https://img.shields.io/npm/v/orchia.svg)](https://www.npmjs.com/package/orchia)
[![CI](https://github.com/MPoulhazan/orchia/actions/workflows/ci.yml/badge.svg)](https://github.com/MPoulhazan/orchia/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<a href="docs/demo/orchia-demo.mp4">
  <img alt="Demo: four Claude Code sessions in one grid; allow a command from the grid, split a plan into lots queued in Up next, give a session its own copy of the repo and merge it" src="docs/demo/orchia-demo.gif">
</a>

<sub>25 seconds. Click for the video with sound.</sub>

## Why Orchia

- **One inbox for every session.** Sessions waiting on a permission, a question or a plan
  come first, with **Allow** and **Deny** right there. No more tabbing through terminals to
  find the one that has been stuck for ten minutes.
- **Plans in lots.** When Claude proposes a multi-step plan, split it: lot 1 starts now, the
  rest waits in **Up next** and is sent one at a time as Claude finishes, with a `/compact`
  in between when the context fills up.
- **GitHub issues to commits.** Pick open issues: each becomes a queued task that ends in a
  commit with `Fixes #N`.
- **Its own copy of the repo.** Let a session work in an isolated copy, then review and
  merge it.
- **Security alerts.** Your connectors, skills and plugins are checked against known CVEs.
- **Local and private.** Listens on `127.0.0.1` only. No telemetry, no account.

## A look around

<table>
  <tr>
    <td colspan="2">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/design/focus-dark.png">
        <img alt="Focus view: a session waits for permission, with the inbox on the left and the session inspector on the right" src="docs/design/focus-light.png">
      </picture>
      <p><b>Focus view.</b> One session at a time, with the inbox on the left and the inspector on the right.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/design/grid4-dark.png">
        <img alt="Grid view with four sessions" src="docs/design/grid4-light.png">
      </picture>
      <p><b>Grid, 2 × 2.</b> Every session shows its state in words. Allow or deny a request without leaving the grid.</p>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/design/grid6-dark.png">
        <img alt="Grid view with six sessions and the sidebar collapsed" src="docs/design/grid6-light.png">
      </picture>
      <p><b>Grid, 3 × 2.</b> The sidebar folds into a rail and keeps the count of sessions that need you.</p>
    </td>
  </tr>
  <tr>
    <td>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/design/palette-dark.png">
        <img alt="Search palette listing sessions that need you, then other sessions and actions" src="docs/design/palette-light.png">
      </picture>
      <p><b>Search, <kbd>Ctrl K</kbd>.</b> Sessions that need you come first. Every action shows its shortcut.</p>
    </td>
    <td>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/design/add-dark.png">
        <img alt="Folder browser to add a project" src="docs/design/add-light.png">
      </picture>
      <p><b>Add a project.</b> Folders you already used with Claude Code are listed first.</p>
    </td>
  </tr>
  <tr>
    <td>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/design/model-dark.png">
        <img alt="Model and effort picker" src="docs/design/model-light.png">
      </picture>
      <p><b>Model and effort.</b> Changed per session. The conversation is kept.</p>
    </td>
    <td>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/design/ended-dark.png">
        <img alt="A session whose Claude process has ended, with restart options" src="docs/design/ended-light.png">
      </picture>
      <p><b>Session ended.</b> Restart and pick the conversation up where it stopped.</p>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/design/welcome-dark.png">
        <img alt="First launch screen suggesting folders to add" src="docs/design/welcome-light.png">
      </picture>
      <p><b>First launch.</b> Add a project in one click from the folders Claude Code already knows.</p>
    </td>
  </tr>
</table>

The demo and the screenshots show the **Établi** theme with made-up projects, rendered from
[docs/design/mockups.html](docs/design/mockups.html). Open it
in a browser to page through the screens, or add `#grid4-dark` (any screen id and
`light` or `dark`) to the URL to render one screen at full size.

## Requirements

- [Node.js](https://nodejs.org) 20.19+ or 22.12+
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in
  (`claude` must work in a terminal)
- Git, for the inspector's changes view and for sessions in their own copy of the repo
- Optional: the [GitHub CLI](https://cli.github.com), signed in, to queue GitHub issues

Developed and used daily on Windows 11. CI builds on Windows, macOS and Linux, but
macOS and Linux have had little real use yet: reports are welcome.

## Run

```sh
npx orchia       # or: npm install -g orchia, then orchia
```

From source:

```sh
git clone https://github.com/MPoulhazan/orchia.git
cd orchia
npm install
npm start        # builds the UI, serves everything on http://127.0.0.1:4317
npm run dev      # development: UI with hot reload on http://localhost:5173
```

Reloading the page reattaches to running sessions. Projects are saved in
`~/.orchia/config.json` and sessions in `~/.orchia/sessions.json`.
Orchia was called AgentHub until October 2026: on first start it moves `~/.agenthub` to
`~/.orchia`, so nothing is lost.

When the server stops (restart, closed terminal, reboot, crash), sessions come
back **paused** and resume their Claude conversation (`claude --resume`) as soon
as they are shown. A turn that was running at that moment is interrupted. The
restart button keeps the conversation; "New conversation" starts a fresh one.

## Shortcuts

| Keys          | Action                                 |
| ------------- | -------------------------------------- |
| `Ctrl K`      | Search projects, folders and actions   |
| `Alt N`       | New session in the current project     |
| `Alt G`       | Switch between focus and grid view     |
| `Alt I`       | Show or hide the inspector (focus view) |
| `Alt 1` … `9` | Jump to a session (sidebar order)      |
| `Shift Enter` | New line in Claude's prompt            |
| `Ctrl C`      | Copy when text is selected, else interrupt |

A new session is named after your first prompt, then after the title Claude Code gives
the conversation (the one `/resume` lists). Double-click a session in the sidebar to
rename it: a name you type is kept. In grid view, clicking a
session in the sidebar adds it to the grid (up to 6); double-click a cell header
to focus it. `Alt 1…9` uses the physical number keys, so it works on AZERTY too.

## Session status

Sessions started from Orchia report what they are doing through Claude Code
HTTP hooks, injected with `--settings ~/.orchia/claude-hooks.json`. They are
added next to your own hooks, never replacing them, and only for these sessions.

| Dot          | Meaning                                              |
| ------------ | ---------------------------------------------------- |
| green, pulse | Working                                              |
| amber        | Needs you: permission, question or plan to review    |
| blue         | Done, not looked at yet                              |
| gray         | Idle                                                 |
| hollow       | Paused after a server restart, resumes when shown    |
| dim          | Process ended                                        |

Amber and blue sessions are listed under **Needs you** and counted in the tab
title. The bell in the sidebar turns on desktop notifications, sent only while
the tab is in the background.

## Permissions

When Claude asks to run a command, edit a file or use another tool, the request
shows in **Needs you** and at the bottom of its grid cell, with **Allow** and
**Deny**. Claude Code's own prompt stays in the terminal: answer either one, and
the first answer applies.

- **Allow** allows this one call, like "Yes" in the terminal. To allow a command
  for good, answer in the terminal.
- **Deny** refuses the call and stops Claude's turn, like "No" in the terminal.
  Type in the session to tell Claude what to do instead.
- Questions and plans to review need the conversation's context, so they only
  open the session.

This uses the `PermissionRequest` hook: Orchia keeps it open until you answer,
for up to 10 minutes. Deny rules in your Claude settings still apply.

## Plans in lots

When Claude presents a plan made of numbered steps or "Lot 1, Lot 2…" sections, a bar
under the terminal offers **Split into Up next**. You can edit or leave out lots, then
**Start lot 1**: the plan is approved with lot 1 as the whole task, and the other lots
wait in Up next, sent one at a time as Claude finishes. Approving in the terminal still
approves the whole plan, as usual. The plan is cut along its own structure, without a
model call.

Each lot asks Claude to commit its work and end with `LOT n DONE`, or `LOT n BLOCKED:` and
the reason. The next lot only goes after `LOT n DONE`: when a lot fails, ends on a question
or says neither, the rest waits and Up next says why, with **Resume** and **Drop the rest**.
So you can start a plan and walk away without coming back to lots piled on a broken one.

Outside plan mode too: when one of Claude's answers is a plan with titled lots ("Lot 1",
"Phase 2", "Step 3" as headings or bold lines), the same bar offers **Run as a sequence**.
A plain numbered list doesn't count, so a summary of what was done doesn't trigger it.

Before starting, pick what happens **Between lots**: **Compact when needed** (the default,
see below) keeps the conversation, **Clear** gives each lot a fresh one. With Clear, Orchia
types `/clear` before each lot after the first, and that lot's prompt carries the whole plan
and points Claude to `git log` for what is done, so Clear always commits after each lot.
**Commit after each lot** can be turned off otherwise.

While the lots run, Up next shows which one Claude is on ("Lot 2/4"). Desktop notifications
and "Needs you on your phone" stay quiet between lots: you hear about the plan once, when
all its lots are done or when one is held.

Between two Up next prompts, when the conversation fills more than 60% of the context,
Orchia types `/compact` first, so Claude Code doesn't compact in the middle of the next
task. Turn it off in Settings, under **Compact between tasks**.

## GitHub issues

**From an issue** in Up next (or **Work on GitHub issues…** in `Ctrl K`) lists the
repository's open issues. Check a few and press Enter: each becomes an Up next prompt
that has Claude read the issue with `gh issue view`, fix it, and commit with
"Fixes #N", so GitHub closes the issue when you push. For a big issue, tick **Plan
first**: Claude plans it in lots, which you split into Up next as above.

Issues opened by someone who is not an owner, member or collaborator are hidden until
you ask: their text goes to Claude, so read it in the preview first. This needs the
[GitHub CLI](https://cli.github.com) signed in (`gh auth login`); Orchia uses your `gh`
login and stores no token.

## Model and effort

The chip next to the session name shows the model that last answered (read from
the transcript and the `PostModelSwitch` hook) and the effort chosen in Orchia.
Changing them relaunches that session with `--resume --model … --effort …`: the
conversation is kept and your global Claude settings are not touched (unlike
typing `/model`, which saves a new default). An `/effort` typed inside Claude is
not reflected in the chip.

## Inspector

The panel on the right of the focus view (`Alt I`) shows, for the session on
screen:

- **From the last answer**: the code blocks of Claude's last reply, each with **Copy**.
  A block that is one shell command also has **Run**, which types `! command` in
  Claude's prompt: Claude Code runs it in the session's folder and Claude sees the
  output. Run waits until Claude is waiting for you.
- **Context** used and **cost so far**, as Claude Code itself estimates them. Claude
  Code only gives these to its status line, so the injected settings also set a
  status line command, `server/statusline.mjs`, which passes them to Orchia and
  then runs your own status line (from your user or project settings) unchanged.
  Side effect: with any status line set, Claude Code hides some footer hints such
  as "esc to interrupt".
- **Skills** and **Connectors** of the project: turn them on or off, add, sign in, remove.
  Connectors load when Claude starts, so after a change Orchia restarts the project's
  sessions by itself once Claude is free, keeping the conversation (Settings: **Restart by
  itself**).
- **Plan**, when Claude keeps one with its task tools (`TaskCreate`/`TaskUpdate`,
  or `TodoWrite`). Recent models don't use them by default, so it is often absent.
- **Uncommitted changes** and **branch** of the project folder, from `git status`
  and `git diff HEAD`. Every session in the same folder sees the same changes.

## Security alerts

Connectors, skills and plugins are checked against the advisories listed in
[awesome-vetted-claude-code](https://github.com/MPoulhazan/awesome-vetted-claude-code),
a catalog where each tool is reviewed and checked for CVEs. A shield next to an item in
the inspector links to its review: red when the issue applies (the version in your
command is affected, or there is no fix yet), grey when it was fixed in a version Orchia
can't see, so you can check yours. High and critical issues that apply also show in
**Needs you**. `npx package` and hosted servers run the latest release, so only issues
with no fix yet concern them.

Orchia also watches for secrets that reach the model: a token in your prompt, or in a
tool call's input or output (`cat .env` printing an API key). Only formats with a fixed
prefix are recognized (GitHub, Anthropic, OpenAI, AWS, Stripe live, GitLab, Slack, npm,
Google API keys and private keys), so an alert is almost always real. It shows in
**Needs you** with a link to revoke the secret, and goes away when you click **Done**.
Orchia keeps only the kind of secret, its first and last characters (`ghp_…a41f`) and a
hash to recognize it again, in `~/.orchia/secrets.json`; never the secret itself.

Permission settings that let Claude do more than you may think show in **Needs you** too,
for projects with a running session:

- an allow rule for every shell command (`Bash`, `Bash(*)`), with **Remove rule** when it
  is in the project's `.claude/settings.local.json`;
- `defaultMode: bypassPermissions`, which skips every prompt;
- `.env` files in the project folder with no deny rule: **Block reads** adds `Read(./.env)`
  and `Read(./.env.*)` to the deny rules of `.claude/settings.local.json`. This stops
  Claude's Read tool, not a shell command such as `cat .env`, which the secret alert above
  still catches.

## Environment

| Variable        | Default      | Purpose                         |
| --------------- | ------------ | ------------------------------- |
| `ORCHIA_PORT`   | `4317`       | Server port                     |
| `ORCHIA_HOME`   | `~/.orchia`  | Where projects are saved        |
| `ORCHIA_CLAUDE` | `claude`     | Command used to start Claude    |
| `ORCHIA_CLOUD_URL` | `https://app.orchia.app` | Orchia Cloud server, if you pair |

## Security

Orchia starts processes on your machine, so it is built to be reachable only by you:

- The server listens on `127.0.0.1` only, never on your network.
- It rejects requests whose `Host` is not `localhost` or `127.0.0.1` (blocks DNS
  rebinding) and whose `Origin` is another site (blocks cross-site requests from
  pages open in your browser).
- Each session gets its own random token; hook calls without it are refused.
- Nothing leaves your machine except what Claude Code itself sends. There is no
  telemetry. Orchia itself only downloads the public advisory catalog
  (`tools.json` from awesome-vetted-claude-code), once a day, without sending anything
  about you or your projects.
- Orchia Cloud is optional and off by default. If you turn it on in Settings, Orchia
  pairs with your account through a code you approve in the browser, then keeps one
  outbound connection open (the cloud never connects to your machine). It sends this
  computer's name, Orchia's version, your OS and when you are online, nothing else:
  no code, prompts, terminal output, file or project names. Settings lists exactly what
  is sent. The device token is saved in `~/.orchia/cloud.json`; Disconnect, or Unpair
  from Devices on the cloud, revokes it. Set `ORCHIA_CLOUD_URL` to use another server.
- "Needs you on your phone", a second switch that is also off by default, sends the
  sessions that need you to the cloud so you can allow or deny from your phone: each
  one's session and project name, why it waits, a permission request's tool and target
  (the command, file or URL), and the summary of a finished turn. Still no code,
  prompts or terminal output. The phone can only answer a request Claude already made,
  never start one or type in a session, and "Always allow" stays on your computer.
  Settings can limit it to Deny, or keep shell commands for the computer. Claude Code's
  own deny rules still apply.
- A connector token you paste is written to Claude Code's own config
  (`~/.claude.json`), where `claude mcp add` would put it.

Anyone who can run code as your user can already drive `claude`, so Orchia does not
try to protect against that. If you find a security issue, please open a
[private security advisory](https://github.com/MPoulhazan/orchia/security/advisories/new)
rather than a public issue.

## Contributing

Bug reports, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Orchia is an independent project, not affiliated with or endorsed by
Anthropic. Claude and Claude Code are trademarks of Anthropic.
