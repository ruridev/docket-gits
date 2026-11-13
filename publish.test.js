'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { collectResult, changedFiles, replyEndpoint, fillLinks, publish, applyHandback } = require('./publish');
const { prepareWorkspace, git } = require('./workspace');

const sh = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }).trim();

// A fake GitHub (bare repository: main, feature, refs/pull/1/head), the user's clone of it, and the run's worktree
// with two fixes on the pull request branch and a split from main
async function setup(t) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docket-pub-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  sh(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'a.js'), 'let a = 1;\n');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-q', '-m', 'base');
  sh(seed, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(seed, 'b.js'), 'let b = 2;\n');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-q', '-m', 'feature');
  const origin = path.join(tmp, 'origins', 'acme', 'api.git');
  fs.mkdirSync(path.dirname(origin), { recursive: true });
  sh(tmp, 'clone', '-q', '--bare', seed, origin);
  sh(origin, 'update-ref', 'refs/pull/1/head', 'refs/heads/feature');
  process.env.DOCKET_CLONE_BASE = path.join(tmp, 'origins');
  t.after(() => { delete process.env.DOCKET_CLONE_BASE; });
  const workdir = path.join(tmp, 'work');
  fs.mkdirSync(workdir);
  const pr = { repo: 'acme/api', number: 1, url: 'https://github.com/acme/api/pull/1', head: 'feature', base: 'main' };
  const ws = await prepareWorkspace(pr, { workdir, home: path.join(tmp, 'home') });
  const { clone } = ws;
  // What the run does in its worktree
  fs.writeFileSync(path.join(ws.cwd, 'a.js'), 'const a = 1;\n');
  sh(ws.cwd, 'commit', '-q', '-am', 'Use const for a');
  fs.writeFileSync(path.join(ws.cwd, 'b.js'), 'const b = 2;\n');
  sh(ws.cwd, 'commit', '-q', '-am', 'Use const for b');
  const fixes = sh(ws.cwd, 'rev-list', '--reverse', `${ws.headSha}..HEAD`).split('\n');
  sh(ws.cwd, 'switch', '-q', '-c', 'docket/pr-1-docs', 'origin/main');
  fs.writeFileSync(path.join(ws.cwd, 'README.md'), '# api\n');
  sh(ws.cwd, 'add', '.');
  sh(ws.cwd, 'commit', '-q', '-m', 'Add the README');
  sh(ws.cwd, 'switch', '-q', 'docket/pr-1');
  const answer = {
    done: true, error: null, summary: 'Fixed two comments and split the README',
    branches: [{ key: 'head', name: 'feature', local: 'docket/pr-1', base: null, pull: null },
      { key: 'docs', name: 'split-docs', local: 'docket/pr-1-docs', base: 'main', pull: { title: 'Add the README', body: 'Split from #1. Follow-up: {issue:more}' } }],
    issues: [{ key: 'more', title: 'Write the docs', body: 'From {pull:docs}', parent: 9 }],
    review: null,
    replies: [{ to: `${pr.url}#discussion_r55`, body: `Fixed ( commit ${fixes[0].slice(0, 7)} )` }, { to: `${pr.url}#issuecomment-66`, body: 'Split into {pull:docs}' }],
  };
  const calls = [];
  const rest = async (method, endpoint, body) => {
    calls.push([method, endpoint, body]);
    return { id: calls.length, html_url: `https://github.com/acme/api/${endpoint.endsWith('/pulls') ? 'pull' : 'x'}/${calls.length}` };
  };
  const ctx = { pr, clone, headSha: ws.headSha, git };
  return { tmp, origin, seed, pr, ws, clone, fixes, answer, calls, rest, ctx };
}

test('collectResult: reads the commits from the clone, flags CI and executable changes, refuses what it must not publish', async (t) => {
  const { pr, ws, fixes, answer, ctx } = await setup(t);
  const result = await collectResult(answer, ctx);
  assert.deepEqual(result.branches.map((b) => [b.key, b.name, b.base, b.commits.map((c) => c.subject), b.files]),
    [['head', 'feature', null, ['Use const for a', 'Use const for b'], ['a.js', 'b.js']], ['docs', 'split-docs', 'main', ['Add the README'], ['README.md']]]);
  assert.deepEqual(result.branches[0].commits.map((c) => c.sha), fixes);
  assert.equal(result.branches[0].tip, fixes[1]);
  assert.deepEqual(result.risky, []);
  assert.deepEqual(changedFiles(':100644 100644 a b M\t.github/workflows/ci.yml\n:000000 100755 0 c A\tbin/run\n:100755 100755 a b M\tbin/old').risky, ['.github/workflows/ci.yml', 'bin/run (executable)']);

  const bad = (change, message) => assert.rejects(collectResult({ ...answer, ...change }, ctx), message);
  await bad({ done: false, error: 'tests failed' }, /tests failed/);
  await bad({ branches: [{ ...answer.branches[0], name: 'main' }] }, /pull request branch is feature/);
  await bad({ branches: [{ ...answer.branches[0], local: 'main' }] }, /pull request branch is feature/);
  await bad({ branches: [{ ...answer.branches[1], local: 'main' }] }, /Invalid split branch/);
  await bad({ branches: [{ ...answer.branches[1], name: 'feature' }] }, /Invalid split branch/);
  await bad({ branches: [{ ...answer.branches[1], name: '-x' }] }, /Invalid branch name/);
  await bad({ replies: [{ to: 'https://github.com/acme/other/pull/1#discussion_r1', body: 'x' }] }, /another page/);
  await bad({ replies: [{ to: 'https://github.com/acme/api/pull/10#discussion_r1', body: 'x' }] }, /another page/);
  // History rewritten under the pull request head is refused
  sh(ws.cwd, 'reset', '-q', '--hard', 'origin/main');
  sh(ws.cwd, 'commit', '-q', '--allow-empty', '-m', 'rewritten');
  await assert.rejects(collectResult(answer, ctx), /does not build on the pull request head/);
});

test('replyEndpoint / fillLinks: thread replies, PR comments, and links filled in', () => {
  const pr = { repo: 'o/r', number: 3 };
  assert.equal(replyEndpoint(pr, 'https://github.com/o/r/pull/3#discussion_r12'), 'repos/o/r/pulls/3/comments/12/replies');
  assert.equal(replyEndpoint(pr, 'https://github.com/o/r/pull/3#issuecomment-5'), 'repos/o/r/issues/3/comments');
  assert.equal(replyEndpoint(pr, 'finding:2', { 2: 77 }), 'repos/o/r/pulls/3/comments/77/replies');
  assert.equal(replyEndpoint(pr, 'finding:4', {}), null);
  assert.equal(fillLinks('{pull:p} / {issue:i} / {issue:none}', { pulls: { p: 'P' }, issues: { i: 'I' } }), 'P / I / {issue:none}');
});

test('publish: pushes exactly the checked commits to the PR branch and a new branch, then issues, the Draft PR and replies, once', async (t) => {
  const { origin, pr, clone, fixes, answer, calls, rest, ctx } = await setup(t);
  const result = await collectResult(answer, ctx);
  const deps = { clone, git, rest, read: async () => [] };
  const progress = await publish(pr, result, {}, deps);
  assert.equal(sh(origin, 'rev-parse', 'feature'), fixes[1]);
  assert.deepEqual(sh(origin, 'log', '--format=%s', 'split-docs').split('\n'), ['Add the README', 'base']);
  assert.deepEqual(calls.map(([m, e]) => `${m} ${e}`), ['POST repos/acme/api/issues', 'POST repos/acme/api/issues/9/sub_issues', 'POST repos/acme/api/pulls',
    'POST repos/acme/api/pulls/1/comments/55/replies', 'POST repos/acme/api/issues/1/comments']);
  assert.deepEqual(calls[1][2], { sub_issue_id: 1 });
  assert.deepEqual(calls[2][2], { title: 'Add the README', body: 'Split from #1. Follow-up: https://github.com/acme/api/x/1', head: 'split-docs', base: 'main', draft: true });
  // Pushed as they are, so the SHAs in replies stay right
  assert.equal(calls[3][2].body, `Fixed ( commit ${fixes[0].slice(0, 7)} )`);
  assert.equal(calls[4][2].body, 'Split into https://github.com/acme/api/pull/3');
  await publish(pr, result, progress, deps);
  assert.equal(calls.length, 5);
});

test('publish: refuses when the PR branch moved, and when a split branch already exists', async (t) => {
  const { tmp, origin, pr, clone, answer, rest, ctx } = await setup(t);
  const result = await collectResult(answer, ctx);
  const deps = { clone, git, rest, read: async () => [] };
  const other = path.join(tmp, 'other');
  sh(tmp, 'clone', '-q', origin, other);
  sh(other, 'checkout', '-q', 'feature');
  sh(other, 'commit', '-q', '--allow-empty', '-m', 'someone else');
  sh(other, 'push', '-q', 'origin', 'feature');
  await assert.rejects(publish(pr, result, {}, deps), /moved since the run/);
  sh(other, 'push', '-q', 'origin', 'HEAD:refs/heads/split-docs');
  await assert.rejects(publish(pr, { ...result, branches: [result.branches[1]] }, {}, deps), /already exists/);
});

test('publish: a self-review is posted with comments on their lines, and replies go to those comments', async () => {
  const calls = [];
  const rest = async (method, endpoint, body) => { calls.push([endpoint, body]); return { id: 40, html_url: 'https://github.com/acme/api/pull/1#pullrequestreview-40' }; };
  const read = async () => [{ id: 701, path: 'a.js', line: 1 }];
  const result = { branches: [], issues: [], review: { body: 'Self-review', comments: [{ no: 1, body: 'Use const' }, { no: 2, body: 'General note' }] },
    replies: [{ to: 'finding:1', body: 'Fixed' }, { to: 'finding:2', body: 'No line to reply to' }] };
  await publish({ repo: 'acme/api', number: 1 }, result, {}, { git, rest, read, findings: [{ no: 1, path: 'a.js', line: 1 }, { no: 2 }] });
  assert.deepEqual(calls, [
    ['repos/acme/api/pulls/1/reviews', { event: 'COMMENT', body: 'Self-review\n\nGeneral note', comments: [{ path: 'a.js', line: 1, side: 'RIGHT', body: 'Use const' }] }],
    ['repos/acme/api/pulls/1/comments/701/replies', { body: 'Fixed' }],
  ]);
});

test('applyHandback: tells the run to commit on docket/pr-<n> and that it cannot publish', () => {
  const text = applyHandback({ url: 'https://github.com/o/r/pull/4', number: 4, head: 'feat' });
  assert.match(text, /on branch docket\/pr-4 at its head/);
  assert.match(text, /git switch -c docket\/pr-4-<short-name> origin\/<base>/);
  assert.match(text, /gh here can only read/);
  assert.match(text, /name "feat", local "docket\/pr-4"/);
});
