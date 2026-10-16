'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 4649);
const DATA_DIR = process.env.REVIEW_BOARD_DATA || path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');

const DEFAULT_CONFIG = {
  workdir: os.homedir(),
  claudeArgs: '--permission-mode acceptEdits --allowedTools Read,Grep,Glob,Write,Edit,Agent,Bash(gh:*),Bash(git:*),Bash(jq:*),Bash(mkdir:*),Bash(rm:*),Bash(cat:*),Bash(ls:*),Bash(yarn:*)',
  pollMinutes: 5,
  // マージ済みでも自分のレビュー依頼が残っている PR を何日前まで表示するか (0 で非表示)
  mergedDays: 7,
  maxConcurrent: 2,
  // 空なら全員。指定するとこの作成者の PR だけ表示する (例: ["alice", "dependabot[bot]"])
  authors: [],
  // { "owner/name": { skill: "be-review", args: "{number}", cwd: "" } }
  repos: {},
};

// 再レビュー依頼と投稿直後の検索反映遅延を区別するための猶予
const RE_REQUEST_GRACE_MS = 2 * 60 * 1000;

const SEARCH_QUERY = `query($open: String!, $merged: String!, $withMerged: Boolean!) {
  viewer { login avatarUrl }
  open: search(query: $open, type: ISSUE, first: 100) { nodes { ...pr } }
  merged: search(query: $merged, type: ISSUE, first: 100) @include(if: $withMerged) { nodes { ...pr } }
}
fragment pr on PullRequest {
      number title url isDraft state mergedAt createdAt updatedAt
      repository { nameWithOwner }
      author { login avatarUrl }
      labels(first: 10) { nodes { name color } }
      closingIssuesReferences(first: 5) { nodes { number title url repository { nameWithOwner } } }
      latestReviews(first: 20) { nodes { state author { login avatarUrl } } }
      reviewRequests(first: 20) { nodes { requestedReviewer {
        ... on User { login avatarUrl }
        ... on Team { name }
      } } }
}`;

// ---------- 純粋関数 (テスト対象) ----------

function searchQueries(mergedDays, now) {
  const base = 'is:pr archived:false user-review-requested:@me';
  const since = new Date(now - mergedDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { open: `${base} is:open`, merged: `${base} is:merged merged:>=${since}`, withMerged: mergedDays > 0 };
}

// GraphQL の Bot login には "[bot]" が付かないので揃えて比較する
function authorKey(login) {
  return (login || '').trim().toLowerCase().replace(/\[bot\]$/, '');
}

function filterByAuthors(nodes, authors) {
  const allow = new Set((authors || []).map(authorKey).filter(Boolean));
  if (allow.size === 0) return nodes;
  return nodes.filter((n) => allow.has(authorKey(n.author?.login)));
}

function prKey(pr) {
  return `${pr.repository.nameWithOwner}#${pr.number}`;
}

function normalizePr(node) {
  return {
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    url: node.url,
    isDraft: node.isDraft,
    state: node.state,
    mergedAt: node.mergedAt,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    author: node.author,
    labels: node.labels.nodes,
    issues: node.closingIssuesReferences.nodes.map((i) => ({ ...i, repo: i.repository.nameWithOwner })),
    reviews: node.latestReviews.nodes.map((r) => ({ state: r.state, login: r.author?.login, avatarUrl: r.author?.avatarUrl })),
    requested: node.reviewRequests.nodes.map((r) => r.requestedReviewer).filter((r) => r && r.login),
  };
}

// GitHub の検索結果とローカル状態を突き合わせる
function mergeBoard(prs, fetched, now) {
  const next = {};
  const seen = new Set();
  for (const node of fetched) {
    const key = prKey(node);
    seen.add(key);
    let entry = prs[key];
    if (!entry || (entry.status === 'commented' && !entry.skipped && now - (entry.commentedAt || 0) > RE_REQUEST_GRACE_MS)) {
      // 再依頼でも PR ごとの累計使用量は引き継ぐ
      entry = { status: 'requested', ...(entry?.usage && { usage: entry.usage }) };
    }
    next[key] = { ...entry, pr: normalizePr(node), active: true };
  }
  for (const [key, entry] of Object.entries(prs)) {
    if (seen.has(key)) continue;
    // 依頼が外れた未着手 PR は消し、作業途中・完了済みは残す
    if (entry.status === 'requested') continue;
    next[key] = { ...entry, active: false };
  }
  return next;
}

// claude -p の JSON 出力から 1 実行分のトークン数 (全モデル・キャッシュ込み) と費用を取り出す
function usageOf(parsed) {
  const models = Object.values(parsed.modelUsage || {});
  if (models.length === 0 && parsed.total_cost_usd == null) return null;
  const tokens = models.reduce((sum, m) => sum + (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0), 0);
  return { tokens, costUsd: parsed.total_cost_usd || 0 };
}

function addUsage(prev, u) {
  if (!u) return prev;
  return { tokens: (prev?.tokens || 0) + u.tokens, costUsd: (prev?.costUsd || 0) + u.costUsd };
}

function fillTemplate(template, pr) {
  const [owner, name] = pr.repo.split('/');
  return (template || '{number}')
    .replaceAll('{number}', String(pr.number))
    .replaceAll('{url}', pr.url)
    .replaceAll('{repo}', name)
    .replaceAll('{owner}', owner)
    .replaceAll('{fullRepo}', pr.repo);
}

function buildReviewPrompt(pr, mapping) {
  return `/${mapping.skill} ${fillTemplate(mapping.args, pr)}

---
(ローカルのレビューボードからの非対話実行です)
- 対象PR: ${pr.url}
- ユーザーへの確認・質問はできません。PR への投稿・Approve はまだ行わず、プレビューまでで止めてください。
- レビュー完了後、最終回答の末尾に、投稿予定の指摘を次の形式で必ず出力してください。指摘が 0 件なら findings は空配列にしてください。

<review-board-findings>
{"summary":"全体所感(1〜3文)","findings":[{"no":1,"severity":"must / want / imo / nit など","title":"一行要約","path":"ファイルパス or null","line":行番号 or null,"body":"投稿予定のコメント本文(Markdown)"}]}
</review-board-findings>`;
}

function buildPostPrompt(pr, findings, decisions, approve, humanRead) {
  const lines = findings.map((f) => {
    const d = decisions[f.no] || {};
    const verdict = d.verdict === 'agree' ? '同意' : '非同意';
    const reason = d.reason?.trim() ? `理由: ${d.reason.trim()}` : '理由なし';
    return `- #${f.no} ${verdict} / ${reason}`;
  });
  return `レビューボードでユーザーが各指摘を判断しました。以下に従って、このスキルの投稿手順 (Reviews API・インラインコメント・失敗時のフォールバック) で PR ${pr.url} に投稿してください。これがユーザーの投稿承認であり、追加の確認は不要です。

## Approve
${approve ? 'する (event: APPROVE)' : 'しない (event: COMMENT)'}

## レビュアー本人のコード確認
${humanRead ? 'あり — レビュー本文に「人間のレビュアーもコードを読みました ✅」という一文を入れる。' : 'なし — コードを読んだ旨は書かない。'}

## 判断
${lines.join('\n')}

## 投稿ルール
- 同意: 指摘を投稿する。理由が書かれていれば、その内容を本文に自然に反映する。
- 非同意 (理由あり): 元の指摘は投稿しない。代わりに同じ箇所へ「🤔💭 」で始まるコメントを投稿し、レビュアー本人がこの点についてどう考えたかを伝える。人間の意見であることが伝わるようにし、ユーザーの文章をそのまま貼らず、文脈を補ったうえでチームのレビュー文化に合う口調に整える。
- 非同意 (理由なし): 投稿しない。
- 投稿対象が 0 件で、Approve もコード確認の表明もない場合は何も投稿しない。
- 完了後、最終回答の末尾に次を必ず出力する。投稿に失敗した場合は posted を false にし、error に理由を入れる。

<review-board-posted>
{"posted":true,"url":"投稿したレビューの URL または null","error":null}
</review-board-posted>`;
}

// 最終回答から <tag>JSON</tag> を取り出す (最後の出現を優先)
function extractTagJson(text, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  const matches = [...(text || '').matchAll(re)];
  if (matches.length === 0) return null;
  const body = matches.at(-1)[1].trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// Claude Code のセッション内でサーバーを起動した場合、親セッションの環境変数を引き継ぐと
// 入れ子起動として拒否されるため取り除く (CLAUDE_CONFIG_DIR はユーザー設定なので残す)
function childEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('CLAUDE') || k === 'CLAUDE_CONFIG_DIR'));
}

// "--a b,c 'd e'" 形式の引数文字列を配列にする
function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function canDecideAll(findings, decisions) {
  return findings.every((f) => ['agree', 'disagree'].includes(decisions?.[f.no]?.verdict));
}

// ---------- 永続化 ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

let config;
let state;

function saveState() {
  writeJson(STATE_FILE, state);
}

function updateEntry(key, patch) {
  // 実行中にカードが削除された場合は結果を捨てる
  if (!state.prs[key]) return;
  state.prs[key] = { ...state.prs[key], ...patch, updatedAt: Date.now() };
  saveState();
}

// ---------- GitHub ----------

function gh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function refreshFromGitHub() {
  const q = searchQueries(config.mergedDays, Date.now());
  const out = await gh(['api', 'graphql', '-f', `query=${SEARCH_QUERY}`, '-f', `open=${q.open}`, '-f', `merged=${q.merged}`, '-F', `withMerged=${q.withMerged}`]);
  const { data } = JSON.parse(out);
  state.viewer = data.viewer;
  const nodes = [...data.open.nodes, ...(data.merged?.nodes || [])].filter((n) => n.number);
  state.prs = mergeBoard(state.prs, filterByAuthors(nodes, config.authors), Date.now());
  state.lastFetchedAt = Date.now();
  state.fetchError = null;
  saveState();
}

// ---------- claude 実行 ----------

const queue = [];
let running = 0;

// stdout/stderr をファイルに書き出した claude の結果を読む。合わせて .log にまとめ、元ファイルは消す
function readRun(dir, logName, code) {
  const base = path.join(dir, logName);
  let stdout;
  let stderr;
  try {
    stdout = fs.readFileSync(`${base}.out`, 'utf8');
    stderr = fs.readFileSync(`${base}.err`, 'utf8');
  } catch (e) {
    return { ok: false, error: `claude の出力を読めません: ${e.message}` };
  }
  fs.writeFileSync(`${base}.log`, `exit=${code}\n--- stdout\n${stdout}\n--- stderr\n${stderr}`);
  fs.rmSync(`${base}.out`, { force: true });
  fs.rmSync(`${base}.err`, { force: true });
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: `claude の出力を解析できません (exit=${code}): ${stderr.slice(-500)}` };
  }
  return { ok: code === 0 && !parsed.is_error, result: parsed.result || '', sessionId: parsed.session_id, usage: usageOf(parsed), error: parsed.is_error ? parsed.result : null };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ponytail: PID が再利用されると無関係なプロセスの終了まで待つ。問題になったら開始時刻も照合する
function waitForExit(pid) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (isAlive(pid)) return;
      clearInterval(timer);
      resolve();
    }, 5000);
  });
}

// サーバーを再起動しても claude を止めず結果を回収できるよう、別プロセスグループで起動し出力をファイルに書かせる
function runClaude(prompt, { key, cwd, resume, logName }) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'json', ...splitArgs(config.claudeArgs)];
    if (resume) args.push('--resume', resume);
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const base = path.join(LOG_DIR, logName);
    const out = fs.openSync(`${base}.out`, 'w');
    const err = fs.openSync(`${base}.err`, 'w');
    const child = spawn('claude', args, { cwd, env: childEnv(process.env), detached: true, stdio: ['ignore', out, err] });
    fs.closeSync(out);
    fs.closeSync(err);
    if (child.pid) updateEntry(key, { run: { pid: child.pid, logName, cwd } });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => resolve(readRun(LOG_DIR, logName, code)));
  });
}

function logName(key, kind) {
  return `${key.replace(/[^\w.-]+/g, '_')}-${kind}-${Date.now()}`;
}

function pump() {
  while (running < config.maxConcurrent && queue.length > 0) {
    const job = queue.shift();
    running++;
    job.run().finally(() => {
      running--;
      pump();
    });
  }
}

function finishReview(key, cwd, res) {
  // キャンセル・失敗時も消費したトークンは計上する
  updateEntry(key, { run: null, usage: addUsage(state.prs[key]?.usage, res.usage) });
  // キャンセル済みなら結果を捨てる
  if (state.prs[key]?.status !== 'reviewing') return;
  if (!res.ok) return updateEntry(key, { status: 'requested', error: res.error || 'レビューに失敗しました' });
  const parsed = extractTagJson(res.result, 'review-board-findings');
  updateEntry(key, {
    status: 'reviewed',
    sessionId: res.sessionId,
    cwd,
    raw: res.result,
    summary: parsed?.summary || null,
    findings: Array.isArray(parsed?.findings) ? parsed.findings : null,
    error: parsed ? null : '指摘一覧 (JSON) を取得できませんでした。原文を確認してください',
    reviewedAt: Date.now(),
  });
}

function finishPost(key, res) {
  updateEntry(key, { run: null, usage: addUsage(state.prs[key]?.usage, res.usage) });
  const posted = res.ok ? extractTagJson(res.result, 'review-board-posted') : null;
  if (!posted?.posted) {
    return updateEntry(key, { status: 'reviewed', error: posted?.error || res.error || '投稿結果を確認できませんでした', postRaw: res.result });
  }
  updateEntry(key, { status: 'commented', commentedAt: Date.now(), postedUrl: posted.url || null, postRaw: res.result });
}

function enqueueReview(key) {
  const entry = state.prs[key];
  const mapping = config.repos[entry.pr.repo];
  const cwd = mapping.cwd || config.workdir;
  updateEntry(key, { status: 'queued', error: null, findings: null, summary: null, raw: null, decisions: {} });
  queue.push({ key, run: async () => {
    updateEntry(key, { status: 'reviewing', startedAt: Date.now() });
    finishReview(key, cwd, await runClaude(buildReviewPrompt(entry.pr, mapping), { key, cwd, logName: logName(key, 'review') }));
  } });
  pump();
}

// 前回のサーバープロセスで起動した claude の終了を待って結果を回収する
function recoverRun(key, { status, run }) {
  running++;
  waitForExit(run.pid)
    // 終了コードは取れないが、JSON は最後にまとめて出力されるので解析できれば正常終了とみなす
    .then(() => readRun(LOG_DIR, run.logName, 0))
    .then((res) => (status === 'reviewing' ? finishReview(key, run.cwd, res) : finishPost(key, res)))
    .finally(() => {
      running--;
      pump();
    });
}

// 投稿は途中で止めると PR に一部だけ投稿された状態になり得るので、レビューのみ対象にする
function cancelReview(key) {
  const i = queue.findIndex((job) => job.key === key);
  if (i >= 0) queue.splice(i, 1);
  const pid = state.prs[key]?.run?.pid;
  if (pid && isAlive(pid)) process.kill(pid, 'SIGTERM');
  updateEntry(key, { status: 'requested', error: null });
}

function enqueuePost(key, decisions, approve, humanRead) {
  const entry = state.prs[key];
  updateEntry(key, { status: 'posting', error: null, decisions, approve, humanRead });
  queue.push({ key, run: async () => {
    const res = await runClaude(buildPostPrompt(entry.pr, entry.findings, decisions, approve, humanRead), {
      key,
      cwd: entry.cwd,
      resume: entry.sessionId,
      logName: logName(key, 'post'),
    });
    finishPost(key, res);
  } });
  pump();
}

// ---------- スキル候補 ----------

// roots: 設定画面で編集中 (未保存) の作業ディレクトリも候補に含める
function listSkills(roots) {
  const dirs = new Set([path.join(os.homedir(), '.claude', 'skills')]);
  for (const root of roots) if (root) dirs.add(path.join(root, '.claude', 'skills'));
  const names = new Set();
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) if (fs.existsSync(path.join(dir, name, 'SKILL.md'))) names.add(name);
  }
  return [...names].sort();
}

// ---------- HTTP ----------

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function boardPayload() {
  return {
    viewer: state.viewer,
    lastFetchedAt: state.lastFetchedAt,
    fetchError: state.fetchError,
    prs: Object.entries(state.prs).map(([key, e]) => ({ key, ...e })),
    config,
  };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  // DNS rebinding 対策
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, { error: 'forbidden host' });

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });

  // 他サイトからの CSRF 対策 (独自ヘッダーはプリフライトが必要になり、CORS を許可していないので弾かれる)
  if (req.headers['x-review-board'] !== '1') return send(res, 403, { error: 'missing header' });

  if (req.method === 'GET' && url.pathname === '/api/board') {
    if (url.searchParams.get('refresh') === '1') {
      try {
        await refreshFromGitHub();
      } catch (e) {
        state.fetchError = e.message;
      }
    }
    return send(res, 200, boardPayload());
  }
  if (req.method === 'GET' && url.pathname === '/api/skills') {
    const roots = [config.workdir, ...Object.values(config.repos).map((m) => m.cwd), ...url.searchParams.getAll('dir')];
    return send(res, 200, { skills: listSkills(roots) });
  }

  const body = await readBody(req);
  if (req.method === 'PUT' && url.pathname === '/api/config') {
    config = { ...config, ...body };
    writeJson(CONFIG_FILE, config);
    pump();
    return send(res, 200, { config });
  }

  const entry = state.prs[body.key];
  if (req.method !== 'POST' || !entry) return send(res, 404, { error: 'not found' });

  if (url.pathname === '/api/review') {
    if (!config.repos[entry.pr.repo]?.skill) return send(res, 400, { error: `${entry.pr.repo} のスキルが未設定です` });
    if (['queued', 'reviewing', 'posting'].includes(entry.status)) return send(res, 409, { error: '実行中です' });
    enqueueReview(body.key);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/post') {
    if (entry.status !== 'reviewed' || !entry.findings || !entry.sessionId) return send(res, 409, { error: '投稿できる状態ではありません' });
    if (!canDecideAll(entry.findings, body.decisions)) return send(res, 400, { error: '未判断の指摘があります' });
    enqueuePost(body.key, body.decisions, !!body.approve, !!body.humanRead);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/cancel') {
    if (!['queued', 'reviewing'].includes(entry.status)) return send(res, 409, { error: 'キャンセルできる状態ではありません' });
    cancelReview(body.key);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/skip') {
    // 投稿せずに Done へ移す。GitHub 上の依頼は残るので mergeBoard で requested に戻さない
    if (entry.status !== 'requested') return send(res, 409, { error: 'スキップできる状態ではありません' });
    updateEntry(body.key, { status: 'commented', commentedAt: Date.now(), skipped: true, error: null });
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/dismiss') {
    delete state.prs[body.key];
    saveState();
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'not found' });
}

function main() {
  config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) };
  state = readJson(STATE_FILE, { prs: {} });
  // 前回プロセスで実行中だったジョブは失われているので戻す
  // claude を起動済みのジョブは別プロセスグループで動き続けているので結果を回収する
  for (const [key, e] of Object.entries(state.prs)) {
    if ((e.status === 'reviewing' || e.status === 'posting') && e.run) {
      recoverRun(key, e);
      continue;
    }
    if (e.status === 'queued' || e.status === 'reviewing') state.prs[key] = { ...e, status: 'requested', error: 'サーバー再起動により中断されました' };
    if (e.status === 'posting') state.prs[key] = { ...e, status: 'reviewed', error: 'サーバー再起動により投稿が中断されました。PR を確認してから再実行してください' };
  }
  saveState();

  const poll = () => refreshFromGitHub().catch((e) => {
    state.fetchError = e.message;
  });
  poll();
  setInterval(poll, config.pollMinutes * 60 * 1000);

  http
    .createServer((req, res) => handle(req, res).catch((e) => send(res, 500, { error: e.message })))
    .listen(PORT, '127.0.0.1', () => console.log(`Review Board: http://localhost:${PORT}`));
}

if (require.main === module) main();

module.exports = { readRun, isAlive, searchQueries, filterByAuthors, usageOf, addUsage, childEnv, mergeBoard, fillTemplate, buildReviewPrompt, buildPostPrompt, extractTagJson, splitArgs, canDecideAll, RE_REQUEST_GRACE_MS };
