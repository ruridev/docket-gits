'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { agentEnv, agentSettings, agentArgs, prepareWorkspace, removeWorkspace, pruneWorkspaces } = require('./workspace');

test('agentEnv: keeps what claude needs, drops other secrets, and gives gh only the read-only token', () => {
  const env = agentEnv({ HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDECODE: '1', GITHUB_TOKEN: 'write', GH_TOKEN: 'write', SSH_AUTH_SOCK: '/s', NPM_TOKEN: 'n' },
    { token: 'read', ghDir: '/run/gh' });
  assert.equal(env.HOME, '/h');
  assert.equal(env.ANTHROPIC_API_KEY, 'k');
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1');
  for (const k of ['CLAUDECODE', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'NPM_TOKEN']) assert.ok(!(k in env), k);
  assert.equal(env.GH_TOKEN, 'read');
  assert.equal(env.GH_CONFIG_DIR, '/run/gh');
  assert.equal(env.GIT_CONFIG_KEY_0, 'core.hooksPath');
});

test('agentEnv: git really skips hooks with that env', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-hooks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = agentEnv(process.env, { token: 'read', ghDir: dir });
  const git = (...a) => execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@example.com', ...a], { cwd: dir, env, stdio: 'pipe' });
  git('init', '-q');
  fs.mkdirSync(path.join(dir, '.husky'));
  fs.writeFileSync(path.join(dir, '.husky', 'pre-commit'), '#!/bin/sh\ntouch ran\n', { mode: 0o755 });
  git('config', 'core.hooksPath', '.husky');
  git('commit', '-q', '--allow-empty', '-m', 'x');
  assert.ok(!fs.existsSync(path.join(dir, 'ran')));
});

test('agentSettings / agentArgs: sandbox on and required, GitHub only, credentials and data unreadable, workdir read-only', () => {
  const s = agentSettings({ runDir: '/run', workdir: '/ws', dataDir: '/data', envPath: '/bin' }).sandbox;
  assert.equal(s.enabled, true);
  assert.equal(s.failIfUnavailable, true);
  assert.equal(s.allowUnsandboxedCommands, false);
  assert.ok(s.network.allowedDomains.every((d) => d === 'github.com' || d.endsWith('.github.com') || d.endsWith('.githubusercontent.com')));
  for (const p of ['~/.ssh', '~/.config/gh', '~/Library/Keychains', '/data']) assert.ok(s.filesystem.denyRead.includes(p), p);
  assert.deepEqual(s.filesystem.allowWrite, ['/run']);
  assert.deepEqual(s.filesystem.denyWrite, ['/ws']);
  const args = agentArgs({ runDir: '/run', workdir: '/ws', dataDir: '/data', deny: ['Write'] });
  assert.equal(args[args.indexOf('--add-dir') + 1], '/ws');
  assert.ok(args.includes('--strict-mcp-config'));
  const deny = args[args.indexOf('--disallowedTools') + 1].split(',');
  for (const r of ['Read(~/.ssh/**)', 'Read(//data/**)', 'Edit(//ws/**)', 'Write(//ws/**)', 'WebFetch', 'WebSearch', 'Write']) assert.ok(deny.includes(r), r);
});

test('prepareWorkspace: a throwaway clone at the pull request head, with gh as its only credential helper', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-ws-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }).trim();
  const origin = path.join(tmp, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(origin, 'checkout', '-q', '-b', 'feature');
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'change');
  const head = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'update-ref', 'refs/pull/7/head', head);
  git(origin, 'checkout', '-q', 'main');

  const root = path.join(tmp, 'work');
  const ws = await prepareWorkspace({ repo: 'acme/api', number: 7, head: 'feature' }, { runId: 'r1', root, remote: origin });
  assert.equal(ws.cwd, path.join(ws.runDir, 'repo'));
  assert.ok(ws.runDir.startsWith(root + path.sep));
  assert.equal(git(ws.cwd, 'rev-parse', 'HEAD'), head);
  assert.equal(git(ws.cwd, 'branch', '--show-current'), 'feature');
  // An empty value first resets helpers from the user's global config
  assert.deepEqual(git(ws.cwd, 'config', '--local', '--get-regexp', 'credential.helper').split('\n').map((l) => l.trim()), ['credential.helper', 'credential.helper !gh auth git-credential']);
  assert.ok(fs.statSync(ws.ghDir).isDirectory());

  // A clone that fails leaves nothing behind
  await assert.rejects(prepareWorkspace({ repo: 'acme/api', number: 8 }, { runId: 'r2', root, remote: origin }));
  assert.deepEqual(fs.readdirSync(root), [path.basename(ws.runDir)]);

  // Only folders under the work root are removed; stale ones are pruned, kept ones stay
  removeWorkspace(tmp, root);
  assert.ok(fs.existsSync(origin));
  const old = path.join(root, 'old');
  fs.mkdirSync(old);
  fs.utimesSync(old, new Date(0), new Date(0));
  pruneWorkspaces(new Set([ws.runDir]), 1000, root);
  assert.ok(!fs.existsSync(old) && fs.existsSync(ws.runDir));
  removeWorkspace(ws.runDir, root);
  assert.ok(!fs.existsSync(ws.runDir));
});
