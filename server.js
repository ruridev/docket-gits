'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 4649);
const DATA_DIR = process.env.DOCKET_DATA || path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const SPRINT_CACHE_FILE = path.join(DATA_DIR, 'sprint-cache.json');

const DEFAULT_CONFIG = {
  workdir: os.homedir(),
  claudeArgs: '--permission-mode acceptEdits --allowedTools Read,Grep,Glob,Write,Edit,Agent,Bash(gh:*),Bash(git:*),Bash(jq:*),Bash(mkdir:*),Bash(cat:*),Bash(ls:*)',
  // 空なら claude の既定。model はサブエージェントにも使わせる
  model: '',
  effort: '',
  pollMinutes: 5,
  // GitHub の自動取得はこの時間帯 (開始時 <= 時 < 終了時) だけ行う。同じ値なら終日
  pollStartHour: 9,
  pollEndHour: 19,
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
  // スキルの代わりに「設定のプロンプト」(PROMPT_SKILL) を選んだリポジトリで使うレビュー指示。空なら既定値に戻す
  reviewPrompt: `PR {pr-url} をレビューしてください。

- \`gh pr view {pr-url}\` で概要を、\`gh pr diff {pr-url}\` で差分を確認する。必要なら周辺のコードも読む。
- 正しさ (バグ・境界値・エラー処理)・セキュリティ・性能・可読性の観点で、修正すべき点を挙げる。好みの問題は避ける。
- 重要度は must (直さないと壊れる) / want (直した方がよい) / imo (意見) / nit (些細) のいずれかにする。
- 各指摘は該当するファイルと diff 上の行番号を添え、なぜ問題か・どう直すかを具体的に書く。`,
  // 指摘への対応で「設定のプロンプト」を選んだリポジトリで使う指示。空なら既定値に戻す
  fixPrompt: `PR {pr-url} に付いたレビュー指摘に対応してください。

- カレントディレクトリが対象リポジトリの clone でなければ、何もせず理由を返す。
- 未コミットの変更があれば、何もせず理由を返す (ユーザーの作業を消さないため)。
- \`gh pr checkout {pr-url}\` で PR ブランチをチェックアウトする。
- 未解決のレビュースレッドとPR コメントを \`gh api\` で取得し、指摘ごとに修正・返信のどちらで対応するかを決める。
- 修正は 1 指摘 1 コミットにし、既存のコミットメッセージの書き方に合わせる。push は force しない。
- 返信には対応したコミット SHA を含める。スレッドへは \`gh api repos/{full-repo-name}/pulls/{pr-number}/comments/<comment_id>/replies\`、PR コメントへは元のコメントを引用して \`gh pr comment {pr-url}\` で返信する。`,
  // ロードマップ画面で見る GitHub Projects の URL (例: https://github.com/orgs/docket/projects/76)
  projects: [],
  // スプリント画面に出す過去・未来のスプリント数 (未来は issue があるものだけ)
  sprintPast: 1,
  sprintFuture: 1,
  // ロードマップの期間別の 1 区切り: week / 2week / month
  roadmapPeriod: 'month',
  // Claude が PR に書く文章・ボードに出す指摘の言語: ja / ko / en
  outputLang: 'ja',
  // 同意しない指摘を理由付きで投稿するとき、レビュアー本人の意見の頭に付けるアイコン
  disagreeIcon: '🤔💭',
  // 終わった実行のログ (.log) を残す日数。これより古いものは毎日自動で消す
  logKeepDays: 30,
  // 同意した「使用前の注意」の版。CONSENT_VERSION 未満なら claude を起動しない
  consentVersion: 0,
};

// 「使用前の注意」の内容を大きく変えたら上げる (全員にもう一度同意を求める)
const CONSENT_VERSION = 1;
const needsConsent = () => (Number(config.consentVersion) || 0) < CONSENT_VERSION;
// claude を起動する API。同意前は受け付けない
const RUN_PATHS = ['/api/review', '/api/post', '/api/mine/run', '/api/mine/apply', '/api/mine/apply-comments'];

// 画面に出すエラーは言語に依存しないコードで返し、ブラウザ側で翻訳する
const E = (code, params) => ({ code, ...(params && { params }) });

// 再レビュー依頼と投稿直後の検索反映遅延を区別するための猶予
const RE_REQUEST_GRACE_MS = 2 * 60 * 1000;
// 依頼が外れた Done は × で消さないと溜まり続け、5 秒ごとの /api/board も重くなるので、30 日で消す
const DONE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const SEARCH_QUERY = `query($open: String!, $merged: String!, $withMerged: Boolean!, $mine: String!) {
  viewer { login avatarUrl }
  open: search(query: $open, type: ISSUE, first: 100) { issueCount nodes { ...pr } }
  merged: search(query: $merged, type: ISSUE, first: 100) @include(if: $withMerged) { issueCount nodes { ...pr } }
  mine: search(query: $mine, type: ISSUE, first: 50) { issueCount nodes { ...pr ... on PullRequest {
    reviewThreads(first: 100) { nodes { isResolved path line
      root: comments(first: 1) { nodes { author { login } body url } }
      comments(last: 1) { nodes { author { login } body url } } } }
    comments(last: 30) { nodes { author { login } body url createdAt } }
    reviews(last: 30) { nodes { author { login } body url submittedAt } }
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
  // 日付はローカル時刻で数える (UTC だと JST の朝 9 時前は 1 日ずれる)
  const from = now - mergedDays * 24 * 60 * 60 * 1000;
  const since = new Date(from - new Date(from).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return { open: `${base} is:open`, merged: `${base} is:merged merged:>=${since}`, withMerged: mergedDays > 0, mine: 'is:pr archived:false author:@me is:open' };
}

// GraphQL の Bot login には "[bot]" が付かないので揃えて比較する
function authorKey(login) {
  // 設定に数値などが混ざっても落ちないよう文字列にする
  return String(login ?? '').trim().toLowerCase().replace(/\[bot\]$/, '');
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
    if (entry.status === 'commented' && now - (entry.commentedAt || 0) > DONE_KEEP_MS) continue;
    next[key] = { ...entry, active: false };
  }
  return next;
}

// 未解決スレッドのうち最後の発言が自分以外 = まだ自分が応答していない指摘
// 返信すると最後の発言が自分になるので、状態を持たずに「新しい指摘」を判定できる
// AI 実行前に人が判断できるよう、最初の指摘と (返信が続いていれば) 最新の発言も持つ
function pendingThreads(node, login) {
  return (node.reviewThreads?.nodes || [])
    .filter((t) => !t.isResolved && t.comments.nodes.at(-1)?.author?.login !== login)
    .map((t, i) => {
      const root = t.root?.nodes[0];
      const last = t.comments.nodes.at(-1);
      return {
        no: i + 1,
        author: root?.author?.login || null,
        url: root?.url || null,
        path: t.path || null,
        line: t.line ?? null,
        comment: root?.body || '',
        lastUrl: last?.url || null,
        ...(last && last.url !== root?.url && { latest: { author: last.author?.login || null, body: last.body || '' } }),
      };
    });
}

// PR 全体へのコメント (Conversation のコメント・レビュー本文) には解決状態が無いので、
// 自分が最後に PR 全体へ発言した後に他の人が書いたものを未対応とみなす
// ponytail: 一部にだけ返信しても以前のものはすべて外れる。コメントごとの対応状態が要るならローカルに持つ
function pendingComments(node, login) {
  const all = [
    ...(node.comments?.nodes || []).map((c) => ({ ...c, at: c.createdAt })),
    ...(node.reviews?.nodes || []).map((r) => ({ ...r, at: r.submittedAt })),
  ].filter((c) => c.at && c.body?.trim());
  const lastMine = all.filter((c) => c.author?.login === login).map((c) => c.at).sort().at(-1) || '';
  return all
    .filter((c) => c.author?.login !== login && c.at > lastMine)
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((c) => ({ kind: 'comment', author: c.author?.login || null, url: c.url, path: null, line: null, comment: c.body, lastUrl: c.url }));
}

// 対象外にした指摘は、その時点の最後の発言とセットで覚える。新しい発言が付けば別のキーになり、また一覧に出る
const skipKey = (t) => `${t.url} ${t.lastUrl}`;

function mineKey(pr) {
  return `mine:${prKey(pr)}`;
}

// 自分の open PR とローカル状態を突き合わせる。クローズされた PR は実行中のものだけ残す
function mergeMine(mine, fetched, login) {
  const next = {};
  for (const node of fetched) {
    const key = mineKey(node);
    // レーンの「指摘あり」はスレッドだけで判定する (PR 全体へのコメントは返信するまで外れず、bot の定期コメントで居座るため)
    const all = [...pendingThreads(node, login), ...pendingComments(node, login)];
    const prev = new Set(mine[key]?.skipped || []);
    // 今も未対応のものだけ覚えておく (新しい発言が付いた・返信したものは忘れる)
    const skipped = all.map(skipKey).filter((k) => prev.has(k));
    const threads = all.filter((t) => !prev.has(skipKey(t))).map((t, i) => ({ ...t, no: i + 1 }));
    const pending = threads.filter((t) => t.kind !== 'comment').length;
    // マージ可能・Done に移した PR でも、新しい指摘が来たら指摘ありに戻す
    next[key] = { status: 'idle', ...mine[key], pr: normalizePr(node), pending, threads, skipped, ...(pending && { mergeReady: false, done: false }) };
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

// スキルの選択肢のうち、ローカルの skill ではなく設定の reviewPrompt を使うことを表す値
const PROMPT_SKILL = '(prompt)';

function buildReviewPrompt(pr, mapping, reviewPrompt = DEFAULT_CONFIG.reviewPrompt) {
  const head = mapping.skill === PROMPT_SKILL
    ? fillTemplate(reviewPrompt?.trim() || DEFAULT_CONFIG.reviewPrompt, pr)
    : `/${mapping.skill} ${fillTemplate(mapping.args, pr)}`;
  return `${head}

---
(ローカルのレビューボードからの非対話実行です)
- 対象PR: ${pr.url}
- ユーザーへの確認・質問はできません。PR への投稿・Approve はまだ行わず、プレビューまでで止めてください。
- レビュー完了後、最終回答の末尾に、投稿予定の指摘を次の形式で必ず出力してください。指摘が 0 件なら findings は空配列にしてください。
- 結果として読み取るのは最後のメッセージだけです。サブエージェントの完了通知などで回答が続いた場合も、最後のメッセージにこのブロックを省略せず再掲してください。

<docket-findings>
{"summary":"全体所感(1〜3文)","findings":[{"no":1,"severity":"must / want / imo / nit など","title":"一行要約","path":"ファイルパス or null","line":行番号 or null,"body":"投稿予定のコメント本文(Markdown)"}]}
</docket-findings>`;
}

// 前回の投稿・対応が途中で失敗した後のやり直しでも、同じものを二重に投稿・返信しないようにする
// スキルを使わない (設定のプロンプト) 場合や、スキルに投稿手順がない場合の投稿方法
const GH_POST = 'スキルに投稿手順がない場合は、`gh api repos/{owner}/{repo}/pulls/{number}/reviews` で 1 つのレビューとして投稿する (body と event、行の指摘は comments に path・line・side: RIGHT)。diff に含まれない行で失敗したら、その指摘はファイル名と行番号を添えてレビュー本文に入れる。';

const NO_DUPLICATE = '始める前に PR の既存のレビュー・コメント・コミットを確認し、前回の実行で既に投稿・返信・push 済みのものは繰り返さず、残りだけを行う。';

function buildPostPrompt(pr, findings, decisions, approve, humanRead, icon = DEFAULT_CONFIG.disagreeIcon) {
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
  - 2 段落目: 「${icon} 」で始め、レビュアー本人がこの点についてどう考えたかを伝える。ユーザーの文章をそのまま貼らず、文脈を補ったうえでチームのレビュー文化に合う口調に整える。
- 非同意 (理由なし): 投稿しない。
- 投稿対象が 0 件で、Approve もコード確認の表明もない場合は何も投稿しない。
- ${GH_POST}
- ${NO_DUPLICATE}
- 完了後、最終回答の末尾に次を必ず出力する。投稿に失敗した場合は posted を false にし、error に理由を入れる。

<docket-posted>
{"posted":true,"url":"投稿したレビューの URL または null","error":null}
</docket-posted>`;
}

// 番号だけだと振り直した場合に取り違えるので、指摘の要約も添える
function decisionLines(items, decisions) {
  return items.map((f) => {
    const d = decisions[f.no] || {};
    const verdict = d.verdict === 'agree' ? '同意' : '非同意';
    const reason = d.reason?.trim() ? `理由: ${d.reason.trim()}` : '理由なし';
    const title = f.title || f.comment;
    return `- #${f.no}${title ? `「${title}」` : ''} ${verdict} / ${reason}`;
  }).join('\n');
}

const APPLIED_TAG = `完了後、最終回答の末尾に次を必ず出力する。push や返信に失敗した場合は done を false にし、error に理由を入れる。

<docket-applied>
{"done":true,"error":null}
</docket-applied>`;

// AI の方針に引きずられないよう、人が先に各指摘の妥当性を判断する (triage)。
// 同意 / 非同意 (理由必須) が AI の対象。skip (対象外: 指摘ではないコメントなど) は触れない
function triageFrom(threads, decisions) {
  const triage = (threads || []).map((t) => ({ ...t, verdict: decisions?.[t.url]?.verdict, reason: decisions?.[t.url]?.reason?.trim() || '' }));
  return triage.every((t) => ['agree', 'disagree', 'skip'].includes(t.verdict)) ? triage : null;
}

const triageTargets = (triage) => triage.filter((t) => t.verdict !== 'skip');

// review-fix は手順 1〜3 (取得・チェックアウト・分類) で止め、対応計画だけを返させる
function buildFixPlanPrompt(pr, mapping, triage, fixPrompt = DEFAULT_CONFIG.fixPrompt) {
  const lines = triageTargets(triage).map((t) => {
    const loc = t.path ? ` ${t.path}${t.line ? `:${t.line}` : ''}` : '';
    const summary = t.comment.replace(/\s+/g, ' ').slice(0, 80);
    return `- #${t.no}${t.kind === 'comment' ? ' [PR コメント]' : ''} @${t.author}${loc} ${t.url}\n  指摘: ${summary}\n  ${t.verdict === 'agree' ? '同意' : '非同意'} / ${t.reason ? `理由: ${t.reason}` : '理由なし'}`;
  });
  const head = mapping.fixSkill === PROMPT_SKILL
    ? fillTemplate(fixPrompt?.trim() || DEFAULT_CONFIG.fixPrompt, pr)
    : `/${mapping.fixSkill} ${fillTemplate(mapping.fixArgs, pr)}`;
  return `${head}

---
(ローカルのレビューボードからの非対話実行です)
- 対象PR: ${pr.url}
- ユーザーへの確認・質問はできません。この実行では指摘の取得・ブランチのチェックアウト・分類までを行い、コードの修正・コミット・push・返信はまだ行わないでください。

## ユーザーの事前判断
ユーザーは AI の方針を見る前に、未対応の指摘ごとに妥当性を判断しました。対象は次の指摘だけです。番号は items の no にそのまま使ってください。
${lines.join('\n')}

- 一覧にないスレッド・コメントは計画に含めない。
- [PR コメント] はスレッドではなく PR 全体へのコメント (またはレビュー本文) です。返信は元のコメントを引用 (またはリンク) した PR コメントとして行う。
- 同意: 指摘に対応する計画を立てる (category は fix / reply / defer / split / followup)。理由が書かれていれば反映する。
- 非同意: ユーザーの理由を検討する。理由が妥当なら category を reply にし、理由に沿った返信案を reply に書く。ユーザーの判断が誤りと考えるなら category を rebut にし、rebuttal に根拠を添えた反論、plan に指摘どおり直す場合の修正内容、reply にその場合の返信案を書く。迎合せず、率直に判断する。
- 最終回答の末尾に、指摘ごとの対応計画を次の形式で必ず出力してください。
- レビュアーが別 PR への分割を求めた、または了承した指摘は category を split にし、plan に「この PR から取り除く変更 (なければ なし)」「新しい PR の内容」「新しいブランチの base (この PR の base か、この PR のブランチか)」を書いてください。
- この PR では対応せず後続で対応することにレビュアーが同意した、または求めた指摘 (この PR の変更は不要) は category を followup にし、plan に後続 issue のタイトルと内容を書いてください。
- 結果として読み取るのは最後のメッセージだけです。サブエージェントの完了通知などで回答が続いた場合も、最後のメッセージにこのブロックを省略せず再掲してください。

<docket-fix-plan>
{"summary":"全体の対応方針(1〜3文)","items":[{"no":1,"category":"fix / reply / defer / split / followup / rebut","author":"指摘者の login","url":"元コメントの URL","path":"ファイルパス or null","line":行番号 or null,"comment":"指摘内容の要約","plan":"修正内容 (fix / split / followup / rebut のみ。それ以外は null)","rebuttal":"ユーザーの判断への反論 (rebut のみ。それ以外は null)","reply":"返信文ドラフト(Markdown)"}]}
</docket-fix-plan>`;
}

function buildFixApplyPrompt(pr, items, decisions) {
  return `レビューボードでユーザーが各指摘への対応計画を判断しました。以下に従って、PR ${pr.url} についてスキル (または最初の指示) の修正・コミット・push・返信の手順を実行してください。これがユーザーの確認ゲートの承認であり、追加の確認は不要です。

## 判断
${decisionLines(items, decisions)}

## ルール
- 同意: 計画どおり修正・返信する。理由が書かれていれば、その内容を反映する。
- 非同意 (理由あり): 計画どおりには対応しない。理由に沿って対応を決め直す (修正方針の変更、または返信のみ)。返信はユーザーの文章をそのまま貼らず、文脈を補ったうえでチームのレビュー文化に合う口調に整える。
- 非同意 (理由なし): 修正も返信もしない。
- split に同意した指摘は次の順に行う。
  1. この PR に取り除く変更があれば取り除き、コミットして push する。
  2. 計画の base から新しいブランチを切り、新しい PR の内容を実装してコミットし push する。
  3. 対象リポジトリの AGENTS.md の規約に従い、Draft PR を作成する。issue の作成・既存 issue との紐付けも規約に従う。
  4. 元のスレッドに、新しい PR の URL (と 1 のコミット SHA) を含めて返信する。
- followup に同意した指摘は、コードを変更せず次を行う。
  1. 対象リポジトリの AGENTS.md の規約に従い、後続 issue を作成する (本文に元の指摘とこの PR の URL を含める)。
  2. この PR が Closes する issue の sub-issue として紐付ける。
  3. 元のスレッドに、作成した issue の URL を含めて返信する。
- [PR コメント] の指摘への返信は、元のコメントを引用 (またはリンク) した PR コメントとして行う。
- rebut (AI の反論) は上の同意 / 非同意より優先して次のとおりにする。
  - 同意 (反論を受け入れた): plan どおり修正し、返信する。
  - 非同意: 修正しない。事前判断の理由 (今回の理由があればそれも) に沿って返信する。
- 計画にない指摘には触れない。resolve はしない。force-push はしない。
- ${NO_DUPLICATE}
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
- ${GH_POST}
- ${NO_DUPLICATE}
- ${APPLIED_TAG}`;
}

// 判断ダイアログを使わず、ユーザーが PR に直接書いたコメントを指示として対応させる
function buildCommentApplyPrompt(pr) {
  return `ユーザーは対応計画への判断をレビューボードではなく、PR ${pr.url} 上のコメントで行いました。PR のレビュースレッドとコメントを取得し、PR 作成者 (ユーザー) が最後に書いたコメントを指示として、スキル (または最初の指示) の修正・コミット・push・返信の手順を実行してください。これがユーザーの確認ゲートの承認であり、追加の確認は不要です。

## ルール
- ユーザーのコメントで指示された内容だけ対応する。指示が無いスレッドには触れない。
- 返信はユーザーのコメントと重複させず、対応したコミット SHA を含める。
- resolve はしない。force-push はしない。
- ${NO_DUPLICATE}
- ${APPLIED_TAG}`;
}

// どの実行にも付ける出力言語の指示。指示文は日本語のまま、書かせる文章の言語だけ切り替える
const OUTPUT_LANGS = { ja: '日本語', ko: '韓国語', en: '英語' };
function withOutputLang(prompt, lang) {
  const name = OUTPUT_LANGS[lang] || OUTPUT_LANGS.ja;
  return `${prompt}

## 出力言語
- PR・issue に書く文章 (レビューコメント・返信・issue / PR の本文) と、<docket-*> ブロック内の文章 (summary・title・body・comment・plan・rebuttal・reply・error) はすべて${name}で書く。上の指示にある定型文 (「人間のレビュアーもコードを読みました ✅」「修正しました」など) も${name}にして使う。
- category など値が決められている項目は指示どおりの値のままにする。`;
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
// 入れ子起動として拒否されるため取り除く (CLAUDE_CONFIG_DIR と Bedrock / Vertex などの接続先指定はユーザー設定なので残す)
function childEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('CLAUDE') || k === 'CLAUDE_CONFIG_DIR' || k.startsWith('CLAUDE_CODE_USE_')));
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

// 判断は no をキーに保存するので、Claude が番号を重複・欠落させたら 1 から振り直す
// null などオブジェクトでない要素は判断の保存・表示で落ちるので捨てる
function normalizeNos(items) {
  if (!Array.isArray(items)) return null;
  const isObj = (f) => f && typeof f === 'object';
  const list = items.every(isObj) ? items : items.filter(isObj);
  const nos = list.map((f) => f.no);
  if (nos.every((n) => n != null && n !== '') && new Set(nos.map(String)).size === nos.length) return list;
  return list.map((f, i) => ({ ...f, no: i + 1 }));
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

// 期間別の区切り。週は月曜始まり、2 週は 2024-01-01 (月曜) から 2 週ずつ、月はカレンダーどおり
const PERIOD_UNITS = { week: 7, '2week': 14, month: 0 };
function periodAt(date, unit) {
  const [y, m] = date.split('-').map(Number);
  if (!PERIOD_UNITS[unit]) {
    const startDate = `${date.slice(0, 7)}-01`;
    return { id: startDate, startDate, endDate: addDays(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10), -1) };
  }
  const days = Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse('2024-01-01T00:00:00Z')) / 86400000);
  const startDate = addDays('2024-01-01', days - (((days % PERIOD_UNITS[unit]) + PERIOD_UNITS[unit]) % PERIOD_UNITS[unit]));
  return { id: startDate, startDate, endDate: addDays(startDate, PERIOD_UNITS[unit] - 1) };
}

// 今日を含む区切りと、過去 past 個・未来 future 個を新しい順に並べる
function periodWindows(today, unit, { past, future }) {
  const list = [periodAt(today, unit)];
  for (let i = 0; i < past; i++) list.push(periodAt(addDays(list.at(-1).startDate, -1), unit));
  for (let i = 0; i < future; i++) list.unshift(periodAt(addDays(list[0].endDate, 1), unit));
  return list;
}

// 期間と重なる issue の検索条件。日付が片方しかない issue はその日付が期間内なら含める
function periodQueries(start, end, { startDate, endDate }) {
  const f = JSON.stringify;
  if (!start || !end) return [`${f(start || end)}:${startDate}..${endDate}`];
  return [
    `${f(start)}:<=${endDate} ${f(end)}:>=${startDate}`,
    `no:${f(start)} ${f(end)}:${startDate}..${endDate}`,
    `no:${f(end)} ${f(start)}:${startDate}..${endDate}`,
  ];
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
      // GraphQL の一部だけエラーでも失敗で終わるので、取れたデータを使えるよう stdout も渡す
      if (err) reject(Object.assign(new Error(stderr || err.message), { stdout }));
      else resolve(stdout);
    });
  });
}

// 定期取得と「更新」ボタンが重なっても GitHub を二重に叩かず、取得中のものを共有する
// (別々に走ると後から終わった古い結果で state.prs を上書きし得る)
let refreshing = null;
function refreshFromGitHub() {
  return (refreshing ||= fetchFromGitHub().finally(() => (refreshing = null)));
}

async function fetchFromGitHub() {
  const q = searchQueries(config.mergedDays, Date.now());
  // SAML で保護された org の PR など一部のノードだけ読めないと gh は失敗で終わる。取れた分は反映し、エラーも画面に出す
  let partialError = null;
  const out = await gh(['api', 'graphql', '-f', `query=${SEARCH_QUERY}`, '-f', `open=${q.open}`, '-f', `merged=${q.merged}`, '-F', `withMerged=${q.withMerged}`, '-f', `mine=${q.mine}`]).catch((e) => {
    try {
      if (JSON.parse(e.stdout).data?.viewer) return (partialError = e.message), e.stdout;
    } catch {}
    throw e;
  });
  const { data } = JSON.parse(out);
  state.viewer = data.viewer;
  const nodes = [...data.open.nodes, ...(data.merged?.nodes || [])].filter((n) => n?.number);
  state.prs = mergeBoard(state.prs, filterByAuthors(nodes, config.authors), Date.now());
  // 個人リポジトリなどを混ぜないよう、設定に登録したリポジトリの PR だけ扱う (未登録なら全件)
  const registered = (n) => Object.keys(config.repos).length === 0 || config.repos[n.repository.nameWithOwner];
  state.mine = mergeMine(state.mine, data.mine.nodes.filter((n) => n?.number && registered(n)), data.viewer.login);
  // ponytail: ページングせず 1 ページだけ取る。上限を超えたら画面で知らせる (超えるようなら after でページングする)
  state.truncated = ['open', 'merged', 'mine'].some((k) => data[k] && data[k].issueCount > data[k].nodes.length);
  state.lastFetchedAt = Date.now();
  state.fetchError = partialError;
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
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number url state isDraft } }
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
    subCount: n.subIssues.totalCount,
    // 閉じただけの PR は出さない (マージ済み・オープン・Draft だけ)
    prs: n.closedByPullRequestsReferences.nodes.filter((pr) => pr.state !== 'CLOSED'),
    sprintId: item?.sprint?.iterationId || null,
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
  if (!p) throw E('projectUrlInvalid', { url });
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
// queries のどれかに当たる issue と、その sub issue を SUB_DEPTH 階層まで集めて sprintTree にする
async function issueTree(url, meta, queries, range) {
  const p = parseProjectUrl(url);
  const names = { sprint: meta.sprint || '-', start: meta.start || '-', end: meta.end || '-' };
  // gh は 1 回ごとにプロセスを起動して遅いので、条件ごとに並行して取る (ページは条件ごとに順に辿る)
  const pages = await Promise.all(queries.map(async (q) => {
    const nodes = [];
    let after = null;
    do {
      const data = await ghql(`query($login: String!, $number: Int!, $q: String!, $after: String, $sprint: String!, $start: String!, $end: String!) { ${projectRoot(p)} {
        items(first: 50, after: $after, query: $q) { pageInfo { hasNextPage endCursor } nodes { content { ...iss } } }
      } } }
      ${ISSUE_FIELDS}`, { login: p.login, number: p.number, q, ...(after && { after }), ...names });
      const page = data[p.owner].projectV2.items;
      nodes.push(...page.nodes);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return nodes;
  }));
  // 並び順が実行ごとに変わらないよう、条件の順にまとめる
  const issues = new Map();
  const ids = [];
  for (const n of pages.flat()) {
    if (!n.content?.id || issues.has(n.content.id)) continue; // Draft issue・PR は対象外
    issues.set(n.content.id, normIssue(n.content, meta.id));
    ids.push(n.content.id);
  }
  return expandTree(ids, issues, names, meta.id, range);
}

// ids の issue に sub issue を SUB_DEPTH 階層まで足して sprintTree にする
async function expandTree(ids, issues, names, projectId, range) {
  // sub issue を 1 階層ずつまとめて取る
  let frontier = [...issues.values()].filter((i) => i.subCount > 0).map((i) => i.id);
  for (let depth = 0; depth < SUB_DEPTH && frontier.length; depth++) {
    const next = [];
    const chunks = [];
    for (let i = 0; i < frontier.length; i += 30) chunks.push(frontier.slice(i, i + 30));
    // ponytail: 同じ階層の chunk は並行数の上限なしで投げる。sub issue が数千件になり GitHub の secondary rate limit に当たるなら上限を付ける
    const results = await Promise.all(chunks.map((chunk) => ghql(`query($sprint: String!, $start: String!, $end: String!) {
        nodes(ids: ${JSON.stringify(chunk)}) { ... on Issue { id subIssues(first: 100) { nodes { ...iss } } } }
      }
      ${ISSUE_FIELDS}`, names)));
    for (const data of results) {
      for (const parent of data.nodes) {
        if (!parent) continue;
        issues.get(parent.id).childIds = parent.subIssues.nodes.map((c) => c.id);
        for (const c of parent.subIssues.nodes) {
          if (issues.has(c.id)) continue;
          const child = normIssue(c, projectId);
          issues.set(c.id, child);
          if (child.subCount > 0) next.push(c.id);
        }
      }
    }
    frontier = next;
  }
  return sprintTree(ids, issues, range);
}

// meta は画面の「今すぐ更新」が先に取り直しているので、ここではキャッシュを使う (refresh は issue だけ)
async function sprintIssues(url, iterationId, refresh) {
  const meta = await projectMeta(url, false);
  const sprint = meta.iterations.find((i) => i.id === iterationId);
  if (!sprint) throw E('sprintNotFound');
  return cached(`sprint:${url}:${iterationId}`, refresh, async () => (
    { sprint, roots: await issueTree(url, meta, [filterQuery(meta.sprint, sprint.title)], sprint), fetchedAt: Date.now() }
  ));
}

const periodRange = () => ({ unit: PERIOD_UNITS[config.roadmapPeriod] !== undefined ? config.roadmapPeriod : 'month', past: Math.max(0, Number(config.sprintPast) || 0), future: Math.max(0, Number(config.sprintFuture) || 0) });

async function periodIssues(url, from, refresh) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '')) throw E('periodInvalid');
  const meta = await projectMeta(url, false);
  if (!meta.start && !meta.end) throw E('noDateField');
  const { unit } = periodRange();
  const period = periodAt(from, unit);
  return cached(`period:${url}:${unit}:${period.id}`, refresh, async () => (
    { sprint: period, roots: await issueTree(url, meta, periodQueries(meta.start, meta.end, period), period), fetchedAt: Date.now() }
  ));
}

// 設定として知っている項目だけを、既定値と同じ型のときに受け付ける (型違いで後の処理が落ちないように)
function sanitizeConfig(body) {
  const kind = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
  // 同意は /api/consent でだけ記録する
  return Object.fromEntries(Object.entries(body || {}).filter(([k, v]) => k in DEFAULT_CONFIG && k !== 'consentVersion' && kind(v) === kind(DEFAULT_CONFIG[k]) && !(typeof v === 'number' && !Number.isFinite(v))));
}

// 0 や空文字で GitHub を叩き続けないよう 1 分未満は既定値に戻す
// setInterval は 2^31 ms (約 24.8 日) を超えると 1 ms になるので、1 日で頭打ちにする
function pollIntervalMs(minutes) {
  const m = Number(minutes);
  return Math.min(m >= 1 ? m : DEFAULT_CONFIG.pollMinutes, 24 * 60) * 60 * 1000;
}

// 設定欄を空にすると 0 になり、キューが二度と動かなくなるので既定値に戻す
function concurrencyLimit(n) {
  return Math.max(1, Math.floor(Number(n)) || DEFAULT_CONFIG.maxConcurrent);
}

// 開始 > 終了なら日をまたぐ時間帯 (例: 22〜6) として扱う
function inPollHours(date, start, end) {
  const h = date.getHours(), s = Number(start), e = Number(end);
  if (s === e) return true;
  return s < e ? h >= s && h < e : h >= s || h < e;
}

let pollTimer = null;
function schedulePoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!inPollHours(new Date(), config.pollStartHour, config.pollEndHour)) return;
    refreshFromGitHub().catch((e) => { state.fetchError = e.message; });
  }, pollIntervalMs(config.pollMinutes));
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

// ログ画面は直近の行しか出さないので、3 秒ごとにファイル全体を読まないよう末尾だけ読む (途中で切れた先頭行は捨てる)
function readTail(file, bytes = 1024 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

// stdout/stderr をファイルに書き出した claude の結果を読む。合わせて .log にまとめ、元ファイルは消す
function readRun(dir, logName, code) {
  const base = path.join(dir, logName);
  let stdout;
  let stderr;
  try {
    stdout = fs.readFileSync(`${base}.out`, 'utf8');
    stderr = fs.readFileSync(`${base}.err`, 'utf8');
    // close ハンドラ内で呼ばれるので、ここで投げるとサーバーごと落ちる
    fs.writeFileSync(`${base}.log`, `exit=${code}\n--- stdout\n${stdout}\n--- stderr\n${stderr}`);
    fs.rmSync(`${base}.out`, { force: true });
    fs.rmSync(`${base}.err`, { force: true });
  } catch (e) {
    return { ok: false, error: E('claudeReadFailed', { message: e.message }) };
  }
  // stream-json は 1 行 1 イベントで、最後の result イベントに結果がまとまる
  const parsed = parseLines(stdout).findLast((ev) => ev.type === 'result');
  if (!parsed) return { ok: false, error: E('claudeParseFailed', { code, stderr: stderr.slice(-500) }) };
  return { ok: code === 0 && !parsed.is_error, result: parsed.result || '', sessionId: parsed.session_id, usage: usageOf(parsed), error: parsed.is_error ? parsed.result : null };
}

// 終わった実行の .log だけを数える・消す (実行中の .out / .err は触らない)
function logFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  // リンク切れ・途中で消えたファイルは飛ばす (日次の削除で投げるとサーバーごと落ちる)
  return names.filter((n) => n.endsWith('.log')).flatMap((n) => {
    const file = path.join(dir, n);
    try {
      const { size, mtimeMs } = fs.statSync(file);
      return [{ file, size, mtimeMs }];
    } catch {
      return [];
    }
  });
}

const sumLogs = (list) => ({ count: list.length, bytes: list.reduce((n, f) => n + f.size, 0) });
const logStats = (dir) => sumLogs(logFiles(dir));

// 溜まり続けるので keepMs より古いものを消す。0 なら終わった .log をすべて消す (設定画面の「すべて削除」)
function pruneLogs(dir, now, keepMs) {
  // 0 は時刻を比べない (書いた直後の mtime が now より少し後になることがある)
  const old = logFiles(dir).filter((f) => keepMs === 0 || now - f.mtimeMs >= keepMs);
  for (const f of old) fs.rmSync(f.file, { force: true });
  return sumLogs(old);
}

// 設定の保存日数。空や 0 で自動削除が全部消してしまわないよう、1 日未満は既定に戻す
const logKeepMs = (days) => (Number(days) >= 1 ? Number(days) : DEFAULT_CONFIG.logKeepDays) * 24 * 60 * 60 * 1000;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// サーバー・マシンの再起動後は保存した PID が別のプロセスに再利用されていることがある。
// 無関係なプロセスの終了を待ったり止めたりしないよう、まだ claude であることも確かめる
// ユーザーが別に開いている claude を止めないよう、runClaude が付ける stream-json 出力の指定も見る (-ww: 長いプロンプトで切らせない)
function isClaudeRun(pid) {
  if (!isAlive(pid)) return false;
  try {
    const command = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    return /claude/.test(command) && /--output-format stream-json/.test(command);
  } catch {
    return false;
  }
}

// detached で起動した claude はプロセスグループのリーダーなので、グループごと止めて Bash ツールの子プロセスも残さない
// 確認した直後に終わっていると ESRCH で投げ、キャンセルが状態を戻せなくなるので無視する
function killRun(pid) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
}

function waitForExit(pid) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (isClaudeRun(pid)) return;
      clearInterval(timer);
      resolve();
    }, 5000);
  });
}

// サーバーを再起動しても claude を止めず結果を回収できるよう、別プロセスグループで起動し出力をファイルに書かせる
function runClaude(prompt, { key, cwd, resume, logName }) {
  return new Promise((resolve) => {
    // ログファイルを開けないなどで投げると呼び出し側のカードが実行中のまま止まるので、失敗として返す
    // 起動後に投げた場合 (状態の保存失敗など) は claude が動いているので、close で結果を返す
    let child;
    try {
      const model = modelOptions(config);
      const args = ['-p', withOutputLang(prompt, config.outputLang), '--output-format', 'stream-json', '--verbose', ...model.args, ...splitArgs(config.claudeArgs)];
      if (resume) args.push('--resume', resume);
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const base = path.join(LOG_DIR, logName);
      const out = fs.openSync(`${base}.out`, 'w');
      const err = fs.openSync(`${base}.err`, 'w');
      child = spawn('claude', args, { cwd, env: { ...childEnv(process.env), ...model.env }, detached: true, stdio: ['ignore', out, err] });
      fs.closeSync(out);
      fs.closeSync(err);
      child.on('error', (e) => resolve({ ok: false, error: e.message }));
      child.on('close', (code) => resolve(readRun(LOG_DIR, logName, code)));
      // lastLog: 実行が終わった後も画面からログを見られるよう残す (タグの再出力はおまけなので本体のログを残す)
      if (child.pid) updateEntry(key, { run: { pid: child.pid, logName, cwd }, ...(!logName.endsWith('-retag') && { lastLog: logName }) });
    } catch (e) {
      if (!child) resolve({ ok: false, error: e.message });
    }
  });
}

// claude -p の result は最後のメッセージだけなので、サブエージェントの完了通知などで回答が続くと
// 先に出力したタグが落ちる。その場合は同じセッションを 1 回だけ再開してタグを再出力させる
// opts.cancelled: 最初の実行中にキャンセルされたら再開しない
async function runForTag(tag, prompt, opts, run = runClaude) {
  const res = await run(prompt, opts);
  if (!res.ok || !res.sessionId || extractTagJson(res.result, tag) || opts.cancelled?.()) return res;
  const retry = await run(`直前までに出力した <${tag}> ブロックを、内容を変えずにもう一度そのまま出力してください。まだ出力していなければ、指示どおりの形式で出力してください。`, {
    ...opts,
    resume: res.sessionId,
    logName: `${opts.logName}-retag`,
  });
  const usage = addUsage(res.usage, retry.usage);
  if (!retry.ok) return { ...res, usage };
  return { ...res, usage, sessionId: retry.sessionId || res.sessionId, result: `${res.result}\n\n${retry.result}` };
}

const newRunId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function logName(key, kind) {
  return `${key.replace(/[^\w.-]+/g, '_')}-${kind}-${Date.now()}`;
}

function pump() {
  for (let i = 0; i < queue.length && running < concurrencyLimit(config.maxConcurrent); ) {
    const job = queue[i];
    if (job.repo && busyRepos.has(job.repo)) {
      i++;
      continue;
    }
    queue.splice(i, 1);
    running++;
    if (job.repo) busyRepos.add(job.repo);
    // 結果の保存に失敗するなどで投げても、未処理の rejection でサーバーごと落とさない
    job.run().catch((e) => console.error(e)).finally(() => {
      running--;
      busyRepos.delete(job.repo);
      pump();
    });
  }
}

// キャンセル後にやり直した場合、前の実行の結果で新しい実行の状態を上書きしないよう runId で見分ける
function finishReview(key, cwd, res, runId) {
  const stale = runId && state.prs[key]?.runId !== runId;
  // キャンセル・失敗時も消費したトークンは計上する
  updateEntry(key, { ...(!stale && { run: null }), usage: addUsage(state.prs[key]?.usage, res.usage) });
  // キャンセル済みなら結果を捨てる
  if (stale || state.prs[key]?.status !== 'reviewing') return;
  if (!res.ok) return updateEntry(key, { status: 'requested', error: res.error || E('reviewFailed') });
  const parsed = extractTagJson(res.result, 'docket-findings');
  const findings = normalizeNos(parsed?.findings);
  updateEntry(key, {
    status: 'reviewed',
    sessionId: res.sessionId,
    cwd,
    raw: res.result,
    summary: parsed?.summary || null,
    findings,
    // findings が配列でなければ投稿できないので、解析失敗として出力を見せる
    error: findings ? null : E('findingsParseFailed'),
    reviewedAt: Date.now(),
  });
}

function finishPost(key, res) {
  updateEntry(key, { run: null, usage: addUsage(state.prs[key]?.usage, res.usage) });
  const posted = res.ok ? extractTagJson(res.result, 'docket-posted') : null;
  if (!posted?.posted) {
    return updateEntry(key, { status: 'reviewed', error: posted?.error || res.error || E('postUnknown'), postRaw: res.result });
  }
  updateEntry(key, { status: 'commented', commentedAt: Date.now(), postedUrl: posted.url || null, postRaw: res.result });
}

function enqueueReview(key) {
  const entry = state.prs[key];
  const mapping = config.repos[entry.pr.repo];
  const cwd = mapping.cwd || config.workdir;
  const runId = newRunId();
  updateEntry(key, { status: 'queued', runId, error: null, findings: null, summary: null, raw: null, decisions: {} });
  queue.push({ key, run: async () => {
    updateEntry(key, { status: 'reviewing', startedAt: Date.now() });
    finishReview(key, cwd, await runForTag('docket-findings', buildReviewPrompt(entry.pr, mapping, config.reviewPrompt), { key, cwd, logName: logName(key, 'review'), cancelled: () => state.prs[key]?.runId !== runId || state.prs[key]?.status !== 'reviewing' }), runId);
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
    .catch((e) => console.error(e))
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
  if (pid && isClaudeRun(pid)) killRun(pid);
  updateEntry(key, { status: 'requested', error: null });
}

function enqueuePost(key, decisions, approve, humanRead) {
  const entry = state.prs[key];
  updateEntry(key, { status: 'posting', error: null, decisions, approve, humanRead });
  queue.push({ key, run: async () => {
    const res = await runClaude(buildPostPrompt(entry.pr, entry.findings, decisions, approve, humanRead, config.disagreeIcon.trim() || DEFAULT_CONFIG.disagreeIcon), {
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

function finishMine(key, cwd, res, runId) {
  const stale = runId && state.mine[key]?.runId !== runId;
  updateEntry(key, { ...(!stale && { run: null }), usage: addUsage(state.mine[key]?.usage, res.usage) });
  const entry = state.mine[key];
  // キャンセル済みなら結果を捨てる
  if (stale || entry?.status !== 'running') return;
  if (!res.ok) return updateEntry(key, { status: 'idle', error: res.error || E('runFailed') });
  const parsed = extractTagJson(res.result, entry.mode === 'self' ? 'docket-findings' : 'docket-fix-plan');
  // rebut の判断材料として、事前判断で書いた理由を添える
  // items が配列でないと map で投げ、カードが実行中のまま止まる
  const items = entry.mode === 'self' ? parsed?.findings : Array.isArray(parsed?.items) ? parsed.items.filter((i) => i && typeof i === 'object').map((i) => ({ ...i, ownReason: entry.triage?.find((t) => String(t.no) === String(i.no))?.reason || null })) : null;
  updateEntry(key, {
    status: 'planned',
    sessionId: res.sessionId,
    cwd,
    raw: res.result,
    summary: parsed?.summary || null,
    findings: normalizeNos(items),
    error: normalizeNos(items) ? null : E('resultParseFailed'),
  });
}

function finishApply(key, res) {
  updateEntry(key, { run: null, usage: addUsage(state.mine[key]?.usage, res.usage) });
  const applied = res.ok ? extractTagJson(res.result, 'docket-applied') : null;
  if (!applied?.done) {
    return updateEntry(key, { status: 'planned', error: applied?.error || res.error || E('applyUnknown'), applyRaw: res.result });
  }
  updateEntry(key, { status: 'idle', error: null, findings: null, summary: null, raw: null, sessionId: null, appliedAt: Date.now(), applyRaw: res.result });
}

// 対象外にした指摘を覚え、次の取得を待たずに一覧と件数から外す
function skipThreads(key, triage) {
  const keys = triage.filter((t) => t.verdict === 'skip').map(skipKey);
  if (keys.length === 0) return;
  const entry = state.mine[key];
  const threads = (entry.threads || []).filter((t) => !keys.includes(skipKey(t)));
  updateEntry(key, { skipped: [...(entry.skipped || []), ...keys], threads, pending: threads.filter((t) => t.kind !== 'comment').length });
}

// mode: 'self' (セルフレビュー) / 'fix' (指摘への対応計画。triage: 人の事前判断)
function enqueueMine(key, mode, triage = null) {
  const entry = state.mine[key];
  const mapping = config.repos[entry.pr.repo];
  const cwd = mapping.cwd || config.workdir;
  const prompt = mode === 'self' ? buildReviewPrompt(entry.pr, { skill: mapping.selfSkill, args: mapping.selfArgs }, config.reviewPrompt) : buildFixPlanPrompt(entry.pr, mapping, triage, config.fixPrompt);
  const runId = newRunId();
  updateEntry(key, { status: 'queued', mode, runId, triage, error: null, findings: null, summary: null, raw: null, decisions: {} });
  queue.push({ key, repo: entry.pr.repo, run: async () => {
    updateEntry(key, { status: 'running', startedAt: Date.now() });
    finishMine(key, cwd, await runForTag(mode === 'self' ? 'docket-findings' : 'docket-fix-plan', prompt, { key, cwd, logName: logName(key, mode), cancelled: () => state.mine[key]?.runId !== runId || state.mine[key]?.status !== 'running' }), runId);
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
  if (pid && isClaudeRun(pid)) killRun(pid);
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

// /api/board は 5 秒ごとに取られるので、Claude の出力は判断ダイアログを開ける状態のときだけ送る
// postRaw・decisions・triage は画面で使わない (判断の下書きはブラウザ側に持つ)
function boardEntry(key, { postRaw, decisions, triage, raw, applyRaw, findings, summary, ...e }) {
  return { key, ...e, ...(['reviewed', 'planned'].includes(e.status) && { raw, applyRaw, findings, summary }) };
}

function boardPayload() {
  return {
    viewer: state.viewer,
    lastFetchedAt: state.lastFetchedAt,
    fetchError: state.fetchError,
    truncated: state.truncated,
    consentVersion: CONSENT_VERSION,
    prs: Object.entries(state.prs).map(([key, e]) => boardEntry(key, e)),
    mine: Object.entries(state.mine).map(([key, e]) => boardEntry(key, e)),
    config,
    // 設定画面の「すべて既定に戻す」用
    defaults: DEFAULT_CONFIG,
  };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  // DNS rebinding 対策
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, { error: 'forbidden host' });

  if (req.method === 'GET' && url.pathname === '/') {
    // 読めなかったときに 500 を返せるよう、ヘッダーより先に読む
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });

  // 他サイトからの CSRF 対策 (独自ヘッダーはプリフライトが必要になり、CORS を許可していないので弾かれる)
  if (req.headers['x-docket'] !== '1') return send(res, 403, { error: 'missing header' });

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
    const entry = state.prs[key] || state.mine[key];
    const run = entry?.run;
    // 実行中は書き込み途中の .out、終わった後は readRun がまとめた .log を読む
    const file = run ? `${run.logName}.out` : entry?.lastLog ? `${entry.lastLog}.log` : null;
    let text = '';
    try {
      if (file) text = readTail(path.join(LOG_DIR, file));
    } catch {}
    return send(res, 200, { running: !!run, lines: logLines(text) });
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') return send(res, 200, logStats(LOG_DIR));
  if (req.method === 'GET' && url.pathname === '/api/skills') {
    const roots = [config.workdir, ...Object.values(config.repos).map((m) => m.cwd), ...url.searchParams.getAll('dir')];
    return send(res, 200, { skills: listSkills(roots) });
  }

  if (req.method === 'GET' && url.pathname === '/api/sprint') {
    const project = url.searchParams.get('project');
    const iteration = url.searchParams.get('iteration');
    const refresh = url.searchParams.get('refresh') === '1';
    try {
      if (!config.projects.includes(project)) return send(res, 404, { error: E('projectNotConfigured') });
      if (url.searchParams.get('mode') === 'period') {
        const id = url.searchParams.get('id');
        if (id) return send(res, 200, await periodIssues(project, id, refresh));
        const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        const { unit, ...range } = periodRange();
        return send(res, 200, { meta: await projectMeta(project, false), periods: periodWindows(today, unit, range) });
      }
      if (!iteration) return send(res, 200, { meta: await projectMeta(project, refresh) });
      return send(res, 200, await sprintIssues(project, iteration, refresh));
    } catch (e) {
      return send(res, 502, { error: e instanceof Error ? e.message : e });
    }
  }

  const body = await readBody(req);
  if (req.method === 'POST' && url.pathname === '/api/consent') {
    config = { ...config, consentVersion: CONSENT_VERSION };
    writeJson(CONFIG_FILE, config);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && RUN_PATHS.includes(url.pathname) && needsConsent()) return send(res, 403, { error: E('consentRequired') });
  // all: 終わったログをすべて消す。それ以外は days (画面で入力中の保存日数) より古いものだけ
  if (req.method === 'POST' && url.pathname === '/api/logs/clear') {
    const removed = pruneLogs(LOG_DIR, Date.now(), body.all ? 0 : logKeepMs(body.days ?? config.logKeepDays));
    return send(res, 200, { removed, ...logStats(LOG_DIR) });
  }
  if (req.method === 'PUT' && url.pathname === '/api/config') {
    config = { ...config, ...sanitizeConfig(body) };
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
      if (!['self', 'fix'].includes(body.mode) || !skill) return send(res, 400, { error: E('skillMissing', { repo: mine.pr.repo }) });
      if (!['idle', 'planned'].includes(mine.status)) return send(res, 409, { error: E('running') });
      let triage = null;
      if (body.mode === 'fix') {
        triage = triageFrom(mine.threads, body.decisions);
        if (!triage) return send(res, 400, { error: E('undecided') });
        if (triage.some((t) => t.verdict === 'disagree' && !t.reason)) return send(res, 400, { error: E('reasonRequired') });
        skipThreads(body.key, triage);
        // すべて対象外なら AI は動かさず、覚えるだけで終わる
        if (triageTargets(triage).length === 0) return send(res, 200, { ok: true });
      }
      enqueueMine(body.key, body.mode, triage);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/mine/apply') {
      if (mine.status !== 'planned' || !mine.findings || !mine.sessionId) return send(res, 409, { error: E('cannotApply') });
      if (!body.confirmed) return send(res, 400, { error: E('confirmRequired') });
      if (!canDecideAll(mine.findings, body.decisions)) return send(res, 400, { error: E('undecided') });
      enqueueApply(body.key, body.decisions);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/mine/apply-comments') {
      if (mine.status !== 'planned' || !mine.sessionId) return send(res, 409, { error: E('cannotApply') });
      enqueueApply(body.key, null);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/mine/merge-ready') {
      if (mine.status !== 'idle' || (body.ready && mine.pending)) return send(res, 409, { error: E('cannotMove') });
      updateEntry(body.key, { mergeReady: !!body.ready, done: false });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/mine/done') {
      // 未対応の指摘が残っていると次の取得で指摘ありに戻るので移せない
      if (mine.status !== 'idle' || (body.done && mine.pending)) return send(res, 409, { error: E('cannotMove') });
      updateEntry(body.key, { done: !!body.done, mergeReady: false });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/mine/cancel') {
      if (!['queued', 'running'].includes(mine.status)) return send(res, 409, { error: E('cannotCancel') });
      cancelMine(body.key);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  }

  const entry = state.prs[body.key];
  if (req.method !== 'POST' || !entry) return send(res, 404, { error: 'not found' });

  if (url.pathname === '/api/review') {
    if (!config.repos[entry.pr.repo]?.skill) return send(res, 400, { error: E('skillMissing', { repo: entry.pr.repo }) });
    if (['queued', 'reviewing', 'posting'].includes(entry.status)) return send(res, 409, { error: E('running') });
    enqueueReview(body.key);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/post') {
    if (entry.status !== 'reviewed' || !entry.findings || !entry.sessionId) return send(res, 409, { error: E('cannotPost') });
    if (!canDecideAll(entry.findings, body.decisions)) return send(res, 400, { error: E('undecided') });
    enqueuePost(body.key, body.decisions, !!body.approve, !!body.humanRead);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/cancel') {
    if (!['queued', 'reviewing'].includes(entry.status)) return send(res, 409, { error: E('cannotCancel') });
    cancelReview(body.key);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/skip') {
    // 投稿せずに Done へ移す。GitHub 上の依頼は残るので mergeBoard で requested に戻さない
    if (!['requested', 'reviewed'].includes(entry.status)) return send(res, 409, { error: E('cannotSkip') });
    updateEntry(body.key, { status: 'commented', commentedAt: Date.now(), skipped: true, error: null });
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/dismiss') {
    // 実行中に消すと claude は動き続け、投稿中なら結果も記録されない
    if (['queued', 'reviewing', 'posting'].includes(entry.status)) return send(res, 409, { error: E('running') });
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
      recoverRun(e.run, (res) => (e.status === 'reviewing' ? finishReview(key, e.run.cwd, res, e.runId) : finishPost(key, res)));
      continue;
    }
    if (e.status === 'queued' || e.status === 'reviewing') {
      if (config.repos[e.pr.repo]?.skill) requeue.push(() => enqueueReview(key));
      else state.prs[key] = { ...e, status: 'requested', error: E('restartInterrupted') };
    }
    if (e.status === 'posting') state.prs[key] = { ...e, status: 'reviewed', error: E('restartPostInterrupted') };
  }
  for (const [key, e] of Object.entries(state.mine)) {
    if ((e.status === 'running' || e.status === 'applying') && e.run) {
      recoverRun(e.run, (res) => (e.status === 'running' ? finishMine(key, e.run.cwd, res, e.runId) : finishApply(key, res)), e.pr.repo);
      continue;
    }
    if (e.status === 'queued' || e.status === 'running') {
      // 指摘への対応は事前判断 (triage) が無いとプロンプトを作れないので、引き継げなければ戻す
      if (config.repos[e.pr.repo]?.[e.mode === 'self' ? 'selfSkill' : 'fixSkill'] && (e.mode === 'self' || e.triage)) requeue.push(() => enqueueMine(key, e.mode, e.triage));
      else state.mine[key] = { ...e, status: 'idle', error: E('restartInterrupted') };
    }
    if (e.status === 'applying') state.mine[key] = { ...e, status: 'planned', error: E('restartApplyInterrupted') };
  }
  saveState();
  // 回収中のジョブを running に数えてから積むので maxConcurrent を超えない
  for (const fn of requeue) fn();

  refreshFromGitHub().catch((e) => {
    state.fetchError = e.message;
  });
  schedulePoll();
  pruneLogs(LOG_DIR, Date.now(), logKeepMs(config.logKeepDays));
  setInterval(() => pruneLogs(LOG_DIR, Date.now(), logKeepMs(config.logKeepDays)), 24 * 60 * 60 * 1000);

  http
    // 送信後に投げた場合にもう一度 writeHead すると、未処理の rejection でサーバーごと落ちる
    .createServer((req, res) => handle(req, res).catch((e) => (res.headersSent ? res.end() : send(res, 500, { error: e.message }))))
    .listen(PORT, '127.0.0.1', () => console.log(`Docket: http://localhost:${PORT}`));
}

if (require.main === module) main();

module.exports = { killRun, readTail, isClaudeRun, pruneLogs, logStats, logKeepMs, periodAt, periodWindows, periodQueries, pickIterations, parseProjectUrl, detectFields, barRange, sprintTree, readRun, logLines, isAlive, searchQueries, filterByAuthors, usageOf, addUsage, childEnv, modelOptions, mergeBoard, mergeMine, pendingThreads, pendingComments, fillTemplate, buildReviewPrompt, PROMPT_SKILL, buildPostPrompt, buildFixPlanPrompt, triageFrom, triageTargets, buildFixApplyPrompt, buildSelfApplyPrompt, buildCommentApplyPrompt, withOutputLang, extractTagJson, runForTag, splitArgs, normalizeNos, boardEntry, DONE_KEEP_MS, canDecideAll, sanitizeConfig, pollIntervalMs, concurrencyLimit, inPollHours, RE_REQUEST_GRACE_MS };
