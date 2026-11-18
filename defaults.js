'use strict';

// Default settings (config.json holds only what the user changed on top of these) and the default shared prompts

const { REGISTRIES } = require('./workspace');

const DEFAULT_CONFIG = {
  // Empty = runs fail until set. Home and / are refused (agents must not roam the whole disk)
  workdir: '',
  // Fix runs may edit <working directory>/.claude/skills without asking (off: those edits are denied)
  skillEdits: false,
  // What AI runs may reach besides GitHub (read-only, through the server): localhost ports, for databases tests use,
  // and these hosts, for installing dependencies. Everything else is blocked by the sandbox
  runLocalhost: false,
  runDomains: REGISTRIES,
  // Env vars for AI runs, KEY=VALUE per line (a local test database's password, ...). The run's commands can read them
  runEnv: '',
  // A Chromium for the runs' Playwright tests, started outside the sandbox (browser.js). Off: browser tests can't run
  runBrowser: false,
  // Reviews and self-reviews run the tests themselves (off: they only read the code; the author ran them)
  reviewChecks: false,
  // Empty = claude's default. Subagents use this model too
  model: '',
  effort: '',
  pollMinutes: 5,
  // Fetch from GitHub automatically only during these hours (start <= hour < end). Same value = all day
  pollStartHour: 0,
  pollEndHour: 0,
  // How often the browser refetches /api/board
  refreshSeconds: 5,
  // How many days to keep showing merged PRs that still have my review request (0 hides them)
  mergedDays: 7,
  maxConcurrent: 10,
  // Empty = everyone. If set, only PRs by these authors are shown (e.g. ["alice", "dependabot[bot]"])
  authors: [],
  // { "owner/name": { skill: "be-review", args: "{pr-number}", cwd: "", selfSkill: "", selfArgs: "", fixSkill: "", fixArgs: "", setup: "" } }
  // setup: shell command the server runs in the worktree before each run, outside the sandbox (see runSetup in workspace.js)
  // selfSkill: self-review of my PRs, fixSkill: handle review comments on my PRs (empty hides the button)
  repos: {},
  // Review instructions for repos that use the "configured prompt" (PROMPT_SKILL) instead of a skill, or have no review skill. Empty = default for the UI language (DEFAULT_PROMPTS)
  reviewPrompt: '',
  // Instructions for handling review comments in repos that use the "configured prompt". Empty = default for the UI language
  fixPrompt: '',
  // UI language (ja / ko / en). Sent when the page opens; picks the default shared prompts
  uiLang: '',
  // URL of the GitHub Project shown on the roadmap screen (e.g. https://github.com/orgs/acme/projects/1)
  projects: [],
  // Number of past and future sprints shown on the sprint screen (future ones only if they have issues)
  sprintPast: 1,
  sprintFuture: 1,
  // Period unit on the roadmap: week / 2week / month
  roadmapPeriod: 'month',
  // Folder for plan md files. Empty = ~/docket-plans (one subfolder per GitHub Project)
  plansDir: '',
  // Project fields the roadmap uses, chosen per project on the roadmap screen: { [url]: { start, end, sprint } } (field names or null).
  // Saved only via /api/plan/fields, so saving the settings form never overwrites it
  projectFields: {},
  // Language Claude uses for text posted to PRs and findings shown on the board: ja / ko / en
  outputLang: 'en',
  // Comment language per author for posts on other people's PRs (e.g. { "tanaka": "ja", "nguyen": "en" }). Others use outputLang
  authorLangs: {},
  // Icon prefixed to the reviewer's own opinion when posting a disagreed finding with a reason
  disagreeIcon: '🙅💭',
  agreeIcon: '🙆💭',
  // Icon placed before the reviewer's own note at the top of the overall review comment
  noteIcon: '💬',
  // Days to keep logs (.log) of finished runs. Older ones are deleted daily
  logKeepDays: 30,
  // Days to keep Done cards whose request was removed. Counted from the day posted or skipped
  doneKeepDays: 7,
  // Accepted version of the "before you use" notice. Below CONSENT_VERSION, claude is not started
  consentVersion: 0,
};

// Default shared prompts. If the setting is empty, the one for the UI language is used
const DEFAULT_PROMPTS = {
  ja: {
    reviewPrompt: `PR {pr-url} をレビューしてください。

- \`gh pr view {pr-url}\` で概要を、\`gh pr diff {pr-url}\` で差分を確認する。必要なら周辺のコードも読む。
- 正しさ (バグ・境界値・エラー処理)・セキュリティ・性能・可読性の観点で、修正すべき点を挙げる。好みの問題は避ける。
- 重要度は must (直さないと壊れる) / want (直した方がよい) / imo (意見) / nit (些細) のいずれかにする。
- 各指摘は該当するファイルと diff 上の行番号を添え、なぜ問題か・どう直すかを具体的に書く。`,
    fixPrompt: `PR {pr-url} に付いたレビュー指摘に対応してください。

- カレントディレクトリが対象リポジトリの clone でなければ、何もせず理由を返す。
- 未コミットの変更があれば、何もせず理由を返す (ユーザーの作業を消さないため)。
- \`gh pr checkout {pr-url}\` で PR ブランチをチェックアウトする。
- 未解決のレビュースレッドとPR コメントを \`gh api\` で取得し、指摘ごとに修正・返信のどちらで対応するかを決める。
- 修正は 1 指摘 1 コミットにし、既存のコミットメッセージの書き方に合わせる。push は force しない。
- 返信には対応したコミット SHA を含める。スレッドへは \`gh api repos/{full-repo-name}/pulls/{pr-number}/comments/<comment_id>/replies\`、PR コメントへは元のコメントを引用して \`gh pr comment {pr-url}\` で返信する。`,
  },
  ko: {
    reviewPrompt: `PR {pr-url} 를 리뷰해 주세요.

- \`gh pr view {pr-url}\` 로 개요를, \`gh pr diff {pr-url}\` 로 변경 내용을 확인한다. 필요하면 주변 코드도 읽는다.
- 정확성 (버그·경계값·오류 처리)·보안·성능·가독성 관점에서 고쳐야 할 점을 든다. 취향 문제는 피한다.
- 중요도는 must (고치지 않으면 깨짐) / want (고치는 편이 좋음) / imo (의견) / nit (사소함) 중 하나로 한다.
- 각 지적에는 해당 파일과 diff 상의 줄 번호를 붙이고, 왜 문제인지·어떻게 고칠지를 구체적으로 쓴다.`,
    fixPrompt: `PR {pr-url} 에 달린 리뷰 지적에 대응해 주세요.

- 현재 디렉터리가 대상 저장소의 clone 이 아니면, 아무것도 하지 말고 이유를 돌려준다.
- 커밋하지 않은 변경이 있으면, 아무것도 하지 말고 이유를 돌려준다 (사용자의 작업을 지우지 않기 위해).
- \`gh pr checkout {pr-url}\` 로 PR 브랜치를 체크아웃한다.
- 해결되지 않은 리뷰 스레드와 PR 코멘트를 \`gh api\` 로 가져와, 지적마다 수정·답글 중 어느 쪽으로 대응할지 정한다.
- 수정은 지적 하나에 커밋 하나로 하고, 기존 커밋 메시지 작성 방식에 맞춘다. push 는 force 하지 않는다.
- 답글에는 대응한 커밋 SHA 를 넣는다. 스레드에는 \`gh api repos/{full-repo-name}/pulls/{pr-number}/comments/<comment_id>/replies\`, PR 코멘트에는 원래 코멘트를 인용해 \`gh pr comment {pr-url}\` 로 답한다.`,
  },
  en: {
    reviewPrompt: `Please review PR {pr-url}.

- Check the overview with \`gh pr view {pr-url}\` and the changes with \`gh pr diff {pr-url}\`. Read the surrounding code if needed.
- List what should be fixed in terms of correctness (bugs, edge cases, error handling), security, performance and readability. Avoid matters of taste.
- Give each one a severity of must (breaks if not fixed) / want (better fixed) / imo (opinion) / nit (minor).
- Attach the file and the line number in the diff to each finding, and write concretely why it is a problem and how to fix it.`,
    fixPrompt: `Please address the review comments on PR {pr-url}.

- If the current directory is not a clone of the target repository, do nothing and return the reason.
- If there are uncommitted changes, do nothing and return the reason (so the user's work is not lost).
- Check out the PR branch with \`gh pr checkout {pr-url}\`.
- Fetch the unresolved review threads and PR comments with \`gh api\`, and decide for each one whether to fix it or reply.
- Make one commit per comment, following the style of the existing commit messages. Do not force push.
- Include the SHA of the fixing commit in each reply. Reply to threads with \`gh api repos/{full-repo-name}/pulls/{pr-number}/comments/<comment_id>/replies\`, and to PR comments by quoting the original with \`gh pr comment {pr-url}\`.`,
  },
};
// Defaults used to be saved verbatim in config.json, so treat a value equal to any language's default as empty
function sharedPrompt(cfg, key) {
  const value = (cfg[key] || '').trim();
  const isDefault = !value || Object.values(DEFAULT_PROMPTS).some((p) => p[key] === value);
  return isDefault ? (DEFAULT_PROMPTS[cfg.uiLang] || DEFAULT_PROMPTS.en)[key] : value;
}

module.exports = { DEFAULT_CONFIG, DEFAULT_PROMPTS, sharedPrompt };
