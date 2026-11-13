'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { collectResult, patchFiles, replyEndpoint, fillLinks, publish, applyHandback } = require('./publish');
const { git: serverGit } = require('./workspace');

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
const sh = (cwd, ...a) => execFileSync('git', [...ID, ...a], { cwd, encoding: 'utf8' }).trim();

// A fake GitHub: a bare repository with main, the pull request branch feature and refs/pull/1/head
function setup(t) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docket-pub-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const origin = path.join(tmp, 'origin.git');
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
  sh(tmp, 'clone', '-q', '--bare', seed, origin);
  sh(origin, 'update-ref', 'refs/pull/1/head', 'refs/heads/feature');
  const pr = { repo: 'acme/api', number: 1, url: 'https://github.com/acme/api/pull/1', head: 'feature', base: 'main' };
  // The run's clone: two fixes on the pull request branch and a split from main, written as patches
  const run = path.join(tmp, 'run');
  const out = path.join(tmp, 'out');
  sh(tmp, 'clone', '-q', origin, run);
  sh(run, 'checkout', '-q', 'feature');
  fs.writeFileSync(path.join(run, 'a.js'), 'const a = 1;\n');
  sh(run, 'commit', '-q', '-am', 'Use const for a');
  fs.writeFileSync(path.join(run, 'b.js'), 'const b = 2;\n');
  sh(run, 'commit', '-q', '-am', 'Use const for b');
  const fixes = sh(run, 'rev-list', '--reverse', 'origin/feature..HEAD').split('\n');
  sh(run, 'format-patch', '-q', 'origin/feature..HEAD', '-o', path.join(out, 'head'));
  sh(run, 'checkout', '-q', '-b', 'split-docs', 'origin/main');
  fs.writeFileSync(path.join(run, 'README.md'), '# api\n');
  sh(run, 'add', '.');
  sh(run, 'commit', '-q', '-m', 'Add the README');
  sh(run, 'format-patch', '-q', 'origin/main..HEAD', '-o', path.join(out, 'split'));
  const answer = {
    done: true, error: null, summary: 'Fixed two comments and split the README',
    branches: [{ key: 'head', name: 'feature', base: null, patchDir: path.join(out, 'head'), pull: null },
      { key: 'split', name: 'split-docs', base: 'main', patchDir: 'split', pull: { title: 'Add the README', body: 'Split from #1. Follow-up: {issue:docs}' } }],
    issues: [{ key: 'docs', title: 'Write the docs', body: 'From {pull:split}', parent: 9 }],
    review: null,
    replies: [{ to: `${pr.url}#discussion_r55`, body: `Fixed ( commit ${fixes[0].slice(0, 7)} )` }, { to: `${pr.url}#issuecomment-66`, body: `Split into {pull:split}, ${fixes[1]}` }],
  };
  // clone(base): a clean clone of the fake GitHub at the pull request head, or at base for a split
  const clone = async (base) => {
    const dir = fs.mkdtempSync(path.join(tmp, 'pub-')) + '/repo';
    sh(tmp, 'clone', '-q', origin, dir);
    sh(dir, 'checkout', '-q', base ? `origin/${base}` : 'origin/feature');
    return dir;
  };
  const calls = [];
  const rest = async (method, endpoint, body) => {
    calls.push([method, endpoint, body]);
    const n = calls.length;
    return { id: n, html_url: `https://github.com/acme/api/${endpoint.endsWith('/pulls') ? 'pull' : 'x'}/${n}` };
  };
  const headSha = sh(origin, 'rev-parse', 'feature');
  return { tmp, origin, pr, run, out, fixes, answer, clone, calls, rest, headSha };
}

test('collectResult: reads the patches, flags CI and executable changes, and refuses what it must not publish', (t) => {
  const { pr, out, answer } = setup(t);
  const result = collectResult(answer, out, pr);
  assert.deepEqual(result.branches.map((b) => [b.key, b.name, b.base, b.patches.map((p) => p.subject)]),
    [['head', 'feature', null, ['Use const for a', 'Use const for b']], ['split', 'split-docs', 'main', ['Add the README']]]);
  assert.deepEqual(result.branches[0].patches[0].files, ['a.js']);
  assert.deepEqual(result.risky, []);
  assert.deepEqual(patchFiles('diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\nnew file mode 100755\n').risky, ['.github/workflows/ci.yml', '(executable file)']);

  const bad = (change, message) => assert.throws(() => collectResult({ ...answer, ...change }, out, pr), message);
  bad({ done: false, error: 'tests failed' }, /tests failed/);
  bad({ branches: [{ ...answer.branches[0], name: 'main' }] }, /pull request branch is feature/);
  bad({ branches: [{ ...answer.branches[1], name: 'feature' }] }, /Invalid split branch/);
  bad({ branches: [{ ...answer.branches[1], name: '-x' }] }, /Invalid branch name/);
  bad({ branches: [{ ...answer.branches[1], patchDir: '../../etc' }] }, /outside the run's folder/);
  bad({ replies: [{ to: 'https://github.com/acme/other/pull/1#discussion_r1', body: 'x' }] }, /another page/);
  bad({ replies: [{ to: 'https://github.com/acme/api/pull/10#discussion_r1', body: 'x' }] }, /another page/);
});

test('replyEndpoint / fillLinks: thread replies, PR comments, and links filled in', () => {
  const pr = { repo: 'o/r', number: 3 };
  assert.equal(replyEndpoint(pr, 'https://github.com/o/r/pull/3#discussion_r12'), 'repos/o/r/pulls/3/comments/12/replies');
  assert.equal(replyEndpoint(pr, 'https://github.com/o/r/pull/3#issuecomment-5'), 'repos/o/r/issues/3/comments');
  assert.equal(replyEndpoint(pr, 'finding:2', { 2: 77 }), 'repos/o/r/pulls/3/comments/77/replies');
  assert.equal(replyEndpoint(pr, 'finding:4', {}), null);
  const from = 'a'.repeat(40);
  const to = 'b'.repeat(40);
  assert.equal(fillLinks(`see ${from.slice(0, 7)} and ${from} in {pull:p} / {issue:i} / {issue:none}`, { shas: { [from]: to }, pulls: { p: 'P' }, issues: { i: 'I' } }),
    `see ${to.slice(0, 7)} and ${to} in P / I / {issue:none}`);
});

test('publish: pushes the patches to the PR branch and a new branch, then issues, the Draft PR and replies, once', async (t) => {
  const { origin, pr, out, fixes, answer, clone, calls, rest, headSha } = setup(t);
  const result = collectResult(answer, out, pr, headSha);
  const deps = { git: (a) => serverGit(a), rest, read: async () => [], clone };
  const progress = await publish(pr, result, {}, deps);

  const pushed = sh(origin, 'log', '--format=%s', 'feature').split('\n');
  assert.deepEqual(pushed.slice(0, 3), ['Use const for b', 'Use const for a', 'feature']);
  assert.deepEqual(sh(origin, 'log', '--format=%s', 'split-docs').split('\n'), ['Add the README', 'base']);
  const published = sh(origin, 'rev-list', '--reverse', 'feature~2..feature').split('\n');
  // Applied again, the commits get new SHAs (committer and date differ); replies use the published ones
  assert.equal(progress.shas[fixes[0]], published[0]);
  assert.equal(progress.shas[fixes[1]], published[1]);
  assert.equal(progress.shas[result.branches[1].patches[0].from], sh(origin, 'rev-parse', 'split-docs'));

  assert.deepEqual(calls.map(([m, e]) => `${m} ${e}`), ['POST repos/acme/api/issues', 'POST repos/acme/api/issues/9/sub_issues', 'POST repos/acme/api/pulls',
    'POST repos/acme/api/pulls/1/comments/55/replies', 'POST repos/acme/api/issues/1/comments']);
  assert.deepEqual(calls[1][2], { sub_issue_id: 1 });
  assert.deepEqual(calls[2][2], { title: 'Add the README', body: 'Split from #1. Follow-up: https://github.com/acme/api/x/1', head: 'split-docs', base: 'main', draft: true });
  assert.equal(calls[3][2].body, `Fixed ( commit ${published[0].slice(0, 7)} )`);
  assert.equal(calls[4][2].body, `Split into https://github.com/acme/api/pull/3, ${published[1]}`);

  // A retry does nothing again
  await publish(pr, result, progress, deps);
  assert.equal(calls.length, 5);
});

test('publish: refuses when the PR branch moved, and when a split branch already exists', async (t) => {
  const { tmp, origin, pr, out, answer, clone, rest, headSha } = setup(t);
  const result = collectResult(answer, out, pr, headSha);
  const deps = { git: (a) => serverGit(a), rest, read: async () => [], clone };
  const other = path.join(tmp, 'other');
  sh(tmp, 'clone', '-q', origin, other);
  sh(other, 'checkout', '-q', 'feature');
  sh(other, 'commit', '-q', '--allow-empty', '-m', 'someone else');
  sh(other, 'push', '-q', 'origin', 'feature');
  await assert.rejects(publish(pr, result, {}, deps), /moved since the run/);

  sh(other, 'push', '-q', 'origin', 'HEAD:refs/heads/split-docs');
  await assert.rejects(publish(pr, { ...result, branches: [result.branches[1]] }, {}, deps), /already exists/);
});

test('publish: a self-review is posted with comments on their lines, and replies go to those comments', async (t) => {
  const { pr, clone } = setup(t);
  const calls = [];
  const rest = async (method, endpoint, body) => { calls.push([endpoint, body]); return { id: 40, html_url: 'https://github.com/acme/api/pull/1#pullrequestreview-40' }; };
  const read = async () => [{ id: 701, path: 'a.js', line: 1 }];
  const result = { branches: [], issues: [], review: { body: 'Self-review', comments: [{ no: 1, body: 'Use const' }, { no: 2, body: 'General note' }] },
    replies: [{ to: 'finding:1', body: 'Fixed' }, { to: 'finding:2', body: 'No line to reply to' }] };
  await publish(pr, result, {}, { git: serverGit, rest, read, clone, findings: [{ no: 1, path: 'a.js', line: 1 }, { no: 2 }] });
  assert.deepEqual(calls, [
    ['repos/acme/api/pulls/1/reviews', { event: 'COMMENT', body: 'Self-review\n\nGeneral note', comments: [{ path: 'a.js', line: 1, side: 'RIGHT', body: 'Use const' }] }],
    ['repos/acme/api/pulls/1/comments/701/replies', { body: 'Fixed' }],
  ]);
});

test('applyHandback: tells the run where to write patches and that it cannot publish', () => {
  const text = applyHandback({ url: 'https://github.com/o/r/pull/1', head: 'feat' }, '/run/out');
  assert.match(text, /git format-patch .* -o \/run\/out\/<key>/);
  assert.match(text, /read-only token/);
  assert.match(text, /name "feat"/);
});
