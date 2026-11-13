'use strict';

// What a fix run hands back, and how docket-gits publishes it after the user checks it.
// The run itself can't write to GitHub (see workspace.js). It commits in its throwaway clone, writes the
// commits as patch files (git format-patch) and answers with APPLY_SCHEMA. docket-gits never runs git in
// the run's clone, whose config the run controls: it applies the patches in a clean clone of its own and
// pushes, opens pull requests, creates issues and posts the review and replies with the user's gh login.

const fs = require('node:fs');
const path = require('node:path');

const MAX_PATCH_BYTES = 5 * 1024 * 1024;

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
          base: { type: ['string', 'null'] },
          patchDir: { type: 'string' },
          pull: { type: ['object', 'null'], properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] },
        },
        required: ['key', 'name', 'patchDir'],
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

// What the run is told about handing its work back. outDir: the folder it writes patches to
function applyHandback(pr, outDir) {
  return `## How this run ends
You can't push, reply, post, open pull requests or create issues: this run has a read-only token, and those commands fail. docket-gits does them after the user checks your work. Skip those steps of the skill or the instructions above, and hand the work back instead:
- Commit locally as usual (one commit per comment or finding). Never rewrite or drop commits that are already on the pull request branch.
- For each branch, write its new commits as patches: \`git format-patch <first new commit>~1..HEAD -o ${outDir}/<key>\` (or \`--root\` style ranges as needed). Use key "head" for the pull request branch ${pr.head || ''}. For a split, create a new branch from its base, commit there, and write its patches under its own key.
- branches: one entry per branch with new commits. For the pull request branch: key "head", name "${pr.head || ''}", base null, pull null. For a split: a new branch name, its base branch, and pull with the title and body of the Draft pull request.
- issues: follow-up issues to create (key, title, body, and parent: the number of the issue to link it under, or null).
- review: only for a self-review: the review body and one comment per agreed finding (no, body). Otherwise null.
- replies: one per reply. to: the URL of the comment you answer (a review thread comment or a pull request comment of ${pr.url}), or "finding:<no>" for a finding of the self-review above.
- In replies and bodies, write commit SHAs as they are in your clone, "{pull:<key>}" for the URL of a split's pull request and "{issue:<key>}" for an issue's URL. docket-gits replaces them after publishing.
- summary: what you did, for the user. done: false with error when you could not do the work.`;
}

const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}$/;

// Files a change touches, and whether it should be shown with a warning: CI and repository settings run on
// push with the repository's secrets, and executable files can run on the next checkout
function patchFiles(text) {
  const files = [...text.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((m) => m[2]);
  const executable = /^(new file mode|new mode) 100755$/m.test(text);
  const risky = files.filter((f) => /^\.github\/|^\.gitlab-ci|^\.circleci\/|^\.husky\/|^\.gitattributes$|^\.gitmodules$/.test(f));
  return { files, risky: [...risky, ...(executable ? ['(executable file)'] : [])] };
}

// Reads a finished run's answer and patches before its folder is removed. Throws with a message for the user
// headSha: the pull request head the run started from
function collectResult(answer, outDir, pr, headSha = null) {
  if (!answer || typeof answer !== 'object') throw new Error('The run returned no result');
  if (!answer.done) throw new Error(answer.error || 'The run did not finish its work');
  const root = fs.realpathSync(outDir);
  let total = 0;
  const branches = (answer.branches || []).map((b) => {
    if (!BRANCH.test(b.name || '')) throw new Error(`Invalid branch name: ${b.name}`);
    const head = b.key === 'head';
    if (head && b.name !== pr.head) throw new Error(`The pull request branch is ${pr.head}, not ${b.name}`);
    if (!head && (!BRANCH.test(b.base || '') || b.name === pr.head || b.name === pr.base)) throw new Error(`Invalid split branch: ${b.name} from ${b.base}`);
    const given = path.resolve(root, b.patchDir || '');
    const dir = fs.existsSync(given) ? fs.realpathSync(given) : given;
    if (!dir.startsWith(root + path.sep)) throw new Error(`Patches outside the run's folder: ${b.patchDir}`);
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^\d{4}-.*\.patch$/.test(n)).sort() : [];
    const patches = names.map((name) => {
      const file = path.join(dir, name);
      if (!fs.lstatSync(file).isFile()) throw new Error(`Not a file: ${name}`);
      const text = fs.readFileSync(file, 'utf8');
      total += text.length;
      if (total > MAX_PATCH_BYTES) throw new Error('The patches are too large');
      const from = /^From ([0-9a-f]{40}) /.exec(text)?.[1] || null;
      const subject = /^Subject: (?:\[PATCH[^\]]*\] )?(.*)$/m.exec(text)?.[1] || name;
      return { name, from, subject, text, ...patchFiles(text) };
    });
    if (patches.length === 0) throw new Error(`No patches for branch ${b.name}`);
    return { key: head ? 'head' : String(b.key), name: b.name, base: head ? null : b.base, pull: !head && b.pull ? { title: String(b.pull.title), body: String(b.pull.body) } : null, patches };
  });
  const issues = (answer.issues || []).map((i) => ({ key: String(i.key), title: String(i.title), body: String(i.body), parent: Number.isInteger(i.parent) ? i.parent : null }));
  const prUrl = pr.url.replace(/\/$/, '');
  const replies = (answer.replies || []).map((r) => {
    const to = String(r.to).trim();
    if (!/^finding:\d+$/.test(to) && !(to === prUrl || to.startsWith(`${prUrl}#`))) throw new Error(`A reply targets another page: ${to}`);
    return { to, body: String(r.body) };
  });
  const review = answer.review && typeof answer.review === 'object' ? { body: String(answer.review.body || ''), comments: (answer.review.comments || []).map((c) => ({ no: c.no, body: String(c.body) })) } : null;
  return { headSha, summary: String(answer.summary || ''), branches, issues, review, replies, risky: [...new Set(branches.flatMap((b) => b.patches.flatMap((p) => p.risky)))] };
}

// Where a reply goes: a thread reply, or a pull request comment
function replyEndpoint(pr, to, findingComments = {}) {
  const finding = /^finding:(\d+)$/.exec(to);
  const thread = finding ? findingComments[finding[1]] : /#discussion_r(\d+)$/.exec(to)?.[1];
  if (finding && !thread) return null;
  return thread ? `repos/${pr.repo}/pulls/${pr.number}/comments/${thread}/replies` : `repos/${pr.repo}/issues/${pr.number}/comments`;
}

// Replaces SHAs of the run's clone with the published ones and {pull:key} / {issue:key} with URLs
function fillLinks(text, { shas = {}, pulls = {}, issues = {} }) {
  let out = text.replace(/\{(pull|issue):([^}]+)\}/g, (m, kind, key) => (kind === 'pull' ? pulls : issues)[key] || m);
  for (const [from, to] of Object.entries(shas)) {
    out = out.replace(new RegExp(`\\b${from.slice(0, 7)}[0-9a-f]{0,33}\\b`, 'g'), (m) => (from.startsWith(m) ? (m.length >= 40 ? to : to.slice(0, m.length)) : m));
  }
  return out;
}

// Applies and pushes the branches, then creates issues and pull requests, posts the review and the replies.
// progress: what an earlier attempt already did (kept by the caller), so a retry does only the rest.
// deps: { git(args, opts), rest(method, endpoint, body), read(endpoint), clone(base) -> dir, findings, decisions }
async function publish(pr, result, progress, deps) {
  progress.shas ||= {};
  progress.pushed ||= {};
  progress.issues ||= {};
  progress.pulls ||= {};
  progress.replies ||= {};
  for (const branch of result.branches) {
    if (progress.pushed[branch.key]) continue;
    const dir = await deps.clone(branch.base);
    const start = (await deps.git(['-C', dir, 'rev-parse', 'HEAD'])).trim();
    if (branch.key === 'head') {
      // The patches were made on the head the run started from (result.headSha). The branch must be in this
      // repository (not a fork) and still there: pushing on top of someone's new commits would bypass them
      const remote = (await deps.git(['-C', dir, 'ls-remote', 'origin', `refs/heads/${branch.name}`])).split(/\s/)[0];
      if (!remote) throw new Error(`The pull request branch ${branch.name} is not in ${pr.repo}`);
      if (remote !== result.headSha || start !== result.headSha) throw new Error(`The pull request branch ${branch.name} moved since the run; run the fix again`);
    } else if ((await deps.git(['-C', dir, 'ls-remote', 'origin', `refs/heads/${branch.name}`])).trim()) {
      throw new Error(`Branch ${branch.name} already exists`);
    }
    const files = branch.patches.map((p, i) => {
      const file = path.join(dir, '..', `${branch.key.replace(/\W/g, '_')}-${String(i).padStart(4, '0')}.patch`);
      fs.writeFileSync(file, p.text);
      return file;
    });
    await deps.git(['-C', dir, 'am', '--committer-date-is-author-date', ...files]);
    const made = (await deps.git(['-C', dir, 'rev-list', '--reverse', `${start}..HEAD`])).split('\n').filter(Boolean);
    branch.patches.forEach((p, i) => { if (p.from && made[i]) progress.shas[p.from] = made[i]; });
    // Never force: a moved branch makes this fail instead of overwriting someone's commits
    await deps.git(['-C', dir, 'push', 'origin', `HEAD:refs/heads/${branch.name}`]);
    progress.pushed[branch.key] = true;
    await deps.save?.(progress);
  }
  const links = () => ({ shas: progress.shas, pulls: progress.pulls, issues: progress.issues });
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
    progress.findingComments = Object.fromEntries(comments.map((c) => [c.no, posted.find((p) => p.path === c.path && (p.line ?? p.original_line) === c.line)?.id]).filter(([, id]) => id));
    progress.review = made.html_url;
    await deps.save?.(progress);
  }
  for (const [i, reply] of result.replies.entries()) {
    if (progress.replies[i]) continue;
    const endpoint = replyEndpoint(pr, reply.to, progress.findingComments);
    if (!endpoint) continue;
    const made = await deps.rest('POST', endpoint, { body: fillLinks(reply.body, links()) });
    progress.replies[i] = made?.html_url || true;
    await deps.save?.(progress);
  }
  return progress;
}

module.exports = { APPLY_SCHEMA, applyHandback, collectResult, patchFiles, replyEndpoint, fillLinks, publish };
