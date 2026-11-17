'use strict';

// Where and how docket-gits runs Claude on a pull request.
// A run works in a git worktree of the pull request, made from a clone docket-gits keeps under ~/.docket-gits
// (borrowing the objects of the user's own clone, found under the working directory by its remote, so it is quick).
// The worktree stays per pull request, so dependencies installed in it are reused, and each run starts it at the
// pull request head. The user's clones and working directory are never written to.
// The run's Bash commands are in Claude Code's sandbox: it may write to its worktree, to what a commit needs in
// the clone's .git (objects, its own worktree admin folder, branches under docket/), and to a package cache;
// never to the clone's config or hooks (the server pushes from that clone), other branches or anything else. It reads GitHub only through the
// gatekeeper (github-proxy.js) and holds no token. Publishing is done by the server (publish.js).

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { SOCKET, ghConfig } = require('./github-proxy');
const jail = require('./jail');

const HOME = path.resolve(process.env.DOCKET_HOME || path.join(os.homedir(), '.docket-gits'));

// Package registries runs may reach to install dependencies, for repositories the user turned on (repos[repo].network).
// The sandbox sees hosts, not methods: a run can publish there with a token of its own, so a host here is a way out.
// Not proxy.golang.org / sum.golang.org: the Go proxy fetches any module path from any host, so it would let a run send data anywhere
const REGISTRIES = ['registry.npmjs.org', 'registry.yarnpkg.com', 'rubygems.org', 'index.rubygems.org', 'pypi.org', 'files.pythonhosted.org',
  'repo.maven.apache.org', 'repo1.maven.org', 'plugins.gradle.org', 'services.gradle.org', 'crates.io', 'static.crates.io', 'index.crates.io'];

// Where credentials live. Bash in the sandbox can't read them, and the Read tool is denied them.
// ~/Library/Keychains: the macOS login keychain is a file, and without this `security` reads the gh token from it
const SECRET_PATHS = ['~/.ssh', '~/.config/gh', '~/Library/Keychains', '/Library/Keychains', '~/.aws', '~/.netrc', '~/.git-credentials',
  '~/.docker', '~/.kube', '~/.gnupg', '~/.npmrc', '~/.gem/credentials', '~/.pypirc', '~/.cargo/credentials.toml', '~/.codex', '~/.config/gcloud',
  '~/.claude.json', '~/.claude/.credentials.json', '~/.claude/settings.json', '~/.claude/settings.local.json',
  '~/.config/git/credentials', '~/.gitconfig', '~/.config/git/config', '~/.config/github-copilot', '~/.config/hub', '~/.config/op', '~/.azure', '~/.terraform.d', '~/.vault-token', '~/.pgpass',
  '~/.yarnrc.yml', '~/.bundle/config', '~/.m2/settings.xml', '~/.gradle/gradle.properties', '~/.composer/auth.json',
  ...(process.env.CLAUDE_CONFIG_DIR ? [path.join(path.resolve(process.env.CLAUDE_CONFIG_DIR), '.credentials.json')] : [])];

// The other docket apps' data (their sign-in secrets): with it a run could sign in to their APIs on local ports.
// Their default places (docket-jobs outside its clone, both in a clone next to this one) and any set in the env
const DOCKET_DATA_PATHS = ['~/Library/Application Support/docket-jobs', '~/.local/share/docket-jobs',
  ...['docket', 'docket-jobs'].map((r) => path.join(path.dirname(__dirname), r, 'data')),
  ...[process.env.DOCKET_PORTAL_DATA, process.env.DOCKET_JOBS_DATA_DIR].filter(Boolean).map((p) => path.resolve(p))];

// What runs, the setup command and the browser can't read: credentials and the data of the docket apps
const deniedPaths = (dataDir) => [...SECRET_PATHS, ...DOCKET_DATA_PATHS, dataDir].filter(Boolean);

// Env vars a run keeps. Everything else (GITHUB_TOKEN, SSH_AUTH_SOCK, other tools' secrets) is dropped.
// CLAUDECODE and the like are dropped too: claude refuses to start nested in another session
const ENV_KEEP = /^(HOME|USER|LOGNAME|PATH|SHELL|LANG|LC_\w+|TERM|TMPDIR|TZ|NODE_EXTRA_CA_CERTS|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy|ANTHROPIC_\w+|CLAUDE_CONFIG_DIR|CLAUDE_CODE_USE_\w+|RBENV_\w+|PYENV_\w+|NVM_\w+|ASDF_\w+|MISE_\w+|VOLTA_\w+|GEM_\w+|JAVA_HOME|GOPATH|GOROOT|RUBY_\w+|BUNDLE_GEMFILE)$/;

// Cloud credentials, kept only when claude itself signs in through that cloud
const CLOUD_KEEP = { CLAUDE_CODE_USE_BEDROCK: /^AWS_\w+$/, CLAUDE_CODE_USE_VERTEX: /^(CLOUD_ML_REGION|VERTEX_\w+|GOOGLE_\w+)$/ };

// gh's config for runs, one per server (port) like the gatekeeper socket it points to
const ghDirOf = (home) => path.join(home, `gh-${process.env.PORT || 4649}`);

// Absolute paths in permission rules start with //
const abs = (p) => (p.startsWith('~') ? p : `/${p}`);

// The user's env vars for runs (settings, KEY=VALUE per line), e.g. the password of a local database tests use.
// The run's commands (the pull request's code) can read them, so they are for local development values only
function runEnv(text) {
  return Object.fromEntries(String(text || '').split('\n').map((line) => line.match(/^\s*([A-Za-z_]\w*)\s*=(.*)$/)).filter(Boolean).map(([, k, v]) => [k, v.trim()]));
}

// extra: runEnv(); it can't replace the values below, which keep the run away from the user's token, hooks and caches
function agentEnv(env, { home = HOME, extra = {} } = {}) {
  const clouds = Object.entries(CLOUD_KEEP).filter(([flag]) => env[flag]).map(([, keep]) => keep);
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => ENV_KEEP.test(k) || clouds.some((keep) => keep.test(k))));
  const cache = path.join(home, 'cache');
  return {
    ...out,
    // claude's Bash tool stops a command after 2 minutes by default, too short for a test suite that boots an app;
    // runEnv can change these
    BASH_DEFAULT_TIMEOUT_MS: '300000',
    BASH_MAX_TIMEOUT_MS: '600000',
    ...extra,
    // gh sends every request to the gatekeeper, which adds the user's token; the placeholder only makes gh try
    GH_TOKEN: 'docket-gits',
    GH_CONFIG_DIR: ghDirOf(home),
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GIT_TERMINAL_PROMPT: '0',
    // Package caches only runs share, never the user's own (a poisoned cache must not reach the user's tools)
    XDG_CACHE_HOME: cache,
    npm_config_cache: path.join(cache, 'npm'),
    npm_config_store_dir: path.join(cache, 'pnpm-store'),
    // Where pnpm keeps the versions it fetches for a project's packageManager (outside the sandbox by default)
    PNPM_HOME: path.join(cache, 'pnpm-home'),
    YARN_CACHE_FOLDER: path.join(cache, 'yarn'),
    PIP_CACHE_DIR: path.join(cache, 'pip'),
    // No git hooks (a run could write one and commit to run it), no automatic gc (it rewrites shared files)
    // The user's git config can hold credentials (url.<https://TOKEN@host>.insteadOf, http.extraHeader) and is
    // denied: runs get a copy with only their name and email (gitConfigOf), for commits
    GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'gc.auto',
    GIT_CONFIG_VALUE_1: '0',
  };
}

// pnpm (12+) takes its store locks in these fixed folders under /tmp, whatever TMPDIR or the store dir say.
// Only lock files go there; agentArgs makes the folders, since a run can't create them in /tmp
const PNPM_LOCKS = ['pnpm-store-operation-locks', 'pnpm-dir-locks'].map((d) => `/tmp/${d}-${process.getuid()}`);

// The run's own temp folder, given to claude as CLAUDE_CODE_TMPDIR (its TMPDIR is <this>/claude-<uid>).
// Dev servers make Unix sockets in TMPDIR, which the sandbox allows only in listed folders; the shared one would also
// reach other sessions' sockets, so each worktree gets its own. Short: a socket path must fit in 104 bytes
const runTmpOf = (ws) => path.join(fs.realpathSync('/tmp'), `dk-${crypto.createHash('sha256').update(ws.cwd || '').digest('hex').slice(0, 10)}`);

// The sandbox of a run in workspace ws ({ cwd, gitDir, adminDir }). allowLocal: localhost ports (databases for tests)
// workdir: added to the run read-only (--add-dir would make it writable)
function agentSettings({ ws, workdir, dataDir, envPath, home = HOME, domains = REGISTRIES, allowLocal = true, socket = SOCKET }) {
  const git = ws.gitDir;
  return {
    ...(envPath && { env: { PATH: envPath } }),
    sandbox: {
      enabled: true,
      // No sandbox, no run: it is the fence
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      // FSEvents: file watching (fs.watch, dev servers) on macOS fails without it
      network: { allowedDomains: domains, allowUnixSockets: [socket, runTmpOf(ws)], allowLocalBinding: Boolean(allowLocal), allowMachLookup: ['com.apple.FSEvents'] },
      filesystem: {
        denyRead: [...SECRET_PATHS, ...DOCKET_DATA_PATHS, dataDir],
        allowWrite: [ws.cwd, path.join(home, 'cache'), ...PNPM_LOCKS, runTmpOf(ws), ...(git ? [path.join(git, 'objects'), ws.adminDir, path.join(git, 'refs', 'heads', 'docket'), path.join(git, 'logs', 'refs', 'heads', 'docket')] : [])],
        // The user's git runs these later, outside the sandbox; the server trusts the admin folder's links
        denyWrite: [...(workdir ? [workdir] : []), ...(git ? [path.join(ws.cwd, '.git'), path.join(git, 'config'), path.join(git, 'hooks'), path.join(git, 'info'), path.join(git, 'packed-refs'),
          path.join(ws.adminDir, 'commondir'), path.join(ws.adminDir, 'gitdir'), path.join(ws.adminDir, 'config.worktree')] : [])],
      },
    },
  };
}

// Rules for Claude's own tools, which the sandbox does not cover: no reading credentials or docket-gits' data,
// no editing the working directory (clones of the user live there), and no web access
function agentToolDeny({ workdir, dataDir }) {
  return [
    ...[...SECRET_PATHS, ...DOCKET_DATA_PATHS, dataDir].map((p) => `Read(${abs(p)}/**)`),
    ...(workdir ? ['Edit', 'Write', 'NotebookEdit'].map((t) => `${t}(${abs(workdir)}/**)`) : []),
    'WebFetch', 'WebSearch',
  ];
}

// The working directory's skills as a plugin. Runs load user settings only (see agentArgs), which also skips the
// skills of an added directory; a plugin brings them back, still invoked as /<skill>. null: no skills there
function workdirPlugin(workdir, home = HOME) {
  const skills = path.join(workdir, '.claude', 'skills');
  if (!fs.existsSync(skills)) return null;
  const dir = path.join(home, 'plugins', crypto.createHash('sha256').update(workdir).digest('hex').slice(0, 16));
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'workdir' }));
  const link = path.join(dir, 'skills');
  let current = null;
  try {
    current = fs.readlinkSync(link);
  } catch {}
  if (current !== skills) {
    fs.rmSync(link, { force: true });
    fs.symlinkSync(skills, link);
  }
  return dir;
}

// Claude CLI options for a run. workdir: the user's working directory, added read-only so its files can be read.
// deny: more rules for the run's mode. --strict-mcp-config: the user's MCP servers run outside the sandbox
// --setting-sources user: the worktree is the pull request's code, and its .claude/ (settings, hooks, skills,
// plugins) would run outside the sandbox or widen it, so only the user's own settings load
function agentArgs({ ws, workdir, dataDir, envPath, deny = [], network = {}, home = HOME }) {
  const plugin = workdir && workdirPlugin(workdir, home);
  for (const dir of [...PNPM_LOCKS, runTmpOf(ws)]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return ['--settings', JSON.stringify(agentSettings({ ws, workdir, dataDir, envPath, ...network })), '--setting-sources', 'user',
    ...(workdir ? ['--add-dir', workdir] : []), ...(plugin ? ['--plugin-dir', plugin] : []),
    '--strict-mcp-config', '--disallowedTools', [...agentToolDeny({ workdir, dataDir }), ...deny].join(',')];
}

function git(args, opts = {}) {
  return new Promise((resolve, reject) => {
    // Server-side git uses the user's gh login over https and never runs hooks
    execFile('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', '-c', 'core.hooksPath=/dev/null', ...args],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n').pop())) : resolve(stdout)));
  });
}

// The user's clone of repo under workdir: a folder with a .git directory whose remote is github.com/<repo>.
// Of several clones, the one named like the repository, then the shallowest. Reads .git/config as text, so nothing
// in a clone runs. Skips dependency folders; looks 3 levels deep
function findClone(workdir, repo, depth = 3) {
  if (!workdir) return null;
  const want = new RegExp(`github\\.com[:/]${repo.replace(/[.]/g, '\\.')}(\\.git)?/?\\s*$`, 'im');
  const name = repo.split('/')[1].toLowerCase();
  const found = [];
  const queue = [[path.resolve(workdir), 0]];
  while (queue.length) {
    const [dir, level] = queue.shift();
    let config = null;
    try {
      if (fs.lstatSync(path.join(dir, '.git')).isDirectory()) config = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    } catch { /* not a clone */ }
    if (config && want.test(config)) {
      if (path.basename(dir).toLowerCase() === name) return dir;
      found.push(dir);
    }
    if (config || level >= depth) continue;
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of names) if (d.isDirectory() && !d.name.startsWith('.') && !['node_modules', 'vendor', 'tmp', 'dist', 'build'].includes(d.name)) queue.push([path.join(dir, d.name), level + 1]);
  }
  return found[0] || null;
}

// DOCKET_CLONE_BASE: a local folder of <owner>/<name>.git repositories to clone from instead of GitHub (tests)
const remoteOf = (repo) => (process.env.DOCKET_CLONE_BASE ? path.join(process.env.DOCKET_CLONE_BASE, `${repo}.git`) : `https://github.com/${repo}.git`);

// The clone worktrees are made from, kept by docket-gits under HOME/repos. When the user has a clone of the
// repository under workdir, its objects are borrowed (--reference), so the first clone is quick
async function ensureClone(repo, { workdir, home = HOME }) {
  const dir = path.join(home, 'repos', ...repo.split('/'));
  if (!fs.existsSync(path.join(dir, '.git'))) {
    const own = findClone(workdir, repo);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(['clone', '--quiet', '--no-checkout', ...(own ? ['--reference-if-able', own] : []), remoteOf(repo), dir]);
  }
  return dir;
}

// Worktree runs on one clone are prepared one at a time (fetches and worktree changes share the clone)
const locks = new Map();
function withLock(key, fn) {
  const next = (locks.get(key) || Promise.resolve()).then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

// The git config of runs and the setup command (GIT_CONFIG_GLOBAL): the user's name and email, nothing else
async function writeGitConfig(home = HOME) {
  const get = (key) => git(['config', '--global', '--get', key]).then((v) => v.trim(), () => '');
  const [name, email] = await Promise.all([get('user.name'), get('user.email')]);
  const quote = (v) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, ' ')}"`;
  fs.writeFileSync(path.join(home, 'gitconfig'), `[user]\n${name ? `\tname = ${quote(name)}\n` : ''}${email ? `\temail = ${quote(email)}\n` : ''}`);
}

// The admin folder git keeps for a worktree (<clone>/.git/worktrees/<id>). Found from its gitdir file, which runs
// can't write, never from the worktree's own .git file, which they can
function adminDirOf(gitDir, worktree) {
  const root = path.join(gitDir, 'worktrees');
  let ids = [];
  try { ids = fs.readdirSync(root); } catch { return null; }
  const want = path.join(fs.realpathSync(worktree), '.git');
  return ids.map((id) => path.join(root, id)).find((d) => {
    try { return path.resolve(fs.readFileSync(path.join(d, 'gitdir'), 'utf8').trim()) === want; } catch { return false; }
  }) || null;
}

// What a run is told about its folder. The AI knows its stack: it copies or installs what the project needs
// browser: a Chromium for Playwright runs outside the sandbox (browser.js), its address in PW_TEST_CONNECT_WS_ENDPOINT
function workspaceNote(ws, pr, { browser = false } = {}) {
  return `## The folder of this run
- The current directory is a git worktree of the pull request at its head, on branch ${ws.branch}${ws.base ? `; the base branch is at origin/${ws.base}` : ''}.
- Files that are not in git (local settings such as .env files, installed dependencies, build output) are not here. ${ws.sourceClone ? `The user's own clone of this repository is at ${ws.sourceClone} (read-only): copy from it what you need to build or test, only files that are not in git (the tracked ones are already here, at this pull request's version).` : 'There is no local clone of this repository to copy them from.'} Install missing dependencies here (for example pnpm install / bundle install): don't link dependency folders such as node_modules from the user's clone, since tools write into them and the clone can't be written.
- Run the tests that cover the changed code here, installing dependencies first if they are missing. CI results don't replace this: a missing node_modules or vendor/bundle is a reason to install, not to skip.
- Before running tests, find out how this project runs them and what they connect to (README, bin/ and scripts, config files, and the local settings in the user's clone). Services such as databases may already be running on local ports. Check, don't guess; if something still can't run, say exactly what you tried and what failed.
- Use the project's usual test setup (for example its usual test database) rather than creating new ones. If you do create anything outside this worktree (a database, files elsewhere), remove it before you finish; if you can't, list what is left in the summary.
- Commands run in a sandbox: the network reaches only package registries and local ports (for example a database the tests use), and only this worktree is writable.
- Start servers (dev servers, test databases) in the background with plain "command &" (nohup fails here), note their PID ($!), and stop them with kill <PID> before your final answer: ps, pkill and lsof can't see processes in this sandbox, and if kill is refused, servers left in this worktree are stopped for you when the run ends.
- A dev server already answering on the project's usual port is the user's, running their clone, not this pull request: don't test against it (turn off any reuse of an existing server). Start this worktree's own on a free port and point the tests at that port.
- Reach local servers by 127.0.0.1, not by a hostname: names don't resolve in the sandbox, and names that point to 127.0.0.1 (such as a dev server's local.* host) are refused. Start servers on 127.0.0.1 (curl --resolve maps a name if a Host header matters).
${browser
    ? `- Browsers can't start in this sandbox on macOS, but a Chromium for Playwright runs outside it: PW_TEST_CONNECT_WS_ENDPOINT is set, so playwright test connects to it by itself (don't install browsers). Run the Playwright tests that cover the change. That browser reaches only loopback: 127.0.0.1, localhost, *.localhost, and names /etc/hosts maps to 127.0.0.1 (so a dev server's local.* host set up there works from the page; names only DNS knows don't); the test runner itself is in the sandbox, so where it checks a URL (webServer url, health checks) point it at 127.0.0.1, for example through the env var the config reads. Cypress and Puppeteer still can't run here: if the project uses them, say so in the summary.`
    : '- Browsers (Playwright, Cypress, Puppeteer) can\'t start in this sandbox on macOS, so don\'t try browser or E2E tests: run unit and component tests, and say in the summary that browser tests were not run for this reason.'}`;
}

const worktreeOf = (pr, home = HOME) => path.join(home, 'worktrees', `${pr.repo.replace('/', '-')}-${pr.number}`);
const branchOf = (pr) => `docket/pr-${pr.number}`;

// The workspace of a run on pr: its worktree at the pull request head (headSha), on branch docket/pr-<n>.
// The base branch is fetched too, so the run can diff against it
async function prepareWorkspace(pr, { workdir, home = HOME }) {
  const clone = await ensureClone(pr.repo, { workdir, home });
  const gitDir = path.join(clone, '.git');
  const cwd = worktreeOf(pr, home);
  return withLock(clone, async () => {
    const pull = `refs/docket/pull/${pr.number}`;
    await git(['-C', clone, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/pull/${pr.number}/head:${pull}`]);
    // Separate fetch: the cached base may be gone on GitHub (a stacked pull request whose parent merged)
    const base = pr.base && await git(['-C', clone, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${pr.base}:refs/remotes/origin/${pr.base}`])
      .then(() => pr.base, () => null);
    const headSha = (await git(['-C', clone, 'rev-parse', pull])).trim();
    // Split branches a previous run left (its result was published or discarded)
    const splits = (await git(['-C', clone, 'for-each-ref', '--format=%(refname)', `refs/heads/${branchOf(pr)}-*`])).split('\n').filter(Boolean);
    for (const ref of splits) await git(['-C', clone, 'update-ref', '-d', ref]);
    let adminDir = fs.existsSync(cwd) ? adminDirOf(gitDir, cwd) : null;
    if (!adminDir) {
      fs.rmSync(cwd, { recursive: true, force: true });
      await git(['-C', clone, 'worktree', 'prune']);
      fs.mkdirSync(path.dirname(cwd), { recursive: true });
      await git(['-C', clone, 'worktree', 'add', '--quiet', '--force', '-B', branchOf(pr), cwd, headSha]);
      adminDir = adminDirOf(gitDir, cwd);
    } else {
      // Every run starts at the head; untracked files (installed dependencies) stay. The server names the
      // admin folder itself instead of reading the worktree's .git file
      await git([`--git-dir=${adminDir}`, `--work-tree=${cwd}`, 'checkout', '--quiet', '--force', '-B', branchOf(pr), headSha]);
      await git([`--git-dir=${adminDir}`, `--work-tree=${cwd}`, 'reset', '--quiet', '--hard', headSha]);
    }
    // A run could leave its own .git here (a folder, or a link to a repository it made), and any git started in the
    // worktree would take that repository's config (core.sshCommand, ...). Put back the link git made
    const dotGit = path.join(cwd, '.git');
    fs.rmSync(dotGit, { recursive: true, force: true });
    fs.writeFileSync(dotGit, `gitdir: ${adminDir}\n`);
    fs.mkdirSync(path.join(home, 'cache'), { recursive: true });
    await writeGitConfig(home);
    fs.mkdirSync(ghDirOf(home), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ghDirOf(home), 'config.yml'), ghConfig());
    // sourceClone: the user's own clone, which the run may read (local settings, dependencies that aren't in git)
    return { cwd, clone, gitDir, adminDir, headSha, base: base || null, branch: branchOf(pr), sourceClone: findClone(workdir, pr.repo) };
  });
}

// The repository's setup command (config repos[repo].setup), run by the server in the worktree before the run.
// The command is the user's, but what it installs and how is up to the pull request (lockfile, .npmrc, install
// code), so it runs in jail.js's sandbox like a run: it can't read credentials or docket data, writes only the
// worktree, the package cache and its own temp folder, and reaches the network only through setup-proxy.js,
// which lets it read registries (adding the user's registry tokens itself) and nothing else.
// sandbox: { port, proxy (its URL with this command's secret), certFile, userconfig, denyRead } from the server; without it (no OS sandbox here) the command
// is not run, and the run goes on without it. extra: the user's env vars for runs (runEnv).
// ponytail: runs every time; pnpm/bundle are quick when installed
function runSetup(cwd, command, { env = process.env, extra = {}, timeoutMs = 10 * 60 * 1000, sandbox = null, home = HOME } = {}) {
  if (!command || !command.trim()) return Promise.resolve({ ok: true });
  if (!sandbox) return Promise.resolve({ ok: true, skipped: true });
  const tmp = path.join(home, 'tmp', 'setup');
  for (const dir of [tmp, path.join(home, 'cache'), ...PNPM_LOCKS]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { proxy } = sandbox;
  // The env of a run without what only claude needs (its API keys, cloud credentials). Every https request ends at
  // the proxy, so tools trust its authority only
  const base = Object.fromEntries(Object.entries(agentEnv(env, { home, extra })).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|VERTEX_|CLOUD_ML_)/.test(k) || k in extra));
  const ca = sandbox.certFile;
  const setupEnv = { ...base, TMPDIR: tmp, npm_config_userconfig: sandbox.userconfig,
    NODE_EXTRA_CA_CERTS: ca, SSL_CERT_FILE: ca, CURL_CA_BUNDLE: ca, GIT_SSL_CAINFO: ca, REQUESTS_CA_BUNDLE: ca, PIP_CERT: ca,
    ...Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'npm_config_proxy', 'npm_config_https_proxy'].map((k) => [k, proxy])),
    NO_PROXY: '', no_proxy: '', ALL_PROXY: '', all_proxy: '',
    // Settings that name a program npm runs while installing: env outranks the pull request's .npmrc
    // (git=./x.sh would run for a git dependency even with --ignore-scripts)
    npm_config_git: fs.existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git', npm_config_script_shell: '/bin/sh', npm_config_node_options: '', npm_config_shell: '/bin/sh' };
  // git settings that name a program, over any repository config git finds (env outranks it)
  const gitPins = { 'core.hooksPath': '/dev/null', 'gc.auto': '0', 'core.sshCommand': 'ssh', 'core.fsmonitor': 'false', 'core.askPass': '', 'core.gitProxy': '',
    'credential.helper': '', 'protocol.ext.allow': 'never', 'diff.external': '', 'core.pager': 'cat', 'uploadpack.packObjectsHook': '' };
  Object.assign(setupEnv, { GIT_CONFIG_COUNT: String(Object.keys(gitPins).length), GIT_CONFIG_NOSYSTEM: '1',
    ...Object.fromEntries(Object.entries(gitPins).flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])) });
  const [cmd, args] = jail.wrap('/bin/sh', ['-c', command], { denyRead: sandbox.denyRead, allowWrite: [cwd, path.join(home, 'cache'), tmp, ...PNPM_LOCKS],
    denyWrite: [path.join(cwd, '.git')], ports: [sandbox.port] });
  return new Promise((resolve) => {
    // Its own process group, so nothing it starts in the background outlives it
    const child = spawn(cmd, args, { cwd, env: setupEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (d) => { output = (output + d).slice(-64 * 1024); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { output += '\ntimed out'; killGroup(); }, timeoutMs);
    child.on('error', (e) => { output += e.message; });
    let code = null;
    // On exit, not on close: something left in the background holds the output open
    child.on('exit', (c) => {
      code = c;
      clearTimeout(timer);
      killGroup();
    });
    child.on('close', () => {
      if (code === 0) return resolve({ ok: true });
      resolve({ ok: false, output: output.trim().split('\n').slice(-20).join('\n') || `exit ${code}` });
    });
  });
}

// Removes the worktree and docket-gits' branches of a pull request that is gone from the board
async function removeWorkspace(pr, { workdir, home = HOME }) {
  const clone = path.join(home, 'repos', ...pr.repo.split('/'));
  if (!fs.existsSync(path.join(clone, '.git'))) return;
  await withLock(clone, async () => {
    await git(['-C', clone, 'worktree', 'remove', '--force', worktreeOf(pr, home)]).catch(() => fs.rmSync(worktreeOf(pr, home), { recursive: true, force: true }));
    await git(['-C', clone, 'worktree', 'prune']).catch(() => {});
    const refs = (await git(['-C', clone, 'for-each-ref', '--format=%(refname)', `refs/heads/docket/pr-${pr.number}`, `refs/heads/docket/pr-${pr.number}-*`, `refs/docket/pull/${pr.number}`])).split('\n').filter(Boolean);
    for (const ref of refs) await git(['-C', clone, 'update-ref', '-d', ref]).catch(() => {});
  });
}

module.exports = { HOME, REGISTRIES, SECRET_PATHS, deniedPaths, PNPM_LOCKS, workspaceNote, agentEnv, runEnv, runTmpOf, agentSettings, agentToolDeny, agentArgs, findClone, ensureClone, adminDirOf, prepareWorkspace, removeWorkspace, runSetup, worktreeOf, branchOf, git };
