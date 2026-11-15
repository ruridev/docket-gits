'use strict';

// What a fix run hands back, and how docket-gits publishes it after the user checks it.
// The run can't write to GitHub (see workspace.js). It commits in its worktree, on docket/pr-<n> (and on
// docket/pr-<n>-<name> for a split), and answers with APPLY_SCHEMA. docket-gits reads the commits from the clone
// (whose config and hooks the run can't change), shows them, and on Publish pushes exactly those commits without
// force, then opens pull requests, creates issues and posts the review and replies with the user's gh login.

const MAX_FILES = 2000;

// The answer of a fix run (--json-schema)
const APPLY_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    error: { type: ['string', 'null'] },
    summary: { type: 'string' },
    branches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          name: { type: 'string' },
          local: { type: 'string' },
          base: { type: ['string', 'null'] },
          pull: { type: ['object', 'null'], properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] },
        },
        required: ['key', 'name', 'local'],
      },
    },
    issues: {
      type: 'array',
      items: { type: 'object', properties: { key: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, parent: { type: ['integer', 'null'] } }, required: ['key', 'title', 'body'] },
    },
    review: {
      type: ['object', 'null'],
      properties: { body: { type: 'string' }, comments: { type: 'array', items: { type: 'object', properties: { no: { type: 'integer' }, body: { type: 'string' } }, required: ['no', 'body'] } } },
      required: ['body', 'comments'],
    },
    replies: { type: 'array', items: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] } },
  },
  required: ['done', 'summary', 'branches', 'issues', 'replies'],
};

const headBranch = (pr) => `docket/pr-${pr.number}`;

// What the run is told about handing its work back
function applyHandback(pr) {
  const local = headBranch(pr);
  return `## How this run ends
You can't push, reply, post, open pull requests or create issues: gh here can only read, and those commands fail. docket-gits does them after the user checks your work. Skip those steps of the skill or the instructions above, and hand the work back instead:
- The current directory is a worktree of the pull request, on branch ${local} at its head. Commit there as usual (one commit per comment or finding). Never rewrite or drop commits that are already on the pull request.
- For a split, create the new branch from its base (\`git switch -c ${local}-<short-name> origin/<base>\`), commit there, and switch back to ${local} afterwards.
- branches: one entry per branch with new commits. The pull request branch: key "head", name "${pr.head || ''}", local "${local}", base null, pull null. A split: key, name (the branch to create on GitHub), local (${local}-<short-name>), base, and pull with the title and body of the Draft pull request.
- issues: follow-up issues to create (key, title, body, and parent: the number of the issue to link it under, or null).
- review: only for a self-review: the review body and one comment per agreed finding (no, body). Otherwise null.
- replies: one per reply. to: the URL of the comment you answer (a review thread comment or a pull request comment of ${pr.url}), or "finding:<no>" for a finding of the self-review above.
- In replies and bodies, use your commit SHAs as they are, "{pull:<key>}" for the URL of a split's pull request and "{issue:<key>}" for an issue's URL. docket-gits fills them in after publishing.
- summary: what you did, for the user. done: false with error when you could not do the work.`;
}

const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}$/;
const RISKY = /^\.github\/|^\.gitlab-ci|^\.circleci\/|^\.husky\/|^\.gitattributes$|^\.gitmodules$/;

// Files of a change, and which deserve a warning: CI and repository settings run with the repository's secrets
// once pushed, and executable files can run on the next checkout. raw: `git diff --raw` output
function changedFiles(raw) {
  const files = [];
  const risky = [];
  for (const line of raw.split('\n')) {
    const m = /^:(\d{6}) (\d{6}) \S+ \S+ \S+\t(.+)$/.exec(line);
    if (!m) continue;
    files.push(m[3]);
    if (RISKY.test(m[3])) risky.push(m[3]);
    else if (m[2] === '100755' && m[1] !== '100755') risky.push(`${m[3]} (executable)`);
  }
  return { files: files.slice(0, MAX_FILES), risky };
}

// Reads a finished run's answer and its commits from the clone. ctx: { pr, clone, headSha, git }. Throws with a message for the user
async function collectResult(answer, { pr, clone, headSha, git }) {
  if (!answer || typeof answer !== 'object') throw new Error('The run returned no result');
  if (!answer.done) throw new Error(answer.error || 'The run did not finish its work');
  const local = headBranch(pr);
  const branches = [];
  for (const b of answer.branches || []) {
    if (!BRANCH.test(b.name || '') || !BRANCH.test(b.local || '')) throw new Error(`Invalid branch name: ${b.name} / ${b.local}`);
    const head = b.key === 'head';
    if (head && (b.name !== pr.head || b.local !== local)) throw new Error(`The pull request branch is ${pr.head} (${local}), not ${b.name} (${b.local})`);
    if (!head && (!b.local.startsWith(`${local}-`) || !BRANCH.test(b.base || '') || [pr.head, pr.base].includes(b.name))) throw new Error(`Invalid split branch: ${b.name} from ${b.base}`);
    if (!head) await git(['-C', clone, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${b.base}:refs/remotes/origin/${b.base}`]);
    const base = head ? headSha : (await git(['-C', clone, 'rev-parse', '--verify', `refs/remotes/origin/${b.base}`])).trim();
    const tip = (await git(['-C', clone, 'rev-parse', '--verify', `refs/heads/${b.local}`])).trim();
    // The new commits must sit on the head (or base) as it was: no rewritten or dropped commits
    try {
      await git(['-C', clone, 'merge-base', '--is-ancestor', base, tip]);
    } catch {
      throw new Error(`${b.local} does not build on ${head ? 'the pull request head' : b.base}`);
    }
    const commits = (await git(['-C', clone, 'log', '--reverse', '--format=%H%x1f%s', `${base}..${tip}`])).split('\n').filter(Boolean).map((l) => {
      const [sha, subject] = l.split('\x1f');
      return { sha, subject };
    });
    if (commits.length === 0) continue;
    const { files, risky } = changedFiles(await git(['-C', clone, 'diff', '--raw', '--no-renames', base, tip]));
    branches.push({ key: head ? 'head' : String(b.key), name: b.name, local: b.local, base: head ? null : b.base, baseSha: base, tip, commits, files, risky,
      pull: !head && b.pull ? { title: String(b.pull.title), body: String(b.pull.body) } : null });
  }
  const issues = (answer.issues || []).map((i) => ({ key: String(i.key), title: String(i.title), body: String(i.body), parent: Number.isInteger(i.parent) ? i.parent : null }));
  const prUrl = pr.url.replace(/\/$/, '');
  const replies = (answer.replies || []).map((r) => {
    const to = String(r.to).trim();
    if (!/^finding:\d+$/.test(to) && !(to === prUrl || to.startsWith(`${prUrl}#`))) throw new Error(`A reply targets another page: ${to}`);
    return { to, body: String(r.body) };
  });
  const review = answer.review && typeof answer.review === 'object' ? { body: String(answer.review.body || ''), comments: (answer.review.comments || []).map((c) => ({ no: c.no, body: String(c.body) })) } : null;
  return { headSha, summary: String(answer.summary || ''), branches, issues, review, replies, risky: [...new Set(branches.flatMap((b) => b.risky))] };
}

// The commits of a branch as patch text, to read before publishing
const branchPatch = (clone, branch, git) => git(['-C', clone, 'format-patch', '--stdout', '--no-signature', `${branch.baseSha}..${branch.tip}`]);

// Where a reply goes: a thread reply, or a pull request comment (also for a finding whose comment wasn't found,
// so no reply is dropped)
function replyEndpoint(pr, to, findingComments = {}) {
  const finding = /^finding:(\d+)$/.exec(to);
  const thread = finding ? findingComments[finding[1]] : /#discussion_r(\d+)$/.exec(to)?.[1];
  return thread ? `repos/${pr.repo}/pulls/${pr.number}/comments/${thread}/replies` : `repos/${pr.repo}/issues/${pr.number}/comments`;
}

// Fills {pull:key} / {issue:key} with the URLs made while publishing
const fillLinks = (text, { pulls = {}, issues = {} }) => text.replace(/\{(pull|issue):([^}]+)\}/g, (m, kind, key) => (kind === 'pull' ? pulls : issues)[key] || m);

// Pushes the branches, then creates issues and pull requests, posts the review and the replies.
// progress: what an earlier attempt already did (kept by the caller), so a retry does only the rest.
// deps: { clone, git(args), rest(method, endpoint, body), read(endpoint), findings, save(progress) }
async function publish(pr, result, progress, deps) {
  progress.pushed ||= {};
  progress.issues ||= {};
  progress.pulls ||= {};
  progress.replies ||= {};
  const { clone, git } = deps;
  for (const branch of result.branches) {
    if (progress.pushed[branch.key]) continue;
    const remote = (await git(['-C', clone, 'ls-remote', 'origin', `refs/heads/${branch.name}`])).split(/\s/)[0];
    if (branch.key === 'head') {
      // Pushing on top of commits someone added since the run would bypass them; a fork's branch isn't here
      if (!remote) throw new Error(`The pull request branch ${branch.name} is not in ${pr.repo}`);
      if (remote !== result.headSha) throw new Error(`The pull request branch ${branch.name} moved since the run; run the fix again`);
    } else if (remote) {
      throw new Error(`Branch ${branch.name} already exists`);
    }
    // Exactly the commits that were checked, never forced
    await git(['-C', clone, 'push', '--quiet', 'origin', `${branch.tip}:refs/heads/${branch.name}`]);
    progress.pushed[branch.key] = true;
    await deps.save?.(progress);
  }
  const links = () => ({ pulls: progress.pulls, issues: progress.issues });
  for (const issue of result.issues) {
    if (progress.issues[issue.key]) continue;
    const made = await deps.rest('POST', `repos/${pr.repo}/issues`, { title: issue.title, body: fillLinks(issue.body, links()) });
    if (issue.parent) await deps.rest('POST', `repos/${pr.repo}/issues/${issue.parent}/sub_issues`, { sub_issue_id: made.id });
    progress.issues[issue.key] = made.html_url;
    await deps.save?.(progress);
  }
  for (const branch of result.branches.filter((b) => b.pull)) {
    if (progress.pulls[branch.key]) continue;
    const made = await deps.rest('POST', `repos/${pr.repo}/pulls`, { title: branch.pull.title, body: fillLinks(branch.pull.body, links()), head: branch.name, base: branch.base, draft: true });
    progress.pulls[branch.key] = made.html_url;
    await deps.save?.(progress);
  }
  if (result.review && !progress.review) {
    // Self-review: each agreed finding on its line, the rest in the body. Replies to "finding:<no>" go to these comments
    const byNo = new Map((deps.findings || []).map((f) => [String(f.no), f]));
    const comments = [];
    const loose = [];
    for (const c of result.review.comments) {
      const f = byNo.get(String(c.no));
      const body = fillLinks(c.body, links());
      if (f?.path && Number(f.line) > 0) comments.push({ path: f.path, line: Number(f.line), side: 'RIGHT', body, no: String(c.no) });
      else loose.push(f?.path ? `**${f.path}**\n\n${body}` : body);
    }
    const body = [fillLinks(result.review.body, links()), ...loose].filter(Boolean).join('\n\n');
    const made = await deps.rest('POST', `repos/${pr.repo}/pulls/${pr.number}/reviews`, { event: 'COMMENT', body, comments: comments.map(({ no, ...c }) => c) });
    const posted = await deps.read(`repos/${pr.repo}/pulls/${pr.number}/reviews/${made.id}/comments`).catch(() => []);
    // This endpoint leaves line empty, so find each comment by its text (then by path and line)
    const list = Array.isArray(posted) ? posted : [];
    progress.findingComments = Object.fromEntries(comments.map((c) => [c.no, (list.find((p) => p.body === c.body && p.path === c.path) || list.find((p) => p.path === c.path && (p.line ?? p.original_line) === c.line))?.id]).filter(([, id]) => id));
    progress.review = made.html_url;
    await deps.save?.(progress);
  }
  for (const [i, reply] of result.replies.entries()) {
    if (progress.replies[i]) continue;
    const endpoint = replyEndpoint(pr, reply.to, progress.findingComments);
    const made = await deps.rest('POST', endpoint, { body: fillLinks(reply.body, links()) });
    progress.replies[i] = made?.html_url || true;
    await deps.save?.(progress);
  }
  return progress;
}

module.exports = { APPLY_SCHEMA, applyHandback, collectResult, changedFiles, branchPatch, replyEndpoint, fillLinks, publish, headBranch };
