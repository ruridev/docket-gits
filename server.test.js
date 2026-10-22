'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CONSENT_VERSION, killRun, readTail, isAgentRun, pruneLogs, logStats, logKeepMs, readRun, logLines, isAlive, searchQueries, isTruncated, filterByAuthors, usageOf, addUsage, childEnv, modelOptions, mergeBoard, mergeMine, pendingThreads, pendingComments, fillTemplate, buildReviewPrompt, PROMPT_SKILL, buildPostPrompt, buildFixPlanPrompt, triageFrom, triageTargets, buildFixApplyPrompt, buildSelfApplyPrompt, buildCommentApplyPrompt, extractTagJson, runForTag, splitArgs, normalizeNos, boardEntry, DONE_KEEP_MS, doneKeepMs, canDecideAll, sanitizeConfig, pollIntervalMs, concurrencyLimit, inPollHours, RE_REQUEST_GRACE_MS } = require('./server');

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

test('mergeBoard: Done を残す日数は設定で変えられる (既定 7 日、1 未満は既定値)', () => {
  const day = 24 * 60 * 60 * 1000;
  assert.equal(DONE_KEEP_MS, 7 * day);
  assert.equal(doneKeepMs(0), 7 * day);
  const prev = { 'acme/api#1': { status: 'commented', commentedAt: 0 } };
  assert.equal(mergeBoard(prev, [], 3 * day, [], null, doneKeepMs(3))['acme/api#1'].status, 'commented');
  assert.equal(mergeBoard(prev, [], 3 * day + 1, [], null, doneKeepMs(3))['acme/api#1'], undefined);
});

test('mergeBoard: 依頼が外れた Done は DONE_KEEP_MS を過ぎたら消す (作業途中は残す)', () => {
  const prev = {
    'acme/api#1': { status: 'commented', commentedAt: 0 },
    'acme/api#2': { status: 'reviewed', findings: [] },
  };
  assert.equal(mergeBoard(prev, [], DONE_KEEP_MS)['acme/api#1'].status, 'commented');
  const prs = mergeBoard(prev, [], DONE_KEEP_MS + 1);
  assert.equal(prs['acme/api#1'], undefined);
  assert.equal(prs['acme/api#2'].status, 'reviewed');
});

const myThread = (root, last, isResolved = false) => ({ isResolved, root: { nodes: [{ author: { login: root } }] }, comments: { nodes: [{ author: { login: last } }] } });
const reviewed = (number, threads) => ({ ...node(number), reviewThreads: { nodes: threads } });

test('mergeBoard: 自分の指摘に作成者が全部対応したら Done から requested に戻す', () => {
  let prs = { 'acme/api#1': { status: 'commented', commentedAt: 0, usage: { tokens: 5 } } };
  prs = mergeBoard(prs, [], 0, [reviewed(1, [myThread('me', 'me'), myThread('me', 'me')])], 'me');
  assert.equal(prs['acme/api#1'].status, 'commented');
  prs = mergeBoard(prs, [], 0, [reviewed(1, [myThread('me', 'alice'), myThread('me', 'me')])], 'me');
  assert.equal(prs['acme/api#1'].status, 'commented');
  prs = mergeBoard(prs, [], 0, [reviewed(1, [myThread('me', 'alice'), myThread('me', 'me', true)])], 'me');
  assert.equal(prs['acme/api#1'].status, 'requested');
  assert.equal(prs['acme/api#1'].active, false);
  assert.deepEqual(prs['acme/api#1'].usage, { tokens: 5 });
  // 依頼が外れたままでも、PR が開いている間は消さない
  prs = mergeBoard(prs, [], 0, [reviewed(1, [])], 'me');
  assert.equal(prs['acme/api#1'].status, 'requested');
  assert.equal(mergeBoard(prs, [], 0, [], 'me')['acme/api#1'], undefined);
});

test('mergeBoard: 自分の指摘が無い Done (Approve のみ・他人のスレッドだけ)・スキップは戻さない', () => {
  const prs = { 'acme/api#1': { status: 'commented', commentedAt: 0 }, 'acme/api#2': { status: 'commented', commentedAt: 0, skipped: true } };
  const next = mergeBoard(prs, [], 0, [reviewed(1, [myThread('bob', 'alice')]), reviewed(2, [myThread('me', 'alice')])], 'me');
  assert.equal(next['acme/api#1'].status, 'commented');
  assert.equal(next['acme/api#2'].status, 'commented');
});

test('mergeBoard: 戻した PR を再レビューして Done にしたら、新しい指摘が対応されるまで戻さない', () => {
  const answered = [reviewed(1, [myThread('me', 'alice', true)])];
  let prs = mergeBoard({ 'acme/api#1': { status: 'commented', commentedAt: 0 } }, [], 0, answered, 'me');
  assert.equal(prs['acme/api#1'].status, 'requested');
  // 再レビューで指摘なし (Approve) → 古いスレッドだけでは戻らない
  prs['acme/api#1'] = { ...prs['acme/api#1'], status: 'commented', commentedAt: 0 };
  assert.equal(mergeBoard(prs, [], 0, answered, 'me')['acme/api#1'].status, 'commented');
  // 再レビューで新しい指摘 → 対応待ち → 対応されたら戻る
  prs = mergeBoard(prs, [], 0, [reviewed(1, [myThread('me', 'alice', true), myThread('me', 'me')])], 'me');
  assert.equal(prs['acme/api#1'].status, 'commented');
  prs = mergeBoard(prs, [], 0, [reviewed(1, [myThread('me', 'alice', true), myThread('me', 'alice')])], 'me');
  assert.equal(prs['acme/api#1'].status, 'requested');
});

test('boardEntry: 判断ダイアログを開けない状態では Claude の出力を送らない', () => {
  const heavy = { raw: 'r', applyRaw: 'a', findings: [{ no: 1 }], summary: 's', postRaw: 'p', decisions: { 1: {} }, sessionId: 'x' };
  const done = boardEntry('k', { status: 'commented', ...heavy });
  assert.deepEqual(Object.keys(done).sort(), ['key', 'sessionId', 'status']);
  const reviewed = boardEntry('k', { status: 'reviewed', ...heavy });
  assert.deepEqual([reviewed.raw, reviewed.applyRaw, reviewed.summary, reviewed.findings.length], ['r', 'a', 's', 1]);
  assert.equal(reviewed.postRaw, undefined);
  assert.equal(reviewed.decisions, undefined);
  assert.equal(boardEntry('k', { status: 'planned', ...heavy }).raw, 'r');
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

test('canDecideAll: 対象外は許可したときだけ判断済みになる', () => {
  const findings = [{ no: 1 }, { no: 2 }];
  const decisions = { 1: { verdict: 'agree' }, 2: { verdict: 'skip' } };
  assert.equal(canDecideAll(findings, decisions), false);
  assert.equal(canDecideAll(findings, decisions, true), true);
});

test('buildPostPrompt: 対象外の指摘は投稿しない', () => {
  const prompt = buildPostPrompt({ url: 'https://x/1' }, [{ no: 1 }], { 1: { verdict: 'skip' } }, false, false);
  assert.match(prompt, /- #1 対象外 \/ 理由なし/);
  assert.match(prompt, /- 対象外: 投稿しない。/);
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
  assert.match(prompt, /繰り返さず、残りだけを行う/);
  assert.match(prompt, /🤔💭/);
  assert.match(prompt, /🤖: /);
  assert.match(prompt, /---/);
});

test('buildPostPrompt: 非同意の意見のアイコンを指定できる', () => {
  const prompt = buildPostPrompt({ url: 'https://x/1' }, [{ no: 1 }], { 1: { verdict: 'disagree', reason: 'r' } }, false, false, '🙋');
  assert.match(prompt, /「🙋 」で始め/);
  assert.doesNotMatch(prompt, /🤔💭/);
});

test('modelOptions: 指定したモデル・effort を渡し、サブエージェントも同じモデルにする。未指定なら何も足さない', () => {
  assert.deepEqual(modelOptions({ model: 'opus', effort: 'medium' }), { args: ['--model', 'opus', '--effort', 'medium'], env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' } });
  assert.deepEqual(modelOptions({ model: '', effort: '' }), { args: [], env: {} });
});

test('childEnv: 親 Claude Code セッションの環境変数を除き、それ以外は残す', () => {
  const env = childEnv({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_PID: '1', CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/bin', HOME: '/h' });
  assert.deepEqual(env, { CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/bin', HOME: '/h' });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-'));
  fs.writeFileSync(path.join(dir, 'b.out'), '');
  fs.writeFileSync(path.join(dir, 'b.err'), 'killed');
  assert.equal(readRun(dir, 'b', null).ok, false);
  assert.equal(readRun(dir, 'missing', 0).ok, false);
});

test('readRun: .log を書けなくても例外を投げず失敗にする (投げると close ハンドラ内でサーバーが落ちる)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-'));
  fs.writeFileSync(path.join(dir, 'c.out'), '{"type":"result","result":"x"}\n');
  fs.writeFileSync(path.join(dir, 'c.err'), '');
  fs.mkdirSync(path.join(dir, 'c.log'));
  const res = readRun(dir, 'c', 0);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'claudeReadFailed');
});

test('isAlive: 自プロセスは生存、終了済みプロセスは非生存', () => {
  assert.equal(isAlive(process.pid), true);
  const { pid } = require('node:child_process').spawnSync('true');
  assert.equal(isAlive(pid), false);
});

const thread = (isResolved, login) => ({ isResolved, comments: { nodes: [{ author: { login } }] } });

test('pendingThreads: 未解決かつ最後の発言が自分以外のスレッドだけ数える', () => {
  const n = { reviewThreads: { nodes: [thread(false, 'bob'), thread(false, 'me'), thread(true, 'bob'), { isResolved: false, comments: { nodes: [] } }] } };
  assert.equal(pendingThreads(n, 'me').length, 2);
  assert.equal(pendingThreads({}, 'me').length, 0);
});

test('pendingThreads: 返信の無い自分だけのスレッド (セルフ指摘) は数え、自分が返信したものは数えない', () => {
  const c = (login, url) => ({ author: { login }, body: '', url });
  const n = { reviewThreads: { nodes: [
    { isResolved: false, root: { nodes: [c('me', 'u1')] }, comments: { nodes: [c('me', 'u1')] } },
    { isResolved: false, root: { nodes: [c('me', 'u2')] }, comments: { nodes: [c('me', 'u3')] } },
    { isResolved: false, root: { nodes: [c('bob', 'u4')] }, comments: { nodes: [c('me', 'u5')] } },
  ] } };
  assert.deepEqual(pendingThreads(n, 'me').map((t) => t.url), ['u1']);
});

test('pendingThreads: 人が判断できるよう最初の指摘と、返信が続いていれば最新の発言を持つ', () => {
  const c = (login, body, url) => ({ author: { login }, body, url });
  const n = { reviewThreads: { nodes: [
    { isResolved: false, path: 'a.rb', line: 3, root: { nodes: [c('bob', '直して', 'u1')] }, comments: { nodes: [c('bob', '直して', 'u1')] } },
    { isResolved: false, path: null, line: null, root: { nodes: [c('amy', 'なぜ?', 'u2')] }, comments: { nodes: [c('amy', '再度確認を', 'u3')] } },
  ] } };
  const [a, b] = pendingThreads(n, 'me');
  assert.deepEqual(a, { no: 1, author: 'bob', url: 'u1', path: 'a.rb', line: 3, comment: '直して', lastUrl: 'u1' });
  assert.equal(b.no, 2);
  assert.deepEqual(b.latest, { author: 'amy', body: '再度確認を' });
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

const triage = [
  { no: 1, author: 'bob', url: 'u1', path: 'a.rb', line: 3, comment: '直して', verdict: 'agree', reason: '' },
  { no: 2, author: 'amy', url: 'u2', path: null, line: null, comment: 'なぜ?', verdict: 'disagree', reason: '仕様どおり' },
  { no: 3, author: 'ci', url: 'u3', path: null, line: null, comment: 'Coverage 80%', verdict: 'skip', reason: '' },
  { no: 4, kind: 'comment', author: 'amy', url: 'u4', path: null, line: null, comment: '全体的に命名を見直して', verdict: 'agree', reason: '' },
];

test('triageFrom: 全指摘に同意/非同意/対象外が付いたときだけ URL で判断を結び付ける', () => {
  const threads = [{ no: 1, url: 'u1' }, { no: 2, url: 'u2' }, { no: 3, url: 'u3' }];
  assert.equal(triageFrom(threads, { u1: { verdict: 'agree' }, u2: { verdict: 'skip' } }), null);
  assert.deepEqual(triageFrom(threads, { u1: { verdict: 'agree' }, u2: { verdict: 'disagree', reason: ' 不要 ' }, u3: { verdict: 'skip' } }), [
    { no: 1, url: 'u1', verdict: 'agree', reason: '' },
    { no: 2, url: 'u2', verdict: 'disagree', reason: '不要' },
    { no: 3, url: 'u3', verdict: 'skip', reason: '' },
  ]);
});

test('triageTargets: 対象外以外 (同意・非同意) を AI の対象にする', () => {
  assert.deepEqual(triageTargets(triage).map((t) => t.no), [1, 2, 4]);
  assert.equal(triageTargets([triage[2]]).length, 0);
});

test('pendingComments: 自分が最後に PR 全体へ発言した後の、他の人の空でないコメントとレビュー本文を古い順に返す', () => {
  const c = (login, body, url, createdAt) => ({ author: { login }, body, url, createdAt });
  const r = (login, body, url, submittedAt) => ({ author: { login }, body, url, submittedAt });
  const n = {
    comments: { nodes: [c('bob', '古い', 'c1', '2026-01-01T00:00:00Z'), c('me', '対応しました', 'c2', '2026-01-02T00:00:00Z'), c('amy', '新しい', 'c3', '2026-01-04T00:00:00Z')] },
    reviews: { nodes: [r('bob', '全体的に…', 'r1', '2026-01-03T00:00:00Z'), r('bob', '', 'r2', '2026-01-05T00:00:00Z'), r('bob', '下書き', 'r3', null)] },
  };
  assert.deepEqual(pendingComments(n, 'me'), [
    { kind: 'comment', author: 'bob', url: 'r1', path: null, line: null, comment: '全体的に…', lastUrl: 'r1' },
    { kind: 'comment', author: 'amy', url: 'c3', path: null, line: null, comment: '新しい', lastUrl: 'c3' },
  ]);
  assert.deepEqual(pendingComments({}, 'me'), []);
});

test('mergeMine: 対象外にした指摘は一覧と件数から外し、新しい発言が付いたらまた出す', () => {
  const c = (login, url) => ({ author: { login }, body: 'x', url });
  const t = (...cs) => ({ isResolved: false, root: { nodes: [cs[0]] }, comments: { nodes: [cs.at(-1)] } });
  const prev = { 'mine:acme/api#1': { status: 'idle', skipped: ['u1 u1', 'u2 u2', 'gone gone'] } };
  const n = { ...node(1), reviewThreads: { nodes: [t(c('bot', 'u1')), t(c('bob', 'u2'), c('bob', 'u3')), t(c('amy', 'u4'))] } };
  const m = mergeMine(prev, [n], 'me')['mine:acme/api#1'];
  assert.deepEqual(m.threads.map((x) => [x.no, x.url]), [[1, 'u2'], [2, 'u4']]);
  assert.equal(m.pending, 2);
  assert.deepEqual(m.skipped, ['u1 u1']);
  const only = mergeMine(prev, [{ ...node(1), reviewThreads: { nodes: [t(c('bot', 'u1'))] } }], 'me')['mine:acme/api#1'];
  assert.equal(only.pending, 0);
});

test('mergeMine: PR 全体へのコメントは判断対象に足すが、指摘ありの件数はスレッドだけで数える', () => {
  const n = { ...node(1), reviewThreads: { nodes: [thread(false, 'bob')] }, comments: { nodes: [{ author: { login: 'ci' }, body: 'Coverage', url: 'c1', createdAt: '2026-01-01T00:00:00Z' }] } };
  const m = mergeMine({}, [n], 'me')['mine:acme/api#1'];
  assert.equal(m.pending, 1);
  assert.deepEqual(m.threads.map((t) => [t.no, t.kind || 'thread']), [[1, 'thread'], [2, 'comment']]);
});

test('buildFixPlanPrompt: 事前判断した指摘だけを対象にし、理由ありの非同意には反論か返信案を返させる', () => {
  const prompt = buildFixPlanPrompt({ repo: 'acme/api', number: 3, url: 'https://x/3' }, { fixSkill: 'review-fix' }, triage);
  assert.match(prompt, /- #1 @bob a\.rb:3 u1\n  指摘: 直して\n  同意 \/ 理由なし/);
  assert.match(prompt, /- #2 @amy u2\n  指摘: なぜ\?\n  非同意 \/ 理由: 仕様どおり/);
  assert.doesNotMatch(prompt, /#3/);
  assert.match(prompt, /- #4 \[PR コメント\] @amy u4/);
  assert.match(prompt, /引用 \(またはリンク\) した PR コメント/);
  assert.match(prompt, /一覧にないスレッド・コメントは計画に含めない/);
  assert.match(prompt, /category を rebut にし/);
  assert.match(prompt, /"rebuttal"/);
});

test('buildFixPlanPrompt: 指定スキルで起動し、修正・push・返信をさせず計画だけ返させる', () => {
  const prompt = buildFixPlanPrompt({ repo: 'acme/api', number: 3, url: 'https://x/3' }, { fixSkill: 'review-fix', fixArgs: '{pr-number} --repo {repo-name}' }, triage);
  assert.match(prompt, /^\/review-fix 3 --repo api\n/);
  assert.match(prompt, /コミット・push・返信はまだ行わない/);
  assert.match(prompt, /<docket-fix-plan>/);
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
  assert.match(fix, /rebut \(AI の反論\)/);
  assert.match(fix, /<docket-applied>/);
  const self = buildSelfApplyPrompt({ url: 'https://x/3' }, [{ no: 1 }], { 1: { verdict: 'agree' } });
  assert.match(self, /event: COMMENT/);
  assert.match(self, /コミット SHA を含む返信/);
  assert.match(self, /<docket-applied>/);
  // 指摘 0 件でも所感をレビュー本文として投稿させる
  const empty = buildSelfApplyPrompt({ url: 'https://x/3' }, [], {}, '問題は見つかりませんでした');
  assert.match(empty, /問題は見つかりませんでした/);
  assert.match(empty, /同意が 0 件でも所感だけのレビューを投稿する/);
  assert.doesNotMatch(empty, /同意が 0 件なら何もしない/);
});

test('buildCommentApplyPrompt: PR 上の自分のコメントを指示として、承認済みで修正・push・返信させる', () => {
  const prompt = buildCommentApplyPrompt({ url: 'https://x/3' });
  assert.match(prompt, /https:\/\/x\/3/);
  assert.match(prompt, /PR 作成者.*コメント/);
  assert.match(prompt, /承認/);
  assert.match(prompt, /force-push はしない/);
  assert.match(prompt, /<docket-applied>/);
});

test('runForTag: 最後のメッセージにタグが無ければ同じセッションを 1 回だけ再開して再出力させる', async () => {
  const usage = { tokens: 1, costUsd: 0.1 };
  const calls = [];
  const fake = (results) => async (prompt, opts) => (calls.push(opts), results.shift());
  const tagged = '<docket-findings>{"findings":[]}</docket-findings>';

  let res = await runForTag('docket-findings', 'p', { logName: 'a' }, fake([{ ok: true, sessionId: 's', result: '出力済みです', usage }, { ok: true, sessionId: 's', result: tagged, usage }]));
  assert.equal(calls.length, 2);
  assert.deepEqual([calls[1].resume, calls[1].logName], ['s', 'a-retag']);
  assert.deepEqual(extractTagJson(res.result, 'docket-findings'), { findings: [] });
  assert.deepEqual(res.usage, { tokens: 2, costUsd: 0.2 });

  calls.length = 0;
  res = await runForTag('docket-findings', 'p', { logName: 'a' }, fake([{ ok: true, sessionId: 's', result: tagged, usage }]));
  assert.equal(calls.length, 1);

  calls.length = 0;
  res = await runForTag('docket-findings', 'p', { logName: 'a' }, fake([{ ok: true, sessionId: 's', result: 'x', usage }, { ok: false, error: 'e', usage }]));
  assert.equal(calls.length, 2);
  assert.equal(res.ok, true);
  assert.equal(res.result, 'x');
  assert.deepEqual(res.usage, { tokens: 2, costUsd: 0.2 });

  // キャンセル済みなら再開しない
  calls.length = 0;
  res = await runForTag('docket-findings', 'p', { logName: 'a', cancelled: () => true }, fake([{ ok: true, sessionId: 's', result: 'x', usage }]));
  assert.equal(calls.length, 1);
  assert.equal(res.result, 'x');
});

test('pollIntervalMs: 分をミリ秒にし、1 分未満や不正値は既定の 5 分に戻す', () => {
  assert.equal(pollIntervalMs(10), 10 * 60 * 1000);
  assert.equal(pollIntervalMs('2'), 2 * 60 * 1000);
  for (const v of [0, -1, '', undefined, 'abc']) assert.equal(pollIntervalMs(v), 5 * 60 * 1000);
  assert.equal(pollIntervalMs(100000), 24 * 60 * 60 * 1000);
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
    { name: 'Status', dataType: 'SINGLE_SELECT', options: [{ name: 'Todo' }, { name: 'Done' }] },
    { name: '[必須]Sprint', dataType: 'ITERATION', configuration: { iterations: [{ id: 'b', title: 'S2', startDate: '2026-10-24', duration: 14 }], completedIterations: [{ id: 'a', title: 'S1', startDate: '2026-10-10', duration: 14 }] } },
    { name: '終了日', dataType: 'DATE' },
    { name: '開始日', dataType: 'DATE' },
  ];
  const f = detectFields(fields);
  assert.equal(f.sprint, '[必須]Sprint');
  assert.equal(f.start, '開始日');
  assert.equal(f.end, '終了日');
  assert.deepEqual(f.statuses, ['Todo', 'Done']);
  assert.deepEqual(f.iterations.map((i) => [i.id, i.endDate, i.completed]), [['b', '2026-11-06', false], ['a', '2026-10-23', true]]);
  assert.deepEqual(detectFields([{ name: 'Target', dataType: 'DATE' }, { name: 'Begin', dataType: 'DATE' }]), { sprint: null, start: 'Begin', end: 'Target', iterations: [], statuses: [] });
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
  assert.deepEqual(periodAt('2026-10-16', 'week'), { id: '2026-10-12', startDate: '2026-10-12', endDate: '2026-10-18' });
  assert.equal(periodAt('2026-10-12', 'week').startDate, '2026-10-12');
  assert.equal(periodAt('2026-10-18', 'week').startDate, '2026-10-12');
  // 2026-10-12 は 2024-01-01 から 1015 日 (= 14 × 72 + 7) なので、2 週の区切りは 10/5 – 10/18
  assert.deepEqual([periodAt('2026-10-16', '2week').startDate, periodAt('2026-10-16', '2week').endDate], ['2026-10-05', '2026-10-18']);
  assert.equal(periodAt('2023-12-31', '2week').startDate, '2023-12-18');
  assert.deepEqual(periodAt('2026-02-10', 'month'), { id: '2026-02-01', startDate: '2026-02-01', endDate: '2026-02-28' });
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


const { withOutputLang } = require('./server');

test('withOutputLang: 書かせる文章の言語を指示し、未知の言語は日本語にする', () => {
  assert.match(withOutputLang('p', 'ko'), /^p\n[\s\S]*すべて韓国語で書く/);
  assert.match(withOutputLang('p', 'en'), /すべて英語で書く/);
  assert.match(withOutputLang('p', undefined), /すべて日本語で書く/);
});

test('i18n: 各言語のキーがそろい、サーバーのエラーコードがすべて翻訳されている', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const I18N = new Function(`return ${/const I18N = (\{[\s\S]*?\n\});/.exec(html)[1]}`)();
  const keys = Object.keys(I18N.ja).sort();
  for (const l of ['ko', 'en']) assert.deepEqual(Object.keys(I18N[l]).sort(), keys, l);
  const codes = [...fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').matchAll(/\bE\('(\w+)'/g)].map((m) => `err.${m[1]}`);
  assert.ok(codes.length > 20);
  for (const c of codes) assert.ok(keys.includes(c), c);
  const used = [...html.matchAll(/\btr\('([\w.]+)'/g)].map((m) => m[1]);
  for (const k of used) assert.ok(keys.includes(k), k);
});

test('concurrencyLimit: 空・0・不正値は既定値、負数は 1 にする', () => {
  assert.equal(concurrencyLimit(3), 3);
  assert.equal(concurrencyLimit('3'), 3);
  assert.equal(concurrencyLimit(''), 2);
  assert.equal(concurrencyLimit(0), 2);
  assert.equal(concurrencyLimit(undefined), 2);
  assert.equal(concurrencyLimit(-1), 1);
});

test('pruneLogs: 30 日より古い .log だけ消し、実行中の .out / .err は残す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-prune-'));
  const old = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000;
  for (const name of ['old.log', 'new.log', 'run.out', 'run.err']) fs.writeFileSync(path.join(dir, name), '');
  for (const name of ['old.log', 'run.out', 'run.err']) fs.utimesSync(path.join(dir, name), old, old);
  pruneLogs(dir, Date.now(), logKeepMs(30));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['new.log', 'run.err', 'run.out']);
  fs.rmSync(dir, { recursive: true });
  pruneLogs(path.join(dir, 'missing'), Date.now(), 0); // ディレクトリが無くても落ちない
});

test('pruneLogs: 指定した期間より古い .log を消して件数・容量を返す。0 なら終わった .log をすべて消す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-prune-'));
  const day = 24 * 60 * 60 * 1000;
  const old = (Date.now() - 3 * day) / 1000;
  fs.writeFileSync(path.join(dir, 'old.log'), 'abc');
  fs.utimesSync(path.join(dir, 'old.log'), old, old);
  for (const name of ['new.log', 'run.out']) fs.writeFileSync(path.join(dir, name), 'de');
  assert.deepEqual(logStats(dir), { count: 2, bytes: 5 });
  assert.deepEqual(pruneLogs(dir, Date.now(), 2 * day), { count: 1, bytes: 3 });
  assert.deepEqual(pruneLogs(dir, Date.now(), 0), { count: 1, bytes: 2 });
  assert.deepEqual(fs.readdirSync(dir), ['run.out']);
  assert.deepEqual(logStats(path.join(dir, 'missing')), { count: 0, bytes: 0 });
  fs.rmSync(dir, { recursive: true });
});

test('logKeepMs: 1 日未満・不正な値は既定の 30 日にする (自動削除で全部消さないように)', () => {
  const day = 24 * 60 * 60 * 1000;
  assert.equal(logKeepMs(7), 7 * day);
  assert.equal(logKeepMs(0), 30 * day);
  assert.equal(logKeepMs(''), 30 * day);
});

test('isAgentRun: 生きていても claude 以外のプロセスなら false', () => {
  const sleep = require('node:child_process').spawn('sleep', ['5']);
  try {
    assert.equal(isAlive(sleep.pid), true);
    assert.equal(isAgentRun(sleep.pid), false);
  } finally {
    sleep.kill();
  }
  assert.equal(isAgentRun(2 ** 22 + 12345), false);
});

test('isAgentRun: レビューボードが起動した claude (stream-json) だけを true にし、ユーザーの他の claude は止めない', () => {
  const { spawn } = require('node:child_process');
  const run = (...args) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)', 'claude', ...args]);
  const ours = run('-p', 'x', '--output-format', 'stream-json');
  const other = run('--resume');
  const codex = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)', 'codex', 'exec', '--json']);
  const interactive = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)', 'codex']);
  try {
    assert.equal(isAgentRun(ours.pid), true);
    assert.equal(isAgentRun(other.pid), false);
    assert.equal(isAgentRun(codex.pid, 'codex'), true);
    assert.equal(isAgentRun(codex.pid), false);
    assert.equal(isAgentRun(interactive.pid, 'codex'), false);
  } finally {
    ours.kill();
    other.kill();
    codex.kill();
    interactive.kill();
  }
});

test('normalizeNos: 番号が重複・欠落していれば 1 から振り直し、正しければそのまま返す', () => {
  const ok = [{ no: 3 }, { no: 5 }];
  assert.equal(normalizeNos(ok), ok);
  assert.deepEqual(normalizeNos([{ no: 1, t: 'a' }, { no: 1, t: 'b' }, { t: 'c' }]).map((f) => [f.no, f.t]), [[1, 'a'], [2, 'b'], [3, 'c']]);
  assert.equal(normalizeNos(undefined), null);
  assert.deepEqual(normalizeNos([null, { no: 1 }, 'x']), [{ no: 1 }]);
});

test('decisionLines: 要約があれば番号の後に添える', () => {
  const prompt = buildFixApplyPrompt({ url: 'https://x/3' }, [{ no: 1, comment: 'null を返す' }], { 1: { verdict: 'agree' } });
  assert.match(prompt, /- #1「null を返す」 同意 \/ 理由なし/);
});

test('sanitizeConfig: 未知の項目と型が違う値を捨てる', () => {
  assert.deepEqual(
    sanitizeConfig({ maxConcurrent: 3, model: 'opus', authors: ['a'], repos: { 'o/r': {} }, unknown: 1, pollMinutes: 'x', projects: 'url', repos2: {}, refreshSeconds: NaN }),
    { maxConcurrent: 3, model: 'opus', authors: ['a'], repos: { 'o/r': {} } },
  );
  assert.deepEqual(sanitizeConfig(null), {});
  assert.deepEqual(sanitizeConfig({ consentVersion: 1 }), {}); // 同意は設定画面からは変えられない
});

test('readTail: 末尾だけ読み、途中で切れた先頭行は捨てる', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'docket-tail-')), 'a.out');
  fs.writeFileSync(file, 'line1\nline2\nline3\n');
  assert.equal(readTail(file), 'line1\nline2\nline3\n');
  assert.equal(readTail(file, 9), 'line3\n'); // "e2\nline3\n" の切れた 1 行目を捨てる
  fs.rmSync(path.dirname(file), { recursive: true });
});

test('buildReviewPrompt: スキル指定なら /skill で始める', () => {
  const prompt = buildReviewPrompt({ url: 'https://x/1', number: 1, repo: 'o/r' }, { skill: 'be-review', args: '{pr-number}' });
  assert.match(prompt, /^\/be-review 1\n/);
  assert.match(prompt, /<docket-findings>/);
});

test('buildReviewPrompt: (prompt) なら設定のプロンプトをテンプレート展開して使う', () => {
  const prompt = buildReviewPrompt({ url: 'https://x/1', number: 1, repo: 'o/r' }, { skill: PROMPT_SKILL }, '{pr-url} を見て');
  assert.match(prompt, /^https:\/\/x\/1 を見て\n/);
  assert.doesNotMatch(prompt, /^\//);
  assert.match(prompt, /プレビューまでで止めて/);
  assert.match(prompt, /<docket-findings>/);
});

test('buildReviewPrompt: 設定のプロンプトが空なら既定のプロンプトを使う', () => {
  const prompt = buildReviewPrompt({ url: 'https://x/1', number: 1, repo: 'o/r' }, { skill: PROMPT_SKILL }, '  ');
  assert.match(prompt, /gh pr diff https:\/\/x\/1/);
});

test('投稿プロンプト: スキルに投稿手順がなくても gh api で投稿できる', () => {
  assert.match(buildPostPrompt({ url: 'https://x/1' }, [], {}, false, false), /gh api/);
  assert.match(buildSelfApplyPrompt({ url: 'https://x/1' }, [], {}), /gh api/);
});

test('buildFixPlanPrompt: (prompt) なら設定の対応プロンプトをテンプレート展開して使う', () => {
  const triage = [{ no: 1, url: 'https://x/c1', author: 'a', comment: 'c', verdict: 'agree', reason: '' }];
  const prompt = buildFixPlanPrompt({ repo: 'acme/api', number: 3, url: 'https://x/3' }, { fixSkill: PROMPT_SKILL }, triage, '{pr-url} に対応');
  assert.match(prompt, /^https:\/\/x\/3 に対応\n/);
  assert.match(prompt, /<docket-fix-plan>/);
  assert.match(buildFixPlanPrompt({ repo: 'acme/api', number: 3, url: 'https://x/3' }, { fixSkill: PROMPT_SKILL }, triage, ''), /gh pr checkout https:\/\/x\/3/);
});

test('対応の実行プロンプト: スキルがなくても最初の指示の手順で動かす', () => {
  assert.match(buildFixApplyPrompt({ url: 'https://x/1' }, [], {}), /最初の指示/);
  assert.match(buildCommentApplyPrompt({ url: 'https://x/1' }), /最初の指示/);
});

test('起動: 待機中の指摘への対応 (fix) が残っていても、事前判断を引き継いで積み直し、起動に失敗しない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-'));
  const triage = [{ no: 1, url: 'https://x/c1', author: 'a', comment: 'c', verdict: 'agree', reason: '' }];
  const pr = { repo: 'acme/api', number: 3, url: 'https://x/3' };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ repos: { 'acme/api': { fixSkill: 'review-fix' } }, consentVersion: 2 }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ prs: {}, mine: { 'mine:acme/api#3': { status: 'queued', mode: 'fix', triage, pr } } }));
  // PATH を空にして gh / claude を実際には起動しない
  const child = require('node:child_process').spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { DOCKET_DATA: dir, PORT: '0', PATH: '' } });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const started = await new Promise((resolve) => {
    child.stdout.on('data', (d) => /Docket:/.test(d) && resolve(true));
    child.on('exit', () => resolve(false));
  });
  child.kill();
  assert.ok(started, stderr);
});

test('logStats / pruneLogs: 読めない .log (リンク切れなど) があっても投げない (日次の削除でサーバーが落ちないように)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-'));
  fs.symlinkSync(path.join(dir, 'missing'), path.join(dir, 'broken.log'));
  fs.writeFileSync(path.join(dir, 'a.log'), 'x');
  assert.deepEqual(logStats(dir), { count: 1, bytes: 1 });
  assert.equal(pruneLogs(dir, Date.now(), 0).count, 1);
});

test('filterByAuthors: 設定に文字列以外が混ざっても投げない', () => {
  assert.deepEqual(filterByAuthors([{ author: { login: 'a' } }, { author: { login: '1' } }], [1, null]), [{ author: { login: '1' } }]);
});

test('GET /: index.html を読めなくても 500 を返し、サーバーは落ちない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-'));
  fs.copyFileSync(path.join(__dirname, 'server.js'), path.join(dir, 'server.js'));
  const port = await new Promise((resolve) => { const srv = require('node:net').createServer().listen(0, '127.0.0.1', () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); }); });
  const child = require('node:child_process').spawn(process.execPath, [path.join(dir, 'server.js')], { env: { DOCKET_DATA: path.join(dir, 'data'), PORT: String(port), PATH: '' } });
  try {
    await new Promise((resolve) => child.stdout.on('data', (d) => /Docket:/.test(d) && resolve()));
    const get = (p) => fetch(`http://localhost:${port}${p}`, { headers: { 'X-Docket': '1' } }).then((r) => r.status);
    assert.equal(await get('/'), 500);
    assert.equal(await get('/api/logs'), 200);
  } finally {
    child.kill();
  }
});

test('killRun: 既に終わったプロセスでも投げない (キャンセルが状態を戻せるように)', () => {
  const { pid } = require('node:child_process').spawnSync('true');
  assert.doesNotThrow(() => killRun(pid));
});

test('GitHub 取得: 一部のノードだけ権限エラー (gh は失敗で終わる) でも、取れた PR は反映してエラーも出す', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-'));
  const data = { viewer: { login: 'me' }, open: { issueCount: 2, nodes: [node(1), null] }, mine: { issueCount: 0, nodes: [] } };
  const errors = [{ message: 'Resource protected by organization SAML enforcement.' }];
  fs.writeFileSync(path.join(dir, 'out.json'), `${JSON.stringify({ data, errors })}\n`);
  // gh の代わりに、部分的なデータを出して失敗で終わるスクリプトを置く
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\nwhile IFS= read -r l; do echo "$l"; done < ${path.join(dir, 'out.json')}\necho "gh: SAML" >&2\nexit 1\n`, { mode: 0o755 });
  const port = await new Promise((resolve) => { const srv = require('node:net').createServer().listen(0, '127.0.0.1', () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); }); });
  const child = require('node:child_process').spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { DOCKET_DATA: path.join(dir, 'data'), PORT: String(port), PATH: dir } });
  try {
    await new Promise((resolve) => child.stdout.on('data', (d) => /Docket:/.test(d) && resolve()));
    const board = await fetch(`http://localhost:${port}/api/board?refresh=1`, { headers: { 'X-Docket': '1' } }).then((r) => r.json());
    assert.deepEqual(board.prs.map((p) => p.key), ['acme/api#1']);
    assert.match(board.fetchError, /SAML/);
  } finally {
    child.kill();
  }
});

test('isTruncated: ページが上限まで埋まり、まだ続きがあるときだけ true', () => {
  const page = (n, total) => ({ issueCount: total, nodes: Array(n).fill({}) });
  // GitHub の検索がたまに issueCount より少ない nodes を返しても、上限未満なら出さない
  assert.equal(isTruncated({ open: page(4, 5), merged: page(3, 3), mine: page(20, 21) }), false);
  assert.equal(isTruncated({ open: page(100, 101), mine: page(20, 20) }), true);
  assert.equal(isTruncated({ open: page(4, 4), mine: page(50, 51) }), true);
  assert.equal(isTruncated({ open: page(100, 100), mine: page(50, 50) }), false);
});
