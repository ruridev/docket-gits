# Security

docket-gits runs an AI agent on pull requests that anyone can write. The diagram is in the [README](../README.md#how-ai-runs-are-contained).

**Why.** Anyone who can open a pull request or write a comment can put instructions in it, and an AI agent that reads them may follow them (prompt injection). Running tests also runs the pull request's own code. With your `gh` login, either could merge, push, or send your tokens out. Telling the agent not to is not enough, so docket-gits limits what it can reach instead.

**How.** Only the server holds your `gh` login. Everything that handles a pull request's files runs in a sandbox with no credentials, and reaches the outside only through a proxy in the server that lets reads through and adds your token itself.

**What you get.**

- A hostile pull request or comment can't write to GitHub as you: nothing is posted or pushed until you check it on the board.
- Your tokens, SSH keys and other credentials never enter a run, so a run can't leak them.
- You can let the AI review, run tests and fix pull requests from people you don't fully trust. You read what it made before publishing, but you don't have to watch the run.

## Reporting a vulnerability

Please report security problems privately through [GitHub's private vulnerability reporting](https://github.com/ruridev/docket-gits/security/advisories/new), not in a public issue.

## The rules

| Part | Rule |
| --- | --- |
| GitHub | `gh` in a run talks only to docket-gits, which lets reads through with your login and refuses anything that could write. Runs hold no token. |
| Publishing | Posts, pushes, replies, issues and pull requests are made by docket-gits itself, after you approve them on the board. It pushes exactly the commits you saw, never forced. |
| AI run | Claude Code's sandbox: no credentials, no docket-gits data, no internet, writes only its worktree and the package cache. Registries and local ports are off by default. |
| The pull request's `.claude/` | Not loaded. Its settings, hooks, skills and plugins can't widen the sandbox. |
| Comments | Read only by runs that commit and publish nothing (review, self-review, fix plan). A fix run gets only the plan you approved. |
| Setup command | Its own sandbox (`sandbox-exec`). Network only through a proxy that passes reads and adds your registry token itself. |
| Browser for Playwright | Its own sandbox (`sandbox-exec`), off by default. Reaches loopback only. Turning it on also lets runs use local ports. |

`npm run check:sandbox` checks all this with one short real run.

## What a run can still do

- Read what your `gh` login can read on GitHub, and files your user can read outside the denied paths (other repositories in your working directory, shell history, other tools' settings).
- Reach the local ports you allow. A local service without authentication would be reachable.
- Read the values you put in **Env vars for AI runs**: they reach runs and the setup command, and so the pull request's code.
- Leave files in the worktree. Files that are not in git stay for the next run, so a review run that read a hostile comment can leave something a later fix run uses.
- Send what it read to a package registry you turned on for the repository, by publishing with a token of its own.
- Put what it read into the text it hands back.

So configure only repositories you trust, turn registries on only where everyone who can open a pull request or comment is trusted, and read findings, replies, plans and diffs before you publish them.

## Claude settings and worktrees

- Runs start Claude with your user settings only (`--setting-sources user`), so a `.claude/settings.json`, hook, skill or plugin committed in the pull request can't run commands outside the sandbox or widen it.
- docket-gits keeps a clone of each repository under `~/.docket-gits/repos` (borrowing the objects of your own clone under the working directory, if it finds one, so it is quick) and makes a worktree per pull request under `~/.docket-gits/worktrees`, on a branch `docket/pr-<number>`. Each run starts it at the pull request head. Untracked files such as installed dependencies stay, so they are installed once per pull request. The worktree is removed when the pull request leaves the board. Your own clones are never written to.

## The GitHub gatekeeper and publishing

- `gh` in a run sends every request to docket-gits, which lets through `GET` and `HEAD` to `api.github.com` and GraphQL queries by `POST`, adding your `gh` login. It refuses every other method, GraphQL by `GET`, and any GraphQL text that contains the word `mutation` or `subscription`. Runs hold no token, and need none set up.
- docket-gits reads the run's commits from its clone, checks that they build on the pull request head, shows them, and pushes exactly those commits from that clone without force. Agent runs never run git hooks (`core.hooksPath` is `/dev/null`).
- The agent's commits are code you push to your repository: read the diff. Changes to CI or repository settings and executable files are flagged and need an extra confirmation, because they run with the repository's secrets once pushed. Protect your default branches.
- A fix run starts a new session that gets only the plan you approved (or, with **Follow PR comments**, your own last comment, which docket-gits fetches by your login) and the code. The plan was written by an AI that read the comments, so read it before you approve it. A post is written by a run with no tools that sees only the findings and your decisions.

## Claude Code's sandbox

- Bash commands run in [Claude Code's sandbox](https://docs.anthropic.com/en/docs/claude-code/sandboxing). A run can't read credential stores (`~/.ssh`, `~/.config/gh`, the macOS keychain, `~/.aws`, `~/.netrc`, `~/.npmrc`, `~/.gitconfig` (runs get a copy with only your name and email), ...) or docket-gits' `data/`.
- It can write only to its worktree, to what a commit needs in docket-gits' clone, and to the package cache. It can't change that clone's git config or hooks, or any branch outside `docket/`.
- Runs refuse to start if the sandbox is unavailable.
- Claude's own tools follow the same rules: reading those paths and editing your working directory are denied, web fetch and search are off, and your MCP servers are not loaded.
- Only an allow list of environment variables reaches a run, so tokens in the server's environment don't (`AWS_*` and `GOOGLE_*` only when Claude itself uses Bedrock or Vertex). The values in **Env vars for AI runs** are added on top, so write local development values only there.
- Review, self-review and fix plan runs can't use Claude's Edit and Write tools, but their Bash commands can still write in the worktree.

## Local ports and package registries

- Local ports (for a test database or other service you run as usual) and package registries per repository are turned on under **Settings → Agent settings → Claude settings**. **Give AI runs a browser for Playwright** turns local ports on too, since the tests reach the dev server through them.
- The sandbox tells hosts apart, not what is sent to them: a run can publish to an allowed registry with a token of its own (`npm publish`, `gem push`, `cargo publish`), and so send out anything it read. Runs of repositories without registries can't install dependencies, and use only what is already in their worktree.
- A host that fetches URLs for you is a way out to any host: the Go module proxy (`proxy.golang.org`) is not allowed by default for that reason, so add it only for repositories you trust.

## The setup command

A run can't read any credential file, so it can't install from a registry you sign in to. A setup command fills that gap for npm registries only: docket-gits adds the tokens from your `~/.npmrc` for it. Give the repository a setup command under **Settings → Agent settings → Claude settings** (for example `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile`): docket-gits runs it in the worktree before each run, and the run starts with the dependencies in place. If it fails, the run stops with its output.

What it installs and how is up to the pull request (the lockfile, `.npmrc`, install code) and to files earlier runs left in the worktree, so the command runs in a sandbox of its own (macOS `sandbox-exec`):

- It can't read credentials (`~/.npmrc` included) or docket-gits' data, can't open apps or send Apple events, and writes only the worktree, the package cache and its own temp folder.
- It reaches the network only through docket-gits: the registries in your `~/.npmrc` (or the npm registry when it names none) and GitHub's download hosts (`codeload.github.com`, `*.githubusercontent.com`). The other package registries and the hosts you allow for runs are reachable only for repositories whose runs may reach registries.
- docket-gits ends TLS with a certificate authority of its own (made in `data/`, trusted only by the setup command through `NODE_EXTRA_CA_CERTS`), for every host. Only reads (GET and HEAD, without a body) go through, with your token added for the registry it belongs to, so the command never holds the token and can upload nothing anywhere.
- The command gets your `~/.npmrc` without its tokens, the env vars of runs (not the server's), and a proxy address that works only while it runs. Credentials other than `~/.npmrc` tokens (SSH keys for `git+ssh` dependencies, `~/.bundle/config`, ...) are not available to it.
- Without `sandbox-exec` (Linux) the setup command is not run, and the run goes on without it.

Downloads alone can still leak data slowly, since which packages are fetched can be seen in public download counts. A command that runs the pull request's code (install scripts, a `Gemfile`, a `yarnPath`, `pip install -e`) could use that to send out files your user can read. So give the setup command flags that run nothing from the pull request:

- `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile`
- `npm ci --ignore-scripts`

Count any other command (yarn, bundler, pip, ...) as running the pull request's code, and use it only for repositories where everyone who can open a pull request or comment is trusted.

## The browser for Playwright

**Give AI runs a browser for Playwright** (off by default) starts Chromium outside Claude Code's sandbox, since it can't start inside. docket-gits puts the browser and its Playwright server in a sandbox of their own (macOS `sandbox-exec`) instead:

- They can't read what a run can't (credentials, docket-gits' data), write only their temp folder, and can't open apps or send Apple events.
- They reach only loopback. Page traffic goes through a proxy that lets through only hosts resolving to loopback.
- Chromium's own sandbox is off there; this outer sandbox is the fence.
- Without `sandbox-exec` (Linux) there is no browser, and runs are told so.

## The server and your data

- **AI runs cost money.** Costs are shown per pull request and in total.
- The server listens on `127.0.0.1` only, and rejects requests from other web pages. The API needs the signed-in session (see [Signing in](usage.md#signing-in)); a program running as your user can still read `data/`, so this is no defense against malware on your account. Don't run docket-gits on a PC you share with other people.
- `data/` (settings, state, logs, results waiting to be published) is readable only by you (0700, files 0600).
- Fix runs may edit files under `.claude/skills` of their worktree without asking only when **Let fix runs edit .claude/skills** is on in Claude settings (off by default), so an instruction hidden in a comment can't slip into a skill unnoticed; such edits are part of the commits you check before publishing.
- Importing `docket-settings.json` never changes what AI runs may reach (skill edits, local ports, hosts, env vars, the browser) or local folders (working directories, plan folder). **Extra claude args** and **Read-only tools** were removed: saved values are ignored and dropped on the next save.

