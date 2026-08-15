# agentory

A cross-agent session workbench for Windows. It collects the coding-agent sessions that
are currently scattered across a dozen terminal windows into one window, and brings them
back after a reboot.

Works with **Claude Code**, **Codex**, **OpenCode**, **Pi** and **Grok Build**.

![agentory](docs/screenshot.png)

## The problem

If you run more than one coding agent, your sessions live in a pile of terminal windows.
There is no list of them, no way to tell which one is which, and when the machine reboots
they are gone — the transcripts survive on disk, but finding and resuming the right one
means remembering a session id you never saw.

Every agent solves this for itself and only for itself. Nothing spans them.

## What it does

**Indexes every session across all five agents.** Reads each agent's own storage
directly — no daemon, no database, no background sync. A full scan of 435 sessions takes
about 670 ms on the development machine.

**Resumes them.** Each agent's resume command was verified by hand against the real CLI,
because the differences are not guessable: Codex is the only one that uses a subcommand
(`codex resume <id>`), and two of the five have a `--session-id` flag whose real meaning is
*create if missing* — using it to resume silently opens an empty session instead of failing.

**Keeps a workspace across restarts.** Sessions you add stay listed after you close the
app. Reopening offers to bring them all back; nothing is restarted without you asking,
because restarting an agent session costs tokens.

**Summarises each session** — *not built yet, see [Status](#status)*. Until it is, each row
shows the first informative message from the session, which is readable for about 90% of
them.

### Reading a session's working directory

Two of the five agents encode the project path into a directory name lossily, so
`local_GPU` and `local-GPU` become the same string on disk. The real working directory is
therefore always read from the session's own content, never reconstructed from the folder
name. Every path the app displays has been checked for existence before it is offered as
something you can resume.

## Install

Download the latest release and run it. Two forms are published:

| File | What it is |
|---|---|
| `agentory-<version>-x64.exe` | Installer. Installs for the current user, no administrator rights needed. |
| `agentory-<version>-portable.exe` | Single file, no installation. Slower to start, since it unpacks itself each time. |

Both store their data in `%APPDATA%\agentory`, so you can switch between them without
losing your workspace.

### Windows will warn you the first time

agentory is not code-signed, so Windows shows **"Windows protected your PC — Unknown
publisher"** on first run. Click **More info**, then **Run anyway**.

This is expected for an unsigned open-source build. SmartScreen is a reputation service:
signing does not remove the warning, it only lets a reputation accumulate over time, and a
certificate costs a few hundred dollars a year. If that trade ever makes sense for this
project it will be revisited.

## Build from source

Requires Node.js 22+ and Windows.

```bash
npm install
npm run dev        # run in development
npm test           # unit tests plus real-machine checks against your own agents
npm run package    # build the installer and the portable exe into release/
```

`npm test` includes tests that spawn your real agent CLIs and read your real session
files. They skip themselves when the thing they need is not present, rather than passing
vacuously.

## Status

Working: session index, resume, workspace persistence, favourites, themes, keyboard
shortcuts, terminal-bell notifications.

Not built yet:

- **Session summaries.** The one genuinely novel feature, and the reason the second line
  of each row currently shows a truncated first message instead.
- **Auto-update.** There is no release feed yet, so there is nothing to update from.
- **Split panes.** One session is visible at a time; switching is by tab or `Ctrl+Tab`.

Known limitation: a session created inside agentory cannot be added to favourites until it
has an id, and agents only assign one after the session starts.

## Keyboard shortcuts

Application actions all live under `Ctrl+Shift`. This is deliberate: the main area is a
terminal, and `Ctrl+W`, `Ctrl+A`, `Ctrl+E` and `Ctrl+C` all mean something to the agent
running inside it. Taking those keys would be a real loss of function, so they are passed
through untouched. Press `F1` for the full list.

## Design notes

`DESIGN.md` records the decisions and, more usefully, the measurements behind them — why
there is no index database, why the terminal is treated as a bought black box, why session
identity is the agent's own id rather than a name we invent. `docs/research-notes.md` is
the investigation that preceded the code.

## License

MIT
