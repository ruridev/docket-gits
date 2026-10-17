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
const SPRINT_CACHE_FILE = path.join(DATA_DIR, 'sprint-cache.json');

const DEFAULT_CONFIG = {
  workdir: os.homedir(),
  claudeArgs: '--permission-mode acceptEdits --allowedTools Read,Grep,Glob,Write,Edit,Agent,Bash(gh:*),Bash(git:*),Bash(jq:*),Bash(mkdir:*),Bash(rm:*),Bash(cat:*),Bash(ls:*),Bash(yarn:*)',
  // 空なら claude の既定。model はサブエージェントにも使わせる
  model: '',
  effort: '',
  pollMinutes: 5,
  // ブラウザが /api/board を取り直す間隔
  refreshSeconds: 5,
  // マージ済みでも自分のレビュー依頼が残っている PR を何日前まで表示するか (0 で非表示)
  mergedDays: 7,
  maxConcurrent: 2,
  // 空なら全員。指定するとこの作成者の PR だけ表示する (例: ["alice", "dependabot[bot]"])
  authors: [],
  // { "owner/name": { skill: "be-review", args: "{pr-number}", cwd: "", selfSkill: "", selfArgs: "", fixSkill: "", fixArgs: "" } }
  // selfSkill: 自分の PR のセルフレビュー、fixSkill: 自分の PR に付いた指摘への対応 (空ならボタンを出さない)
  repos: {},
  // スプリント画面で見る GitHub Projects の URL (例: https://github.com/orgs/docket/projects/76)
  projects: [],
  // スプリント画面に出す過去・未来のスプリント数 (未来は issue があるものだけ)
  sprintPast: 1,
  sprintFuture: 1,
};

// 再レビュー依頼と投稿直後の検索反映遅延を区別するための猶予
const RE_REQUEST_GRACE_MS = 2 * 60 * 1000;

const SEARCH_QUERY = `query($open: String!, $merged: String!, $withMerged: Boolean!, $mine: String!) {
  viewer { login avatarUrl }
  open: search(query: $open, type: ISSUE, first: 100) { nodes { ...pr } }
  merged: search(query: $merged, type: ISSUE, first: 100) @include(if: $withMerged) { nodes { ...pr } }
  mine: search(query: $mine, type: ISSUE, first: 50) { nodes { ...pr ... on PullRequest {
    reviewThreads(first: 100) { nodes { isResolved comments(last: 1) { nodes { author { login } } } } }
  } } }
}
fragment pr on PullRequest {
      number title url isDraft state mergedAt createdAt updatedAt baseRefName headRefName
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
  return { open: `${base} is:open`, merged: `${base} is:merged merged:>=${since}`, withMerged: mergedDays > 0, mine: 'is:pr archived:false author:@me is:open' };
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
    base: node.baseRefName,
    head: node.headRefName,
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

// 未解決スレッドのうち最後の発言が自分以外 = まだ自分が応答していない指摘
// 返信すると最後の発言が自分になるので、状態を持たずに「新しい指摘」を判定できる
function pendingThreads(node, login) {
  return (node.reviewThreads?.nodes || []).filter((t) => !t.isResolved && t.comments.nodes.at(-1)?.author?.login !== login).length;
}

function mineKey(pr) {
  return `mine:${prKey(pr)}`;
}

// 自分の open PR とローカル状態を突き合わせる。クローズされた PR は実行中のものだけ残す
function mergeMine(mine, fetched, login) {
  const next = {};
  for (const node of fetched) {
    const key = mineKey(node);
    const pending = pendingThreads(node, login);
    // マージ可能・Done に移した PR でも、新しい指摘が来たら指摘ありに戻す
    next[key] = { status: 'idle', ...mine[key], pr: normalizePr(node), pending, ...(pending && { mergeReady: false, done: false }) };
  }
  for (const [key, entry] of Object.entries(mine)) {
    if (!next[key] && ['queued', 'running', 'applying'].includes(entry.status)) next[key] = entry;
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
  return (template || '{pr-number}')
    .replaceAll('{pr-number}', String(pr.number))
    .replaceAll('{pr-url}', pr.url)
    .replaceAll('{repo-name}', name)
    .replaceAll('{owner-name}', owner)
    .replaceAll('{full-repo-name}', pr.repo);
}

function buildReviewPrompt(pr, mapping) {
  return `/${mapping.skill} ${fillTemplate(mapping.args, pr)}

---
(ローカルのレビューボードからの非対話実行です)
- 対象PR: ${pr.url}
- ユーザーへの確認・質問はできません。PR への投稿・Approve はまだ行わず、プレビューまでで止めてください。
- レビュー完了後、最終回答の末尾に、投稿予定の指摘を次の形式で必ず出力してください。指摘が 0 件なら findings は空配列にしてください。
- 結果として読み取るのは最後のメッセージだけです。サブエージェントの完了通知などで回答が続いた場合も、最後のメッセージにこのブロックを省略せず再掲してください。

<review-board-findings>
{"summary":"全体所感(1〜3文)","findings":[{"no":1,"severity":"must / want / imo / nit など","title":"一行要約","path":"ファイルパス or null","line":行番号 or null,"body":"投稿予定のコメント本文(Markdown)"}]}
</review-board-findings>`;
}

function buildPostPrompt(pr, findings, decisions, approve, humanRead) {
  return `レビューボードでユーザーが各指摘を判断しました。以下に従って、このスキルの投稿手順 (Reviews API・インラインコメント・失敗時のフォールバック) で PR ${pr.url} に投稿してください。これがユーザーの投稿承認であり、追加の確認は不要です。

## Approve
${approve ? 'する (event: APPROVE)' : 'しない (event: COMMENT)'}

## レビュアー本人のコード確認
${humanRead ? 'あり — レビュー本文に「人間のレビュアーもコードを読みました ✅」という一文を入れる。' : 'なし — コードを読んだ旨は書かない。'}

## 判断
${decisionLines(findings, decisions)}

## 投稿ルール
- 同意: 指摘を投稿する。理由が書かれていれば、その内容を本文に自然に反映する。
- 非同意 (理由あり): 同じ箇所へ次の形式で 1 つのコメントを投稿する。AI の指摘をレビュアー本人が書いたように見せないため、AI の指摘と本人の意見をはっきり分ける。
  - 1 段落目: 「🤖: 」で始め、AI エージェントの元の指摘を要約して載せる。
  - 区切り線 \`---\`
  - 2 段落目: 「🤔💭 」で始め、レビュアー本人がこの点についてどう考えたかを伝える。ユーザーの文章をそのまま貼らず、文脈を補ったうえでチームのレビュー文化に合う口調に整える。
- 非同意 (理由なし): 投稿しない。
- 投稿対象が 0 件で、Approve もコード確認の表明もない場合は何も投稿しない。
- 完了後、最終回答の末尾に次を必ず出力する。投稿に失敗した場合は posted を false にし、error に理由を入れる。

<review-board-posted>
{"posted":true,"url":"投稿したレビューの URL または null","error":null}
</review-board-posted>`;
}

function decisionLines(items, decisions) {
  return items.map((f) => {
    const d = decisions[f.no] || {};
    const verdict = d.verdict === 'agree' ? '同意' : '非同意';
    const reason = d.reason?.trim() ? `理由: ${d.reason.trim()}` : '理由なし';
    return `- #${f.no} ${verdict} / ${reason}`;
  }).join('\n');
}

const APPLIED_TAG = `完了後、最終回答の末尾に次を必ず出力する。push や返信に失敗した場合は done を false にし、error に理由を入れる。

<review-board-applied>
{"done":true,"error":null}
</review-board-applied>`;

// review-fix は手順 1〜3 (取得・チェックアウト・分類) で止め、対応計画だけを返させる
function buildFixPlanPrompt(pr, mapping) {
  return `/${mapping.fixSkill} ${fillTemplate(mapping.fixArgs, pr)}

---
(ローカルのレビューボードからの非対話実行です)
- 対象PR: ${pr.url}
- ユーザーへの確認・質問はできません。この実行では指摘の取得・ブランチのチェックアウト・分類までを行い、コードの修正・コミット・push・返信はまだ行わないでください。
- 最終回答の末尾に、指摘ごとの対応計画を次の形式で必ず出力してください。未対応の指摘が 0 件なら items は空配列にしてください。
- 結果として読み取るのは最後のメッセージだけです。サブエージェントの完了通知などで回答が続いた場合も、最後のメッセージにこのブロックを省略せず再掲してください。

<review-board-fix-plan>
{"summary":"全体の対応方針(1〜3文)","items":[{"no":1,"category":"fix / reply / defer","author":"指摘者の login","url":"元コメントの URL","path":"ファイルパス or null","line":行番号 or null,"comment":"指摘内容の要約","plan":"修正内容 (fix のみ。それ以外は null)","reply":"返信文ドラフト(Markdown)"}]}
</review-board-fix-plan>`;
}

function buildFixApplyPrompt(pr, items, decisions) {
  return `レビューボードでユーザーが各指摘への対応計画を判断しました。以下に従って、PR ${pr.url} についてこのスキルの修正・コミット・push・返信の手順を実行してください。これがユーザーの確認ゲートの承認であり、追加の確認は不要です。

## 判断
${decisionLines(items, decisions)}

## ルール
- 同意: 計画どおり修正・返信する。理由が書かれていれば、その内容を反映する。
- 非同意 (理由あり): 計画どおりには対応しない。理由に沿って対応を決め直す (修正方針の変更、または返信のみ)。返信はユーザーの文章をそのまま貼らず、文脈を補ったうえでチームのレビュー文化に合う口調に整える。
- 非同意 (理由なし): 修正も返信もしない。
- 計画にない指摘には触れない。resolve はしない。force-push はしない。
- ${APPLIED_TAG}`;
}

// セルフレビューで同意した指摘は、PR に投稿 → 修正・push → 投稿した指摘へ返信、までを行う
function buildSelfApplyPrompt(pr, findings, decisions) {
  return `レビューボードでユーザーがセルフレビューの各指摘を判断しました。PR ${pr.url} について次を行ってください。これがユーザーの投稿・push の承認であり、追加の確認は不要です。

## 判断
${decisionLines(findings, decisions)}

## 手順
1. 同意した指摘を、このスキルの投稿手順で PR に投稿する (Approve はしない。event: COMMENT)。理由が書かれていれば本文に反映する。
2. AGENTS.md の規約に従い対象リポジトリの clone で PR ブランチをチェックアウトし、同意した指摘ごとに修正して 1 指摘 1 コミットにする。
3. push する (force-push はしない)。
4. 1 で投稿した各指摘コメントに、対応したコミット SHA を含む返信をする (例: 「修正しました ( commit abc123 )」。SHA と括弧の間の半角スペースは GitHub の自動リンクのため残す)。resolve はしない。

## ルール
- 非同意の指摘は投稿も修正もしない。
- 同意が 0 件なら何もしない。
- ${APPLIED_TAG}`;
}

// 判断ダイアログを使わず、ユーザーが PR に直接書いたコメントを指示として対応させる
function buildCommentApplyPrompt(pr) {
  return `ユーザーは対応計画への判断をレビューボードではなく、PR ${pr.url} 上のコメントで行いました。PR のレビュースレッドとコメントを取得し、PR 作成者 (ユーザー) が最後に書いたコメントを指示として、このスキルの修正・コミット・push・返信の手順を実行してください。これがユーザーの確認ゲートの承認であり、追加の確認は不要です。

## ルール
- ユーザーのコメントで指示された内容だけ対応する。指示が無いスレッドには触れない。
- 返信はユーザーのコメントと重複させず、対応したコミット SHA を含める。
- resolve はしない。force-push はしない。
- ${APPLIED_TAG}`;
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

// 未指定だとサブエージェント (Explore など) は Haiku で動くので、設定のモデルに揃える
function modelOptions(cfg) {
  return {
    args: [...(cfg.model ? ['--model', cfg.model] : []), ...(cfg.effort ? ['--effort', cfg.effort] : [])],
    env: cfg.model ? { CLAUDE_CODE_SUBAGENT_MODEL: cfg.model } : {},
  };
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

// ---------- スプリント (GitHub Projects) ----------

function parseProjectUrl(url) {
  const m = /github\.com\/(orgs|users)\/([^/]+)\/projects\/(\d+)/.exec(url || '');
  return m && { owner: m[1] === 'orgs' ? 'organization' : 'user', login: m[2], number: Number(m[3]) };
}

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// 最初の Iteration フィールドをスプリント、名前で開始日・終了日の Date フィールドを選ぶ (見つからなければ Date フィールドの 1・2 個目)
function detectFields(fields) {
  const iter = fields.find((f) => f.dataType === 'ITERATION');
  const dates = fields.filter((f) => f.dataType === 'DATE').map((f) => f.name);
  const start = dates.find((n) => /開始|start|begin/i.test(n)) || dates[0] || null;
  const end = dates.find((n) => /終了|end|due|target|deadline/i.test(n)) || dates.find((n) => n !== start) || null;
  const toIter = (completed) => (i) => ({ id: i.id, title: i.title, startDate: i.startDate, endDate: addDays(i.startDate, i.duration - 1), completed });
  const iterations = iter ? [...iter.configuration.iterations.map(toIter(false)), ...iter.configuration.completedIterations.map(toIter(true))] : [];
  return { sprint: iter?.name || null, start, end, iterations };
}

// 現在のスプリントと、過去 past 個・未来 future 個 (issue があるものだけ) に絞り、新しい順に並べる
function pickIterations(iterations, today, { past, future }) {
  const asc = [...iterations].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const before = asc.filter((i) => i.endDate < today);
  return [
    ...before.slice(Math.max(0, before.length - past)),
    ...asc.filter((i) => i.startDate <= today && today <= i.endDate),
    ...asc.filter((i) => i.startDate > today && i.count !== 0).slice(0, future),
  ].reverse();
}

// 日付が未設定・スプリント外なら、スプリントの開始日・終了日として扱う (YYYY-MM-DD は文字列比較できる)
function barRange(start, end, sprint) {
  const inside = (d) => d && d >= sprint.startDate && d <= sprint.endDate;
  const s = inside(start) ? start : sprint.startDate;
  const e = inside(end) ? end : sprint.endDate;
  return s <= e ? { start: s, end: e } : { start: sprint.startDate, end: sprint.endDate };
}

// sprintIds: スプリントに紐づく issue。issues: id → { childIds, start, end, ... } (子孫も含む)
// 他のスプリント issue の子孫になっているものは、最上位の親の下にだけ出す
function sprintTree(sprintIds, issues, sprint) {
  const descendants = (id) => {
    const seen = new Set();
    const walk = (i) => (issues.get(i)?.childIds || []).forEach((c) => !seen.has(c) && (seen.add(c), walk(c)));
    walk(id);
    seen.delete(id);
    return seen;
  };
  const under = new Set(sprintIds.flatMap((id) => [...descendants(id)]));
  const roots = sprintIds.filter((id) => !under.has(id));
  // 循環で全員が誰かの子孫になった場合は、まだ出ていないものを起点にする
  const shown = new Set(roots.flatMap((id) => [id, ...descendants(id)]));
  for (const id of sprintIds) if (!shown.has(id)) { roots.push(id); descendants(id).forEach((d) => shown.add(d)); shown.add(id); }

  const build = (id, path) => {
    const { childIds = [], ...issue } = issues.get(id);
    const next = new Set(path).add(id);
    return {
      ...issue,
      ...barRange(issue.start, issue.end, sprint),
      rawStart: issue.start || null,
      rawEnd: issue.end || null,
      children: childIds.filter((c) => issues.has(c) && !next.has(c)).map((c) => build(c, next)),
    };
  };
  return roots.map((id) => build(id, new Set()));
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

// レビューする側は state.prs、レビューを受ける側 (キーが mine: で始まる) は state.mine
const mapOf = (key) => (key.startsWith('mine:') ? state.mine : state.prs);

function updateEntry(key, patch) {
  const map = mapOf(key);
  // 実行中にカードが削除された場合は結果を捨てる
  if (!map[key]) return;
  map[key] = { ...map[key], ...patch, updatedAt: Date.now() };
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
  const out = await gh(['api', 'graphql', '-f', `query=${SEARCH_QUERY}`, '-f', `open=${q.open}`, '-f', `merged=${q.merged}`, '-F', `withMerged=${q.withMerged}`, '-f', `mine=${q.mine}`]);
  const { data } = JSON.parse(out);
  state.viewer = data.viewer;
  const nodes = [...data.open.nodes, ...(data.merged?.nodes || [])].filter((n) => n.number);
  state.prs = mergeBoard(state.prs, filterByAuthors(nodes, config.authors), Date.now());
  // 個人リポジトリなどを混ぜないよう、設定に登録したリポジトリの PR だけ扱う (未登録なら全件)
  const registered = (n) => Object.keys(config.repos).length === 0 || config.repos[n.repository.nameWithOwner];
  state.mine = mergeMine(state.mine, data.mine.nodes.filter((n) => n.number && registered(n)), data.viewer.login);
  state.lastFetchedAt = Date.now();
  state.fetchError = null;
  saveState();
}

// ---------- スプリント ----------

async function ghql(query, vars = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === 'string' ? '-f' : '-F', `${k}=${v}`);
  const json = JSON.parse(await gh(args));
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('\n'));
  return json.data;
}

const projectRoot = (p) => `${p.owner}(login: $login) { projectV2(number: $number)`;

const ISSUE_FIELDS = `fragment iss on Issue {
  id number title url state stateReason repository { nameWithOwner }
  assignees(first: 5) { nodes { login avatarUrl } }
  subIssues { totalCount }
  projectItems(first: 20) { nodes {
    project { id }
    sprint: fieldValueByName(name: $sprint) { ... on ProjectV2ItemFieldIterationValue { iterationId } }
    start: fieldValueByName(name: $start) { ... on ProjectV2ItemFieldDateValue { date } }
    end: fieldValueByName(name: $end) { ... on ProjectV2ItemFieldDateValue { date } }
  } }
}`;

// 開始日・終了日・スプリントはこのプロジェクトの値だけ使う (プロジェクトに無い issue は未設定)
function normIssue(n, projectId) {
  const item = n.projectItems.nodes.find((i) => i.project?.id === projectId);
  return {
    id: n.id, number: n.number, title: n.title, url: n.url, repo: n.repository.nameWithOwner,
    state: n.state, stateReason: n.stateReason, assignees: n.assignees.nodes,
    subCount: n.subIssues.totalCount, sprintId: item?.sprint?.iterationId || null,
    start: item?.start?.date || null, end: item?.end?.date || null, childIds: [],
  };
}

// サーバーを再起動しても取り直さないようファイルにも保存する
const sprintCache = new Map(Object.entries(readJson(SPRINT_CACHE_FILE, {})));
// 全体スケジュールの把握用なので自動では取り直さない。最新にしたいときは画面の「今すぐ更新」で refresh=1 を送る
const SPRINT_CACHE_MS = 24 * 60 * 60 * 1000;
async function cached(key, refresh, fn) {
  const hit = sprintCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < SPRINT_CACHE_MS) return hit.data;
  const data = await fn();
  sprintCache.set(key, { at: Date.now(), data });
  for (const [k, v] of sprintCache) if (Date.now() - v.at >= SPRINT_CACHE_MS) sprintCache.delete(k);
  writeJson(SPRINT_CACHE_FILE, Object.fromEntries(sprintCache));
  return data;
}

const filterQuery = (field, title) => `${JSON.stringify(field)}:${JSON.stringify(title)}`;

async function projectMeta(url, refresh) {
  const p = parseProjectUrl(url);
  if (!p) throw new Error(`プロジェクト URL を解析できません: ${url}`);
  const range = { past: Math.max(0, Number(config.sprintPast) || 0), future: Math.max(0, Number(config.sprintFuture) || 0) };
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return cached(`meta:${url}:${range.past}:${range.future}:${today}`, refresh, async () => {
    const data = await ghql(`query($login: String!, $number: Int!) { ${projectRoot(p)} { id title url fields(first: 50) { nodes {
      ... on ProjectV2FieldCommon { name dataType }
      ... on ProjectV2IterationField { configuration { iterations { id title startDate duration } completedIterations { id title startDate duration } } }
    } } } } }`, { login: p.login, number: p.number });
    const project = data[p.owner].projectV2;
    const fields = detectFields(project.fields.nodes);
    // スプリントごとの件数はエイリアスでまとめて取る
    // 件数で未来のスプリントを絞るので、未来はいったんすべて数える
    fields.iterations = pickIterations(fields.iterations, today, { past: range.past, future: Infinity });
    if (fields.iterations.length) {
      const counts = await ghql(`query($login: String!, $number: Int!) { ${projectRoot(p)} {
        ${fields.iterations.map((it, i) => `c${i}: items(first: 0, query: ${JSON.stringify(filterQuery(fields.sprint, it.title))}) { totalCount }`).join('\n')}
      } } }`, { login: p.login, number: p.number });
      fields.iterations.forEach((it, i) => (it.count = counts[p.owner].projectV2[`c${i}`].totalCount));
    }
    fields.iterations = pickIterations(fields.iterations, today, range);
    return { url, id: project.id, title: project.title, ...fields };
  });
}

const SUB_DEPTH = 6;
async function sprintIssues(url, iterationId, refresh) {
  const meta = await projectMeta(url, refresh);
  const sprint = meta.iterations.find((i) => i.id === iterationId);
  if (!sprint) throw new Error('スプリントが見つかりません');
  return cached(`sprint:${url}:${iterationId}`, refresh, async () => {
    const p = parseProjectUrl(url);
    const names = { sprint: meta.sprint, start: meta.start || '-', end: meta.end || '-' };
    const issues = new Map();
    const sprintIds = [];
    let after = null;
    do {
      const data = await ghql(`query($login: String!, $number: Int!, $q: String!, $after: String, $sprint: String!, $start: String!, $end: String!) { ${projectRoot(p)} {
        items(first: 50, after: $after, query: $q) { pageInfo { hasNextPage endCursor } nodes { content { ...iss } } }
      } } }
      ${ISSUE_FIELDS}`, { login: p.login, number: p.number, q: filterQuery(meta.sprint, sprint.title), ...(after && { after }), ...names });
      const page = data[p.owner].projectV2.items;
      for (const n of page.nodes) {
        if (!n.content?.id) continue; // Draft issue・PR は対象外
        issues.set(n.content.id, normIssue(n.content, meta.id));
        sprintIds.push(n.content.id);
      }
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);

    // sub issue を 1 階層ずつまとめて取る
    let frontier = [...issues.values()].filter((i) => i.subCount > 0).map((i) => i.id);
    for (let depth = 0; depth < SUB_DEPTH && frontier.length; depth++) {
      const next = [];
      for (let i = 0; i < frontier.length; i += 30) {
        const ids = frontier.slice(i, i + 30);
        const data = await ghql(`query($sprint: String!, $start: String!, $end: String!) {
          nodes(ids: ${JSON.stringify(ids)}) { ... on Issue { id subIssues(first: 100) { nodes { ...iss } } } }
        }
        ${ISSUE_FIELDS}`, names);
        for (const parent of data.nodes) {
          if (!parent) continue;
          issues.get(parent.id).childIds = parent.subIssues.nodes.map((c) => c.id);
          for (const c of parent.subIssues.nodes) {
            if (issues.has(c.id)) continue;
            const child = normIssue(c, meta.id);
            issues.set(c.id, child);
            if (child.subCount > 0) next.push(c.id);
          }
        }
      }
      frontier = next;
    }
    return { sprint, roots: sprintTree(sprintIds, issues, sprint), fetchedAt: Date.now() };
  });
}

// 0 や空文字で GitHub を叩き続けないよう 1 分未満は既定値に戻す
function pollIntervalMs(minutes) {
  const m = Number(minutes);
  return (m >= 1 ? m : DEFAULT_CONFIG.pollMinutes) * 60 * 1000;
}

let pollTimer = null;
function schedulePoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => refreshFromGitHub().catch((e) => {
    state.fetchError = e.message;
  }), pollIntervalMs(config.pollMinutes));
}

// ---------- claude 実行 ----------

const queue = [];
let running = 0;
// 自分の PR への対応は同じ clone でブランチを切り替えるので、リポジトリごとに 1 件ずつ実行する
const busyRepos = new Set();

function parseLines(text) {
  return text.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

// 実行中の stream-json 出力から、Claude の発言とツール呼び出しを直近 limit 件だけ 1 行ずつにする
function logLines(text, limit = 50) {
  const lines = [];
  for (const ev of parseLines(text)) {
    if (ev.type !== 'assistant') continue;
    const indent = ev.parent_tool_use_id ? '  ↳ ' : '';
    for (const c of ev.message?.content || []) {
      if (c.type === 'text' && c.text.trim()) lines.push(`${indent}💬 ${c.text.trim()}`);
      if (c.type === 'tool_use') lines.push(`${indent}🔧 ${c.name} ${JSON.stringify(c.input).slice(0, 200)}`);
    }
  }
  return lines.slice(-limit);
}

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
  // stream-json は 1 行 1 イベントで、最後の result イベントに結果がまとまる
  const parsed = parseLines(stdout).findLast((ev) => ev.type === 'result');
  if (!parsed) return { ok: false, error: `claude の出力を解析できません (exit=${code}): ${stderr.slice(-500)}` };
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
    const model = modelOptions(config);
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...model.args, ...splitArgs(config.claudeArgs)];
    if (resume) args.push('--resume', resume);
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const base = path.join(LOG_DIR, logName);
    const out = fs.openSync(`${base}.out`, 'w');
    const err = fs.openSync(`${base}.err`, 'w');
    const child = spawn('claude', args, { cwd, env: { ...childEnv(process.env), ...model.env }, detached: true, stdio: ['ignore', out, err] });
    fs.closeSync(out);
    fs.closeSync(err);
    if (child.pid) updateEntry(key, { run: { pid: child.pid, logName, cwd } });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => resolve(readRun(LOG_DIR, logName, code)));
  });
}

// claude -p の result は最後のメッセージだけなので、サブエージェントの完了通知などで回答が続くと
// 先に出力したタグが落ちる。その場合は同じセッションを 1 回だけ再開してタグを再出力させる
async function runForTag(tag, prompt, opts, run = runClaude) {
  const res = await run(prompt, opts);
  if (!res.ok || !res.sessionId || extractTagJson(res.result, tag)) return res;
  const retry = await run(`直前までに出力した <${tag}> ブロックを、内容を変えずにもう一度そのまま出力してください。まだ出力していなければ、指示どおりの形式で出力してください。`, {
    ...opts,
    resume: res.sessionId,
    logName: `${opts.logName}-retag`,
  });
  const usage = addUsage(res.usage, retry.usage);
  if (!retry.ok) return { ...res, usage };
  return { ...res, usage, sessionId: retry.sessionId || res.sessionId, result: `${res.result}\n\n${retry.result}` };
}

function logName(key, kind) {
  return `${key.replace(/[^\w.-]+/g, '_')}-${kind}-${Date.now()}`;
}

function pump() {
  for (let i = 0; i < queue.length && running < config.maxConcurrent; ) {
    const job = queue[i];
    if (job.repo && busyRepos.has(job.repo)) {
      i++;
      continue;
    }
    queue.splice(i, 1);
    running++;
    if (job.repo) busyRepos.add(job.repo);
    job.run().finally(() => {
      running--;
      busyRepos.delete(job.repo);
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
    finishReview(key, cwd, await runForTag('review-board-findings', buildReviewPrompt(entry.pr, mapping), { key, cwd, logName: logName(key, 'review') }));
  } });
  pump();
}

// 前回のサーバープロセスで起動した claude の終了を待って結果を回収する
function recoverRun(run, finish, repo) {
  running++;
  if (repo) busyRepos.add(repo);
  waitForExit(run.pid)
    // 終了コードは取れないが、result イベントは最後に出力されるので解析できれば正常終了とみなす
    .then(() => readRun(LOG_DIR, run.logName, 0))
    .then(finish)
    .finally(() => {
      running--;
      busyRepos.delete(repo);
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

// ---------- 自分の PR (レビューを受ける) ----------

function finishMine(key, cwd, res) {
  updateEntry(key, { run: null, usage: addUsage(state.mine[key]?.usage, res.usage) });
  const entry = state.mine[key];
  // キャンセル済みなら結果を捨てる
  if (entry?.status !== 'running') return;
  if (!res.ok) return updateEntry(key, { status: 'idle', error: res.error || '実行に失敗しました' });
  const parsed = extractTagJson(res.result, entry.mode === 'self' ? 'review-board-findings' : 'review-board-fix-plan');
  const items = entry.mode === 'self' ? parsed?.findings : parsed?.items;
  updateEntry(key, {
    status: 'planned',
    sessionId: res.sessionId,
    cwd,
    raw: res.result,
    summary: parsed?.summary || null,
    findings: Array.isArray(items) ? items : null,
    error: parsed ? null : '結果 (JSON) を取得できませんでした。原文を確認してください',
  });
}

function finishApply(key, res) {
  updateEntry(key, { run: null, usage: addUsage(state.mine[key]?.usage, res.usage) });
  const applied = res.ok ? extractTagJson(res.result, 'review-board-applied') : null;
  if (!applied?.done) {
    return updateEntry(key, { status: 'planned', error: applied?.error || res.error || '対応結果を確認できませんでした。PR を確認してください', applyRaw: res.result });
  }
  updateEntry(key, { status: 'idle', error: null, findings: null, summary: null, raw: null, sessionId: null, appliedAt: Date.now(), applyRaw: res.result });
}

// mode: 'self' (セルフレビュー) / 'fix' (指摘への対応計画)
function enqueueMine(key, mode) {
  const entry = state.mine[key];
  const mapping = config.repos[entry.pr.repo];
  const cwd = mapping.cwd || config.workdir;
  const prompt = mode === 'self' ? buildReviewPrompt(entry.pr, { skill: mapping.selfSkill, args: mapping.selfArgs }) : buildFixPlanPrompt(entry.pr, mapping);
  updateEntry(key, { status: 'queued', mode, error: null, findings: null, summary: null, raw: null, decisions: {} });
  queue.push({ key, repo: entry.pr.repo, run: async () => {
    updateEntry(key, { status: 'running', startedAt: Date.now() });
    finishMine(key, cwd, await runForTag(mode === 'self' ? 'review-board-findings' : 'review-board-fix-plan', prompt, { key, cwd, logName: logName(key, mode) }));
  } });
  pump();
}

// decisions が無ければ PR 上のコメントを指示として対応する
function enqueueApply(key, decisions) {
  const entry = state.mine[key];
  const prompt = !decisions ? buildCommentApplyPrompt(entry.pr) : entry.mode === 'self' ? buildSelfApplyPrompt(entry.pr, entry.findings, decisions) : buildFixApplyPrompt(entry.pr, entry.findings, decisions);
  updateEntry(key, { status: 'applying', error: null, decisions });
  queue.push({ key, repo: entry.pr.repo, run: async () => {
    finishApply(key, await runClaude(prompt, { key, cwd: entry.cwd, resume: entry.sessionId, logName: logName(key, 'apply') }));
  } });
  pump();
}

// 対応 (push・返信) は途中で止めると一部だけ反映された状態になり得るので、計画・セルフレビューのみ対象にする
function cancelMine(key) {
  const i = queue.findIndex((job) => job.key === key);
  if (i >= 0) queue.splice(i, 1);
  const pid = state.mine[key]?.run?.pid;
  if (pid && isAlive(pid)) process.kill(pid, 'SIGTERM');
  updateEntry(key, { status: 'idle', error: null });
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
    mine: Object.entries(state.mine).map(([key, e]) => ({ key, ...e })),
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
  if (req.method === 'GET' && url.pathname === '/api/log') {
    const key = url.searchParams.get('key');
    const run = (state.prs[key] || state.mine[key])?.run;
    let text = '';
    try {
      if (run) text = fs.readFileSync(path.join(LOG_DIR, `${run.logName}.out`), 'utf8');
    } catch {}
    return send(res, 200, { running: !!run, lines: logLines(text) });
  }
  if (req.method === 'GET' && url.pathname === '/api/skills') {
    const roots = [config.workdir, ...Object.values(config.repos).map((m) => m.cwd), ...url.searchParams.getAll('dir')];
    return send(res, 200, { skills: listSkills(roots) });
  }

  if (req.method === 'GET' && url.pathname === '/api/sprint') {
    const project = url.searchParams.get('project');
    const iteration = url.searchParams.get('iteration');
    const refresh = url.searchParams.get('refresh') === '1';
    if (!config.projects.includes(project)) return send(res, 404, { error: 'プロジェクトが設定にありません' });
    try {
      if (!iteration) return send(res, 200, { meta: await projectMeta(project, refresh) });
      return send(res, 200, await sprintIssues(project, iteration, refresh));
    } catch (e) {
      return send(res, 502, { error: e.message });
    }
  }

  const body = await readBody(req);
  if (req.method === 'PUT' && url.pathname === '/api/config') {
    config = { ...config, ...body };
    writeJson(CONFIG_FILE, config);
    pump();
    schedulePoll();
    return send(res, 200, { config });
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/mine/')) {
    const mine = state.mine[body.key];
    if (!mine) return send(res, 404, { error: 'not found' });
    if (url.pathname === '/api/mine/run') {
      const skill = config.repos[mine.pr.repo]?.[body.mode === 'self' ? 'selfSkill' : 'fixSkill'];
      if (!['self', 'fix'].includes(body.mode) || !skill) return send(res, 400, { error: `${mine.pr.repo} のスキルが未設定です` });
      if (!['idle', 'planned'].includes(mine.status)) return send(res, 409, { error: '実行中です' });
      enqueueMine(body.key, body.mode);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/mine/apply') {
      if (mine.status !== 'planned' || !mine.findings || !mine.sessionId) return send(res, 409, { error: '対応できる状態ではありません' });
      if (!body.confirmed) return send(res, 400, { error: '「指摘内容を確認しました」にチェックしてください' });
      if (!canDecideAll(mine.findings, body.decisions)) return send(res, 400, { error: '未判断の指摘があります' });
      enqueueApply(body.key, body.decisions);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/mine/apply-comments') {
      if (mine.status !== 'planned' || !mine.sessionId) return send(res, 409, { error: '対応できる状態ではありません' });
      enqueueApply(body.key, null);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/mine/merge-ready') {
      if (mine.status !== 'idle' || (body.ready && mine.pending)) return send(res, 409, { error: '移動できる状態ではありません' });
      updateEntry(body.key, { mergeReady: !!body.ready, done: false });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/mine/done') {
      // 未対応の指摘が残っていると次の取得で指摘ありに戻るので移せない
      if (mine.status !== 'idle' || (body.done && mine.pending)) return send(res, 409, { error: '移動できる状態ではありません' });
      updateEntry(body.key, { done: !!body.done, mergeReady: false });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/mine/cancel') {
      if (!['queued', 'running'].includes(mine.status)) return send(res, 409, { error: 'キャンセルできる状態ではありません' });
      cancelMine(body.key);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
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
    if (!['requested', 'reviewed'].includes(entry.status)) return send(res, 409, { error: 'スキップできる状態ではありません' });
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
  state = { mine: {}, ...readJson(STATE_FILE, { prs: {} }) };
  // claude を起動済みのジョブは別プロセスグループで動き続けているので結果を回収する
  // 未起動のレビュー・計画は副作用がないのでキューに積み直し、投稿・対応は二重実行を避けて戻す
  const requeue = [];
  for (const [key, e] of Object.entries(state.prs)) {
    if ((e.status === 'reviewing' || e.status === 'posting') && e.run) {
      recoverRun(e.run, (res) => (e.status === 'reviewing' ? finishReview(key, e.run.cwd, res) : finishPost(key, res)));
      continue;
    }
    if (e.status === 'queued' || e.status === 'reviewing') {
      if (config.repos[e.pr.repo]?.skill) requeue.push(() => enqueueReview(key));
      else state.prs[key] = { ...e, status: 'requested', error: 'サーバー再起動により中断されました' };
    }
    if (e.status === 'posting') state.prs[key] = { ...e, status: 'reviewed', error: 'サーバー再起動により投稿が中断されました。PR を確認してから再実行してください' };
  }
  for (const [key, e] of Object.entries(state.mine)) {
    if ((e.status === 'running' || e.status === 'applying') && e.run) {
      recoverRun(e.run, (res) => (e.status === 'running' ? finishMine(key, e.run.cwd, res) : finishApply(key, res)), e.pr.repo);
      continue;
    }
    if (e.status === 'queued' || e.status === 'running') {
      if (config.repos[e.pr.repo]?.[e.mode === 'self' ? 'selfSkill' : 'fixSkill']) requeue.push(() => enqueueMine(key, e.mode));
      else state.mine[key] = { ...e, status: 'idle', error: 'サーバー再起動により中断されました' };
    }
    if (e.status === 'applying') state.mine[key] = { ...e, status: 'planned', error: 'サーバー再起動により対応が中断されました。PR を確認してから再実行してください' };
  }
  saveState();
  // 回収中のジョブを running に数えてから積むので maxConcurrent を超えない
  for (const fn of requeue) fn();

  refreshFromGitHub().catch((e) => {
    state.fetchError = e.message;
  });
  schedulePoll();

  http
    .createServer((req, res) => handle(req, res).catch((e) => send(res, 500, { error: e.message })))
    .listen(PORT, '127.0.0.1', () => console.log(`Review Board: http://localhost:${PORT}`));
}

if (require.main === module) main();

module.exports = { pickIterations, parseProjectUrl, detectFields, barRange, sprintTree, readRun, logLines, isAlive, searchQueries, filterByAuthors, usageOf, addUsage, childEnv, modelOptions, mergeBoard, mergeMine, pendingThreads, fillTemplate, buildReviewPrompt, buildPostPrompt, buildFixPlanPrompt, buildFixApplyPrompt, buildSelfApplyPrompt, buildCommentApplyPrompt, extractTagJson, runForTag, splitArgs, canDecideAll, pollIntervalMs, RE_REQUEST_GRACE_MS };
