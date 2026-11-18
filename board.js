'use strict';

// The board's data from GitHub: the searches and fields fetched, and how their results merge into the saved cards
// (review requests in prs, my own pull requests in mine). Pure functions; server.js fetches and saves

const { DEFAULT_CONFIG } = require('./defaults');

// Grace period to tell a re-review request from search index lag right after posting
const RE_REQUEST_GRACE_MS = 2 * 60 * 1000;
// Done cards with a removed request pile up unless dismissed with x, slowing the 5s /api/board, so drop them after the configured days
const doneKeepMs = (days) => (Number(days) >= 1 ? Number(days) : DEFAULT_CONFIG.doneKeepDays) * 24 * 60 * 60 * 1000;
const DONE_KEEP_MS = doneKeepMs();

// The board fetch has two steps. LIST_QUERY returns only ids and update times of the PRs each search finds
// (searches are what take time, so this stays well under GitHub's time limit). Full details are fetched only
// for PRs that are new or updated since the last fetch (detailQuery), and kept in detailCache.
const LIST_QUERY = `query($open: String!, $merged: String!, $withMerged: Boolean!, $mine: String!, $reviewed: String!) {
  viewer { login avatarUrl }
  open: search(query: $open, type: ISSUE, first: 100) { issueCount nodes { ...item } }
  merged: search(query: $merged, type: ISSUE, first: 100) @include(if: $withMerged) { issueCount nodes { ...item } }
  mine: search(query: $mine, type: ISSUE, first: 50) { issueCount nodes { ...item } }
  reviewed: search(query: $reviewed, type: ISSUE, first: 50) { nodes { ...item } }
}
fragment item on PullRequest { id url updatedAt }`;

const PR_FRAGMENT = `fragment pr on PullRequest {
      id number title url isDraft state mergedAt createdAt updatedAt baseRefName headRefName
      repository { nameWithOwner }
      author { login avatarUrl }
      milestone { title }
      labels(first: 10) { nodes { name color } }
      closingIssuesReferences(first: 5) { nodes { number title url repository { nameWithOwner } } }
      latestReviews(first: 20) { nodes { state author { login avatarUrl } } }
      reviewRequests(first: 20) { nodes { requestedReviewer {
        ... on User { login avatarUrl }
        ... on Team { name }
      } } }
}`;

// Fields fetched per search (my own PRs also need their threads and comments)
const DETAIL_FIELDS = {
  open: '...pr',
  merged: '...pr',
  mine: `...pr
    reviewThreads(last: 100) { nodes { isResolved path line
      root: comments(first: 1) { nodes { author { login } body url } }
      comments(last: 1) { nodes { author { login } body url createdAt } } } }
    comments(last: 50) { nodes { author { login } body url createdAt } }
    reviews(last: 50) { nodes { author { login } body url submittedAt } }`,
  reviewed: `...pr
    reviewThreads(last: 100) { nodes { isResolved
      root: comments(first: 1) { nodes { author { login } } }
      comments(last: 1) { nodes { author { login } } } } }`,
};
const DETAIL_CHUNK = 50;
const detailQuery = (group, ids) => `query { n: nodes(ids: ${JSON.stringify(ids)}) { ... on PullRequest { ${DETAIL_FIELDS[group]} } } }
${PR_FRAGMENT}`;
// Details older than an hour are read again, for changes that do not update the PR's update time
const DETAIL_MAX_AGE_MS = 60 * 60 * 1000;

// Ids in a search result whose details are missing, older than the PR, or over an hour old (null nodes are PRs that couldn't be read)
function staleIds(items, cache, group, now = Date.now()) {
  return items.filter((it) => {
    const c = it?.id && cache.get(`${group}:${it.id}`);
    return it?.id && (!c || c.updatedAt !== it.updatedAt || now - c.at > DETAIL_MAX_AGE_MS);
  }).map((it) => it.id);
}

// The search result with full details from the cache, in search order. A PR without details is left out
function withDetails(items, cache, group) {
  return items.map((it) => it?.id && cache.get(`${group}:${it.id}`)?.node).filter(Boolean);
}

function searchQueries(mergedDays, now) {
  const base = 'is:pr archived:false user-review-requested:@me';
  // Count days in local time (with UTC, JST mornings before 9am are off by one day)
  const from = now - mergedDays * 24 * 60 * 60 * 1000;
  const since = new Date(from - new Date(from).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return { open: `${base} is:open`, merged: `${base} is:merged merged:>=${since}`, withMerged: mergedDays > 0, mine: 'is:pr archived:false author:@me is:open',
    // NOTE: only checks the 50 most recently updated. Old Done cards come back only via a new request
    reviewed: 'is:pr archived:false reviewed-by:@me is:open sort:updated-desc' };
}

// GraphQL Bot logins lack "[bot]", so normalize before comparing
function authorKey(login) {
  // Coerce to string so numbers etc. in the config don't crash this
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
    // For the board filters (older cached PRs may lack these)
    milestone: node.milestone?.title || null,
  };
}


// Threads I started: unresolved with my comment last = waiting on the author, otherwise = addressed
function myThreadCounts(node, login) {
  const mine = (node.reviewThreads?.nodes || []).filter((t) => t.root?.nodes[0]?.author?.login === login);
  const waiting = mine.filter((t) => !t.isResolved && t.comments.nodes.at(-1)?.author?.login === login).length;
  return { waiting, answered: mine.length - waiting };
}

// Merge GitHub search results with local state
// reviewed: open PRs I reviewed. Commenting removes the request, so track comment progress here
function mergeBoard(prs, fetched, now, reviewed = [], login = null, keepMs = DONE_KEEP_MS) {
  const reviewedByKey = new Map(reviewed.map((n) => [prKey(n), n]));
  const next = {};
  const seen = new Set();
  for (const node of fetched) {
    const key = prKey(node);
    seen.add(key);
    let entry = prs[key];
    if (!entry || (entry.status === 'commented' && !entry.skipped && now - (entry.commentedAt || 0) > RE_REQUEST_GRACE_MS)) {
      // Keep the PR's cumulative usage across re-requests
      entry = { status: 'requested', ...(entry?.usage && { usage: entry.usage }) };
    }
    next[key] = { ...entry, pr: normalizePr(node), active: true };
  }
  for (let [key, entry] of Object.entries(prs)) {
    if (seen.has(key)) continue;
    const node = reviewedByKey.get(key);
    // When the author has replied to or resolved all my comments, move it back to requested for re-review
    // Once moved back, wait until a new comment is pending so old threads don't keep moving it back
    if (entry.status === 'commented' && !entry.skipped && node) {
      const { waiting, answered } = myThreadCounts(node, login);
      if (waiting > 0 && !entry.awaitingAuthor) entry = { ...entry, awaitingAuthor: true };
      if (waiting === 0 && (entry.awaitingAuthor || (!entry.reopened && answered > 0))) entry = { status: 'requested', reopened: true, ...(entry.usage && { usage: entry.usage }) };
    }
    // Drop untouched PRs whose request was removed (moved-back PRs stay while open); keep in-progress and done ones
    if (entry.status === 'requested' && !(entry.reopened && node)) continue;
    if (entry.status === 'commented' && now - (entry.commentedAt || 0) > keepMs) continue;
    next[key] = { ...entry, ...(node && { pr: normalizePr(node) }), active: false };
  }
  return next;
}

// Unresolved threads whose last comment is not mine = comments I haven't answered yet
// Replying makes me the last commenter, so new comments can be detected without extra state
// Keep the first comment and (if replies follow) the latest one, so a human can judge before running AI
// Threads with only my comments and no reply (self-comments on my own PR) count, since nobody has answered yet
// AI replies to self-comments use the same account, so my additions after the AI run (appliedAt) count as new comments
function pendingThreads(node, login, appliedAt = 0) {
  return (node.reviewThreads?.nodes || [])
    .filter((t) => {
      const last = t.comments.nodes.at(-1);
      const root = t.root?.nodes[0];
      if (t.isResolved) return false;
      if (last?.author?.login !== login || (last.url && last.url === root?.url)) return true;
      return root?.author?.login === login && appliedAt > 0 && Date.parse(last.createdAt) > appliedAt;
    })
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

// PR-level comments (Conversation comments, review bodies) have no resolved state, so
// anything others wrote after my last PR-level comment counts as unaddressed
// NOTE: replying to just one clears all earlier ones. Store per-comment state locally if that's needed
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

// Skipped comments are remembered with their last comment at that time. A new comment changes the key and shows it again
const skipKey = (t) => `${t.url} ${t.lastUrl}`;

function mineKey(pr) {
  return `mine:${prKey(pr)}`;
}

// Merge my open PRs with local state. Closed PRs are kept only while running
function mergeMine(mine, fetched, login) {
  const next = {};
  for (const node of fetched) {
    const key = mineKey(node);
    // The lane's "has comments" uses threads only (PR-level comments stay until replied to, and periodic bot comments would stick)
    const all = [...pendingThreads(node, login, mine[key]?.appliedAt), ...pendingComments(node, login)];
    const prev = new Set(mine[key]?.skipped || []);
    // Remember only those still unaddressed (forget ones with new comments or my reply)
    const skipped = all.map(skipKey).filter((k) => prev.has(k));
    const threads = all.filter((t) => !prev.has(skipKey(t))).map((t, i) => ({ ...t, no: i + 1 }));
    const pending = threads.filter((t) => t.kind !== 'comment').length;
    next[key] = { status: 'idle', ...mine[key], pr: normalizePr(node), pending, threads, skipped };
  }
  for (const [key, entry] of Object.entries(mine)) {
    if (!next[key] && ['queued', 'running', 'applying', 'ready', 'publishing'].includes(entry.status)) next[key] = entry;
  }
  return next;
}

module.exports = {
  RE_REQUEST_GRACE_MS, doneKeepMs, DONE_KEEP_MS, LIST_QUERY, DETAIL_FIELDS, DETAIL_CHUNK, detailQuery, staleIds, withDetails, searchQueries,
  authorKey, filterByAuthors, normalizePr, mergeBoard, pendingThreads, pendingComments, skipKey, mergeMine,
};
