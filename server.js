'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { MAX_DEPTH, parsePlan, serializePlan, flatten, syncSnapshot, fieldsOf, snapshotFields, mergeRemote, same, validFile } = require('./plans');
const { createAuth } = require('./auth');
const { startGateway } = require('./browser');
const jail = require('./jail');
const { GITHUB_HOSTS, parseNpmrc, startSetupProxy } = require('./setup-proxy');
const { HOME: DOCKET_HOME, REGISTRIES, deniedPaths, workspaceNote, agentArgs, agentEnv, runEnv, runTmpOf, prepareWorkspace, removeWorkspace, runSetup, git } = require('./workspace');
const { APPLY_SCHEMA, applyHandback, collectResult, branchPatch, publish } = require('./publish');
const { startGitHubProxy } = require('./github-proxy');
const { DEFAULT_CONFIG, DEFAULT_PROMPTS, sharedPrompt } = require('./defaults');
const { repoTool, buildReviewPrompt, normalizeUnverified, buildSetupPrompt, postable, buildComposePrompt, POST_SCHEMA, reviewPayload, triageFrom, triageTargets, prAuthor, buildFixPlanPrompt, latestAuthorComment, applyRun, withOutputLang, postLang, extractTagJson } = require('./prompts');
const { doneKeepMs, LIST_QUERY, DETAIL_FIELDS, DETAIL_CHUNK, detailQuery, staleIds, withDetails, searchQueries, authorKey, filterByAuthors, mergeBoard, skipKey, mergeMine } = require('./board');
const { parseLines, logLines, readTail, logStats, pruneLogs } = require('./logs');
const { isAgentRun, reapLeftovers, reapWorktree, killRun, waitForExit } = require('./procs');

const PORT = Number(process.env.PORT || 4649);
const DATA_DIR = path.resolve(process.env.DOCKET_DATA || path.join(__dirname, 'data'));
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');
// GitHub Project fields, items and repository options read for the plan screen (the file name is older than the plan screen)
const PROJECT_CACHE_FILE = path.join(DATA_DIR, 'sprint-cache.json');
// What fix runs handed back (patches, replies...), waiting for the user to publish them
const RESULTS_DIR = path.join(DATA_DIR, 'results');
const auth = createAuth({ file: path.join(DATA_DIR, 'auth.json'), cookie: 'docket_gits_session', header: 'x-docket' });
// The docket portal embeds this app in an iframe. X-Frame-Options can't allow-list, so use CSP only
const FRAME_ANCESTORS = process.env.DOCKET_FRAME_ANCESTORS || "'self' http://localhost:4600 http://127.0.0.1:4600";

// Bump when the "before you use" notice changes significantly (asks everyone to accept again)
const CONSENT_VERSION = 2;
const needsConsent = () => (Number(config.consentVersion) || 0) < CONSENT_VERSION;
// APIs that start claude. Rejected before consent
const RUN_PATHS = ['/api/review', '/api/post', '/api/mine/run', '/api/mine/apply', '/api/mine/apply-comments', '/api/setup/suggest'];

// Errors shown in the UI are returned as language-neutral codes and translated in the browser
const E = (code, params) => ({ code, ...(params && { params }) });

// group:id -> { updatedAt, at, node } (see staleIds). In memory only: after a restart the first fetch reads everything again
const detailCache = new Map();

// ---------- Pure functions (tested) ----------

// Extract tokens (all models, incl. cache) and cost for one run from claude -p JSON output
function usageOf(parsed) {
  const models = Object.values(parsed.modelUsage || {});
  if (models.length === 0 && parsed.total_cost_usd == null) return null;
  const tokens = models.reduce((sum, m) => sum + (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0), 0);
  return { tokens, costUsd: parsed.total_cost_usd || 0 };
}

function addUsage(prev, u) {
  if (!u) return prev;
  return { tokens: (prev?.tokens || 0) + u.tokens, costUsd: u.costUsd == null || (prev && prev.costUsd == null) ? null : (prev?.costUsd || 0) + u.costUsd };
}

// In -p runs, edits under .claude/ (protected path) wait for confirmation and get denied, so route it to permission-mcp.js and allow skill edits only
// DOCKET_SKILLS_ROOT: only <cwd>/.claude/skills of this run may be edited
function permissionArgs(cwd) {
  return ['--mcp-config', JSON.stringify({ mcpServers: { docket: { command: process.execPath, args: [path.join(__dirname, 'permission-mcp.js')], env: { DOCKET_SKILLS_ROOT: cwd || '' } } } }), '--permission-prompt-tool', 'mcp__docket__approve'];
}

// If unset, subagents (Explore etc.) run on Haiku, so match the configured model
function modelOptions(cfg) {
  return {
    args: [...(cfg.model ? ['--model', cfg.model] : []), ...(cfg.effort ? ['--effort', cfg.effort] : [])],
    env: cfg.model ? { CLAUDE_CODE_SUBAGENT_MODEL: cfg.model } : {},
  };
}

// Claude args for a run, on top of the sandbox, the token and the rules of its workspace (see workspace.js):
// read: review / self-review / fix plan, which edit no files; apply: a fix run, which edits and commits in its
// clone and hands back patches; compose: writes the text of a post, with no tools at all.
// Bash runs in the sandbox, so no command list is needed: what a run can't do is decided by the token and the sandbox
// ws: the run's workspace (see workspace.js), with workdir
// repo: the run's repository. Registries are reached only by repositories turned on (repos[repo].network): an
// allowed registry also takes uploads, so a run could publish what it read with a token of its own
function claudeArgs(mode = 'apply', ws = {}, cfg = config || DEFAULT_CONFIG, repo = '') {
  const network = cfg.repos?.[repo]?.network === true;
  const env = agentArgs({ ws, workdir: ws.workdir, dataDir: DATA_DIR, envPath: process.env.PATH, deny: mode === 'read' ? ['Write', 'Edit', 'NotebookEdit'] : [],
    network: { allowLocal: cfg.runLocalhost === true || cfg.runBrowser === true, domains: network && Array.isArray(cfg.runDomains) ? cfg.runDomains.filter((d) => typeof d === 'string' && /^[\w.*-]+$/.test(d)) : [] } });
  if (mode === 'compose') return ['--tools', '', '--json-schema', JSON.stringify(POST_SCHEMA), ...env];
  // Every Bash command runs in the sandbox (it can't leave it), so allow them all: without this, claude still asks
  // about commands it can't check up front (shell variables, $(...)), and a run can't answer
  const bash = ['--allowedTools', 'Bash'];
  if (mode === 'apply') return ['--permission-mode', 'acceptEdits', ...bash, '--json-schema', JSON.stringify(APPLY_SCHEMA), ...env];
  return [...bash, ...env];
}

// Worktrees of pull requests that left the board (closed, merged, no longer requested)
function dropWorktrees(before, after) {
  for (const [key, e] of Object.entries(before)) {
    if (!after[key] && e.pr) removeWorkspace(e.pr, { workdir: repoCwd(e.pr.repo) }).catch((err) => console.error(`worktree ${key}: ${err.message}`));
  }
}

// Runs fn(ws) in the pull request's worktree (see workspace.js). clone: false gives an empty folder (a post's text needs no code).
// workdir: the user's working directory: where their clones are found, read-only for runs
async function withWorkspace(pr, workdir, fn, clone = true) {
  const unsafe = cwdError(workdir);
  if (unsafe) return { ok: false, error: unsafe };
  if (!clone) {
    const cwd = path.join(DOCKET_HOME, 'empty');
    fs.mkdirSync(cwd, { recursive: true });
    return fn({ cwd, workdir });
  }
  let ws;
  try {
    ws = await prepareWorkspace(pr, { workdir });
  } catch (e) {
    return { ok: false, error: E('workspaceFailed', { message: e.message }) };
  }
  const command = repoTool(config.repos[pr.repo]).setup;
  let sandbox = null;
  try {
    sandbox = command?.trim() ? await setupSandbox(pr.repo) : null;
  } catch (e) {
    return { ok: false, error: E('setupFailed', { message: `docket-gits could not start the setup sandbox: ${e.message}` }) };
  }
  const lease = sandbox && sandbox.lease();
  const setup = await runSetup(ws.cwd, command, { extra: runEnv(config.runEnv), sandbox: sandbox && { ...sandbox, proxy: lease.url } }).finally(() => lease?.release());
  if (setup.skipped) console.warn(`setup ${pr.repo}: not run, the setup command needs the macOS sandbox (sandbox-exec)`);
  if (!setup.ok) return { ok: false, error: E('setupFailed', { message: setup.output }) };
  return fn({ ...ws, workdir });
}

// The setup command's sandbox (runSetup in workspace.js). The proxy starts once; before each setup it is told which
// hosts it may reach and which of the user's ~/.npmrc tokens to add, and the command gets ~/.npmrc without them.
// null where there is no OS sandbox
let setupProxy = null;
async function setupSandbox(repo = '') {
  if (!jail.available()) return null;
  setupProxy = setupProxy || startSetupProxy({ keyDir: path.join(DATA_DIR, 'setup-ca'), certFile: path.join(DOCKET_HOME, 'setup', 'ca.pem'),
    log: (m) => console.log(`setup proxy: ${m}`) }).catch((e) => {
    setupProxy = null;
    throw e;
  });
  const proxy = await setupProxy;
  let text = '';
  try {
    text = fs.readFileSync(process.env.npm_config_userconfig || process.env.NPM_CONFIG_USERCONFIG || path.join(os.homedir(), '.npmrc'), 'utf8');
  } catch { /* no ~/.npmrc */ }
  const npmrc = parseNpmrc(text);
  const userconfig = path.join(DOCKET_HOME, 'setup', 'npmrc');
  fs.mkdirSync(path.dirname(userconfig), { recursive: true });
  fs.writeFileSync(userconfig, npmrc.config);
  const cfg = config || DEFAULT_CONFIG;
  // Even reading can send data out where downloads are counted in public (a package version per bit). So the
  // public registries runs may reach (repos[repo].network) are the setup command's only for repositories turned
  // on; otherwise only what ~/.npmrc names (or the default npm registry), and GitHub's download hosts
  const open_ = cfg.repos?.[repo]?.network === true;
  const domains = open_ && Array.isArray(cfg.runDomains) ? cfg.runDomains.filter((d) => typeof d === 'string' && /^[\w.*-]+$/.test(d)) : [];
  const npmDefault = /(^|\n)\s*registry\s*=/.test(npmrc.config) ? [] : ['registry.npmjs.org'];
  await proxy.update({ auth: npmrc.auth });
  const hosts = [...(open_ ? REGISTRIES : []), ...domains, ...npmDefault, ...GITHUB_HOSTS, ...npmrc.hosts];
  return { port: proxy.port, lease: () => proxy.lease(hosts), certFile: proxy.certFile, userconfig, denyRead: deniedPaths(DATA_DIR) };
}

// Agents must run inside a project, never in the home directory or / (their tools could reach everything)
function cwdError(cwd) {
  if (!cwd) return E('workdirMissing');
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const dir = real(cwd);
  return dir === path.parse(dir).root || dir === real(os.homedir()) ? E('workdirUnsafe', { dir: cwd }) : null;
}

// Decisions are stored by no, so renumber from 1 if Claude duplicates or skips numbers
// Drop non-object items like null; they break saving and showing decisions
function normalizeNos(items) {
  if (!Array.isArray(items)) return null;
  const isObj = (f) => f && typeof f === 'object';
  const list = items.every(isObj) ? items : items.filter(isObj);
  const nos = list.map((f) => f.no);
  if (nos.every((n) => n != null && n !== '') && new Set(nos.map(String)).size === nos.length) return list;
  return list.map((f, i) => ({ ...f, no: i + 1 }));
}

// skip (out of scope) is only available for review posting
function canDecideAll(findings, decisions, allowSkip = false) {
  const verdicts = allowSkip ? ['agree', 'disagree', 'skip'] : ['agree', 'disagree'];
  return findings.every((f) => verdicts.includes(decisions?.[f.no]?.verdict));
}

// ---------- Sprints (GitHub Projects) ----------

function parseProjectUrl(url) {
  const m = /github\.com\/(orgs|users)\/([^/]+)\/projects\/(\d+)/.exec(url || '');
  return m && { owner: m[1] === 'orgs' ? 'organization' : 'user', login: m[2], number: Number(m[3]) };
}

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Project field types the roadmap can filter by (with the field's options for select and iteration fields)
const FILTER_TYPES = ['TEXT', 'NUMBER', 'DATE', 'SINGLE_SELECT', 'ITERATION'];

// start / end (Date fields) and sprint (an Iteration field) are the fields the user chose for this project.
// Nothing is guessed: until chosen, or if a chosen field is gone or has another type, that value is null
// statuses: options of the Status field (in project order). fields: every field the roadmap can filter by
function detectFields(fields, choice = {}) {
  const pick = (name, type) => (name && fields.some((f) => f.name === name && f.dataType === type) ? name : null);
  const start = pick(choice.start, 'DATE');
  const end = pick(choice.end, 'DATE');
  const sprint = pick(choice.sprint, 'ITERATION');
  const iter = sprint && fields.find((f) => f.name === sprint);
  const toIter = (completed) => (i) => ({ id: i.id, title: i.title, startDate: i.startDate, endDate: addDays(i.startDate, i.duration - 1), completed });
  const iterations = iter ? [...iter.configuration.iterations.map(toIter(false)), ...iter.configuration.completedIterations.map(toIter(true))] : [];
  const statuses = (fields.find((f) => f.name === 'Status')?.options || []).map((o) => o.name);
  const options = (f) => (f.options ? f.options.map((o) => o.name) : f.configuration ? [...f.configuration.iterations, ...f.configuration.completedIterations].map((i) => i.title) : undefined);
  const filterable = fields.filter((f) => FILTER_TYPES.includes(f.dataType)).map((f) => ({ name: f.name, type: f.dataType, ...(options(f) && { options: options(f) }) }));
  return { sprint, start, end, iterations, statuses, fields: filterable };
}

const fieldChoice = (url) => config.projectFields?.[url] || null;

// Keep the current sprint plus `past` past and `future` future ones (only with issues), newest first
function pickIterations(iterations, today, { past, future }) {
  const asc = [...iterations].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const before = asc.filter((i) => i.endDate < today);
  return [
    ...before.slice(Math.max(0, before.length - past)),
    ...asc.filter((i) => i.startDate <= today && today <= i.endDate),
    ...asc.filter((i) => i.startDate > today && i.count !== 0).slice(0, future),
  ].reverse();
}

// Period buckets. Weeks start Monday, 2 weeks count from 2024-01-01 (a Monday), months follow the calendar
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

// The bucket containing today plus `past` past and `future` future ones, newest first
function periodWindows(today, unit, { past, future }) {
  const list = [periodAt(today, unit)];
  for (let i = 0; i < past; i++) list.push(periodAt(addDays(list.at(-1).startDate, -1), unit));
  for (let i = 0; i < future; i++) list.unshift(periodAt(addDays(list[0].endDate, 1), unit));
  return list;
}

// ---------- Persistence ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // Keep a broken hand-edited config under another name so the next save doesn't overwrite it with defaults
    const keep = `${file}.broken-${Date.now()}`;
    try {
      fs.copyFileSync(file, keep);
      console.error(`Could not read ${file}; starting with defaults (the original is kept as ${keep}): ${err.message}`);
    } catch {
      console.error(`Could not read ${file}; starting with defaults: ${err.message}`);
    }
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

let config;
let state;

function saveState() {
  writeJson(STATE_FILE, state);
}

// Reviewer side lives in state.prs, author side (keys starting with mine:) in state.mine
const mapOf = (key) => (key.startsWith('mine:') ? state.mine : state.prs);
// Keys come from requests, so never pick up inherited names like constructor / __proto__
const own = (map, key) => (Object.hasOwn(map, key) ? map[key] : undefined);

function updateEntry(key, patch) {
  const map = mapOf(key);
  // Discard the result if the card was deleted while running
  if (!own(map, key)) return;
  map[key] = { ...map[key], ...patch, updatedAt: Date.now() };
  saveState();
}

// ---------- GitHub ----------

function gh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      // gh fails if any part of the GraphQL query errors, so pass stdout too to use the data we got
      if (err) reject(Object.assign(new Error(stderr || err.message), { stdout }));
      else resolve(stdout);
    });
  });
}

// Posts with the user's gh login. since: when the review ran; a review with the same body posted after it
// (a restart or timeout hid the result) counts as this one, so nothing is posted twice
async function postReview(pr, review, since = 0, rest = ghRest, read = (endpoint) => gh(['api', endpoint]).then(JSON.parse)) {
  const endpoint = `repos/${pr.repo}/pulls/${pr.number}/reviews`;
  const existing = await read(`${endpoint}?per_page=100`).catch(() => []);
  const same = (Array.isArray(existing) ? existing : []).find((r) => (r.body || '') === review.body && Date.parse(r.submitted_at) >= since);
  if (same) return same.html_url || null;
  try {
    return (await rest('POST', endpoint, review))?.html_url || null;
  } catch (e) {
    if (review.comments.length === 0 || !/422|Unprocessable|line/i.test(e.message)) throw e;
    // A line outside the diff makes GitHub reject the whole review: put the line comments in the body instead
    const body = [review.body, ...review.comments.map((c) => `**${c.path}:${c.line}**\n\n${c.body}`)].filter(Boolean).join('\n\n');
    return (await rest('POST', endpoint, { event: review.event, body, comments: [] }))?.html_url || null;
  }
}

async function fetchAuthorComment(pr) {
  const jq = '.[] | {login: .user.login, at: (.submitted_at // .created_at), body}';
  const outs = await Promise.all([`issues/${pr.number}/comments`, `pulls/${pr.number}/comments`, `pulls/${pr.number}/reviews`]
    .map((p) => gh(['api', '--paginate', `repos/${pr.repo}/${p}`, '--jq', jq])));
  return latestAuthorComment(outs, prAuthor(pr));
}

// Share the in-flight fetch so periodic fetches and the Refresh button don't hit GitHub twice
// (separate runs could overwrite state.prs with an older result that finished later)
let refreshing = null;
function refreshFromGitHub() {
  return (refreshing ||= fetchFromGitHub().finally(() => (refreshing = null)));
}

// NOTE: fetch one page only, no paging. Show a notice in the UI if over the limit (page with after if that happens)
// GitHub search sometimes returns fewer nodes than issueCount, so only check when the page is full
const SEARCH_LIMITS = { open: 100, merged: 100, mine: 50 };
function isTruncated(data) {
  return Object.entries(SEARCH_LIMITS).some(([k, limit]) => data[k] && data[k].nodes.length >= limit && data[k].issueCount > limit);
}

async function fetchFromGitHub() {
  const q = searchQueries(config.mergedDays, Date.now());
  // gh fails if some nodes are unreadable (e.g. PRs in SAML-protected orgs). Use what we got and show the error too
  let partialError = null;
  const out = await gh(['api', 'graphql', '-f', `query=${LIST_QUERY}`, '-f', `open=${q.open}`, '-f', `merged=${q.merged}`, '-F', `withMerged=${q.withMerged}`, '-f', `mine=${q.mine}`, '-f', `reviewed=${q.reviewed}`]).catch((e) => {
    try {
      if (JSON.parse(e.stdout).data?.viewer) return (partialError = e.message), e.stdout;
    } catch {}
    throw e;
  });
  const { data } = JSON.parse(out);
  const groups = Object.keys(DETAIL_FIELDS).filter((g) => data[g]);
  // Details only for new or updated PRs, a few in each request so no single request gets slow
  const jobs = groups.flatMap((g) => {
    const ids = staleIds(data[g].nodes, detailCache, g);
    return Array.from({ length: Math.ceil(ids.length / DETAIL_CHUNK) }, (_, i) => ghqlResult(detailQuery(g, ids.slice(i * DETAIL_CHUNK, (i + 1) * DETAIL_CHUNK))).then(({ data: d, failed, message }) => {
      if (failed) partialError = message || partialError;
      for (const node of d.n || []) if (node?.id) detailCache.set(`${g}:${node.id}`, { updatedAt: node.updatedAt, at: Date.now(), node });
    }));
  });
  await Promise.all(jobs);
  // Forget PRs no search returns any more
  const seen = new Set(groups.flatMap((g) => data[g].nodes.filter((it) => it?.id).map((it) => `${g}:${it.id}`)));
  for (const k of detailCache.keys()) if (!seen.has(k)) detailCache.delete(k);
  state.truncated = isTruncated(data);
  for (const g of groups) data[g].nodes = withDetails(data[g].nodes, detailCache, g);
  state.viewer = data.viewer;
  const nodes = [...data.open.nodes, ...(data.merged?.nodes || [])].filter((n) => n?.number);
  const before = { ...state.prs, ...state.mine };
  state.prs = mergeBoard(state.prs, filterByAuthors(nodes, config.authors), Date.now(), (data.reviewed?.nodes || []).filter((n) => n?.number), data.viewer.login, doneKeepMs(config.doneKeepDays));
  // Only handle PRs from repos in the config, to keep personal repos etc. out (all PRs if none configured)
  const registered = (n) => Object.keys(config.repos).length === 0 || config.repos[n.repository.nameWithOwner];
  state.mine = mergeMine(state.mine, data.mine.nodes.filter((n) => n?.number && registered(n)), data.viewer.login);
  dropWorktrees(before, { ...state.prs, ...state.mine });
  state.lastFetchedAt = Date.now();
  state.fetchError = partialError;
  saveState();
}

// ---------- GitHub Projects ----------

function ghqlArgs(query, vars) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === 'string' ? '-f' : '-F', `${k}=${v}`);
  return args;
}

async function ghql(query, vars = {}) {
  const json = JSON.parse(await gh(ghqlArgs(query, vars)));
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('\n'));
  return json.data;
}

// Return what could be read even if some items (e.g. deleted issues) are unreadable
async function ghqlPartial(query, vars = {}) {
  return (await ghqlResult(query, vars)).data;
}

// What was read, and whether anything failed for a reason other than "not found" (rate limit, SAML, permissions, etc.)
async function ghqlResult(query, vars = {}) {
  const out = await gh(ghqlArgs(query, vars)).catch((e) => {
    if (e.stdout) return e.stdout;
    throw e;
  });
  const json = JSON.parse(out);
  const errors = (json.errors || []).filter((e) => e.type !== 'NOT_FOUND');
  return { data: json.data || {}, failed: !json.data || errors.length > 0, message: errors.map((e) => e.message).join('\n') };
}

const projectRoot = (p) => `${p.owner}(login: $login) { projectV2(number: $number)`;

const ISSUE_FIELDS = `fragment iss on Issue {
  id number title url state stateReason repository { nameWithOwner }
  assignees(first: 5) { nodes { login avatarUrl } }
  subIssues { totalCount }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number url state isDraft } }
  projectItems(first: 20) { nodes {
    project { id }
    sprint: fieldValueByName(name: $sprint) { ... on ProjectV2ItemFieldIterationValue { iterationId title } }
    status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name color } }
    start: fieldValueByName(name: $start) { ... on ProjectV2ItemFieldDateValue { date } }
    end: fieldValueByName(name: $end) { ... on ProjectV2ItemFieldDateValue { date } }
    values: fieldValues(first: 50) { nodes {
      ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { name } } }
    } }
  } }
}`;

// Use start/end dates and sprint only from this project (issues not in the project are unset)
function normIssue(n, projectId) {
  const item = n.projectItems.nodes.find((i) => i.project?.id === projectId);
  return {
    id: n.id, number: n.number, title: n.title, url: n.url, repo: n.repository.nameWithOwner,
    state: n.state, stateReason: n.stateReason, assignees: n.assignees.nodes,
    subCount: n.subIssues.totalCount,
    // Skip PRs that were just closed (only merged, open, or Draft)
    prs: n.closedByPullRequestsReferences.nodes.filter((pr) => pr.state !== 'CLOSED'),
    sprintId: item?.sprint?.iterationId || null,
    sprintTitle: item?.sprint?.title || null,
    status: item?.status?.name ? item.status : null,
    inProject: !!item,
    start: item?.start?.date || null, end: item?.end?.date || null, childIds: [],
  };
}

// Also save to a file so a server restart doesn't refetch
const projectCache = new Map(Object.entries(readJson(PROJECT_CACHE_FILE, {})));
// This is for an overall schedule view, so no auto-refetch. The UI's "Refresh now" sends refresh=1 to get the latest
const PROJECT_CACHE_MS = 24 * 60 * 60 * 1000;
// Drop caches whose key starts with prefix (after writing to GitHub, so stale values aren't shown)
function dropCached(prefix) {
  for (const k of projectCache.keys()) if (k.startsWith(prefix)) projectCache.delete(k);
  writeJson(PROJECT_CACHE_FILE, Object.fromEntries(projectCache));
}

async function cached(key, refresh, fn) {
  const hit = projectCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < PROJECT_CACHE_MS) return hit.data;
  const data = await fn();
  // Don't keep partial results (refetch next time it's opened)
  if (data?.partial) return data;
  projectCache.set(key, { at: Date.now(), data });
  for (const [k, v] of projectCache) if (Date.now() - v.at >= PROJECT_CACHE_MS) projectCache.delete(k);
  writeJson(PROJECT_CACHE_FILE, Object.fromEntries(projectCache));
  return data;
}

const filterQuery = (field, title) => `${JSON.stringify(field)}:${JSON.stringify(title)}`;

// One read of the Project for both the roadmap (fields, iterations with counts) and applying plans (field ids, repos).
// v3: the cached value carries the filterable field list, field ids and repos (older entries lack them)
async function projectMeta(url, refresh) {
  const p = parseProjectUrl(url);
  if (!p) throw E('projectUrlInvalid', { url });
  const range = { past: Math.max(0, Number(config.sprintPast) || 0), future: Math.max(0, Number(config.sprintFuture) || 0) };
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return cached(`meta:v3:${url}:${range.past}:${range.future}:${today}`, refresh, async () => {
    const data = await ghql(`query($login: String!, $number: Int!) { ${projectRoot(p)} { id title url repositories(first: 50) { nodes { nameWithOwner } } fields(first: 50) { nodes {
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2IterationField { configuration { iterations { id title startDate duration } completedIterations { id title startDate duration } } }
      ... on ProjectV2SingleSelectField { options { name } }
    } } } } }`, { login: p.login, number: p.number });
    const project = data[p.owner].projectV2;
    const fields = detectFields(project.fields.nodes, fieldChoice(url) || {});
    const fieldIds = Object.fromEntries(project.fields.nodes.filter((f) => f.id).map((f) => [f.name, f.id]));
    // Only unfinished iterations can be chosen in plans
    const openIterations = fields.iterations.filter((i) => !i.completed).sort((a, b) => a.startDate.localeCompare(b.startDate)).map(({ id, title, startDate, endDate }) => ({ id, title, startDate, endDate }));
    // Fetch per-sprint counts in one query via aliases
    // Future sprints are filtered by count, so count all of them first
    fields.iterations = pickIterations(fields.iterations, today, { past: range.past, future: Infinity });
    if (fields.iterations.length) {
      const counts = await ghql(`query($login: String!, $number: Int!) { ${projectRoot(p)} {
        ${fields.iterations.map((it, i) => `c${i}: items(first: 0, query: ${JSON.stringify(filterQuery(fields.sprint, it.title))}) { totalCount }`).join('\n')}
      } } }`, { login: p.login, number: p.number });
      fields.iterations.forEach((it, i) => (it.count = counts[p.owner].projectV2[`c${i}`].totalCount));
    }
    fields.iterations = pickIterations(fields.iterations, today, range);
    return { url, id: project.id, title: project.title, ...fields, fieldIds, openIterations, repos: project.repositories.nodes.map((r) => r.nameWithOwner) };
  });
}

const periodRange = () => ({ unit: PERIOD_UNITS[config.roadmapPeriod] !== undefined ? config.roadmapPeriod : 'month', past: Math.max(0, Number(config.sprintPast) || 0), future: Math.max(0, Number(config.sprintFuture) || 0) });

// ---------- Plans (Draft) ----------

// Plans are md files so they can live in git. GitHub is written only on "Apply to GitHub"
const plansRoot = () => config.plansDir || path.join(os.homedir(), 'docket-plans');
// One folder per GitHub Project (named by owner and number so renames don't change it)
function projectDir(url) {
  const p = parseProjectUrl(url);
  if (!p) throw E('projectUrlInvalid', { url });
  return path.join(plansRoot(), `${p.login}-${p.number}`);
}
// git init folders that docket-gits created (leave user-provided folders alone)
function ensureDir(dir) {
  const root = plansRoot();
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
    try { execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' }); } catch {}
  }
  fs.mkdirSync(dir, { recursive: true });
}
// git in the plans folder (sync, null on failure). Clones of pull requests use git from workspace.js
function planGit(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}
const inGit = (dir) => fs.existsSync(dir) && planGit(dir, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
// Contents at the last commit (null if not committed)
const committedText = (file) => planGit(path.dirname(file), ['show', `HEAD:./${path.basename(file)}`]);

const PLAN_SYNC_FILE = path.join(DATA_DIR, 'plan-sync.json');
// Contents last applied to GitHub (file -> issue key -> syncSnapshot). Used to spot issues changed after applying
// "^key" holds the parent key on GitHub (an issue moved from under another issue differs from the plan's parent until applied)
const planSync = readJson(PLAN_SYNC_FILE, {});
// Key in plan-sync.json. Issues in the plan's repo use just the number (legacy format)
const syncKey = (plan, n) => (n.repo && n.repo !== plan.repo ? `${n.repo}#${n.issue}` : String(n.issue));
// Key that identifies an issue across plans
const fullKey = (plan, n) => `${n.repo || plan.repo}#${n.issue}`;
// '+' for a parent not yet created, '' for top level
const parentKey = (plan, p) => (!p ? '' : p.issue ? syncKey(plan, p) : '+');
const relinked = (synced, plan, node, parent) => !!parent && `^${syncKey(plan, node)}` in synced && synced[`^${syncKey(plan, node)}`] !== parentKey(plan, parent);

function planFile(url, file) {
  if (!validFile(file)) throw E('planFileInvalid');
  return path.join(projectDir(url), file);
}

function listPlans(url) {
  const dir = projectDir(url);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(validFile).sort() : [];
  return {
    dir,
    plans: files.map((f) => {
      const full = path.join(dir, f);
      const text = fs.readFileSync(full, 'utf8');
      const plan = parsePlan(text);
      const all = flatten(plan.nodes);
      const nodes = all.map(({ node }) => node);
      return {
        file: f, title: plan.title || f, status: plan.status, count: all.length,
        issues: nodes.filter((n) => n.issue).map((n) => fullKey(plan, n)),
        // Used to filter plans by the UI's "Sprint · Period"
        sprints: [...new Set(nodes.map((n) => n.sprint).filter(Boolean))],
        spans: nodes.filter((n) => n.start || n.end).map((n) => [n.start || n.end, n.end || n.start]),
      };
    }),
  };
}

function planDoc(url, file) {
  const full = planFile(url, file);
  if (!fs.existsSync(full)) throw E('planNotFound');
  const md = fs.readFileSync(full, 'utf8');
  const plan = parsePlan(md);
  const dir = path.dirname(full);
  const tracked = inGit(dir);
  const base = tracked ? committedText(full) : null;
  const synced = planSync[full] || {};
  const changed = flatten(plan.nodes).filter(({ node, parent }) => {
    if (!node.issue) return false;
    const key = syncKey(plan, node);
    // "+key" = created, but not yet moved under its parent or added to the Project (retried on the next apply if it failed midway)
    return (synced[key] && synced[key] !== syncSnapshot(node)) || `+${key}` in synced || relinked(synced, plan, node, parent);
  }).map(({ node }) => syncKey(plan, node));
  // Fields changed both on GitHub and in the plan (excluding plan values synced to GitHub). key -> field -> GitHub value
  const conflicts = {};
  for (const { node } of flatten(plan.nodes)) {
    const c = node.issue && synced[`!${syncKey(plan, node)}`];
    if (!c) continue;
    const local = fieldsOf(node);
    const left = Object.fromEntries(Object.entries(c).filter(([f, v]) => !same(local[f], v)));
    if (Object.keys(left).length) conflicts[syncKey(plan, node)] = left;
  }
  const top = tracked && planGit(dir, ['rev-parse', '--show-toplevel'])?.trim();
  return { file, rel: top ? path.relative(top, full).split(path.sep).join('/') : full, plan, md, base, git: tracked, changed, conflicts };
}

function writePlan(url, file, plan) {
  const full = planFile(url, file);
  ensureDir(path.dirname(full));
  fs.writeFileSync(full, serializePlan({ ...plan, project: url }));
}

function createPlan(url, { file, title, repo }) {
  if (fs.existsSync(planFile(url, file))) throw E('planExists', { file });
  const name = title || file.replace(/\.md$/, '');
  // One plan = one top-level issue. Create it up front with the plan's name
  writePlan(url, file, { title: name, repo: repo || '', status: 'draft', nodes: [{ title: name, children: [] }] });
}

// Imported issues also get labels, milestone, and their parent on GitHub
// Body is not fetched (long text and images; key discussion is often in comments, so read it on GitHub)
const IMPORT_FIELDS = ISSUE_FIELDS.replace('id number title', 'id number title labels(first: 20) { nodes { name } } milestone { title } parent { number repository { nameWithOwner } }');

// Turn a GitHub issue and its sub issues into plan nodes (up to `levels` deep)
async function importTree(url, repo, number, levels) {
  if (!validRepo(repo) || !(number > 0)) throw E('planIssueNotFound');
  const meta = await projectMeta(url, false);
  const names = { sprint: meta.sprint || '-', start: meta.start || '-', end: meta.end || '-' };
  const [owner, name] = repo.split('/');
  const data = await ghqlPartial(`query($owner: String!, $name: String!, $number: Int!, $sprint: String!, $start: String!, $end: String!) {
    repository(owner: $owner, name: $name) { issue(number: $number) { ...iss } }
  }
  ${IMPORT_FIELDS}`, { owner, name, number, ...names });
  const raw = data.repository?.issue;
  if (!raw) throw E('planIssueNotFound');
  // Normalize title whitespace so writing to md and reading back gives the same value
  const toNode = (n) => {
    const item = n.projectItems.nodes.find((i) => i.project?.id === meta.id);
    return {
      gid: n.id, subCount: n.subIssues.totalCount,
      title: n.title.replace(/\s+/g, ' ').trim(), body: '',
      issue: n.number, repo: n.repository.nameWithOwner, start: item?.start?.date || null, end: item?.end?.date || null,
      assignees: n.assignees.nodes.map((a) => a.login), labels: n.labels.nodes.map((l) => l.name), milestone: n.milestone?.title || null, sprint: item?.sprint?.title || null, children: [],
    };
  };
  const root = toNode(raw);
  let frontier = [root];
  for (let level = 1; level < levels && frontier.length; level++) {
    const parents = frontier.filter((n) => n.subCount > 0);
    const chunks = [];
    for (let i = 0; i < parents.length; i += 30) chunks.push(parents.slice(i, i + 30));
    const results = await Promise.all(chunks.map((chunk) => ghql(`query($sprint: String!, $start: String!, $end: String!) {
        nodes(ids: ${JSON.stringify(chunk.map((n) => n.gid))}) { ... on Issue { id subIssues(first: 100) { nodes { ...iss } } } }
      }
      ${IMPORT_FIELDS}`, names)));
    const byId = new Map(parents.map((n) => [n.gid, n]));
    frontier = [];
    for (const data of results) {
      for (const p of data.nodes) {
        if (!p) continue;
        byId.get(p.id).children = p.subIssues.nodes.map(toNode);
        frontier.push(...byId.get(p.id).children);
      }
    }
  }
  return { root, parent: raw.parent ? { repo: raw.parent.repository.nameWithOwner, issue: raw.parent.number } : null };
}

// An issue belongs to only one plan (so two plans don't overwrite the same issue)
function checkTaken(url, root) {
  const owners = {};
  for (const p of listPlans(url).plans) for (const k of p.issues) owners[k] = p;
  const walk = (n) => {
    const hit = owners[`${n.repo}#${n.issue}`];
    if (hit) throw E('planIssueTaken', { number: n.issue, title: hit.title });
    n.children.forEach(walk);
  };
  walk(root);
}

// Record imported issues as matching GitHub (so untouched issues don't show as "changed")
function adoptTree(url, file, plan, { root, parent }) {
  const synced = (planSync[planFile(url, file)] ||= {});
  const walk = (n, pkey) => {
    delete n.gid;
    delete n.subCount;
    if (n.repo === plan.repo) n.repo = null;
    const key = syncKey(plan, n);
    synced[key] = syncSnapshot(n);
    synced[`^${key}`] = pkey;
    n.children.forEach((c) => walk(c, key));
  };
  walk(root, parent ? syncKey(plan, parent) : '');
  writeJson(PLAN_SYNC_FILE, planSync);
  return root;
}

async function createPlanFromIssue(url, { file, repo, number }) {
  if (fs.existsSync(planFile(url, file))) throw E('planExists', { file });
  const tree = await importTree(url, repo, number, MAX_DEPTH);
  checkTaken(url, tree.root);
  const plan = { title: tree.root.title, repo, status: 'applied', nodes: [] };
  plan.nodes.push(adoptTree(url, file, plan, tree));
  writePlan(url, file, plan);
}

// Fetch issues for level `level` (1-based) of the plan. They're written to md when saved from the UI
async function importIssue(url, file, { repo, number, level }) {
  const { plan } = planDoc(url, file);
  const tree = await importTree(url, repo, number, Math.max(1, MAX_DEPTH - (Number(level) || 1) + 1));
  checkTaken(url, tree.root);
  return adoptTree(url, file, plan, tree);
}

// Issue fields used for comparing and importing (includes sub issue numbers)
const PULL_QUERY_FIELDS = IMPORT_FIELDS.replace('id number title', 'id number title subs: subIssues(first: 50) { nodes { number repository { nameWithOwner } } }');

// Read the plan's issues from GitHub. key (owner/name#number) -> issue
async function remoteIssues(url, plan, nodes) {
  const meta = await projectMeta(url, false);
  const names = { sprint: meta.sprint || '-', start: meta.start || '-', end: meta.end || '-' };
  const byRepo = {};
  for (const n of nodes) (byRepo[n.repo || plan.repo] ||= new Set()).add(n.issue);
  const repos = Object.keys(byRepo).filter(validRepo);
  if (!repos.length) return { meta, issues: {} };
  const { data, failed, message } = await ghqlResult(`query($sprint: String!, $start: String!, $end: String!) { ${repos.map((r, i) => {
    const [owner, name] = r.split('/');
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${[...byRepo[r]].map((num) => `i${num}: issue(number: ${num}) { ...iss }`).join(' ')} }`;
  }).join('\n')} }
  ${PULL_QUERY_FIELDS}`, names);
  const issues = {};
  repos.forEach((r, i) => {
    for (const num of byRepo[r]) {
      const n = data[`r${i}`]?.[`i${num}`];
      if (n) issues[`${r}#${num}`] = n;
    }
  });
  return { meta, issues, failed, message };
}

// Convert GitHub values to plan fields. If sprint/start/end can't be read from the Project (issue not in it, no field), keep the plan's values
function remoteFields(n, meta, base) {
  const item = n.projectItems.nodes.find((i) => i.project?.id === meta.id);
  const f = {
    title: n.title.replace(/\s+/g, ' ').trim(), assignees: n.assignees.nodes.map((a) => a.login).sort(), labels: n.labels.nodes.map((l) => l.name).sort(),
    milestone: n.milestone?.title || null, sprint: item?.sprint?.title || null, start: item?.start?.date || null, end: item?.end?.date || null,
  };
  for (const k of ['sprint', 'start', 'end']) if (!item || !meta[k]) f[k] = base[k];
  return f;
}

// Project field values of an item, by field name (text, number, date, option name or iteration title)
const itemValues = (item) => Object.fromEntries((item?.values?.nodes || []).filter((v) => v?.field?.name)
  .map((v) => [v.field.name, v.text ?? v.number ?? v.date ?? v.name ?? v.title ?? null]).filter(([, v]) => v !== null));

const liveOf = (n, meta) => {
  const it = normIssue(n, meta.id);
  return { fields: itemValues(n.projectItems.nodes.find((i) => i.project?.id === meta.id)), state: it.state, status: it.status?.name || null, color: it.status?.color || null, prs: it.prs.map((pr) => ({ number: pr.number, url: pr.url, kind: pr.state === 'MERGED' ? 'merged' : pr.isDraft ? 'draft' : 'open' })) };
};

// Import values changed on GitHub into the plan. Fields also changed in the plan are recorded as conflicts; the UI picks which wins
// Sub issues added on GitHub to plan issues are added to the plan too, unless they're in another plan
// Read and write back each plan md one file at a time (so saving during import, or importing during apply, doesn't write stale content)
const planLocks = new Map();
function withPlanLock(url, file, fn) {
  const key = `${url}\n${file}`;
  const run = (planLocks.get(key) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  planLocks.set(key, tail);
  tail.then(() => { if (planLocks.get(key) === tail) planLocks.delete(key); });
  return run;
}

function pullPlan(url, file, meta, issues) {
  return withPlanLock(url, file, () => pullPlanNow(url, file, meta, issues));
}

async function pullPlanNow(url, file, meta, issues) {
  const full = planFile(url, file);
  const { plan } = planDoc(url, file);
  const synced = (planSync[full] ||= {});
  const owners = new Set(listPlans(url).plans.flatMap((p) => p.issues));
  let updated = 0;
  let added = 0;
  let conflicted = 0;
  const walk = async (nodes, level) => {
    for (const node of nodes) {
      const raw = node.issue && issues[fullKey(plan, node)];
      if (raw) {
        const key = syncKey(plan, node);
        const local = fieldsOf(node);
        // No record (older plans): match GitHub's values
        const base = synced[key] ? snapshotFields(synced[key]) : local;
        const remote = remoteFields(raw, meta, base);
        const { take, conflicts } = mergeRemote(local, base, remote, synced[`!${key}`]);
        if (Object.keys(take).length) { Object.assign(node, take); updated++; }
        synced[key] = syncSnapshot({ ...remote, body: node.body });
        if (Object.keys(conflicts).length) { synced[`!${key}`] = conflicts; conflicted++; } else delete synced[`!${key}`];
        for (const c of raw.subs.nodes) {
          const ckey = `${c.repository.nameWithOwner}#${c.number}`;
          if (owners.has(ckey) || level >= MAX_DEPTH) continue;
          const tree = await importTree(url, c.repository.nameWithOwner, c.number, MAX_DEPTH - level);
          node.children.push(adoptTree(url, file, plan, { root: tree.root, parent: { repo: node.repo || plan.repo, issue: node.issue } }));
          const mark = (x) => { owners.add(`${x.repo || plan.repo}#${x.issue}`); x.children.forEach(mark); };
          mark(node.children.at(-1));
          added++;
        }
      }
      await walk(node.children, level + 1);
    }
  };
  await walk(plan.nodes, 1);
  if (updated || added) writePlan(url, file, plan);
  writeJson(PLAN_SYNC_FILE, planSync);
  return { updated, added, conflicts: conflicted };
}

// Current state of plan issues (Status, open/closed, PRs). Used for filtering and display
// When reread from GitHub (no cache, or ↻), also import changed values (not from a stale cache, which would revert applied values)
async function planLive(url, file, refresh) {
  const { plan } = planDoc(url, file);
  const nodes = flatten(plan.nodes).map(({ node }) => node).filter((n) => n.issue);
  if (!nodes.length) return { issues: {}, fetchedAt: null };
  const keys = nodes.map((n) => fullKey(plan, n)).sort();
  let pulled = null;
  const live = await cached(`plan-live:v2:${url}:${keys.join(',')}`, refresh, async () => {
    const { meta, issues, failed } = await remoteIssues(url, plan, nodes);
    pulled = await pullPlan(url, file, meta, issues);
    // Don't cache if anything was unreadable (cached checks partial and skips saving)
    return { issues: Object.fromEntries(Object.entries(issues).map(([k, n]) => [k, liveOf(n, meta)])), fetchedAt: Date.now(), ...(failed && { partial: true }) };
  });
  return { ...live, pulled };
}

// Save the Project fields the roadmap uses. Each must exist with the right type (or be null for "not used")
async function saveFieldChoice(url, body) {
  const meta = await projectMeta(url, true);
  const choice = {};
  for (const [k, type] of [['start', 'DATE'], ['end', 'DATE'], ['sprint', 'ITERATION']]) {
    const name = body?.[k] || null;
    if (name !== null && !meta.fields.some((f) => f.name === name && f.type === type)) throw E('planFieldInvalid', { name: String(name) });
    choice[k] = name;
  }
  const before = fieldChoice(url) || {};
  config = { ...config, projectFields: { ...config.projectFields, [url]: choice } };
  writeJson(CONFIG_FILE, config);
  unsyncFields(url, ['sprint', 'start', 'end'].filter((k) => (before[k] || null) !== choice[k]));
  for (const prefix of [`meta:v3:${url}:`, `plan-live:v2:${url}:`]) dropCached(prefix);
}

// A newly linked field has no synced value yet: clear it from the last-synced snapshots, so plan values show as
// changes to push (instead of an empty GitHub value overwriting them), and a value already on GitHub shows as a conflict
function unsyncFields(url, keys) {
  if (!keys.length) return;
  for (const { file } of listPlans(url).plans) {
    const synced = planSync[planFile(url, file)];
    if (synced) clearSynced(synced, keys);
  }
  writeJson(PLAN_SYNC_FILE, planSync);
}

// In one plan's sync record: null those fields in each snapshot (plain keys) and drop them from conflicts ("!" keys)
function clearSynced(synced, keys) {
  const at = { sprint: 5, start: 6, end: 7 };
  for (const [k, v] of Object.entries(synced)) {
    if (k[0] === '!') keys.forEach((f) => delete v[f]);
    else if (!'+^'.includes(k[0])) {
      const snap = JSON.parse(v);
      keys.forEach((f) => (snap[at[f]] = null));
      synced[k] = JSON.stringify(snap);
    }
  }
  return synced;
}

// Options for "Sprint · Period" (counts follow the configured past/future sprint and period counts)
async function planRanges(url, refresh) {
  const meta = await projectMeta(url, refresh).catch(() => null);
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const { unit, ...range } = periodRange();
  // chosen: whether the user has picked the date and sprint fields for this project (the roadmap asks first if not)
  const choice = { start: meta?.start || null, end: meta?.end || null, sprint: meta?.sprint || null };
  return { unit, title: meta?.title || null, readable: !!meta, chosen: !!fieldChoice(url), choice, fields: meta?.fields || [], statuses: meta?.statuses || [], sprints: (meta?.iterations || []).map(({ id, title, startDate, endDate }) => ({ id, title, startDate, endDate })), periods: periodWindows(today, unit, range) };
}

// One GraphQL request that sets or clears several Project fields of one item. ops: { field, v, type, key } to set, { field } to clear
function fieldMutation(project, item, ops) {
  const vars = { project, item };
  const parts = ops.map((op, i) => {
    vars[`f${i}`] = op.field.id;
    if (!op.key) return `c${i}: clearProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $f${i} }) { clientMutationId }`;
    vars[`v${i}`] = op.v;
    return `s${i}: updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $f${i}, value: { ${op.key}: $v${i} } }) { clientMutationId }`;
  });
  const params = ops.map((op, i) => `$f${i}: ID!${op.key ? `, $v${i}: ${op.type}!` : ''}`).join(', ');
  return [`mutation($project: ID!, $item: ID!, ${params}) { ${parts.join(' ')} }`, vars];
}

// Project fields for start date, end date, and sprint (chosen the same way as the roadmap)
async function projectFields(url, refresh = false) {
  const m = await projectMeta(url, refresh);
  const ref = (name) => name && { id: m.fieldIds[name], name };
  // repos: candidates for a new plan (repos linked to the project)
  return { id: m.id, title: m.title, start: ref(m.start), end: ref(m.end), sprint: ref(m.sprint), repos: m.repos, iterations: m.openIterations };
}

// Segments made only of dots (. / ..) would walk out of repos/ in API paths
const validRepo = (repo) => /^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/.test(repo || '');

// Candidates for assignees, labels, and milestones
async function repoOptions(repo, refresh = false) {
  if (!validRepo(repo)) return { assignees: [], labels: [], milestones: [] };
  const [owner, name] = repo.split('/');
  return cached(`plan-repo:v2:${repo}`, refresh, async () => {
    // The three lists share each request and page together, so a repo needs as many requests as its longest list has pages
    const lists = {
      assignees: { conn: 'assignableUsers', fields: 'login avatarUrl' },
      labels: { conn: 'labels', fields: 'name color' },
      milestones: { conn: 'milestones', args: 'states: OPEN, ', fields: 'title number' },
    };
    const out = { assignees: [], labels: [], milestones: [] };
    let todo = Object.keys(lists).map((k) => [k, null]);
    let partial = false;
    while (todo.length) {
      const body = todo.map(([k, after]) => `${k}: ${lists[k].conn}(${lists[k].args || ''}first: 100${after ? `, after: ${JSON.stringify(after)}` : ''}) { nodes { ${lists[k].fields} } pageInfo { hasNextPage endCursor } }`).join('\n');
      const { data, failed } = await ghqlResult(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${body} } }`, { owner, name }).catch(() => ({ data: {}, failed: true }));
      const r = data.repository;
      if (failed || !r) { partial = true; break; }
      for (const [k] of todo) out[k].push(...r[k].nodes);
      todo = todo.filter(([k]) => r[k].pageInfo.hasNextPage).map(([k]) => [k, r[k].pageInfo.endCursor]);
    }
    return {
      assignees: out.assignees.map((a) => ({ login: a.login, avatarUrl: a.avatarUrl })),
      labels: out.labels.map((l) => ({ name: l.name, color: l.color })),
      milestones: out.milestones.map((m) => ({ title: m.title, number: m.number })),
      ...(partial && { partial }),
    };
  });
}

// Pass a JSON body to gh api via stdin (sends values -f can't express, e.g. an empty array to clear assignees)
function ghRest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const child = execFile('gh', ['api', '-X', method, endpoint, '--input', '-'], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout ? JSON.parse(stdout) : null);
    });
    child.stdin.end(JSON.stringify(body || {}));
  });
}

const planApplying = new Set();

// Issues to create (no number) and issues changed since the last apply
function applyTargets(doc) {
  const changed = new Set(doc.changed);
  return flatten(doc.plan.nodes).filter(({ node }) => !node.issue || changed.has(syncKey(doc.plan, node)));
}

// Create issues parent first (write the number to md right away so a midway failure doesn't create duplicates); children become sub issues of the parent
// Issues moved from under another issue are re-parented under the plan's parent
// With addToProject, add to the Project and set start/end dates and sprint
async function applyPlan(url, file, { addToProject = true, commit = false } = {}) {
  const doc = planDoc(url, file);
  const full = planFile(url, file);
  const { plan } = doc;
  const repo = plan.repo;
  if (!validRepo(repo)) throw E('planRepoMissing');
  const optsOf = {};
  const fields = addToProject ? await projectFields(url) : null;
  const synced = (planSync[full] ||= {});
  // If an issue changed on GitHub since the last sync, stop instead of overwriting (import it with ↻ first)
  const existing = applyTargets(doc).map(({ node }) => node).filter((n) => n.issue && synced[syncKey(plan, n)]);
  if (existing.length) {
    const { meta, issues, failed, message } = await remoteIssues(url, plan, existing);
    // Treating unreadable issues as "unchanged on GitHub" would overwrite changes made there
    if (failed) throw E('planReadFailed', { message });
    for (const n of existing) {
      const raw = issues[fullKey(plan, n)];
      const base = snapshotFields(synced[syncKey(plan, n)]);
      if (raw && !same(remoteFields(raw, meta, base), base)) throw E('planStale', { title: n.title });
    }
  }
  const warnings = [];
  let created = 0;
  let updated = 0;
  const save = () => {
    writePlan(url, file, plan);
    writeJson(PLAN_SYNC_FILE, planSync);
  };
  for (const { node, parent } of applyTargets(doc)) {
    const nodeRepo = node.repo || repo;
    const opts = await (optsOf[nodeRepo] ||= repoOptions(nodeRepo));
    const relink = !!node.issue && relinked(synced, plan, node, parent);
    const milestone = node.milestone ? opts.milestones.find((m) => m.title === node.milestone) : null;
    if (node.milestone && !milestone) warnings.push(E('planMilestoneMissing', { title: node.title, milestone: node.milestone }));
    const body = { title: node.title, assignees: node.assignees, labels: node.labels, milestone: milestone ? milestone.number : null };
    // Don't clear GitHub's value with a milestone not in the candidates (closed or not fetched)
    if (node.milestone && !milestone) delete body.milestone;
    // For applied issues, send only fields changed in the plan (assignees/labels are only partly read from GitHub, so sending all would drop the rest)
    const snap = node.issue && synced[syncKey(plan, node)];
    if (snap) {
      const base = snapshotFields(snap);
      const local = fieldsOf(node);
      for (const f of ['title', 'assignees', 'labels', 'milestone']) if (same(local[f], base[f])) delete body[f];
    }
    // Body is written only on create. Existing issue bodies are edited on GitHub, never overwritten from the plan
    if (!node.issue) body.body = node.body || '';
    const isNew = !node.issue;
    // Issue that stopped right after creation last time. Attach to the parent as on create, and keep Project values
    const fresh = isNew || `+${syncKey(plan, node)}` in synced;
    let issue;
    if (isNew) {
      issue = await ghRest('POST', `repos/${nodeRepo}/issues`, body);
      node.issue = issue.number;
      plan.status = 'applied';
      synced[`+${syncKey(plan, node)}`] = true;
      created++;
      save();
    } else {
      issue = await ghRest('PATCH', `repos/${nodeRepo}/issues/${node.issue}`, body);
      updated++;
    }
    if (parent?.issue && (fresh || relink)) await ghRest('POST', `repos/${parent.repo || repo}/issues/${parent.issue}/sub_issues`, { sub_issue_id: issue.id, replace_parent: true });
    if (fields) {
      const { addProjectV2ItemById: { item } } = await ghql('mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }', { project: fields.id, content: issue.node_id });
      // Dates and iteration are set (or cleared) in one request
      const ops = [];
      const set = (field, v, type, key) => ops.push({ field, v, type, key });
      const clear = (field) => ops.push({ field });
      // For applied issues, values removed in the plan are removed from the Project too
      for (const k of ['start', 'end']) {
        if (!fields[k]) continue;
        if (node[k]) set(fields[k], node[k], 'Date', 'date');
        else if (!fresh) clear(fields[k]);
      }
      if (node.sprint) {
        const it = fields.sprint && fields.iterations.find((i) => i.title === node.sprint);
        if (it) set(fields.sprint, it.id, 'String', 'iterationId');
        else warnings.push(E('planSprintMissing', { title: node.title, sprint: node.sprint }));
      } else if (fields.sprint && !fresh) clear(fields.sprint);
      if (ops.length) await ghql(...fieldMutation(fields.id, item.id, ops));
    }
    synced[syncKey(plan, node)] = syncSnapshot(node);
    delete synced[`!${syncKey(plan, node)}`];
    delete synced[`+${syncKey(plan, node)}`];
    if (parent) synced[`^${syncKey(plan, node)}`] = parentKey(plan, parent);
    save();
  }
  let committed = false;
  if (commit && doc.git) {
    const cwd = path.dirname(full);
    const name = path.basename(full);
    committed = planGit(cwd, ['add', '--', name]) !== null && planGit(cwd, ['commit', '-q', '-m', `Apply plan "${plan.title || name}" to GitHub`, '--', name]) !== null;
  }
  // Drop the cache so stale values don't revert what was just applied
  dropCached(`plan-live:v2:${url}:`);
  return { created, updated, committed, warnings, doc: planDoc(url, file) };
}

// Accept only known settings, and only with the same type as the default (so wrong types don't crash later)
function sanitizeConfig(body) {
  const kind = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
  // Consent is recorded only via /api/consent
  return Object.fromEntries(Object.entries(body || {}).filter(([k, v]) => k in DEFAULT_CONFIG && k !== 'consentVersion' && k !== 'projectFields' && kind(v) === kind(DEFAULT_CONFIG[k]) && !(typeof v === 'number' && !Number.isFinite(v))));
}

// Reset values under 1 minute to the default so 0 or empty doesn't keep hitting GitHub
// setInterval turns delays over 2^31 ms (~24.8 days) into 1 ms, so cap at 1 day
function pollIntervalMs(minutes) {
  const m = Number(minutes);
  return Math.min(m >= 1 ? m : DEFAULT_CONFIG.pollMinutes, 24 * 60) * 60 * 1000;
}

// Clearing the field gives 0 and the queue would never run again, so reset to the default
function concurrencyLimit(n) {
  return Math.max(1, Math.floor(Number(n)) || DEFAULT_CONFIG.maxConcurrent);
}

// start > end means a window crossing midnight (e.g. 22-6)
function inPollHours(date, start, end) {
  const h = date.getHours(), s = Number(start), e = Number(end);
  if (s === e) return true;
  return s < e ? h >= s && h < e : h >= s || h < e;
}

let pollTimer = null;
// Nothing on the server acts on new pull requests by itself, so polling only matters while someone has the page
// open (it asks for /api/board every few seconds). A page opened after a skipped poll fetches right away
let lastViewAt = 0;
const VIEW_IDLE_MS = 2 * 60 * 1000;
const viewing = (now) => now - lastViewAt < VIEW_IDLE_MS;
function schedulePoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!inPollHours(new Date(), config.pollStartHour, config.pollEndHour) || !viewing(Date.now())) return;
    refreshFromGitHub().catch((e) => { state.fetchError = e.message; });
  }, pollIntervalMs(config.pollMinutes));
}

// ---------- claude runs ----------

const queue = [];
let running = 0;
// Fixes on my PRs switch branches in the same clone, so run one per repo at a time
const busyRepos = new Set();

// Read a claude result written to stdout/stderr files. Merge them into .log and delete the originals
function readRun(dir, logName, code) {
  const base = path.join(dir, logName);
  let stdout;
  let stderr;
  try {
    stdout = fs.readFileSync(`${base}.out`, 'utf8');
    stderr = fs.readFileSync(`${base}.err`, 'utf8');
    // Called inside the close handler; throwing here takes down the whole server
    fs.writeFileSync(`${base}.log`, `exit=${code}\n--- stdout\n${stdout}\n--- stderr\n${stderr}`, { mode: 0o600 });
    fs.rmSync(`${base}.out`, { force: true });
    fs.rmSync(`${base}.err`, { force: true });
  } catch (e) {
    return { ok: false, error: E('claudeReadFailed', { message: e.message }) };
  }
  // stream-json is one event per line; the final result event holds the result
  const parsed = parseLines(stdout).findLast((ev) => ev.type === 'result');
  if (!parsed) return { ok: false, error: E('claudeParseFailed', { code, stderr: stderr.slice(-500) }) };
  // structured: the JSON of a run given --json-schema, validated by claude
  return { ok: code === 0 && !parsed.is_error, result: parsed.result || '', structured: parsed.structured_output ?? null, sessionId: parsed.session_id, usage: usageOf(parsed), error: parsed.is_error ? parsed.result : null };
}

// Configured retention days. Reset under 1 day to the default so empty or 0 doesn't make auto-cleanup delete everything
const logKeepMs = (days) => (Number(days) >= 1 ? Number(days) : DEFAULT_CONFIG.logKeepDays) * 24 * 60 * 60 * 1000;

// Start claude in its own process group writing output to files, so a server restart neither stops it nor loses its result
// ws: the run's workspace from withWorkspace. Claude runs in ws.cwd; it reaches GitHub only through the gatekeeper
// readOnly: review / self-review / fix plan, which edit no files. mode: 'compose' for the text of a post
// One gateway for every run, started the first time a run needs it
let browserGateway = null;
function browserEndpoint() {
  browserGateway = browserGateway || startGateway({ home: DOCKET_HOME, denyRead: deniedPaths(DATA_DIR) }).catch((e) => {
    browserGateway = null;
    throw e;
  });
  return browserGateway.then((g) => g.endpoint);
}

function runAgent(prompt, opts) {
  // A run without the browser it was promised still runs, and is told browsers can't start
  const browser = config.runBrowser === true && opts.ws.gitDir ? browserEndpoint().catch((e) => (console.error(`browser gateway: ${e.message}`), null)) : Promise.resolve(null);
  return browser.then((endpoint) => startAgent(prompt, { ...opts, browser: endpoint }));
}

function startAgent(prompt, { key, ws, resume, logName, lang = config.outputLang, readOnly = false, pr, mode: forced, browser }) {
  return new Promise((resolve) => {
    // Throwing (e.g. log file can't be opened) would leave the caller's card stuck running, so return a failure
    // If it throws after starting (e.g. saving state fails), claude is running, so return the result on close
    let child;
    try {
      const model = modelOptions(config);
      // Only fix runs may edit skills, and only when turned on: review and post runs read other people's PRs
      const mode = forced || (readOnly ? 'read' : 'apply');
      // Runs in a worktree are told what it lacks and where the user's clone is (a post's text needs no folder)
      const instruction = withOutputLang(ws.gitDir ? `${prompt}\n\n${workspaceNote(ws, pr, { browser: Boolean(browser) })}` : prompt, lang);
      const args = ['-p', instruction, '--output-format', 'stream-json', '--verbose', ...model.args, ...(mode === 'apply' && config.skillEdits ? permissionArgs(ws.cwd) : []), ...claudeArgs(mode, ws, config, pr?.repo)];
      if (resume) args.push('--resume', resume);
      fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
      const base = path.join(LOG_DIR, logName);
      const out = fs.openSync(`${base}.out`, 'w', 0o600);
      const err = fs.openSync(`${base}.err`, 'w', 0o600);
      child = spawn('claude', args, { cwd: ws.cwd, env: { ...agentEnv(process.env, { extra: runEnv(config.runEnv) }), CLAUDE_CODE_TMPDIR: runTmpOf(ws), ...(browser && { PW_TEST_CONNECT_WS_ENDPOINT: browser }), ...model.env }, detached: true, stdio: ['ignore', out, err] });
      fs.closeSync(out);
      fs.closeSync(err);
      child.on('error', (e) => resolve({ ok: false, error: e.message }));
      const seen = {};
      const reaper = setInterval(() => reapLeftovers(child.pid, `${base}.out`, seen), 10 * 1000);
      child.on('close', (code) => {
        clearInterval(reaper);
        reapWorktree(ws.gitDir && ws.cwd);
        const result = readRun(LOG_DIR, logName, code);
        resolve({ ...result, sessionId: result.sessionId || resume });
      });
      // lastLog: kept so the log stays viewable after the run (tag re-output is extra, so keep the main run's log)
      if (child.pid && key) updateEntry(key, { run: { pid: child.pid, logName, cwd: ws.cwd, workdir: ws.workdir, clone: ws.clone, headSha: ws.headSha }, ...(!logName.endsWith('-retag') && { lastLog: logName }) });
    } catch (e) {
      if (!child) resolve({ ok: false, error: e.message });
    }
  });
}

// claude -p's result is only the last message, so if the answer continues (e.g. subagent completion notices)
// the earlier tag is lost. Then resume the same session once and have it output the tag again
// opts.cancelled: don't resume if cancelled during the first run
async function runForTag(tag, prompt, opts, run = runAgent) {
  const res = await run(prompt, opts);
  if (!res.ok || !res.sessionId || extractTagJson(res.result, tag) || opts.cancelled?.()) return res;
  const retry = await run(`Output the <${tag}> block you wrote earlier once more, unchanged. If you have not written it yet, write it in the format given in the instructions.`, {
    ...opts,
    resume: res.sessionId,
    logName: `${opts.logName}-retag`,
  });
  const usage = addUsage(res.usage, retry.usage);
  if (!retry.ok) return { ...res, usage };
  return { ...res, usage, sessionId: retry.sessionId || res.sessionId, result: `${res.result}\n\n${retry.result}` };
}

// The folder a repository's runs start from: its own working directory, else the shared one
const repoCwd = (repo) => repoTool(config.repos[repo]).cwd || config.workdir;
// The last line of a command's error (gh prints the reason last)
const lastLine = (text) => text.trim().split('\n').pop();

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
    // Even if saving the result throws, don't crash the server with an unhandled rejection
    job.run().catch((e) => console.error(e)).finally(() => {
      running--;
      busyRepos.delete(job.repo);
      pump();
    });
  }
}

// When retried after cancel, use runId so the old run's result doesn't overwrite the new run's state
function finishReview(key, cwd, res, runId) {
  const stale = runId && state.prs[key]?.runId !== runId;
  // Count tokens used even on cancel or failure
  updateEntry(key, { ...(!stale && { run: null }), usage: addUsage(state.prs[key]?.usage, res.usage) });
  // Discard the result if cancelled
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
    unverified: normalizeUnverified(parsed?.unverified),
    // findings must be an array to post, so show the output as a parse failure otherwise
    error: findings ? null : E('findingsParseFailed'),
    reviewedAt: Date.now(),
  });
}

// res: { ok, posted, url, error, result (the compose run's output), usage }
function finishPost(key, res) {
  updateEntry(key, { run: null, usage: addUsage(state.prs[key]?.usage, res.usage) });
  if (!res.posted) return updateEntry(key, { status: 'reviewed', error: res.error || E('postUnknown'), postRaw: res.result || null });
  // PRs posted after a skip and re-review also return to requested once the author responds
  updateEntry(key, { status: 'commented', commentedAt: Date.now(), postedUrl: res.url || null, postRaw: res.result || null, skipped: false });
}

function enqueueReview(key) {
  const entry = state.prs[key];
  const mapping = repoTool(config.repos[entry.pr.repo]);
  const cwd = repoCwd(entry.pr.repo);
  const runId = newRunId();
  const prompt = buildReviewPrompt(entry.pr, mapping, sharedPrompt(config, 'reviewPrompt'));
  updateEntry(key, { status: 'queued', runId, error: null, findings: null, summary: null, raw: null, decisions: {}, unverified: null, setupSuggestion: null });
  queue.push({ key, run: async () => {
    updateEntry(key, { status: 'reviewing', startedAt: Date.now() });
    finishReview(key, cwd, await withWorkspace(entry.pr, cwd, (ws) => runForTag('docket-findings', prompt, { key, ws, pr: entry.pr, readOnly: true, logName: logName(key, 'review'), cancelled: () => state.prs[key]?.runId !== runId || state.prs[key]?.status !== 'reviewing' })), runId);
  } });
  pump();
}

// A setup command for what the last review of key could not check (see buildSetupPrompt). Not tied to the card's
// run: the card keeps its result while this runs, and reviews of it wait (see the API)
function enqueueSetupSuggestion(key) {
  const entry = mapOf(key)[key];
  const mapping = repoTool(config.repos[entry.pr.repo]);
  const current = mapping.setup || '';
  updateEntry(key, { setupSuggestion: { status: 'queued', current } });
  queue.push({ key, run: async () => {
    updateEntry(key, { setupSuggestion: { status: 'running', current } });
    const res = await withWorkspace(entry.pr, repoCwd(entry.pr.repo), (ws) => runForTag('docket-setup', buildSetupPrompt(entry.pr, current, entry.unverified || []), { key: null, ws, pr: entry.pr, readOnly: true, logName: logName(key, 'setup') }));
    updateEntry(key, { usage: addUsage(mapOf(key)[key]?.usage, res.usage), setupSuggestion: setupSuggestionOf(res, current) });
  } });
  pump();
}

// The answer of a setup suggestion run. setup: one line, or null when no setup command fixes it
function setupSuggestionOf(res, current) {
  if (!res.ok) return { status: 'failed', current, error: res.error || E('runFailed') };
  const parsed = extractTagJson(res.result, 'docket-setup');
  const setup = typeof parsed?.setup === 'string' && parsed.setup.trim() ? parsed.setup.trim() : null;
  if (!parsed || (setup && (/[\r\n]/.test(setup) || setup.length > 4000))) return { status: 'failed', current, error: E('resultParseFailed') };
  return { status: 'done', current, setup: setup === current ? null : setup, reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 2000) : '' };
}

// Wait for claude started by the previous server process to exit and collect its result
function recoverRun(run, finish, repo) {
  running++;
  if (repo) busyRepos.add(repo);
  waitForExit(run.pid)
    // Exit code is unavailable, but the result event comes last, so a parseable result counts as success
    .then(() => readRun(LOG_DIR, run.logName, 0))
    .then(finish)
    .catch((e) => console.error(e))
    .finally(() => {
      running--;
      busyRepos.delete(repo);
      pump();
    });
}

// Drops a queued job or stops its claude, and puts the card back to status. Stopping posts and fixes (push,
// replies) midway can leave them partly done, so only reviews, plans and self-reviews are cancelled (see the API)
function cancelRun(key, status) {
  const i = queue.findIndex((job) => job.key === key);
  if (i >= 0) queue.splice(i, 1);
  const pid = mapOf(key)[key]?.run?.pid;
  if (pid && isAgentRun(pid)) killRun(pid);
  updateEntry(key, { status, error: null });
}

// An AI run with no tools writes the text; docket-gits posts it with the user's gh login
function enqueuePost(key, decisions, approve, humanRead) {
  const entry = state.prs[key];
  updateEntry(key, { status: 'posting', error: null, decisions, approve, humanRead });
  queue.push({ key, run: async () => {
    const items = postable(entry.findings, decisions);
    let res = { ok: true, result: null, usage: null };
    let text = { body: '', comments: [] };
    if (items.length || entry.summary?.trim()) {
      const prompt = buildComposePrompt(entry.pr, items, decisions, config.disagreeIcon.trim() || DEFAULT_CONFIG.disagreeIcon, entry.summary);
      res = await withWorkspace(entry.pr, entry.cwd || repoCwd(entry.pr.repo),
        (ws) => runAgent(prompt, { key, ws, pr: entry.pr, mode: 'compose', logName: logName(key, 'post'), lang: postLang(entry.pr.author?.login, config) }), false);
      text = res.ok && res.structured && typeof res.structured === 'object' ? res.structured : null;
      if (!text) return finishPost(key, { ...res, error: res.error || E('postTextMissing') });
    }
    const review = reviewPayload(items, decisions, text, { approve, humanRead });
    try {
      finishPost(key, { ...res, posted: true, url: review ? await postReview(entry.pr, review, entry.reviewedAt || 0) : null });
    } catch (e) {
      finishPost(key, { ...res, error: E('postFailed', { message: lastLine(e.message) }) });
    }
  } });
  pump();
}

// ---------- My PRs (receiving reviews) ----------

function finishMine(key, cwd, res, runId) {
  const stale = runId && state.mine[key]?.runId !== runId;
  updateEntry(key, { ...(!stale && { run: null }), usage: addUsage(state.mine[key]?.usage, res.usage) });
  const entry = state.mine[key];
  // Discard the result if cancelled
  if (stale || entry?.status !== 'running') return;
  if (!res.ok) return updateEntry(key, { status: 'idle', error: res.error || E('runFailed') });
  const parsed = extractTagJson(res.result, entry.mode === 'self' ? 'docket-findings' : 'docket-fix-plan');
  // Include the reasons from the pre-judgment as input for rebut
  // If items isn't an array, map throws and the card stays stuck running
  const items = entry.mode === 'self' ? parsed?.findings : Array.isArray(parsed?.items) ? parsed.items.filter((i) => i && typeof i === 'object').map((i) => ({ ...i, ownReason: entry.triage?.find((t) => String(t.no) === String(i.no))?.reason || null })) : null;
  updateEntry(key, {
    status: 'planned',
    sessionId: res.sessionId,
    cwd,
    raw: res.result,
    summary: parsed?.summary || null,
    findings: normalizeNos(items),
    unverified: entry.mode === 'self' ? normalizeUnverified(parsed?.unverified) : [],
    error: normalizeNos(items) ? null : E('resultParseFailed'),
  });
}

const resultFile = (key) => path.join(RESULTS_DIR, `${key.replace(/[^\w.-]+/g, '_')}.json`);
// The result for the board: without the clone's path
const resultView = ({ clone, ...r }) => r;

// Reads what a fix run handed back (its answer and its commits in the clone)
async function collectApply(res, run, pr) {
  if (!res.ok) return res;
  try {
    return { ...res, collected: { ...(await collectResult(res.structured, { pr, clone: run.clone, headSha: run.headSha, git })), clone: run.clone } };
  } catch (e) {
    return { ...res, ok: false, error: E('applyResultInvalid', { message: e.message }) };
  }
}

// A fix run's result waits for the user (status ready); nothing is published yet
function finishApply(key, res) {
  updateEntry(key, { run: null, usage: addUsage(state.mine[key]?.usage, res.usage) });
  if (!res.ok || !res.collected) return updateEntry(key, { status: 'planned', error: res.error || E('applyUnknown'), applyRaw: res.result || null });
  writeJson(resultFile(key), res.collected);
  updateEntry(key, { status: 'ready', error: null, applyRaw: res.result || null, result: resultView(res.collected), publishProgress: {} });
}

// Publishes a checked result with the user's gh login: patches applied in a clean clone and pushed, then issues,
// Draft pull requests, the self-review and replies. Progress is kept, so a retry after a failure does only the rest
function enqueuePublish(key) {
  const entry = state.mine[key];
  updateEntry(key, { status: 'publishing', error: null });
  queue.push({ key, repo: entry.pr.repo, run: async () => {
    try {
      const result = JSON.parse(fs.readFileSync(resultFile(key), 'utf8'));
      const progress = await publish(entry.pr, result, { ...(state.mine[key].publishProgress || {}) }, {
        clone: result.clone,
        git,
        rest: ghRest,
        read: (endpoint) => gh(['api', endpoint]).then(JSON.parse),
        findings: entry.findings,
        save: (p) => updateEntry(key, { publishProgress: p }),
      });
      fs.rmSync(resultFile(key), { force: true });
      updateEntry(key, { status: 'idle', error: null, findings: null, summary: null, raw: null, sessionId: null, result: null, publishProgress: null, published: progress, appliedAt: Date.now() });
    } catch (e) {
      updateEntry(key, { status: 'ready', error: E('publishFailed', { message: lastLine(e.message) }) });
    }
  } });
  pump();
}

// Remember skipped comments and drop them from the list and counts without waiting for the next fetch
function skipThreads(key, triage) {
  const keys = triage.filter((t) => t.verdict === 'skip').map(skipKey);
  if (keys.length === 0) return;
  const entry = state.mine[key];
  const threads = (entry.threads || []).filter((t) => !keys.includes(skipKey(t)));
  updateEntry(key, { skipped: [...(entry.skipped || []), ...keys], threads, pending: threads.filter((t) => t.kind !== 'comment').length });
}

// mode: 'self' (self-review) / 'fix' (plan for handling comments; triage: human pre-judgment)
function enqueueMine(key, mode, triage = null) {
  const entry = state.mine[key];
  const mapping = repoTool(config.repos[entry.pr.repo]);
  const cwd = repoCwd(entry.pr.repo);
  const prompt = mode === 'self' ? buildReviewPrompt(entry.pr, { skill: mapping.selfSkill, args: mapping.selfArgs }, sharedPrompt(config, 'reviewPrompt')) : buildFixPlanPrompt(entry.pr, mapping, triage, sharedPrompt(config, 'fixPrompt'));
  const runId = newRunId();
  updateEntry(key, { status: 'queued', mode, runId, triage, error: null, findings: null, summary: null, raw: null, decisions: {}, unverified: null, setupSuggestion: null });
  queue.push({ key, repo: entry.pr.repo, run: async () => {
    updateEntry(key, { status: 'running', startedAt: Date.now() });
    finishMine(key, cwd, await withWorkspace(entry.pr, cwd, (ws) => runForTag(mode === 'self' ? 'docket-findings' : 'docket-fix-plan', prompt, { key, ws, pr: entry.pr, readOnly: true, logName: logName(key, mode), cancelled: () => state.mine[key]?.runId !== runId || state.mine[key]?.status !== 'running' })), runId);
  } });
  pump();
}

// Without decisions, follow the PR author's comment (fetched by the server) as instructions
function enqueueApply(key, decisions, comment = '') {
  const entry = state.mine[key];
  updateEntry(key, { status: 'applying', error: null, decisions });
  queue.push({ key, repo: entry.pr.repo, run: async () => {
    finishApply(key, await withWorkspace(entry.pr, entry.cwd || repoCwd(entry.pr.repo), async (ws) => {
      const { prompt } = applyRun(entry, decisions, comment, config);
      return collectApply(await runAgent(prompt, { ws, key, pr: entry.pr, logName: logName(key, 'apply') }), ws, entry.pr);
    }));
  } });
  pump();
}


// ---------- Skill candidates ----------

// roots: also include working dirs being edited (unsaved) in settings
function listSkills(roots) {
  const dirs = new Set([...roots.filter(Boolean), os.homedir()].map((root) => path.join(root, '.claude', 'skills')));
  const names = new Set();
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (fs.existsSync(path.join(dir, name, 'SKILL.md'))) names.add(name);
    }
  }
  return [...names].sort();
}

// ---------- HTTP ----------

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const MAX_BODY = 1e6;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    // Sign-in routes read the body before any session check, so cap it. Past the cap the rest is drained, not kept
    const onData = (d) => {
      data += d;
      if (data.length <= MAX_BODY) return;
      req.off('data', onData);
      req.resume();
      reject(Object.assign(new Error('Request body too large'), { status: 413 }));
    };
    req.on('data', onData);
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

// /api/board is fetched every 5s, so send Claude's output only when the decision dialog can be opened
// postRaw, decisions and triage aren't used by the UI (decision drafts live in the browser)
// Lanes cards can be moved to by hand. Running cards aren't moved, so the run stays visible
const MOVE_LANES = { prs: ['requested', 'reviewing', 'reviewed', 'commented'], mine: ['mine', 'pending', 'running', 'planned'] };
const RUNNING = ['queued', 'reviewing', 'posting', 'running', 'applying', 'publishing'];
// A review card whose run (or post) is queued or going
const REVIEW_BUSY = ['queued', 'reviewing', 'posting'];
// A card with a review, self-review or plan waiting for the user's decisions
const hasResult = (e) => ['reviewed', 'planned'].includes(e.status);
// A setup suggestion for the card is queued or running (reviews of the card wait for it)
const suggesting = (e) => ['queued', 'running'].includes(e.setupSuggestion?.status);
// If state, unaddressed count, Draft, or PR updates (commits, comments, etc.) change after a manual move, return to the automatic lane
const laneSnapshot = (e) => ({ status: e.status, pending: e.pending ?? null, isDraft: !!e.pr?.isDraft, prUpdatedAt: e.pr?.updatedAt ?? null });
function manualLane(e) {
  // Cards moved to a lane that no longer exists (e.g. old Draft) go back to the automatic lane
  if (!e.manual || ![...MOVE_LANES.prs, ...MOVE_LANES.mine].includes(e.manual.lane)) return null;
  const now = laneSnapshot(e);
  return Object.keys(now).every((k) => e.manual[k] === now[k]) ? e.manual.lane : null;
}

// newCount: comments not yet in the current plan. A planned thread counts again once it gets a new comment
function boardEntry(key, { postRaw, decisions, triage, raw, applyRaw, findings, summary, manual, ...e }) {
  const lane = manualLane({ ...e, manual });
  const planned = new Set((triage || []).map(skipKey));
  return {
    key, ...e, ...(lane && { manualLane: lane }),
    ...(e.threads && { newCount: e.threads.filter((t) => !planned.has(skipKey(t))).length }),
    ...(hasResult(e) && { raw, applyRaw, findings, summary }),
  };
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
    // For "Reset all to defaults" in settings
    defaults: DEFAULT_CONFIG,
    defaultPrompts: DEFAULT_PROMPTS,
  };
}

async function handlePlan(req, res, url) {
  const body = req.method === 'GET' ? {} : await readBody(req);
  const project = req.method === 'GET' ? url.searchParams.get('project') : body.project;
  const file = req.method === 'GET' ? url.searchParams.get('file') : body.file;
  if (!config.projects.includes(project)) return send(res, 404, { error: E('projectNotConfigured') });
  try {
    if (req.method === 'GET' && url.pathname === '/api/plans') return send(res, 200, listPlans(project));
    if (req.method === 'GET' && url.pathname === '/api/plan') return send(res, 200, planDoc(project, file));
    if (req.method === 'GET' && url.pathname === '/api/plan/options') {
      const refresh = url.searchParams.get('refresh') === '1';
      // Allow choosing assignees etc. even if the Project can't be read
      const [fields, repo] = await Promise.all([projectFields(project, refresh).catch(() => null), repoOptions(url.searchParams.get('repo'), refresh)]);
      return send(res, 200, { fields, ...repo });
    }
    if (req.method === 'PUT' && url.pathname === '/api/plan') {
      if (!body.plan || !Array.isArray(body.plan.nodes)) return send(res, 400, { error: E('planInvalid') });
      await withPlanLock(project, file, () => writePlan(project, file, body.plan));
      return send(res, 200, planDoc(project, file));
    }
    if (req.method === 'POST' && url.pathname === '/api/plan/new') {
      if (body.issue) await createPlanFromIssue(project, { file, repo: body.issue.repo, number: Number(body.issue.number) });
      else createPlan(project, { file, title: body.title, repo: body.repo });
      return send(res, 200, planDoc(project, file));
    }
    if (req.method === 'PUT' && url.pathname === '/api/plan/fields') {
      await saveFieldChoice(project, body);
      return send(res, 200, await planRanges(project, false));
    }
    if (req.method === 'GET' && url.pathname === '/api/plan/ranges') return send(res, 200, await planRanges(project, url.searchParams.get('refresh') === '1'));
    if (req.method === 'GET' && url.pathname === '/api/plan/live') return send(res, 200, await planLive(project, file, url.searchParams.get('refresh') === '1'));
    if (req.method === 'POST' && url.pathname === '/api/plan/import') {
      return send(res, 200, { node: await importIssue(project, file, { repo: body.repo, number: Number(body.number), level: body.level }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/plan/apply') {
      // Pressing the same plan repeatedly must not create issues twice
      const key = planFile(project, file);
      if (planApplying.has(key)) return send(res, 409, { error: E('planApplying') });
      planApplying.add(key);
      try {
        return send(res, 200, await withPlanLock(project, file, () => applyPlan(project, file, { addToProject: body.addToProject !== false, commit: !!body.commit })));
      } finally {
        planApplying.delete(key);
      }
    }
  } catch (e) {
    return send(res, e instanceof Error ? 502 : 400, { error: e instanceof Error ? e.message : e });
  }
  return send(res, 404, { error: 'not found' });
}

// Font for the pixel-font theme (Fusion Pixel 12px Korean, subset to the characters used. OFL)
const FONTS = { '/fonts/pixel.ttf': 'fusion-pixel-12px-ko.ttf' };
// Files of the sign-in page and the app. Serve only fixed files (never build paths). They hold no data, so they are
// served signed out too; the app's data comes from the API
const CSS = 'text/css; charset=utf-8';
const JS = 'text/javascript; charset=utf-8';
const PAGE_FILES = { '/login.css': CSS, '/login.js': JS, '/style.css': CSS, '/theme.js': JS, '/i18n.js': JS, '/app.js': JS, '/plan.js': JS, '/main.js': JS };

// Scripts only from this server, none inline. Images may come from anywhere (avatars, images in PR text); images
// cannot run code
const CSP = `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${FRAME_ANCESTORS}`;

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Security-Policy', `${CSP}; script-src 'self'`);
  // DNS rebinding protection
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, { error: 'forbidden host' });

  if (req.method === 'GET' && url.pathname === '/') {
    // Read before sending headers so we can return 500 if it fails. Signed out, the page is the sign-in page
    const html = fs.readFileSync(path.join(__dirname, auth.user(req) ? 'index.html' : 'login.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  if (req.method === 'GET' && Object.hasOwn(PAGE_FILES, url.pathname)) {
    const file = fs.readFileSync(path.join(__dirname, url.pathname.slice(1)));
    res.writeHead(200, { 'Content-Type': PAGE_FILES[url.pathname], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(file);
  }
  // Theme font. Serve only fixed files (never build paths)
  if (req.method === 'GET' && FONTS[url.pathname]) {
    let font;
    try {
      font = fs.readFileSync(path.join(__dirname, 'fonts', FONTS[url.pathname]));
    } catch {
      return send(res, 404, { error: 'not found' });
    }
    res.writeHead(200, { 'Content-Type': 'font/ttf', 'Cache-Control': 'max-age=86400' });
    return res.end(font);
  }
  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });

  // CSRF protection from other sites (custom headers need a preflight, which fails since CORS isn't allowed)
  if (!req.headers['x-docket']) return send(res, 403, { error: 'missing header' });
  // Every other API call needs the owner's session (see auth.js)
  const signIn = await auth.route(req, res, url.pathname, () => readBody(req));
  if (signIn) return send(res, signIn.status, signIn.body);
  if (!auth.apiUser(req)) return send(res, 401, { error: 'signin' });

  if (req.method === 'GET' && url.pathname === '/api/board') {
    const now = Date.now();
    // Opened again after polls were skipped: fetch now if the data is older than one poll
    if (!viewing(now) && now - (state.lastFetchedAt || 0) >= pollIntervalMs(config.pollMinutes) && inPollHours(new Date(now), config.pollStartHour, config.pollEndHour)) {
      refreshFromGitHub().catch((e) => { state.fetchError = e.message; });
    }
    lastViewAt = now;
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
    const entry = own(state.prs, key) || own(state.mine, key);
    const run = entry?.run;
    // While running, read the in-progress .out; after, read the .log merged by readRun
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

  if (url.pathname.startsWith('/api/plan')) return handlePlan(req, res, url);

  // The patches of a result waiting to be published, to read before publishing
  if (req.method === 'GET' && url.pathname === '/api/mine/patches') {
    const key = url.searchParams.get('key') || '';
    if (!own(state.mine, key) || !fs.existsSync(resultFile(key))) return send(res, 404, { error: 'not found' });
    const result = JSON.parse(fs.readFileSync(resultFile(key), 'utf8'));
    const branches = await Promise.all(result.branches.map(async (b) => ({ key: b.key, name: b.name, patch: await branchPatch(result.clone, b, git).catch(() => '') })));
    return send(res, 200, { branches });
  }

  const body = await readBody(req);
  if (req.method === 'POST' && url.pathname === '/api/consent') {
    config = { ...config, consentVersion: CONSENT_VERSION };
    writeJson(CONFIG_FILE, config);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && RUN_PATHS.includes(url.pathname) && needsConsent()) return send(res, 403, { error: E('consentRequired') });
  // all: delete all finished logs. Otherwise only those older than days (retention being typed in the UI)
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

  // A setup command for what the card's last review could not check: proposed by AI, applied only by the user
  if (req.method === 'POST' && ['/api/setup/suggest', '/api/setup/apply'].includes(url.pathname)) {
    const target = own(mapOf(String(body.key)), body.key);
    if (!target) return send(res, 404, { error: 'not found' });
    const s = target.setupSuggestion;
    if (url.pathname === '/api/setup/suggest') {
      if (!hasResult(target) || !target.unverified?.length) return send(res, 409, { error: E('cannotSuggestSetup') });
      if (suggesting(target)) return send(res, 409, { error: E('running') });
      enqueueSetupSuggestion(body.key);
      return send(res, 200, { ok: true });
    }
    if (s?.status !== 'done' || !s.setup) return send(res, 409, { error: E('cannotApplySetup') });
    // The user read the proposal against the command it was made from; if that changed since, they read the wrong diff
    const repo = target.pr.repo;
    if ((config.repos[repo]?.setup || '') !== s.current) return send(res, 409, { error: E('setupChanged') });
    config = { ...config, repos: { ...config.repos, [repo]: { ...config.repos[repo], setup: s.setup } } };
    writeJson(CONFIG_FILE, config);
    updateEntry(body.key, { setupSuggestion: { ...s, status: 'applied' } });
    // Re-run what the suggestion was for, so it uses the new command. Runs that can't be rebuilt keep 'applied'
    // (not when a run started meanwhile; repoTool always gives a review skill)
    const tool = repoTool(config.repos[repo]);
    const idle = hasResult(target);
    if (idle && !body.key.startsWith('mine:')) enqueueReview(body.key);
    else if (idle && (target.mode === 'self' ? tool.selfSkill : tool.fixSkill && target.triage)) enqueueMine(body.key, target.mode, target.triage);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/move') {
    const target = own(mapOf(String(body.key)), body.key);
    if (!target) return send(res, 404, { error: 'not found' });
    if (!MOVE_LANES[body.key.startsWith('mine:') ? 'mine' : 'prs'].includes(body.lane)) return send(res, 400, { error: 'invalid lane' });
    if (RUNNING.includes(target.status)) return send(res, 409, { error: E('running') });
    updateEntry(body.key, { manual: { lane: body.lane, ...laneSnapshot(target) } });
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/mine/')) {
    const mine = own(state.mine, body.key);
    if (!mine) return send(res, 404, { error: 'not found' });
    if (url.pathname === '/api/mine/run') {
      const skill = repoTool(config.repos[mine.pr.repo])[body.mode === 'self' ? 'selfSkill' : 'fixSkill'];
      if (!['self', 'fix'].includes(body.mode) || !skill) return send(res, 400, { error: E('skillMissing', { repo: mine.pr.repo }) });
      if (!['idle', 'planned'].includes(mine.status) || suggesting(mine)) return send(res, 409, { error: E('running') });
      let triage = null;
      if (body.mode === 'fix') {
        triage = triageFrom(mine.threads, body.decisions);
        if (!triage) return send(res, 400, { error: E('undecided') });
        if (triage.some((t) => t.verdict === 'disagree' && !t.reason)) return send(res, 400, { error: E('reasonRequired') });
        skipThreads(body.key, triage);
        // If everything is skipped, don't run the AI; just remember them
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
      const comment = await fetchAuthorComment(mine.pr).catch(() => undefined);
      if (comment === undefined) return send(res, 502, { error: E('runFailed') });
      if (!comment) return send(res, 409, { error: E('cannotApply') });
      enqueueApply(body.key, null, comment);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/mine/publish') {
      if (mine.status !== 'ready' || !fs.existsSync(resultFile(body.key))) return send(res, 409, { error: E('cannotPublish') });
      if (mine.result?.risky?.length && !body.confirmRisky) return send(res, 400, { error: E('riskyNotConfirmed') });
      enqueuePublish(body.key);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/mine/discard') {
      if (mine.status !== 'ready') return send(res, 409, { error: E('cannotPublish') });
      fs.rmSync(resultFile(body.key), { force: true });
      updateEntry(body.key, { status: 'planned', error: null, result: null, publishProgress: null });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/mine/cancel') {
      if (!['queued', 'running'].includes(mine.status)) return send(res, 409, { error: E('cannotCancel') });
      cancelRun(body.key, 'idle');
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  }

  const entry = own(state.prs, body.key);
  if (req.method !== 'POST' || !entry) return send(res, 404, { error: 'not found' });

  if (url.pathname === '/api/review') {
    if (!repoTool(config.repos[entry.pr.repo]).skill) return send(res, 400, { error: E('skillMissing', { repo: entry.pr.repo }) });
    if (REVIEW_BUSY.includes(entry.status) || suggesting(entry)) return send(res, 409, { error: E('running') });
    enqueueReview(body.key);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/post') {
    if (entry.status !== 'reviewed' || !entry.findings || !entry.sessionId) return send(res, 409, { error: E('cannotPost') });
    if (!canDecideAll(entry.findings, body.decisions, true)) return send(res, 400, { error: E('undecided') });
    enqueuePost(body.key, body.decisions, !!body.approve, !!body.humanRead);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/cancel') {
    if (!['queued', 'reviewing'].includes(entry.status)) return send(res, 409, { error: E('cannotCancel') });
    cancelRun(body.key, 'requested');
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/skip') {
    // Move to Done without posting. The request stays on GitHub, so mergeBoard must not move it back to requested
    if (!['requested', 'reviewed'].includes(entry.status)) return send(res, 409, { error: E('cannotSkip') });
    updateEntry(body.key, { status: 'commented', commentedAt: Date.now(), skipped: true, error: null });
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/dismiss') {
    // Deleting while running leaves claude running, and a post's result wouldn't be recorded
    if (REVIEW_BUSY.includes(entry.status)) return send(res, 409, { error: E('running') });
    delete state.prs[body.key];
    saveState();
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'not found' });
}

function main() {
  // Settings, state and logs are private to this user
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DATA_DIR, 0o700);
  // claudeArgs / readOnlyTools were settings before skills listed their own tools: drop them
  // provider / codex* were settings while Codex was supported: drop them too
  const { claudeArgs: _args, readOnlyTools: _tools, provider: _provider, codexModel: _codexModel, codexEffort: _codexEffort, codexArgs: _codexArgs, ...saved } = readJson(CONFIG_FILE, {});
  config = { ...DEFAULT_CONFIG, ...saved };
  state = { mine: {}, ...readJson(STATE_FILE, { prs: {} }) };
  // A setup suggestion isn't recovered after a restart: drop it, so it doesn't hold back reviews of its card
  for (const e of [...Object.values(state.prs), ...Object.values(state.mine)]) {
    if (suggesting(e)) e.setupSuggestion = { ...e.setupSuggestion, status: 'failed', error: E('runFailed') };
  }
  // Jobs whose claude already started keep running in their own process group, so collect their results
  // Unstarted reviews and plans have no side effects, so requeue them; posts and fixes are reverted to avoid running twice
  const requeue = [];
  for (const [key, e] of Object.entries(state.prs)) {
    if (e.status === 'reviewing' && e.run) {
      recoverRun(e.run, (res) => finishReview(key, e.run.workdir || e.run.cwd, res, e.runId));
      continue;
    }
    if (e.status === 'queued' || e.status === 'reviewing') {
      if (repoTool(config.repos[e.pr.repo]).skill) requeue.push(() => enqueueReview(key));
      else state.prs[key] = { ...e, status: 'requested', error: E('restartInterrupted') };
    }
    if (e.status === 'posting') state.prs[key] = { ...e, status: 'reviewed', error: E('restartPostInterrupted') };
  }
  for (const [key, e] of Object.entries(state.mine)) {
    if ((e.status === 'running' || e.status === 'applying') && e.run) {
      recoverRun(e.run, (res) => (e.status === 'running' ? finishMine(key, e.run.workdir || e.run.cwd, res, e.runId) : collectApply(res, e.run, e.pr).then((r) => finishApply(key, r))), e.pr.repo);
      continue;
    }
    if (e.status === 'queued' || e.status === 'running') {
      // Fixing comments needs the triage to build the prompt, so revert if it can't be carried over
      if (repoTool(config.repos[e.pr.repo])[e.mode === 'self' ? 'selfSkill' : 'fixSkill'] && (e.mode === 'self' || e.triage)) requeue.push(() => enqueueMine(key, e.mode, e.triage));
      else state.mine[key] = { ...e, status: 'idle', error: E('restartInterrupted') };
    }
    if (e.status === 'applying') state.mine[key] = { ...e, status: 'planned', error: E('restartApplyInterrupted') };
    // Progress is kept, so publishing again does only the rest
    if (e.status === 'publishing') state.mine[key] = { ...e, status: 'ready', error: E('restartPublishInterrupted') };
  }
  saveState();
  // Count recovered jobs as running before queueing, so maxConcurrent isn't exceeded
  for (const fn of requeue) fn();

  refreshFromGitHub().catch((e) => {
    state.fetchError = e.message;
  });
  schedulePoll();
  pruneLogs(LOG_DIR, Date.now(), logKeepMs(config.logKeepDays));
  // AI runs reach GitHub only through this gatekeeper, which lets reads through with the user's gh login
  startGitHubProxy({ log: (m) => console.log(`github gatekeeper: ${m}`) }).catch((e) => console.error(`github gatekeeper: ${e.message}`));
  setInterval(() => pruneLogs(LOG_DIR, Date.now(), logKeepMs(config.logKeepDays)), 24 * 60 * 60 * 1000);

  http
    // If it threw after sending, calling writeHead again would crash the server with an unhandled rejection
    .createServer((req, res) => handle(req, res).catch((e) => (res.headersSent ? res.end() : e.status ? send(res, e.status, { error: e.message }) : (console.error(e), send(res, 500, { error: 'Internal error' })))))
    .listen(PORT, '127.0.0.1', () => {
      // Make the setup code before announcing the server, so it exists once the address is printed
      const code = !auth.hasAccount() && auth.setupCode();
      console.log(`docket-gits: http://127.0.0.1:${PORT}`);
      if (code) console.log(`Create the account: http://127.0.0.1:${PORT}/?setup=${code}`);
    });
}

if (require.main === module && process.argv.includes('--reset-password')) {
  console.log(auth.reset() ? 'Removed the account. Open docket-gits and create it again with setup code ' + auth.setupCode() + '.' : 'There is no account.');
} else if (require.main === module) main();

module.exports = { setupSandbox, postReview, repoOptions, fieldMutation, claudeArgs, cwdError, validRepo, CONSENT_VERSION, withPlanLock, listSkills, logKeepMs, periodAt, periodWindows, pickIterations, parseProjectUrl, detectFields, clearSynced, readRun, isTruncated, usageOf, addUsage, modelOptions, permissionArgs, setupSuggestionOf, runForTag, normalizeNos, boardEntry, manualLane, laneSnapshot, canDecideAll, sanitizeConfig, pollIntervalMs, concurrencyLimit, inPollHours };
