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
const { execFile } = require('node:child_process');
const { SOCKET, ghConfig } = require('./github-proxy');

const HOME = path.resolve(process.env.DOCKET_HOME || path.join(os.homedir(), '.docket-gits'));

// Package registries runs may reach to install dependencies. Publishing needs credentials, which runs can't read
const REGISTRIES = ['registry.npmjs.org', 'registry.yarnpkg.com', 'rubygems.org', 'index.rubygems.org', 'pypi.org', 'files.pythonhosted.org',
  'repo.maven.apache.org', 'repo1.maven.org', 'plugins.gradle.org', 'services.gradle.org', 'proxy.golang.org', 'sum.golang.org', 'crates.io', 'static.crates.io', 'index.crates.io'];

// Where credentials live. Bash in the sandbox can't read them, and the Read tool is denied them.
// ~/Library/Keychains: the macOS login keychain is a file, and without this `security` reads the gh token from it
const SECRET_PATHS = ['~/.ssh', '~/.config/gh', '~/Library/Keychains', '/Library/Keychains', '~/.aws', '~/.netrc', '~/.git-credentials',
  '~/.docker', '~/.kube', '~/.gnupg', '~/.npmrc', '~/.gem/credentials', '~/.pypirc', '~/.cargo/credentials.toml', '~/.codex', '~/.config/gcloud',
  '~/.claude.json', '~/.claude/.credentials.json', '~/.claude/settings.json', '~/.claude/settings.local.json'];

// The other docket apps' data (their sign-in secrets): with it a run could sign in to their APIs on local ports.
// Their default places (docket-jobs outside its clone, both in a clone next to this one) and any set in the env
const DOCKET_DATA_PATHS = ['~/Library/Application Support/docket-jobs', '~/.local/share/docket-jobs',
  ...['docket', 'docket-jobs'].map((r) => path.join(path.dirname(__dirname), r, 'data')),
  ...[process.env.DOCKET_PORTAL_DATA, process.env.DOCKET_JOBS_DATA_DIR].filter(Boolean).map((p) => path.resolve(p))];

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
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'gc.auto',
    GIT_CONFIG_VALUE_1: '0',
  };
}

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
      network: { allowedDomains: domains, allowUnixSockets: [socket], allowLocalBinding: Boolean(allowLocal) },
      filesystem: {
        denyRead: [...SECRET_PATHS, ...DOCKET_DATA_PATHS, dataDir],
        allowWrite: [ws.cwd, path.join(home, 'cache'), ...(git ? [path.join(git, 'objects'), ws.adminDir, path.join(git, 'refs', 'heads', 'docket'), path.join(git, 'logs', 'refs', 'heads', 'docket')] : [])],
        // The user's git runs these later, outside the sandbox; the server trusts the admin folder's links
        denyWrite: [...(workdir ? [workdir] : []), ...(git ? [path.join(git, 'config'), path.join(git, 'hooks'), path.join(git, 'info'), path.join(git, 'packed-refs'),
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
function workspaceNote(ws, pr) {
  return `## The folder of this run
- The current directory is a git worktree of the pull request at its head, on branch ${ws.branch}${pr.base ? `; the base branch is at origin/${pr.base}` : ''}.
- Files that are not in git (local settings such as .env files, installed dependencies, build output) are not here. ${ws.sourceClone ? `The user's own clone of this repository is at ${ws.sourceClone} (read-only): copy from it what you need to build or test.` : 'There is no local clone of this repository to copy them from.'} Install missing dependencies here (for example pnpm install / bundle install): don't link dependency folders such as node_modules from the user's clone, since tools write into them and the clone can't be written.
- Before running tests, find out how this project runs them and what they connect to (README, bin/ and scripts, config files, and the local settings in the user's clone). Services such as databases may already be running on local ports. Check, don't guess; if something still can't run, say exactly what you tried and what failed.
- Use the project's usual test setup (for example its usual test database) rather than creating new ones. If you do create anything outside this worktree (a database, files elsewhere), remove it before you finish; if you can't, list what is left in the summary.
- Commands run in a sandbox: the network reaches only package registries and local ports (for example a database the tests use), and only this worktree is writable.`;
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
    await git(['-C', clone, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/pull/${pr.number}/head:${pull}`, ...(pr.base ? [`+refs/heads/${pr.base}:refs/remotes/origin/${pr.base}`] : [])]);
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
    fs.mkdirSync(path.join(home, 'cache'), { recursive: true });
    fs.mkdirSync(ghDirOf(home), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ghDirOf(home), 'config.yml'), ghConfig());
    // sourceClone: the user's own clone, which the run may read (local settings, dependencies that aren't in git)
    return { cwd, clone, gitDir, adminDir, headSha, branch: branchOf(pr), sourceClone: findClone(workdir, pr.repo) };
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

module.exports = { HOME, REGISTRIES, SECRET_PATHS, workspaceNote, agentEnv, runEnv, agentSettings, agentToolDeny, agentArgs, findClone, ensureClone, adminDirOf, prepareWorkspace, removeWorkspace, worktreeOf, branchOf, git };
