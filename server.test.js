'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readRun, isAlive, searchQueries, filterByAuthors, usageOf, addUsage, childEnv, mergeBoard, fillTemplate, buildPostPrompt, extractTagJson, splitArgs, canDecideAll, RE_REQUEST_GRACE_MS } = require('./server');

const node = (number, repo = 'acme/api') => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
  isDraft: false,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  repository: { nameWithOwner: repo },
  author: { login: 'alice', avatarUrl: '' },
  labels: { nodes: [] },
  closingIssuesReferences: { nodes: [{ number: 9, title: 'issue', url: 'u', repository: { nameWithOwner: repo } }] },
  latestReviews: { nodes: [{ state: 'APPROVED', author: { login: 'bob', avatarUrl: '' } }] },
  reviewRequests: { nodes: [{ requestedReviewer: { login: 'me', avatarUrl: '' } }, { requestedReviewer: { name: 'team' } }] },
});

test('mergeBoard: 新規 PR は requested になり、関連 issue・レビュー状況を正規化する', () => {
  const prs = mergeBoard({}, [node(1)], 0);
  const e = prs['acme/api#1'];
  assert.equal(e.status, 'requested');
  assert.equal(e.active, true);
  assert.deepEqual(e.pr.issues.map((i) => i.repo), ['acme/api']);
  assert.deepEqual(e.pr.reviews, [{ state: 'APPROVED', login: 'bob', avatarUrl: '' }]);
  assert.deepEqual(e.pr.requested.map((r) => r.login), ['me']);
});

test('mergeBoard: 依頼が外れた PR は未着手なら消し、作業中・完了済みは残す', () => {
  const prev = {
    'acme/api#1': { status: 'requested' },
    'acme/api#2': { status: 'reviewed', findings: [] },
    'acme/api#3': { status: 'commented', commentedAt: 0 },
  };
  const prs = mergeBoard(prev, [], 0);
  assert.equal(prs['acme/api#1'], undefined);
  assert.equal(prs['acme/api#2'].active, false);
  assert.equal(prs['acme/api#3'].status, 'commented');
});

test('mergeBoard: commented 後に再度依頼されたら requested に戻す (投稿直後は戻さない)', () => {
  const prev = { 'acme/api#1': { status: 'commented', commentedAt: 1000 } };
  assert.equal(mergeBoard(prev, [node(1)], 1000 + 1)['acme/api#1'].status, 'commented');
  assert.equal(mergeBoard(prev, [node(1)], 1000 + RE_REQUEST_GRACE_MS + 1)['acme/api#1'].status, 'requested');
});

test('mergeBoard: スキップした PR は依頼が残っていても requested に戻さない', () => {
  const prev = { 'acme/api#1': { status: 'commented', commentedAt: 1000, skipped: true } };
  assert.equal(mergeBoard(prev, [node(1)], 1000 + RE_REQUEST_GRACE_MS + 1)['acme/api#1'].status, 'commented');
});

test('mergeBoard: レビュー中の PR は状態を保持する', () => {
  const prev = { 'acme/api#1': { status: 'reviewing', startedAt: 5 } };
  assert.equal(mergeBoard(prev, [node(1)], 0)['acme/api#1'].status, 'reviewing');
});

test('fillTemplate: プレースホルダーを置換する', () => {
  const pr = { repo: 'acme/api', number: 12, url: 'https://x/12' };
  assert.equal(fillTemplate('{number} --repo {repo}', pr), '12 --repo api');
  assert.equal(fillTemplate('', pr), '12');
  assert.equal(fillTemplate('{fullRepo} {owner} {url}', pr), 'acme/api acme https://x/12');
});

test('extractTagJson: 最後のタグの JSON を取り出し、コードフェンスも許容する', () => {
  const text = 'example <x>{"a":0}</x>\n本番:\n<x>\n```json\n{"a":1}\n```\n</x>';
  assert.deepEqual(extractTagJson(text, 'x'), { a: 1 });
  assert.equal(extractTagJson('なし', 'x'), null);
  assert.equal(extractTagJson('<x>壊れた</x>', 'x'), null);
});

test('splitArgs: 引用符付きの引数を扱う', () => {
  assert.deepEqual(splitArgs('--a b,c "d e" \'f\''), ['--a', 'b,c', 'd e', 'f']);
  assert.deepEqual(splitArgs(''), []);
});

test('canDecideAll: 全指摘に同意/非同意がないと false', () => {
  const findings = [{ no: 1 }, { no: 2 }];
  assert.equal(canDecideAll(findings, { 1: { verdict: 'agree' } }), false);
  assert.equal(canDecideAll(findings, { 1: { verdict: 'agree' }, 2: { verdict: 'disagree', reason: '' } }), true);
  assert.equal(canDecideAll([], {}), true);
});

test('buildPostPrompt: 判断・理由・Approve を反映する', () => {
  const prompt = buildPostPrompt(
    { url: 'https://x/1' },
    [{ no: 1 }, { no: 2 }, { no: 3 }],
    { 1: { verdict: 'agree', reason: 'ぜひ' }, 2: { verdict: 'disagree', reason: ' 件数が少ない ' }, 3: { verdict: 'disagree' } },
    true,
    true,
  );
  assert.match(prompt, /人間のレビュアーもコードを読みました ✅/);
  assert.match(prompt, /- #1 同意 \/ 理由: ぜひ/);
  assert.match(prompt, /- #2 非同意 \/ 理由: 件数が少ない\n/);
  assert.match(prompt, /- #3 非同意 \/ 理由なし/);
  assert.match(prompt, /event: APPROVE/);
  assert.match(prompt, /🤔💭/);
});

test('childEnv: 親 Claude Code セッションの環境変数を除き、それ以外は残す', () => {
  const env = childEnv({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_PID: '1', CLAUDE_CONFIG_DIR: '/c', PATH: '/bin', HOME: '/h' });
  assert.deepEqual(env, { CLAUDE_CONFIG_DIR: '/c', PATH: '/bin', HOME: '/h' });
});

test('searchQueries: マージ済みは指定日数以内に絞り、0 日なら取得しない', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const q = searchQueries(7, now);
  assert.equal(q.open, 'is:pr archived:false user-review-requested:@me is:open');
  assert.equal(q.merged, 'is:pr archived:false user-review-requested:@me is:merged merged:>=2026-10-09');
  assert.equal(q.withMerged, true);
  assert.equal(searchQueries(0, now).withMerged, false);
});

test('buildPostPrompt: コード確認なしならその旨を書かせない', () => {
  const prompt = buildPostPrompt({ url: 'https://x/1' }, [], {}, false, false);
  assert.match(prompt, /なし — コードを読んだ旨は書かない/);
  assert.doesNotMatch(prompt, /「人間のレビュアーもコードを読みました ✅」/);
});

test('usageOf / addUsage: 全モデルのトークン (キャッシュ込み) と費用を PR ごとに累計する', () => {
  const parsed = {
    total_cost_usd: 1.5,
    modelUsage: {
      opus: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40 },
      haiku: { inputTokens: 5, outputTokens: 5 },
    },
  };
  const u = usageOf(parsed);
  assert.deepEqual(u, { tokens: 380, costUsd: 1.5 });
  assert.equal(usageOf({ result: 'x' }), null);
  assert.deepEqual(addUsage(addUsage(undefined, u), u), { tokens: 760, costUsd: 3 });
  assert.deepEqual(addUsage(u, null), u);
});

test('mergeBoard: 再依頼でリセットしても使用量の累計は残す', () => {
  const prev = { 'acme/api#1': { status: 'commented', commentedAt: 0, usage: { tokens: 1, costUsd: 0.1 } } };
  const prs = mergeBoard(prev, [node(1)], RE_REQUEST_GRACE_MS + 1);
  assert.equal(prs['acme/api#1'].status, 'requested');
  assert.deepEqual(prs['acme/api#1'].usage, { tokens: 1, costUsd: 0.1 });
});

test('filterByAuthors: 指定した作成者だけ残し、[bot] 表記と大文字小文字の差を吸収する。空なら全件', () => {
  const by = (login) => ({ ...node(1), author: { login } });
  const nodes = [by('alice'), by('dependabot'), by('github-actions'), { ...node(2), author: null }];
  assert.deepEqual(filterByAuthors(nodes, ['Alice', ' dependabot[bot] ', '']).map((n) => n.author.login), ['alice', 'dependabot']);
  assert.equal(filterByAuthors(nodes, []).length, 4);
  assert.equal(filterByAuthors(nodes, undefined).length, 4);
});

test('readRun: ファイルに書かれた claude の JSON を解析し、.log にまとめて元ファイルを消す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
  fs.writeFileSync(path.join(dir, 'a.out'), JSON.stringify({ result: 'done', session_id: 's1', is_error: false }));
  fs.writeFileSync(path.join(dir, 'a.err'), '');
  const res = readRun(dir, 'a', 0);
  assert.equal(res.ok, true);
  assert.equal(res.result, 'done');
  assert.equal(res.sessionId, 's1');
  assert.deepEqual(fs.readdirSync(dir), ['a.log']);
});

test('readRun: 途中で止まった出力や出力ファイルが無い場合は失敗にする', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
  fs.writeFileSync(path.join(dir, 'b.out'), '');
  fs.writeFileSync(path.join(dir, 'b.err'), 'killed');
  assert.equal(readRun(dir, 'b', null).ok, false);
  assert.equal(readRun(dir, 'missing', 0).ok, false);
});

test('isAlive: 自プロセスは生存、終了済みプロセスは非生存', () => {
  assert.equal(isAlive(process.pid), true);
  const { pid } = require('node:child_process').spawnSync('true');
  assert.equal(isAlive(pid), false);
});
