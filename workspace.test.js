'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const jail = require('./jail');
const { agentEnv, runEnv, runTmpOf, agentSettings, agentArgs, findClone, prepareWorkspace, removeWorkspace, workspaceNote, runSetup } = require('./workspace');

const sh = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }).trim();
const tmpdir = (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docket-ws-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('agentEnv: keeps what claude and toolchains need, drops secrets, points gh at the gatekeeper and caches at docket-gits', () => {
  const env = agentEnv({ HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '1', RBENV_VERSION: '3.3', CLAUDECODE: '1', GITHUB_TOKEN: 'w', GH_TOKEN: 'w', SSH_AUTH_SOCK: '/s', NPM_TOKEN: 'n' }, { home: '/d' });
  for (const k of ['HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'RBENV_VERSION']) assert.ok(k in env, k);
  for (const k of ['CLAUDECODE', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'NPM_TOKEN']) assert.ok(!(k in env), k);
  assert.equal(env.GH_TOKEN, 'docket-gits');
  assert.equal(env.GH_CONFIG_DIR, `/d/gh-${process.env.PORT || 4649}`);
  assert.equal(env.npm_config_store_dir, '/d/cache/pnpm-store');
  assert.equal(env.GIT_CONFIG_KEY_0, 'core.hooksPath');
});

test('agentEnv: pnpm keeps the versions it fetches for packageManager in the cache, not in the user\'s pnpm home', () => {
  const env = agentEnv({ PATH: '/bin', PNPM_HOME: '/Users/u/Library/pnpm' }, { home: '/d' });
  assert.equal(env.PNPM_HOME, '/d/cache/pnpm-home');
});

test('runEnv: KEY=VALUE lines the user set reach a run, but never replace what keeps the run in its fence', () => {
  const extra = runEnv('DB_PASSWORD=p=w\n# comment\n  RAILS_ENV = test \nbad key=x\nnoequals\nGH_TOKEN=leak\nGIT_CONFIG_VALUE_0=hooks\nPNPM_HOME=/x\n');
  assert.deepEqual(extra, { DB_PASSWORD: 'p=w', RAILS_ENV: 'test', GH_TOKEN: 'leak', GIT_CONFIG_VALUE_0: 'hooks', PNPM_HOME: '/x' });
  assert.deepEqual(runEnv(undefined), {});
  const env = agentEnv({ PATH: '/bin' }, { home: '/d', extra });
  assert.equal(env.DB_PASSWORD, 'p=w');
  assert.equal(env.RAILS_ENV, 'test');
  assert.equal(env.GH_TOKEN, 'docket-gits');
  assert.equal(env.GIT_CONFIG_VALUE_0, '/dev/null');
  assert.equal(env.PNPM_HOME, '/d/cache/pnpm-home');
});

test('agentEnv: cloud credentials only reach a run when claude itself uses that cloud', () => {
  const secrets = { AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 's', GOOGLE_APPLICATION_CREDENTIALS: '/g', CLOUD_ML_REGION: 'r', VERTEX_REGION_X: 'r' };
  const plain = agentEnv({ PATH: '/bin', ...secrets }, { home: '/d' });
  for (const k of Object.keys(secrets)) assert.ok(!(k in plain), k);
  const bedrock = agentEnv({ PATH: '/bin', CLAUDE_CODE_USE_BEDROCK: '1', ...secrets }, { home: '/d' });
  assert.ok('AWS_SECRET_ACCESS_KEY' in bedrock && !('GOOGLE_APPLICATION_CREDENTIALS' in bedrock));
  const vertex = agentEnv({ PATH: '/bin', CLAUDE_CODE_USE_VERTEX: '1', ...secrets }, { home: '/d' });
  assert.ok('GOOGLE_APPLICATION_CREDENTIALS' in vertex && 'CLOUD_ML_REGION' in vertex && !('AWS_SECRET_ACCESS_KEY' in vertex));
});

test('agentArgs: settings in the pull request are not loaded; the working directory\'s skills come as a plugin', (t) => {
  const home = tmpdir(t);
  const ws = { cwd: '/wt' };
  const bare = agentArgs({ ws, workdir: path.join(home, 'none'), dataDir: '/data', home });
  assert.equal(bare[bare.indexOf('--setting-sources') + 1], 'user');
  assert.ok(!bare.includes('--plugin-dir'));
  const workdir = path.join(home, 'w');
  fs.mkdirSync(path.join(workdir, '.claude', 'skills', 'review'), { recursive: true });
  fs.writeFileSync(path.join(workdir, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\n');
  const args = agentArgs({ ws, workdir, dataDir: '/data', home });
  const plugin = args[args.indexOf('--plugin-dir') + 1];
  assert.ok(plugin.startsWith(home + path.sep), plugin);
  assert.ok(fs.existsSync(path.join(plugin, 'skills', 'review', 'SKILL.md')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'workdir');
  // Same working directory, same plugin
  assert.equal(agentArgs({ ws, workdir, dataDir: '/data', home })[args.indexOf('--plugin-dir') + 1], plugin);
});

test('agentEnv: git really skips hooks with that env', (t) => {
  const dir = tmpdir(t);
  const env = agentEnv(process.env, { home: dir });
  const git = (...a) => execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@example.com', ...a], { cwd: dir, env, stdio: 'pipe' });
  git('init', '-q');
  fs.mkdirSync(path.join(dir, '.husky'));
  fs.writeFileSync(path.join(dir, '.husky', 'pre-commit'), '#!/bin/sh\ntouch ran\n', { mode: 0o755 });
  git('config', 'core.hooksPath', '.husky');
  git('commit', '-q', '--allow-empty', '-m', 'x');
  assert.ok(!fs.existsSync(path.join(dir, 'ran')));
});

test('agentSettings / agentArgs: what a commit needs is writable; config, hooks and other branches are not', () => {
  const ws = { cwd: '/wt', gitDir: '/c/.git', adminDir: '/c/.git/worktrees/x' };
  const s = agentSettings({ ws, dataDir: '/data', home: '/d', socket: '/sock' }).sandbox;
  assert.equal(s.failIfUnavailable, true);
  assert.equal(s.allowUnsandboxedCommands, false);
  // The run's own temp folder (CLAUDE_CODE_TMPDIR): short enough for socket paths, and dev servers may make sockets there
  const tmp = runTmpOf(ws);
  assert.ok(tmp.length <= 30 && runTmpOf({ cwd: '/other' }) !== tmp, tmp);
  assert.deepEqual(s.network.allowUnixSockets, ['/sock', tmp]);
  // File watching (fs.watch, dev servers) needs FSEvents on macOS
  assert.deepEqual(s.network.allowMachLookup, ['com.apple.FSEvents']);
  assert.equal(s.network.allowLocalBinding, true);
  assert.ok(s.network.allowedDomains.includes('registry.npmjs.org') && !s.network.allowedDomains.some((d) => /github/.test(d)));
  // The Go proxy fetches any module path from any host: allowing it would let a run send data anywhere
  assert.ok(!s.network.allowedDomains.some((d) => /golang/.test(d)));
  const uid = process.getuid();
  assert.deepEqual(s.filesystem.allowWrite, ['/wt', '/d/cache', `/tmp/pnpm-store-operation-locks-${uid}`, `/tmp/pnpm-dir-locks-${uid}`, tmp, '/c/.git/objects', '/c/.git/worktrees/x', '/c/.git/refs/heads/docket', '/c/.git/logs/refs/heads/docket']);
  for (const p of ['/c/.git/config', '/c/.git/hooks', '/c/.git/packed-refs', '/c/.git/worktrees/x/commondir', '/c/.git/worktrees/x/gitdir']) assert.ok(s.filesystem.denyWrite.includes(p), p);
  for (const p of ['~/.ssh', '~/.config/gh', '~/Library/Keychains', '~/.config/git/credentials', '~/.config/github-copilot', '/data']) assert.ok(s.filesystem.denyRead.includes(p), p);
  for (const p of ['~/Library/Application Support/docket-jobs', path.join(path.dirname(__dirname), 'docket', 'data')]) assert.ok(s.filesystem.denyRead.includes(p), p);
  const args = agentArgs({ ws, workdir: '/w', dataDir: '/data', deny: ['Write'], network: { allowLocal: false, domains: [] } });
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]).sandbox.network;
  assert.equal(settings.allowLocalBinding, false);
  // The working directory is added so skills load, which would make it writable: it is denied
  assert.ok(JSON.parse(args[args.indexOf('--settings') + 1]).sandbox.filesystem.denyWrite.includes('/w'));
  assert.deepEqual(settings.allowedDomains, []);
  assert.equal(args[args.indexOf('--add-dir') + 1], '/w');
  assert.ok(args.includes('--strict-mcp-config'));
  for (const r of ['Read(~/.ssh/**)', 'Read(//data/**)', 'Edit(//w/**)', 'WebFetch', 'Write']) assert.ok(args[args.indexOf('--disallowedTools') + 1].split(',').includes(r), r);
});

test('findClone: the clone whose remote is the repository, wherever it is under the working directory', (t) => {
  const w = tmpdir(t);
  const clone = (rel, url) => {
    const dir = path.join(w, rel);
    fs.mkdirSync(dir, { recursive: true });
    sh(dir, 'init', '-q');
    sh(dir, 'remote', 'add', 'origin', url);
    return dir;
  };
  clone('other', 'git@github.com:acme/apiserver.git');
  const want = clone('repos/api', 'git@github.com:acme/api.git');
  fs.mkdirSync(path.join(w, 'repos', 'api', 'node_modules', 'x'), { recursive: true });
  // A worktree (.git is a file) is not a clone
  fs.mkdirSync(path.join(w, 'aaa'));
  fs.writeFileSync(path.join(w, 'aaa', '.git'), 'gitdir: /elsewhere\n');
  assert.equal(findClone(w, 'acme/api'), want);
  assert.equal(findClone(w, 'ACME/API'), want);
  assert.equal(findClone(w, 'acme/web'), null);
  // Of several clones, the one named like the repository wins over one found first
  clone('aa-api-fix', 'git@github.com:acme/api.git');
  assert.equal(findClone(w, 'acme/api'), want);
  clone('https-clone', 'https://github.com/acme/web');
  assert.equal(findClone(w, 'acme/web'), path.join(w, 'https-clone'));
});

test('prepareWorkspace: a worktree per pull request at its head, reset each run, dependencies kept, removed when gone', async (t) => {
  const tmp = tmpdir(t);
  // A fake GitHub (bare repository with refs/pull/7/head) and the user's clone of it under the working directory
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  sh(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'a.js'), '1\n');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-q', '-m', 'base');
  sh(seed, 'checkout', '-q', '-b', 'feature');
  sh(seed, 'commit', '-q', '--allow-empty', '-m', 'feature');
  const origin = path.join(tmp, 'origins', 'acme', 'api.git');
  fs.mkdirSync(path.dirname(origin), { recursive: true });
  sh(tmp, 'clone', '-q', '--bare', seed, origin);
  sh(origin, 'update-ref', 'refs/pull/7/head', 'refs/heads/feature');
  process.env.DOCKET_CLONE_BASE = path.join(tmp, 'origins');
  t.after(() => { delete process.env.DOCKET_CLONE_BASE; });
  const workdir = path.join(tmp, 'work');
  const userClone = path.join(workdir, 'repos', 'api');
  fs.mkdirSync(path.dirname(userClone), { recursive: true });
  sh(tmp, 'clone', '-q', origin, userClone);
  sh(userClone, 'remote', 'set-url', 'origin', 'git@github.com:acme/api.git');
  const userState = () => [sh(userClone, 'branch', '--list'), sh(userClone, 'worktree', 'list'), fs.readFileSync(path.join(userClone, '.git', 'config'), 'utf8')];
  const before = userState();

  const home = path.join(tmp, 'home');
  const pr = { repo: 'acme/api', number: 7, base: 'main' };
  const ws = await prepareWorkspace(pr, { workdir, home });
  const clone = path.join(home, 'repos', 'acme', 'api');
  assert.equal(ws.clone, clone);
  // docket-gits' own clone borrows the objects of the user's clone
  assert.equal(fs.readFileSync(path.join(clone, '.git', 'objects', 'info', 'alternates'), 'utf8').trim(), path.join(userClone, '.git', 'objects'));
  assert.equal(ws.cwd, path.join(home, 'worktrees', 'acme-api-7'));
  assert.equal(ws.headSha, sh(origin, 'rev-parse', 'feature'));
  assert.equal(sh(ws.cwd, 'rev-parse', 'HEAD'), ws.headSha);
  assert.equal(sh(ws.cwd, 'branch', '--show-current'), 'docket/pr-7');
  assert.ok(ws.adminDir.startsWith(path.join(clone, '.git', 'worktrees')));
  assert.equal(sh(clone, 'rev-parse', 'origin/main'), sh(origin, 'rev-parse', 'main'));
  assert.match(fs.readFileSync(path.join(home, `gh-${process.env.PORT || 4649}`, 'config.yml'), 'utf8'), /^http_unix_socket: /);

  // A run's changes and commits go away next run; installed dependencies stay. A forged .git file is ignored
  fs.writeFileSync(path.join(ws.cwd, 'a.js'), 'changed\n');
  sh(ws.cwd, 'commit', '-q', '-am', 'local');
  fs.mkdirSync(path.join(ws.cwd, 'node_modules'));
  fs.writeFileSync(path.join(ws.cwd, 'node_modules', 'dep.js'), '');
  // A .git of the run's own (here a repository folder) is replaced by git's link
  fs.rmSync(path.join(ws.cwd, '.git'));
  sh(ws.cwd, 'init', '-q');
  // The clone's head moves on GitHub
  sh(seed, 'commit', '-q', '--allow-empty', '-m', 'more');
  sh(seed, 'push', '-q', origin, 'feature');
  sh(origin, 'update-ref', 'refs/pull/7/head', 'refs/heads/feature');
  const again = await prepareWorkspace(pr, { workdir, home });
  assert.equal(again.adminDir, ws.adminDir);
  assert.equal(again.headSha, sh(origin, 'rev-parse', 'feature'));
  assert.equal(sh(again.cwd, 'rev-parse', 'HEAD'), again.headSha);
  assert.equal(fs.readFileSync(path.join(again.cwd, '.git'), 'utf8'), `gitdir: ${again.adminDir}\n`);
  // Runs' git config: only the name and email of the user's
  const gc = fs.readFileSync(path.join(home, 'gitconfig'), 'utf8');
  assert.match(gc, /^\[user\]\n/);
  assert.doesNotMatch(gc, /url|insteadOf|extraHeader|credential/i);
  assert.equal(agentEnv({ PATH: '/bin' }, { home }).GIT_CONFIG_GLOBAL, path.join(home, 'gitconfig'));
  // The run is told where the user's clone is, to copy local settings from
  assert.equal(again.sourceClone, userClone);
  assert.match(workspaceNote(again, pr), new RegExp(`user's own clone of this repository is at ${userClone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(read-only\\)`));
  assert.match(workspaceNote({ ...again, sourceClone: null }, pr), /no local clone/);
  assert.match(workspaceNote(again, pr), /don't link dependency folders such as node_modules/);
  assert.match(workspaceNote(again, pr), /CI results don't replace this/);
  assert.match(workspaceNote(again, pr), /spend no more than a few minutes on it: don't debug the environment/);
  assert.match(workspaceNote(again, pr), /stop them with kill <PID> before your final answer/);
  assert.match(workspaceNote(again, pr), /is the user's, running their clone, not this pull request/);
  assert.match(workspaceNote(again, pr), /Browsers \(Playwright, Cypress, Puppeteer\) can't start in this sandbox/);
  // With the browser setting on, Playwright tests are run against the browser docket-gits starts outside
  // A review runs no checks: the note leaves out how to run tests, servers and browsers
  const noChecks = workspaceNote(again, pr, { checks: false });
  assert.match(noChecks, /user's own clone of this repository is at/);
  assert.doesNotMatch(noChecks, /CI results don't replace this|kill <PID>|Browsers|Playwright/);
  const withBrowser = workspaceNote(again, pr, { browser: true });
  assert.match(withBrowser, /PW_TEST_CONNECT_WS_ENDPOINT/);
  assert.match(withBrowser, /Cypress and Puppeteer still can't run/);
  assert.doesNotMatch(withBrowser, /don't try browser or E2E tests/);
  assert.match(workspaceNote(again, pr), /find out how this project runs them[\s\S]*Check, don't guess/);
  assert.match(workspaceNote(again, pr), /remove it before you finish/);
  assert.match(workspaceNote(again, pr), /branch docket\/pr-7; the base branch is at origin\/main/);
  assert.equal(fs.readFileSync(path.join(again.cwd, 'a.js'), 'utf8'), '1\n');
  assert.ok(fs.existsSync(path.join(again.cwd, 'node_modules', 'dep.js')));

  // A cached base branch that was deleted on GitHub (a stacked pull request whose parent merged) doesn't block the run
  const stale = { ...pr, base: 'gone-parent' };
  const staleWs = await prepareWorkspace(stale, { workdir, home });
  assert.equal(staleWs.headSha, again.headSha);
  assert.equal(staleWs.base, null);
  assert.doesNotMatch(workspaceNote(staleWs, stale), /base branch is at/);

  await removeWorkspace(pr, { workdir, home });
  assert.ok(!fs.existsSync(ws.cwd));
  assert.equal(sh(clone, 'branch', '--list', 'docket/*'), '');
  assert.equal(sh(clone, 'for-each-ref', 'refs/docket'), '');
  // The user's clone is never touched
  assert.deepEqual(userState(), before);
});

test('runSetup: nothing to run, or no OS sandbox to run it in, is not an error', async (t) => {
  const cwd = tmpdir(t);
  assert.deepEqual(await runSetup(cwd, ''), { ok: true });
  assert.deepEqual(await runSetup(cwd, 'touch ran'), { ok: true, skipped: true });
  assert.equal(fs.existsSync(path.join(cwd, 'ran')), false);
});

test('runSetup: runs in the sandbox, with no credentials and the network only through the setup proxy', { skip: !jail.available() && 'macOS only' }, async (t) => {
  const root = tmpdir(t);
  const cwd = path.join(root, 'wt');
  const home = path.join(root, 'home');
  const secret = path.join(root, 'secret');
  fs.mkdirSync(cwd);
  fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, 'token'), 'TOKEN');
  const userconfig = path.join(root, 'npmrc');
  fs.writeFileSync(userconfig, 'registry=https://registry.npmjs.org/\n');
  // A stand-in for the setup proxy: the only port the command may reach
  const proxy = require('node:http').createServer((q, s) => s.end('via proxy'));
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => proxy.close());
  const sandbox = { port: proxy.address().port, proxy: `http://docket:s@127.0.0.1:${proxy.address().port}`, certFile: userconfig, userconfig, denyRead: [secret] };
  const env = { ...process.env, NPM_TOKEN: 'server-secret', ANTHROPIC_API_KEY: 'claude-key', AWS_SECRET_ACCESS_KEY: 'aws', CLAUDE_CODE_USE_BEDROCK: '1' };
  const opts = { env, sandbox, home, extra: { DB_URL: 'postgres://localhost/test' } };

  const ok = await runSetup(cwd, [
    'echo "$DB_URL|$NPM_TOKEN$ANTHROPIC_API_KEY$AWS_SECRET_ACCESS_KEY|$HTTPS_PROXY|$npm_config_userconfig|$SSL_CERT_FILE|$CI" > out.txt',
    `cat ${secret}/token > read.txt 2>&1 || echo denied > read.txt`,
    `(echo x > ${root}/outside.txt) 2>/dev/null || echo denied > write.txt`,
    `curl -s -m 3 http://127.0.0.1:${sandbox.port}/ > proxy.txt`,
    'curl -s -m 3 https://1.1.1.1/ >/dev/null 2>&1 || echo denied > net.txt',
  ].join('; '), opts);
  assert.deepEqual(ok, { ok: true });
  const read = (f) => fs.readFileSync(path.join(cwd, f), 'utf8').trim();
  assert.equal(read('out.txt'), `postgres://localhost/test||${sandbox.proxy}|${userconfig}|${sandbox.certFile}|true`);
  assert.equal(read('read.txt'), 'denied');
  assert.equal(read('write.txt'), 'denied');
  assert.equal(fs.existsSync(path.join(root, 'outside.txt')), false);
  assert.equal(read('proxy.txt'), 'via proxy');
  assert.equal(read('net.txt'), 'denied');

  // Nothing it starts outlives it
  await runSetup(cwd, '(sleep 3; touch late.txt) & echo started', opts);
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(fs.existsSync(path.join(cwd, 'late.txt')), false);

  const bad = await runSetup(cwd, 'echo first; echo boom >&2; exit 3', opts);
  assert.equal(bad.ok, false);
  assert.match(bad.output, /boom/);
  const slow = await runSetup(cwd, 'sleep 5', { ...opts, timeoutMs: 200 });
  assert.equal(slow.ok, false);
});

test('runSetup: a pull request\'s .npmrc can\'t name the programs npm runs (git=./x.sh runs even with --ignore-scripts)', { skip: !jail.available() && 'macOS only' }, async (t) => {
  const root = tmpdir(t);
  const cwd = path.join(root, 'wt');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', dependencies: { dep: 'git+ssh://git@example.com/x/dep.git' } }));
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ name: 'p', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
    '': { name: 'p', version: '1.0.0', dependencies: { dep: 'git+ssh://git@example.com/x/dep.git' } },
    'node_modules/dep': { version: '1.0.0', resolved: 'git+ssh://git@example.com/x/dep.git#a151093f2eb7dee1d699cfae7767890767cad630' } } }));
  fs.writeFileSync(path.join(cwd, 'evil.sh'), '#!/bin/sh\ntouch "$(dirname "$0")/ran"\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(cwd, '.npmrc'), 'git=./evil.sh\nscript-shell=./evil.sh\n');
  const userconfig = path.join(root, 'npmrc');
  fs.writeFileSync(userconfig, '');
  const sandbox = { port: 1, proxy: 'http://docket:s@127.0.0.1:1', certFile: userconfig, userconfig, denyRead: [] };
  await runSetup(cwd, 'npm ci --ignore-scripts --no-audit --no-fund', { sandbox, home: path.join(root, 'home') });
  assert.equal(fs.existsSync(path.join(cwd, 'ran')), false);
});

test('runSetup: a .git a run left in the worktree can\'t hand git a config of its own', { skip: !jail.available() && 'macOS only' }, async (t) => {
  const root = tmpdir(t);
  const cwd = path.join(root, 'wt');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', dependencies: { dep: 'git+ssh://git@example.com/x/dep.git' } }));
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ name: 'p', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
    '': { name: 'p', version: '1.0.0', dependencies: { dep: 'git+ssh://git@example.com/x/dep.git' } },
    'node_modules/dep': { version: '1.0.0', resolved: 'git+ssh://git@example.com/x/dep.git#a151093f2eb7dee1d699cfae7767890767cad630' } } }));
  fs.writeFileSync(path.join(cwd, 'evil.sh'), '#!/bin/sh\ntouch "$(dirname "$0")/ran"\nexit 1\n', { mode: 0o755 });
  // What a run could do: a repository of its own whose config names a program, and a .git pointing at it
  execFileSync('git', ['init', '-q', '--bare', path.join(cwd, '.evil')]);
  execFileSync('git', ['--git-dir', path.join(cwd, '.evil'), 'config', 'core.sshCommand', path.join(cwd, 'evil.sh')]);
  fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: .evil\n');
  const userconfig = path.join(root, 'npmrc');
  fs.writeFileSync(userconfig, '');
  const sandbox = { port: 1, proxy: 'http://docket:s@127.0.0.1:1', certFile: userconfig, userconfig, denyRead: [] };
  const home = path.join(root, 'home');
  await runSetup(cwd, 'npm ci --ignore-scripts --no-audit --no-fund', { sandbox, home });
  assert.equal(fs.existsSync(path.join(cwd, 'ran')), false);
  // ... nor write one
  await runSetup(cwd, 'echo "gitdir: elsewhere" > .git || true', { sandbox, home });
  assert.equal(fs.readFileSync(path.join(cwd, '.git'), 'utf8'), 'gitdir: .evil\n');
});

test('agentEnv: gives the Bash tool a longer time limit by default, which runEnv can change', () => {
  const env = agentEnv({ PATH: '/bin', BASH_DEFAULT_TIMEOUT_MS: '1' }, { home: '/d' });
  assert.equal(env.BASH_DEFAULT_TIMEOUT_MS, '300000');
  assert.equal(env.BASH_MAX_TIMEOUT_MS, '600000');
  assert.equal(agentEnv({ PATH: '/bin' }, { home: '/d', extra: { BASH_DEFAULT_TIMEOUT_MS: '120000' } }).BASH_DEFAULT_TIMEOUT_MS, '120000');
});
