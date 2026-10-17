'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readRun, logLines, isAlive, searchQueries, filterByAuthors, usageOf, addUsage, childEnv, modelOptions, mergeBoard, mergeMine, pendingThreads, fillTemplate, buildPostPrompt, buildFixPlanPrompt, buildFixApplyPrompt, buildSelfApplyPrompt, buildCommentApplyPrompt, extractTagJson, runForTag, splitArgs, canDecideAll, pollIntervalMs, inPollHours, RE_REQUEST_GRACE_MS } = require('./server');

const node = (number, repo = 'acme/api') => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
  isDraft: false,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  baseRefName: 'main',
  headRefName: `feature-${number}`,
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
  assert.deepEqual([e.pr.base, e.pr.head], ['main', 'feature-1']);
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
  assert.equal(fillTemplate('{pr-number} --repo {repo-name}', pr), '12 --repo api');
  assert.equal(fillTemplate('', pr), '12');
  assert.equal(fillTemplate('{full-repo-name} {owner-name} {pr-url}', pr), 'acme/api acme https://x/12');
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
  assert.match(prompt, /🤖: /);
  assert.match(prompt, /---/);
});

test('modelOptions: 指定したモデル・effort を渡し、サブエージェントも同じモデルにする。未指定なら何も足さない', () => {
  assert.deepEqual(modelOptions({ model: 'opus', effort: 'medium' }), { args: ['--model', 'opus', '--effort', 'medium'], env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' } });
  assert.deepEqual(modelOptions({ model: '', effort: '' }), { args: [], env: {} });
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
  fs.writeFileSync(path.join(dir, 'a.out'), [{ type: 'system' }, { type: 'result', result: 'done', session_id: 's1', is_error: false }].map((e) => JSON.stringify(e)).join('\n'));
  fs.writeFileSync(path.join(dir, 'a.err'), '');
  const res = readRun(dir, 'a', 0);
  assert.equal(res.ok, true);
  assert.equal(res.result, 'done');
  assert.equal(res.sessionId, 's1');
  assert.deepEqual(fs.readdirSync(dir), ['a.log']);
});

test('logLines: 発言とツール呼び出しだけを 1 行ずつにし、サブエージェント分は字下げする', () => {
  const text = [
    { type: 'system' },
    { type: 'assistant', message: { content: [{ type: 'text', text: ' 読みます ' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a.rb' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
    { type: 'assistant', parent_tool_use_id: 't1', message: { content: [{ type: 'text', text: 'sub' }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n{"type":"assis';
  assert.deepEqual(logLines(text), ['💬 読みます', '🔧 Read {"file_path":"a.rb"}', '  ↳ 💬 sub']);
  assert.deepEqual(logLines(text, 1), ['  ↳ 💬 sub']);
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

const thread = (isResolved, login) => ({ isResolved, comments: { nodes: [{ author: { login } }] } });

test('pendingThreads: 未解決かつ最後の発言が自分以外のスレッドだけ数える', () => {
  const n = { reviewThreads: { nodes: [thread(false, 'bob'), thread(false, 'me'), thread(true, 'bob'), { isResolved: false, comments: { nodes: [] } }] } };
  assert.equal(pendingThreads(n, 'me'), 2);
  assert.equal(pendingThreads({}, 'me'), 0);
});

test('mergeMine: 状態を保持して未対応数を更新し、クローズされた PR は実行中のものだけ残す', () => {
  const prev = {
    'mine:acme/api#1': { status: 'planned', findings: [] },
    'mine:acme/api#2': { status: 'idle' },
    'mine:acme/api#3': { status: 'applying' },
    'mine:acme/api#4': { status: 'planned' },
  };
  const mine = mergeMine(prev, [{ ...node(1), reviewThreads: { nodes: [thread(false, 'bob')] } }, node(5)], 'me');
  assert.equal(mine['mine:acme/api#1'].status, 'planned');
  assert.equal(mine['mine:acme/api#1'].pending, 1);
  assert.equal(mine['mine:acme/api#5'].status, 'idle');
  assert.equal(mine['mine:acme/api#5'].pending, 0);
  assert.equal(mine['mine:acme/api#2'], undefined);
  assert.equal(mine['mine:acme/api#3'].status, 'applying');
  assert.equal(mine['mine:acme/api#4'], undefined);
});

test('mergeMine: マージ可能に移した PR は新しい指摘が来たら外れる', () => {
  const prev = { 'mine:acme/api#1': { status: 'idle', mergeReady: true }, 'mine:acme/api#2': { status: 'idle', mergeReady: true } };
  const mine = mergeMine(prev, [{ ...node(1), reviewThreads: { nodes: [thread(false, 'bob')] } }, node(2)], 'me');
  assert.equal(mine['mine:acme/api#1'].mergeReady, false);
  assert.equal(mine['mine:acme/api#2'].mergeReady, true);
});

test('mergeMine: Done に移した PR は新しい指摘が来たら外れる', () => {
  const prev = { 'mine:acme/api#1': { status: 'idle', done: true }, 'mine:acme/api#2': { status: 'idle', done: true } };
  const mine = mergeMine(prev, [{ ...node(1), reviewThreads: { nodes: [thread(false, 'bob')] } }, node(2)], 'me');
  assert.equal(mine['mine:acme/api#1'].done, false);
  assert.equal(mine['mine:acme/api#2'].done, true);
});

test('buildFixPlanPrompt: 指定スキルで起動し、修正・push・返信をさせず計画だけ返させる', () => {
  const prompt = buildFixPlanPrompt({ repo: 'acme/api', number: 3, url: 'https://x/3' }, { fixSkill: 'review-fix', fixArgs: '{pr-number} --repo {repo-name}' });
  assert.match(prompt, /^\/review-fix 3 --repo api\n/);
  assert.match(prompt, /コミット・push・返信はまだ行わない/);
  assert.match(prompt, /<review-board-fix-plan>/);
  assert.match(prompt, /category を split にし/);
  assert.match(prompt, /category を followup にし/);
});

test('buildFixApplyPrompt / buildSelfApplyPrompt: 判断を渡し、承認済みとして push・返信させる', () => {
  const decisions = { 1: { verdict: 'agree' }, 2: { verdict: 'disagree', reason: '仕様どおり' } };
  const fix = buildFixApplyPrompt({ url: 'https://x/3' }, [{ no: 1 }, { no: 2 }], decisions);
  assert.match(fix, /- #1 同意 \/ 理由なし/);
  assert.match(fix, /- #2 非同意 \/ 理由: 仕様どおり/);
  assert.match(fix, /確認ゲートの承認/);
  assert.match(fix, /split に同意した指摘/);
  assert.match(fix, /Draft PR を作成する/);
  assert.match(fix, /sub-issue として紐付ける/);
  assert.match(fix, /<review-board-applied>/);
  const self = buildSelfApplyPrompt({ url: 'https://x/3' }, [{ no: 1 }], { 1: { verdict: 'agree' } });
  assert.match(self, /event: COMMENT/);
  assert.match(self, /コミット SHA を含む返信/);
  assert.match(self, /<review-board-applied>/);
});

test('buildCommentApplyPrompt: PR 上の自分のコメントを指示として、承認済みで修正・push・返信させる', () => {
  const prompt = buildCommentApplyPrompt({ url: 'https://x/3' });
  assert.match(prompt, /https:\/\/x\/3/);
  assert.match(prompt, /PR 作成者.*コメント/);
  assert.match(prompt, /承認/);
  assert.match(prompt, /force-push はしない/);
  assert.match(prompt, /<review-board-applied>/);
});

test('runForTag: 最後のメッセージにタグが無ければ同じセッションを 1 回だけ再開して再出力させる', async () => {
  const usage = { tokens: 1, costUsd: 0.1 };
  const calls = [];
  const fake = (results) => async (prompt, opts) => (calls.push(opts), results.shift());
  const tagged = '<review-board-findings>{"findings":[]}</review-board-findings>';

  let res = await runForTag('review-board-findings', 'p', { logName: 'a' }, fake([{ ok: true, sessionId: 's', result: '出力済みです', usage }, { ok: true, sessionId: 's', result: tagged, usage }]));
  assert.equal(calls.length, 2);
  assert.deepEqual([calls[1].resume, calls[1].logName], ['s', 'a-retag']);
  assert.deepEqual(extractTagJson(res.result, 'review-board-findings'), { findings: [] });
  assert.deepEqual(res.usage, { tokens: 2, costUsd: 0.2 });

  calls.length = 0;
  res = await runForTag('review-board-findings', 'p', { logName: 'a' }, fake([{ ok: true, sessionId: 's', result: tagged, usage }]));
  assert.equal(calls.length, 1);

  calls.length = 0;
  res = await runForTag('review-board-findings', 'p', { logName: 'a' }, fake([{ ok: true, sessionId: 's', result: 'x', usage }, { ok: false, error: 'e', usage }]));
  assert.equal(calls.length, 2);
  assert.equal(res.ok, true);
  assert.equal(res.result, 'x');
  assert.deepEqual(res.usage, { tokens: 2, costUsd: 0.2 });
});

test('pollIntervalMs: 分をミリ秒にし、1 分未満や不正値は既定の 5 分に戻す', () => {
  assert.equal(pollIntervalMs(10), 10 * 60 * 1000);
  assert.equal(pollIntervalMs('2'), 2 * 60 * 1000);
  for (const v of [0, -1, '', undefined, 'abc']) assert.equal(pollIntervalMs(v), 5 * 60 * 1000);
});

test('inPollHours: 開始時 <= 時 < 終了時 だけ取得し、日またぎと終日も扱う', () => {
  const at = (h) => new Date(2026, 9, 16, h, 30);
  assert.equal(inPollHours(at(8), 9, 19), false);
  assert.equal(inPollHours(at(9), 9, 19), true);
  assert.equal(inPollHours(at(18), 9, 19), true);
  assert.equal(inPollHours(at(19), 9, 19), false);
  assert.equal(inPollHours(at(23), 22, 6), true);
  assert.equal(inPollHours(at(5), 22, 6), true);
  assert.equal(inPollHours(at(12), 22, 6), false);
  assert.equal(inPollHours(at(3), 0, 0), true);
  assert.equal(inPollHours(at(3), '9', '19'), false);
});

const { parseProjectUrl, detectFields, barRange, sprintTree } = require('./server');

test('parseProjectUrl: org / user のプロジェクト URL を解析し、それ以外は null', () => {
  assert.deepEqual(parseProjectUrl('https://github.com/orgs/docket/projects/76/views/1'), { owner: 'organization', login: 'docket', number: 76 });
  assert.deepEqual(parseProjectUrl('https://github.com/users/alice/projects/3'), { owner: 'user', login: 'alice', number: 3 });
  assert.equal(parseProjectUrl('https://github.com/docket/repo'), null);
});

test('detectFields: 最初の Iteration と、名前から開始日・終了日の Date フィールドを選ぶ', () => {
  const fields = [
    { name: 'Status', dataType: 'SINGLE_SELECT' },
    { name: '[必須]Sprint', dataType: 'ITERATION', configuration: { iterations: [{ id: 'b', title: 'S2', startDate: '2026-10-24', duration: 14 }], completedIterations: [{ id: 'a', title: 'S1', startDate: '2026-10-10', duration: 14 }] } },
    { name: '終了日', dataType: 'DATE' },
    { name: '開始日', dataType: 'DATE' },
  ];
  const f = detectFields(fields);
  assert.equal(f.sprint, '[必須]Sprint');
  assert.equal(f.start, '開始日');
  assert.equal(f.end, '終了日');
  assert.deepEqual(f.iterations.map((i) => [i.id, i.endDate, i.completed]), [['b', '2026-11-06', false], ['a', '2026-10-23', true]]);
  assert.deepEqual(detectFields([{ name: 'Target', dataType: 'DATE' }, { name: 'Begin', dataType: 'DATE' }]), { sprint: null, start: 'Begin', end: 'Target', iterations: [] });
});

test('barRange: スプリント外・未設定の日付はスプリントの開始日・終了日として扱う', () => {
  const s = { startDate: '2026-10-10', endDate: '2026-10-23' };
  assert.deepEqual(barRange(null, null, s), { start: '2026-10-10', end: '2026-10-23' });
  assert.deepEqual(barRange('2026-10-12', '2026-10-15', s), { start: '2026-10-12', end: '2026-10-15' });
  assert.deepEqual(barRange('2026-09-01', '2026-12-01', s), { start: '2026-10-10', end: '2026-10-23' });
  assert.deepEqual(barRange('2026-10-20', null, s), { start: '2026-10-20', end: '2026-10-23' });
  assert.deepEqual(barRange('2026-11-01', '2026-11-05', s), { start: '2026-10-10', end: '2026-10-23' });
  // 開始 > 終了の矛盾はスプリント全体にする
  assert.deepEqual(barRange('2026-10-20', '2026-10-12', s), { start: '2026-10-10', end: '2026-10-23' });
});

test('sprintTree: 同じスプリントの子孫は最上位の親の下にだけ出し、別スプリント・未登録の子孫も含める', () => {
  const sprint = { id: 'S', startDate: '2026-10-10', endDate: '2026-10-23' };
  const iss = (id, childIds = [], extra = {}) => ({ id, title: id, childIds, sprintId: null, start: null, end: null, ...extra });
  const issues = new Map([
    ['A', iss('A', ['B'], { sprintId: 'S', end: '2026-12-01' })],
    ['B', iss('B', ['C', 'D'], { sprintId: 'X' })],
    ['C', iss('C', [], { sprintId: 'S' })],
    ['D', iss('D', [], { start: '2026-10-15' })],
    ['E', iss('E', [], { sprintId: 'S' })],
  ]);
  const roots = sprintTree(['A', 'C', 'E'], issues, sprint);
  assert.deepEqual(roots.map((r) => r.id), ['A', 'E']);
  const a = roots[0];
  assert.deepEqual(a.children.map((c) => c.id), ['B']);
  assert.deepEqual(a.children[0].children.map((c) => [c.id, c.start, c.end]), [['C', '2026-10-10', '2026-10-23'], ['D', '2026-10-15', '2026-10-23']]);
  // 元の日付はスプリントからはみ出した表示用に残す
  assert.equal(a.end, '2026-10-23');
  assert.equal(a.rawEnd, '2026-12-01');
});

test('sprintTree: 親子が循環していても止まる', () => {
  const sprint = { id: 'S', startDate: '2026-10-10', endDate: '2026-10-23' };
  const issues = new Map([
    ['A', { id: 'A', childIds: ['B'], sprintId: 'S' }],
    ['B', { id: 'B', childIds: ['A'], sprintId: 'S' }],
  ]);
  const roots = sprintTree(['A', 'B'], issues, sprint);
  assert.ok(roots.length >= 1);
});

const { pickIterations } = require('./server');

test('pickIterations: 現在と前後 N 個に絞り、未来は issue があるものだけ、新しい順に並べる', () => {
  const it = (id, startDate, endDate, count) => ({ id, startDate, endDate, count });
  const all = [
    it('p2', '2026-09-12', '2026-09-25', 5), it('p1', '2026-09-26', '2026-10-09', 3), it('now', '2026-10-10', '2026-10-23', 27),
    it('f1', '2026-10-24', '2026-11-06', 0), it('f2', '2026-11-07', '2026-11-20', 2), it('f3', '2026-11-21', '2026-12-04', 1),
  ];
  assert.deepEqual(pickIterations(all, '2026-10-16', { past: 1, future: 1 }).map((i) => i.id), ['f2', 'now', 'p1']);
  assert.deepEqual(pickIterations(all, '2026-10-16', { past: 0, future: 2 }).map((i) => i.id), ['f3', 'f2', 'now']);
  // 件数を数える前は未来をすべて候補にする
  assert.deepEqual(pickIterations(all.map((i) => ({ ...i, count: undefined })), '2026-10-16', { past: 2, future: Infinity }).map((i) => i.id), ['f3', 'f2', 'f1', 'now', 'p1', 'p2']);
});

const { periodAt, periodWindows, periodQueries } = require('./server');

test('periodAt: 週は月曜始まり、2 週は 2024-01-01 起点、月はカレンダーどおり', () => {
  assert.deepEqual(periodAt('2026-10-16', 'week'), { id: '2026-10-12', title: '10/12 からの週', startDate: '2026-10-12', endDate: '2026-10-18' });
  assert.equal(periodAt('2026-10-12', 'week').startDate, '2026-10-12');
  assert.equal(periodAt('2026-10-18', 'week').startDate, '2026-10-12');
  // 2026-10-12 は 2024-01-01 から 1015 日 (= 14 × 72 + 7) なので、2 週の区切りは 10/5 – 10/18
  assert.deepEqual([periodAt('2026-10-16', '2week').startDate, periodAt('2026-10-16', '2week').endDate], ['2026-10-05', '2026-10-18']);
  assert.equal(periodAt('2023-12-31', '2week').startDate, '2023-12-18');
  assert.deepEqual(periodAt('2026-02-10', 'month'), { id: '2026-02-01', title: '2026年2月', startDate: '2026-02-01', endDate: '2026-02-28' });
  assert.equal(periodAt('2026-12-31', 'month').endDate, '2026-12-31');
});

test('periodWindows: 未来 → 今 → 過去 の順に並べる', () => {
  assert.deepEqual(periodWindows('2026-01-15', 'month', { past: 2, future: 1 }).map((p) => p.id), ['2026-02-01', '2026-01-01', '2025-12-01', '2025-11-01']);
  assert.deepEqual(periodWindows('2026-10-16', 'week', { past: 1, future: 0 }).map((p) => p.id), ['2026-10-12', '2026-10-05']);
});

test('periodQueries: 期間と重なるもの、片方の日付だけ期間内のもの', () => {
  const p = { startDate: '2026-10-01', endDate: '2026-10-31' };
  assert.deepEqual(periodQueries('開始日', '終了日', p), [
    '"開始日":<=2026-10-31 "終了日":>=2026-10-01',
    'no:"開始日" "終了日":2026-10-01..2026-10-31',
    'no:"終了日" "開始日":2026-10-01..2026-10-31',
  ]);
  assert.deepEqual(periodQueries(null, '期限', p), ['"期限":2026-10-01..2026-10-31']);
});

