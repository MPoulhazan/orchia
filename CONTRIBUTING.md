# Contributing

Thanks for wanting to help. Bug reports, ideas and pull requests are all welcome.

## Set up

```sh
npm install
npm run dev        # UI with hot reload on http://localhost:5173; restart it to load server changes
npm run dev:watch  # same, and the server restarts on each change: it cuts the turns of the sessions it hosts
npm run typecheck  # must pass before a pull request
npm run smoke      # starts the server with a fake claude and walks a session through a turn
```

The server is in `server/` (Node, TypeScript run by `tsx`), the UI in `web/src/` (React,
xterm.js). There is no formatter config: match the style of the file you edit.

Your real sessions stay safe while you work if you run a second server with its own data:

```sh
ORCHIA_PORT=4399 ORCHIA_HOME=/tmp/orchia-dev npx tsx server/index.ts
```

`ORCHIA_CLAUDE` lets you replace `claude` with a script, for example a fake that prints
a Claude-like screen and posts hook payloads to `http://127.0.0.1:<port>/api/hook`
(headers `x-orchia-session: $ORCHIA_SESSION_ID` and
`authorization: Bearer $ORCHIA_TOKEN`). Handy to test statuses and permission cards
without spending tokens.

## Pull requests

- Keep them focused: one change per pull request.
- Say what you tested, and on which OS. macOS and Linux reports are especially useful.
- UI text is in English, short and plain. Describe what the user sees, not how it works.
- For a bigger change, open an issue first so we can agree on the approach.

Ideas already agreed on are in [docs/roadmap.md](docs/roadmap.md).
