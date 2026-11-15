'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { agentEnv, agentSettings, agentArgs, findClone, prepareWorkspace, removeWorkspace, workspaceNote } = require('./workspace');

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
  assert.deepEqual(s.network.allowUnixSockets, ['/sock']);
  assert.equal(s.network.allowLocalBinding, true);
  assert.ok(s.network.allowedDomains.includes('registry.npmjs.org') && !s.network.allowedDomains.some((d) => /github/.test(d)));
  assert.deepEqual(s.filesystem.allowWrite, ['/wt', '/d/cache', '/c/.git/objects', '/c/.git/worktrees/x', '/c/.git/refs/heads/docket', '/c/.git/logs/refs/heads/docket']);
  for (const p of ['/c/.git/config', '/c/.git/hooks', '/c/.git/packed-refs', '/c/.git/worktrees/x/commondir', '/c/.git/worktrees/x/gitdir']) assert.ok(s.filesystem.denyWrite.includes(p), p);
  for (const p of ['~/.ssh', '~/.config/gh', '~/Library/Keychains', '/data']) assert.ok(s.filesystem.denyRead.includes(p), p);
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
  // The clone's head moves on GitHub
  sh(seed, 'commit', '-q', '--allow-empty', '-m', 'more');
  sh(seed, 'push', '-q', origin, 'feature');
  sh(origin, 'update-ref', 'refs/pull/7/head', 'refs/heads/feature');
  const again = await prepareWorkspace(pr, { workdir, home });
  assert.equal(again.adminDir, ws.adminDir);
  assert.equal(again.headSha, sh(origin, 'rev-parse', 'feature'));
  assert.equal(sh(again.cwd, 'rev-parse', 'HEAD'), again.headSha);
  // The run is told where the user's clone is, to copy local settings from
  assert.equal(again.sourceClone, userClone);
  assert.match(workspaceNote(again, pr), new RegExp(`user's own clone of this repository is at ${userClone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(read-only\\)`));
  assert.match(workspaceNote({ ...again, sourceClone: null }, pr), /no local clone/);
  assert.match(workspaceNote(again, pr), /find out how this project runs them[\s\S]*Check, don't guess/);
  assert.match(workspaceNote(again, pr), /branch docket\/pr-7; the base branch is at origin\/main/);
  assert.equal(fs.readFileSync(path.join(again.cwd, 'a.js'), 'utf8'), '1\n');
  assert.ok(fs.existsSync(path.join(again.cwd, 'node_modules', 'dep.js')));

  await removeWorkspace(pr, { workdir, home });
  assert.ok(!fs.existsSync(ws.cwd));
  assert.equal(sh(clone, 'branch', '--list', 'docket/*'), '');
  assert.equal(sh(clone, 'for-each-ref', 'refs/docket'), '');
  // The user's clone is never touched
  assert.deepEqual(userState(), before);
});
