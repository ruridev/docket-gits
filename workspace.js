'use strict';

// The environment docket-gits gives its Claude runs.
// A run never holds a way to write to GitHub: it gets a read-only token, its Bash commands run in
// Claude Code's sandbox (no credential stores, network only to GitHub, writes only to its own folder),
// and it works in a throwaway clone of the pull request. GitHub writes are done by the server.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const WORK_ROOT = path.resolve(process.env.DOCKET_WORK || path.join(os.tmpdir(), 'docket-gits-work'));

const GITHUB_DOMAINS = ['github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com'];

// Where credentials live. Bash in the sandbox can't read them, and the Read tool is denied them.
// ~/Library/Keychains: the macOS login keychain is a file, and without this `security` reads the gh token from it
const SECRET_PATHS = ['~/.ssh', '~/.config/gh', '~/Library/Keychains', '/Library/Keychains', '~/.aws', '~/.netrc', '~/.git-credentials',
  '~/.docker', '~/.kube', '~/.gnupg', '~/.npmrc', '~/.codex', '~/.config/gcloud', '~/.claude.json', '~/.claude/.credentials.json',
  '~/.claude/settings.json', '~/.claude/settings.local.json'];

// Env vars a run keeps. Everything else (GITHUB_TOKEN, SSH_AUTH_SOCK, other tools' secrets) is dropped.
// CLAUDECODE and the like are dropped too: claude refuses to start nested in another session
const ENV_KEEP = /^(HOME|USER|LOGNAME|PATH|SHELL|LANG|LC_\w+|TERM|TMPDIR|TZ|NODE_EXTRA_CA_CERTS|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy|ANTHROPIC_\w+|CLAUDE_CONFIG_DIR|CLAUDE_CODE_USE_\w+|AWS_\w+|CLOUD_ML_REGION|VERTEX_\w+|GOOGLE_\w+)$/;

// Absolute paths in permission rules start with //
const abs = (p) => (p.startsWith('~') ? p : `/${p}`);

function agentEnv(env, { token, ghDir }) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => ENV_KEEP.test(k)));
  return {
    ...out,
    // gh and git (through gh's credential helper) use only this token; GH_CONFIG_DIR hides the user's gh login
    GH_TOKEN: token,
    GH_CONFIG_DIR: ghDir,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    // No git hooks: a run could write a hook script and then commit to run it
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
  };
}

// --settings for a run. envPath: env.PATH in ~/.claude/settings.json would replace the server's PATH, so pass it again
function agentSettings({ runDir, workdir, dataDir, envPath }) {
  return {
    ...(envPath && { env: { PATH: envPath } }),
    sandbox: {
      enabled: true,
      // No sandbox, no run: without it the token rules above are the only fence
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: GITHUB_DOMAINS },
      filesystem: { denyRead: [...SECRET_PATHS, dataDir], allowWrite: [runDir], denyWrite: workdir ? [workdir] : [] },
    },
  };
}

// Rules for Claude's own tools, which the sandbox does not cover: no reading credentials or docket-gits' data,
// no editing the working directory (only the run's clone), and no web access
function agentToolDeny({ workdir, dataDir }) {
  return [
    ...[...SECRET_PATHS, dataDir].map((p) => `Read(${abs(p)}/**)`),
    ...(workdir ? ['Edit', 'Write', 'NotebookEdit'].map((t) => `${t}(${abs(workdir)}/**)`) : []),
    'WebFetch', 'WebSearch',
  ];
}

// Claude CLI options for a run in runDir. workdir: the user's working directory, added read-only so its
// skills (.claude/skills) and other repositories can be read. deny: more rules for the run's mode.
// --strict-mcp-config: the user's MCP servers run outside the sandbox, so a run gets none of them
function agentArgs({ runDir, workdir, dataDir, envPath, deny = [] }) {
  return ['--settings', JSON.stringify(agentSettings({ runDir, workdir, dataDir, envPath })), ...(workdir ? ['--add-dir', workdir] : []),
    '--strict-mcp-config', '--disallowedTools', [...agentToolDeny({ workdir, dataDir }), ...deny].join(',')];
}

function git(args, opts = {}) {
  return new Promise((resolve, reject) => {
    // Server-side git uses the user's gh login over https, never a config from the clone it runs in
    execFile('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', '-c', 'core.hooksPath=/dev/null', ...args],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 16 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n').pop())) : resolve(stdout)));
  });
}

// A throwaway folder for one run: <runDir>/gh (empty gh config) and, with clone, <runDir>/repo checked out at the pull request head.
// workdir/<repo name>, when it is a clone, lends its objects (--reference) so the clone is fast
// DOCKET_CLONE_BASE: a local folder of <owner>/<name>.git repositories to clone from instead of GitHub (tests)
const remoteOf = (repo) => (process.env.DOCKET_CLONE_BASE ? path.join(process.env.DOCKET_CLONE_BASE, `${repo}.git`) : `https://github.com/${repo}.git`);

async function prepareWorkspace(pr, { runId, workdir, clone = true, root = WORK_ROOT, remote = remoteOf(pr.repo) }) {
  const runDir = path.join(root, `${pr.repo.replace(/\W+/g, '_')}-${pr.number}-${runId}`);
  const ghDir = path.join(runDir, 'gh');
  fs.mkdirSync(ghDir, { recursive: true, mode: 0o700 });
  if (!clone) return { runDir, ghDir, cwd: runDir };
  const repoDir = path.join(runDir, 'repo');
  const ref = workdir && path.join(workdir, pr.repo.split('/')[1]);
  const useRef = ref && fs.existsSync(path.join(ref, '.git'));
  try {
    await git(['clone', '--quiet', '--no-checkout', ...(useRef ? ['--reference', ref] : []), remote, repoDir]);
    await git(['-C', repoDir, 'fetch', '--quiet', 'origin', `+refs/pull/${pr.number}/head:refs/remotes/origin/pr/${pr.number}`]);
    await git(['-C', repoDir, 'checkout', '--quiet', '-B', pr.head || `pr-${pr.number}`, `refs/remotes/origin/pr/${pr.number}`]);
    // Inside the run, git over https asks gh, which answers with the read-only GH_TOKEN
    await git(['-C', repoDir, 'config', 'credential.helper', '']);
    await git(['-C', repoDir, 'config', '--add', 'credential.helper', '!gh auth git-credential']);
  } catch (e) {
    removeWorkspace(runDir, root);
    throw e;
  }
  return { runDir, ghDir, cwd: repoDir };
}

function removeWorkspace(runDir, root = WORK_ROOT) {
  if (!runDir || !path.resolve(runDir).startsWith(path.resolve(root) + path.sep)) return;
  fs.rmSync(runDir, { recursive: true, force: true });
}

// Folders left by runs that ended while the server was down. keep: folders of runs still going
function pruneWorkspaces(keep = new Set(), maxAgeMs = 24 * 3600e3, root = WORK_ROOT) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { return; }
  for (const name of names) {
    const dir = path.join(root, name);
    if (keep.has(dir)) continue;
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > maxAgeMs) removeWorkspace(dir, root);
    } catch { /* already gone */ }
  }
}

module.exports = { WORK_ROOT, SECRET_PATHS, GITHUB_DOMAINS, agentEnv, agentSettings, agentToolDeny, agentArgs, prepareWorkspace, removeWorkspace, pruneWorkspaces, git };
