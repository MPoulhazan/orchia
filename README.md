# Orchia

One dashboard for all your Claude Code sessions, organized by project.

Run several sessions side by side, see at a glance which ones are working, which
ones need you and which ones are done, and answer permission requests without
hunting through terminals. Everything runs locally: Orchia starts the real
`claude` CLI in terminals it hosts, and listens to it through Claude Code hooks.

[![CI](https://github.com/MPoulhazan/orchia/actions/workflows/ci.yml/badge.svg)](https://github.com/MPoulhazan/orchia/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/design/focus-dark.png">
  <img alt="Focus view: a session waits for permission, with the inbox on the left and the session inspector on the right" src="docs/design/focus-light.png">
</picture>

> [!NOTE]
> These screenshots are mockups of the **Établi** theme.

## A look around

<table>
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

The screenshots come from [docs/design/mockups.html](docs/design/mockups.html). Open it
in a browser to page through the screens, or add `#grid4-dark` (any screen id and
`light` or `dark`) to the URL to render one screen at full size.

## Requirements

- [Node.js](https://nodejs.org) 20.19+ or 22.12+
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and signed in
  (`claude` must work in a terminal)
- Git, for the inspector's changes view and for sessions in their own copy of the repo

Developed and used daily on Windows 11. CI builds on Windows, macOS and Linux, but
macOS and Linux have had little real use yet: reports are welcome.

## Run

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

Double-click a session in the sidebar to rename it. In grid view, clicking a
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

- **Context** used and **cost so far**, as Claude Code itself estimates them. Claude
  Code only gives these to its status line, so the injected settings also set a
  status line command, `server/statusline.mjs`, which passes them to Orchia and
  then runs your own status line (from your user or project settings) unchanged.
  Side effect: with any status line set, Claude Code hides some footer hints such
  as "esc to interrupt".
- **Plan**, when Claude keeps one with its task tools (`TaskCreate`/`TaskUpdate`,
  or `TodoWrite`). Recent models don't use them by default, so it is often absent.
- **Uncommitted changes** and **branch** of the project folder, from `git status`
  and `git diff HEAD`. Every session in the same folder sees the same changes.

## Environment

| Variable        | Default      | Purpose                         |
| --------------- | ------------ | ------------------------------- |
| `ORCHIA_PORT`   | `4317`       | Server port                     |
| `ORCHIA_HOME`   | `~/.orchia`  | Where projects are saved        |
| `ORCHIA_CLAUDE` | `claude`     | Command used to start Claude    |

## Security

Orchia starts processes on your machine, so it is built to be reachable only by you:

- The server listens on `127.0.0.1` only, never on your network.
- It rejects requests whose `Host` is not `localhost` or `127.0.0.1` (blocks DNS
  rebinding) and whose `Origin` is another site (blocks cross-site requests from
  pages open in your browser).
- Each session gets its own random token; hook calls without it are refused.
- Nothing leaves your machine except what Claude Code itself sends. There is no
  telemetry.
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
