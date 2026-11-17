# Setup

## Requirements

- Node.js 22 or later
- macOS or Linux (Windows is not supported). On Linux the repository setup command and the browser for Playwright are not available, since they need macOS `sandbox-exec`
- [GitHub CLI](https://cli.github.com/), logged in with `gh auth login`
- `claude` (Claude Code), logged in. AI runs use its [sandbox](https://docs.anthropic.com/en/docs/claude-code/sandboxing), which is built in on macOS and needs `bubblewrap` and `socat` on Linux; runs refuse to start without it
- `git`. AI runs work in a git worktree of the pull request; tests that need a database or other service use the one you already run on `localhost` (turn on **Let AI runs use local ports** in Claude settings for that). Tests that start containers themselves (for example `docker compose run`) can't run inside the sandbox: start the services first

## First run

1. Clone the repository and start the server:

   ```bash
   git clone https://github.com/ruridev/docket-gits.git
   cd docket-gits
   npm start
   ```

   There are no dependencies, so there is no `npm install`.

2. Open http://localhost:4649 and create your account (see [Signing in](usage.md#signing-in)).
3. Read the notice about the risks and agree to it. Nothing that starts `claude` works until you do.
4. Open **Settings** from the account menu at the top right, then under **Agent settings**:
   - **Work targets**: set the working directory where your skills live, and the repositories to watch (`owner/name`, one per line). Runs refuse to start until a working directory is set, and never run in your home directory or `/`.
   - **Claude settings**: pick a review skill per repository, or use the built-in review prompt. You can also choose whether AI runs may use local ports (for test databases) and which repositories' runs may reach package registries to install dependencies (none by default); see [Security](SECURITY.md#local-ports-and-package-registries).
5. Press **Refresh** in the left sidebar. Review requests show up under **Requested**.

## Environment variables

| Environment variable | Default | |
| --- | --- | --- |
| `PORT` | `4649` | Port to listen on |
| `DOCKET_DATA` | `./data` | Where settings, state and logs are stored (created with mode 0700) |
| `DOCKET_HOME` | `~/.docket-gits` | docket-gits' clones of your repositories, the worktree of each pull request, and the package cache of AI runs |
| `DOCKET_FRAME_ANCESTORS` | `'self' http://localhost:4600 http://127.0.0.1:4600` | Pages allowed to embed docket-gits in a frame (`Content-Security-Policy: frame-ancestors`). Set `"'self'"` to allow no other page |

## Troubleshooting

If you start the server without a login shell (from launchd, for example), `gh` and `claude` may not be on `PATH` (`spawn claude ENOENT`). Add the directories that `which gh claude` prints to `PATH`.
