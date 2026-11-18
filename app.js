// Illustration for "Before you start". Colors follow the theme via CSS (.art)
const ROBOT_HEAD = '<line x1="32" y1="9" x2="32" y2="4"/><circle class="a" cx="32" cy="3.5" r="2.5"/><rect class="b" x="20" y="9" width="24" height="18" rx="6"/>';
const ART = {
  house: '<path class="d" d="M6 30 32 8l26 22"/><rect class="b" x="13" y="27" width="38" height="30" rx="2"/><path d="M27 40v-4a5 5 0 0 1 10 0v4"/><rect class="w" x="24" y="40" width="16" height="13" rx="2"/><circle class="k" cx="32" cy="46" r="1.8"/><path class="h" d="M50 14c-2-3-6-1-4 2l4 4 4-4c2-3-2-5-4-2z"/>',
  robot: `${ROBOT_HEAD}<circle class="k" cx="27" cy="17" r="2"/><circle class="k" cx="37" cy="17" r="2"/><path d="M28 22q4 3 8 0"/><rect class="b" x="24" y="28" width="16" height="12" rx="3"/><path d="M24 32 12 46M26 38l-6 8M40 32l12 14M38 38l6 8"/><path class="m" d="M6 38l3-2M5 44l3-1M58 38l-3-2M59 44l-3-1"/><rect class="b" x="6" y="47" width="52" height="10" rx="2"/><path d="M11 52h3M18 52h3M25 52h3M32 52h3M39 52h3M46 52h3"/>`,
  note: '<rect class="b" x="8" y="6" width="34" height="46" rx="3"/><path d="M14 16h22M14 23h22M14 30h16"/><g transform="rotate(12 44 42)"><rect class="w" x="32" y="30" width="24" height="22" rx="2"/><circle class="k" cx="41" cy="38" r="1.8"/><circle class="k" cx="49" cy="38" r="1.8"/><path d="M40 45q5 2 9-2"/></g>',
  tag: `${ROBOT_HEAD}<circle class="k" cx="27" cy="17" r="2"/><circle class="k" cx="37" cy="17" r="2"/><path d="M28 22q4 3 8 0"/><rect class="b" x="16" y="28" width="32" height="28" rx="5"/><rect class="a" x="22" y="36" width="20" height="14" rx="2"/><circle class="t" cx="32" cy="41" r="2.5"/><path class="t" d="M27 48a5 4 0 0 1 10 0"/>`,
  cool: `${ROBOT_HEAD}<rect class="k" x="22" y="14" width="9" height="5" rx="2"/><rect class="k" x="33" y="14" width="9" height="5" rx="2"/><path d="M31 16h2"/><path d="M26 22q6 4 12 0"/><rect class="b" x="24" y="28" width="16" height="14" rx="3"/><path d="M40 33l8-5"/><path class="a" d="M48 22v6h4v-3a2 2 0 0 0-4-3z"/><path class="d" d="M50 6a4 4 0 1 1 4 4v3M54 17v.5" stroke-width="2.5"/><path d="M24 33l-6 6"/>`,
  cookie: `${ROBOT_HEAD}<circle class="k" cx="27" cy="16" r="2"/><circle class="k" cx="37" cy="16" r="2"/><ellipse class="k" cx="32" cy="22.5" rx="4" ry="3"/><circle class="w" cx="46" cy="40" r="12"/><circle class="k" cx="42" cy="36" r="1.5"/><circle class="k" cx="49" cy="35" r="1.5"/><circle class="k" cx="45" cy="44" r="1.5"/><circle class="k" cx="51" cy="43" r="1.5"/><path class="c" d="M34 30l2 2M30 34l1 2M38 36l1 1"/><rect class="b" x="14" y="30" width="16" height="14" rx="3"/><path d="M30 36l6 2"/>`,
};
document.querySelectorAll('.consent [data-art]').forEach((el) => el.insertAdjacentHTML('afterbegin', `<svg class="art" viewBox="0 0 64 64" aria-hidden="true">${ART[el.dataset.art]}</svg>`));
// Marker for the most important item. Overlaps slightly offset strokes to look hand-drawn in pencil
const STAR = '<svg viewBox="0 0 40 40" aria-hidden="true"><path fill="#f7d84a" opacity=".55" d="M20 4l4.6 10.2 11 1.1-8.3 7.4 2.5 10.9L20 28l-9.7 5.6 2.4-10.9-8.2-7.5 11-1z"/><g fill="none" stroke="#d9a400" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.3 3.6l4.4 10.5 11.2 1-8.5 7.5 2.7 11-9.9-5.8-9.6 5.9 2.3-11.1-8.4-7.3 11.2-1.2z"/><path d="M19.6 4.8l4.9 9.6 10.6 1.5-8 7.1 2.2 10.6-9.6-5.4-9.9 5.2 2.6-10.6-8-7.6 10.7-.6z" opacity=".6"/><path d="M15 17l8-2M14 21l12-4M15 25l12-4M18 28l7-3" opacity=".45" stroke-width="1.1"/></g></svg>';
document.querySelectorAll('.consent .star').forEach((el) => (el.innerHTML = STAR.repeat(3)));
document.querySelectorAll('.consent li > div').forEach((el) => el.insertAdjacentHTML('beforeend', `<label class="got"><input type="checkbox"> ${tr('consent.got')}</label>`));

const LANES = [
  { id: 'requested', label: tr('lane.requested'), color: 'var(--ok)', statuses: ['requested'], badge: true },
  { id: 'reviewing', label: tr('lane.reviewing'), color: 'var(--warn)', statuses: ['queued', 'reviewing'], badge: true },
  { id: 'reviewed', label: tr('lane.reviewed'), color: 'var(--accent)', statuses: ['reviewed', 'posting'] },
  { id: 'commented', label: tr('lane.done'), color: 'var(--merged)', statuses: ['commented'] },
];
// Being reviewed (my PRs)
const MINE_LANES = [
  // Drafts go in the same lane too (marked as Draft on the card, and moved to the bottom of the lane unless sorted by stack)
  { id: 'mine', label: tr('lane.mine'), color: 'var(--ok)', match: (e) => e.status === 'idle' && !e.pending, badge: true },
  { id: 'pending', label: tr('lane.pending'), color: 'var(--danger)', match: (e) => e.status === 'idle' && e.pending > 0, badge: true },
  { id: 'running', label: tr('lane.running'), color: 'var(--warn)', match: (e) => ['queued', 'running', 'applying', 'publishing'].includes(e.status), badge: true },
  { id: 'planned', label: tr('lane.planned'), color: 'var(--accent)', match: (e) => ['planned', 'ready'].includes(e.status), badge: true },
];
// Lane order and names are saved per browser. Drag to reorder and rename only in "Edit lanes" mode
// Names only override the display; key is `${view}:${lane id}`. Falls back to the default name
const LANE_NAMES_KEY = 'docket-lane-names';
const laneNames = () => { try { return JSON.parse(localStorage.getItem(LANE_NAMES_KEY)) || {}; } catch { return {}; } };
const saveLaneNames = (names) => {
  try { localStorage.setItem(LANE_NAMES_KEY, JSON.stringify(Object.fromEntries(Object.entries(names).map(([k, n]) => [k, n.trim()]).filter(([, n]) => n)))); } catch {}
};
const laneLabel = (v, lane) => laneNames()[`${v}:${lane.id}`] || lane.label;
const laneOrderKey = (v) => `docket-lane-order:${v}`;
function lanesFor(v) {
  const lanes = v === 'receive' ? MINE_LANES : LANES;
  let order = laneEdit || [];
  if (!laneEdit) try { order = JSON.parse(localStorage.getItem(laneOrderKey(v))) || []; } catch {}
  const rank = (l) => (order.includes(l.id) ? order.indexOf(l.id) : order.length + lanes.indexOf(l));
  return [...lanes].sort((a, b) => rank(a) - rank(b));
}
// A card moved by hand stays in that lane until something changes (manualLane is decided by the server)
const laneMatch = (lane) => (p) => (p.manualLane ? p.manualLane === lane.id : lane.match ? lane.match(p) : lane.statuses.includes(p.status));
let laneEdit = null; // lane id array being edited
let laneNameEdit = null; // Lane names being edited (same shape as laneNames)
// Repository / author filters (the hidden ones) are also saved per tab and per browser. kind is the multiSelect key
const hiddenKey = (kind, v) => `docket-hidden-${kind}:${v}`;
function hiddenOf(kind, v) {
  try { return JSON.parse(localStorage.getItem(hiddenKey(kind, v))) || []; } catch { return []; }
}
// Archive: takes PRs you do not need to watch now off the board. Saves repo#number per tab and per browser
const archivedOf = (v) => { try { return JSON.parse(localStorage.getItem(`docket-archived:${v}`)) || []; } catch { return []; } };
// Only items not in the archive (used for tab counts and home totals)
const unarchived = (v) => { const a = archivedOf(v); return (v === 'receive' ? board.mine : board.prs).filter((p) => !a.includes(prId(p.pr))); };
let archiveView = false; // Showing only archived PRs
const ARCH_ICON = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="3.5" rx="1"/><path d="M2.5 6v6.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6M6.5 9h3"/></svg>';
const UNARCH_ICON = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10V2.5M5 5.5l3-3 3 3M2.5 9.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/></svg>';
let laneDrag = null;
// The roadmap moved into the plan screen. Redirect old roadmap bookmarks (by sprint, by period, etc.) there
const OLD_ROADMAP = ['#sprint', '#period', '#milestone', '#repo'];
if (OLD_ROADMAP.includes(location.hash)) location.replace('#plan');
const PAGES = ['about', 'tips', 'settings'];
const view = () => (!location.hash ? 'home' : location.hash === '#receive' ? 'receive' : location.hash === '#plan' ? 'plan' : PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'review');
const REVIEW_ICON = { APPROVED: '✅', CHANGES_REQUESTED: '🔴', COMMENTED: '💬', DISMISSED: '⚪', PENDING: '⏳' };

let board = { prs: [], mine: [], config: { repos: {} } };
let openKey = null;
// Flag status changes in tabs not being shown with a red dot on the tab name (memory only)
const seenSig = {};
const tabSig = (v) => (v === 'receive' ? board.mine : board.prs).map((p) => `${p.key}:${p.status}`).sort().join();

// Embedded browsers (Electron etc.) do not show confirm()/alert() and return false immediately, so
// confirmations use "press again" and notifications use toasts
const CONFIRM_MS = 5000;
let armed = null;
function confirmTwice(btn, id, label) {
  if (armed?.id === id && Date.now() < armed.until) {
    armed = null;
    return true;
  }
  armed = { id, until: Date.now() + CONFIRM_MS };
  const original = btn.textContent;
  btn.textContent = label;
  setTimeout(() => {
    if (btn.isConnected) btn.textContent = original;
    render();
  }, CONFIRM_MS);
  return false;
}
const armedLabel = (id, normal, confirmLabel) => (armed?.id === id && Date.now() < armed.until ? confirmLabel : normal);
// Red (error) by default. Pass ok for green success messages
function toast(msg, ok = false) {
  const el = document.createElement('div');
  el.className = ok ? 'toast ok' : 'toast';
  // Also announce to screen readers (failures right away, successes at a natural pause)
  el.setAttribute('role', ok ? 'status' : 'alert');
  el.textContent = msg;
  // Modal dialogs live in the top layer, so a toast in body would be hidden behind them. Put it inside the open dialog
  const box = document.querySelector('dialog[open]') || document.body;
  // Stack on top of existing toasts so earlier ones are not hidden
  const below = [...box.querySelectorAll(':scope > .toast')].reduce((h, t) => Math.max(h, parseFloat(t.style.bottom || 24) + t.offsetHeight + 8), 24);
  el.style.bottom = `${below}px`;
  box.append(el);
  setTimeout(() => el.remove(), 6000);
}

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// URLs from Claude output also end up in href, so allow only https to avoid javascript: and the like
const safeUrl = (u) => (/^https:\/\//i.test(u || '') ? u : '#');

// The API token from sign-in, kept in this origin's storage (cookies alone are shared with every localhost port)
const apiToken = () => { try { return localStorage.getItem('docket-token') || '1'; } catch { return '1'; } };
// Signed out, or the cookie is valid but this browser has no token: drop the cookie so the page shows the sign-in form
const signedOut = (header) => fetch('/api/auth/logout', { method: 'POST', headers: { [header]: '1' } }).catch(() => {}).then(() => { location.reload(); return new Promise(() => {}); });

async function api(path, opts = {}) {
  // Even when the server is down or the response is not JSON, show the message in the UI language, not the browser's English one
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Docket': apiToken() },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).catch(() => { throw new Error(tr('err.network')); });
  // Signed out (or the session ran out): reloading shows the sign-in page
  if (res.status === 401) return signedOut('X-Docket');
  const json = await res.json().catch(() => { throw new Error(tr('err.badResponse', { status: res.status })); });
  if (!res.ok) throw new Error(errText(json.error) || res.statusText);
  return json;
}

// Return empty for old data without a timestamp, so render as a whole does not crash
function ago(iso) {
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (Number.isNaN(min)) return '';
  if (min < 60) return tr('ago.min', { n: min });
  if (min < 60 * 24) return tr('ago.hour', { n: Math.round(min / 60) });
  return tr('ago.day', { n: Math.round(min / 1440) });
}

// When a polling fetch and a post-action fetch overlap, do not let an older response arriving later overwrite a newer view
let loadSeq = 0;
let loadApplied = 0;
// During a manual refresh, show a spinner and disable the button, like the roadmap
let refreshing = false;
// Last rendered response. Skip redraw if unchanged (rebuilding every 5 s loses focus and text selection)
let lastBoardText = '';
let lastLoadRenderAt = 0;
// "N min ago" is in minutes, so redraw at this interval even if the content is unchanged
const SAME_BOARD_RENDER_MS = 30000;
// quiet: polling fetch. Fetches after an action redraw even if the response is the same
async function load(refresh = false, quiet = false) {
  const seq = ++loadSeq;
  try {
    const next = await api(`/api/board${refresh ? '?refresh=1' : ''}`);
    // For "Refresh", a later poll may return first while GitHub is being fetched, but this result is the newest, so keep it
    if (seq < loadApplied && !refresh) return;
    loadApplied = Math.max(loadApplied, seq);
    const text = JSON.stringify(next);
    const unchanged = quiet && text === lastBoardText && !board.fetchError && Date.now() - lastLoadRenderAt < SAME_BOARD_RENDER_MS;
    lastBoardText = text;
    board = next;
    // The server picks the default shared prompts in the UI language, so tell it the current language
    if (board.config.uiLang !== lang) api('/api/config', { method: 'PUT', body: { uiLang: lang } }).catch(() => {});
    if (unchanged) return;
  } catch (e) {
    // If a later fetch already succeeded, do not show "fetch failed" for an older failure
    if (seq < loadApplied) return;
    board.fetchError = e.message;
  }
  lastLoadRenderAt = Date.now();
  render();
}

// Redrawing while a button is pressed recreates it and the click on release is lost. Redraw on release
let pointerDown = false;
let renderSkipped = false;
document.addEventListener('pointerdown', () => (pointerDown = true), true);
// Moving to another app while pressed may never send pointerup, so treat losing focus as a release too
const release = () => {
  pointerDown = false;
  if (renderSkipped) setTimeout(render); // after the click handler finishes
};
for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, release, true);
window.addEventListener('blur', release);

function render() {
  if (dragging || laneDrag) return; // Redrawing would interrupt the drag
  if (board.consentVersion && (board.config.consentVersion || 0) < board.consentVersion) openConsent(true);
  if (pointerDown) return void (renderSkipped = true);
  renderSkipped = false;
  for (const el of document.querySelectorAll('[data-disagree-icon]')) el.textContent = disagreeIcon();
  $('#viewer').innerHTML = board.viewer ? `<img class="avatar" src="${esc(board.viewer.avatarUrl)}" alt=""> ${esc(board.viewer.login)}` : '';
  // Manual refresh button that also shows the fetch time (same look as roadmap spRefetch)
  $('#refresh').disabled = refreshing;
  $('#refresh').innerHTML = `${refreshing ? '<span class="spin"></span> ' : '<span class="hint">↻ </span>'}${board.lastFetchedAt ? tr('fetchedAgo', { ago: ago(board.lastFetchedAt) }) : tr('refreshNow')}`;
  $('#refresh').title = `${board.lastFetchedAt ? `${new Date(board.lastFetchedAt).toLocaleString(lang)} — ` : ''}${tr('refetchTitle')}`;
  // Show in the browser tab title when something needs a decision (Reviewed / Needs decision), even while another tab is open
  const waiting = unarchived('review').filter((p) => p.status === 'reviewed').length + unarchived('receive').filter((p) => ['planned', 'ready'].includes(p.status)).length;
  document.title = `${waiting ? `(${waiting}) ` : ''}docket-gits`;
  $('#banner').innerHTML = (board.fetchError ? `<div class="banner">${tr('fetchFailed', { msg: esc(board.fetchError) })}</div>` : '')
    + (board.truncated ? `<div class="banner" style="border-color:var(--warn);color:var(--warn)">${tr('truncated')}</div>` : '');

  const mine = view() === 'receive';
  document.querySelectorAll('nav.tabs a[data-view]').forEach((a) => {
    const v = a.dataset.view;
    if (v === 'plan') return a.classList.toggle('on', v === view());
    if (board.lastFetchedAt && (v === view() || seenSig[v] === undefined)) seenSig[v] = tabSig(v);
    a.title = board.lastFetchedAt ? tr('lastFetched', { ago: ago(board.lastFetchedAt) }) : '';
    a.classList.toggle('on', v === view());
    a.classList.toggle('changed', seenSig[v] !== undefined && seenSig[v] !== tabSig(v));
    // Show remaining work counts in the lane color (hide zero)
    const entries = unarchived(v);
    a.querySelector('.badges').innerHTML = lanesFor(v).filter((l) => l.badge).map((l) => {
      const n = entries.filter(laneMatch(l)).length;
      return n ? `<span class="badge" style="background:${l.color}" title="${esc(laneLabel(v, l))}">${n}</span>` : '';
    }).join('');
  });
  const about = view() === 'about';
  const home = view() === 'home';
  const page = PAGES.includes(view());
  const plan = view() === 'plan';
  $('#board').hidden = $('#board-bar').hidden = $('#board-view').hidden = page || home || plan;
  $('#plan').hidden = !plan;
  for (const p of PAGES) $(`#${p}`).hidden = view() !== p;
  $('#home').hidden = !home;
  if (about && !$('#about').innerHTML) renderAbout(); // Changing the language reloads the page, so draw this only once
  if (home) renderHome();
  if (page || home || plan) return;
  const hidden = hiddenOf('repos', view());
  const hiddenAuthors = mine ? [] : hiddenOf('authors', view());
  const all = mine ? board.mine : board.prs;
  const archived = archivedOf(view());
  const isArchived = (p) => archived.includes(prId(p.pr));
  $('#archive-toggle').innerHTML = `${ARCH_ICON}${tr('archive')}<span class="count">${all.filter(isArchived).length}</span>`;
  $('#archive-toggle').classList.toggle('primary', archiveView);
  $('#archive-toggle').setAttribute('aria-pressed', archiveView);
  const order = Object.keys(board.config.repos || {});
  const rank = (r) => (order.includes(r) ? order.indexOf(r) : order.length);
  const repos = [...new Set(all.map((p) => p.pr.repo))].sort().sort((a, b) => rank(a) - rank(b));
  const shown = repos.filter((r) => !hidden.includes(r));
  // Build both before inserting (inserting first would lose the open state of the later dropdown)
  const repoSelect = multiSelect('repos', tr('repo'),
    `${shown.length === repos.length ? tr('all') : shown.length ? esc(shown.map((r) => r.split('/')[1]).join(', ')) : tr('none')}`,
    [...new Set([...order, ...repos])].map((r) => ({ value: r, text: r.split('/')[1], disabled: !repos.includes(r) })),
    (r) => !hidden.includes(r));
  // Only the reviewing side also filters by PR author (on the receiving side they are all mine)
  let authorSelect = '';
  if (!mine) {
    const authors = [...new Map(all.filter((p) => p.pr.author).map((p) => [p.pr.author.login, p.pr.author])).values()].sort((a, b) => a.login.localeCompare(b.login));
    const on = authors.filter((a) => !hiddenAuthors.includes(a.login));
    authorSelect = multiSelect('authors', tr('author'),
      `${on.length === authors.length ? tr('all') : on.length ? on.map((a) => `<img class="avatar" src="${esc(a.avatarUrl)}" alt="" title="${esc(a.login)}">`).join('') : tr('none')}`,
      authors.map((a) => ({ value: a.login, text: a.login, img: a.avatarUrl })), (l) => !hiddenAuthors.includes(l));
  }
  // Filter to PRs approved by at least one person / all others (latestReviews, so still approved now). Saved per tab
  let approved = '';
  try { approved = localStorage.getItem(`docket-approved:${view()}`) || ''; } catch {}
  const isApproved = (p) => p.pr.reviews.some((r) => r.state === 'APPROVED');
  // One button that cycles all -> only -> exclude on each press
  const APPROVED = { '': tr('all'), only: tr('approved.only'), exclude: tr('approved.exclude') };
  approved = { APPROVED: 'only', notApproved: 'exclude' }[approved] || approved; // values saved by a short-lived review state select
  if (!(approved in APPROVED)) approved = '';
  const approvedSeg = field(tr('approved'), `<button data-approved="${approved}"${approved ? ' class="primary"' : ''} title="${esc(tr('approved.title'))}">${APPROVED[approved]}</button>`);
  // Merged PRs use the same 3 states. Reviewing side only (the receiving side fetches only open). Excluded when nothing is saved
  let merged = '';
  if (!mine) {
    try { merged = localStorage.getItem('docket-merged:review') ?? 'exclude'; } catch { merged = 'exclude'; }
    if (!(merged in APPROVED)) merged = 'exclude';
  }
  const isMerged = (p) => p.pr.state === 'MERGED';
  const mergedSeg = field(tr('merged'), `<button data-merged="${merged}"${merged ? ' class="primary"' : ''} title="${esc(tr('approved.title'))}">${APPROVED[merged]}</button>`);
  // Keep focus in the search box during periodic redraws by moving it back to the rebuilt field
  const q = document.activeElement?.matches('#repo-filter [data-ms-q]') && document.activeElement;
  const qAt = q && [q.closest('[data-ms]').dataset.ms, q.selectionStart, q.selectionEnd];
  // Showing everything at first is too much, so show only ones added with "+" and ones with an active filter
  const extra = valueFilters(all);
  const filters = [
    ['repos', tr('repo'), repoSelect, repos.some((r) => hidden.includes(r))],
    ...(mine ? [] : [['authors', tr('author'), authorSelect, hiddenAuthors.length]]),
    ['approved', tr('approved'), approvedSeg, approved],
    ...(mine ? [] : [['merged', tr('merged'), mergedSeg, merged]]),
    ...extra.map((f) => [f.kind, f.label, f.html, f.active]),
  ];
  const added = boardFx[view()];
  const shownF = (x) => added.has(x[0]) || x[3];
  const rest = filters.filter((x) => !shownF(x));
  $('#repo-filter').innerHTML = filters.filter(shownF).map(([k, , html]) => `<div class="pl-xf">${html}<button data-filter-del="${k}" title="${esc(tr('pl.removeField'))}">×</button></div>`).join('')
    + (rest.length ? `<div class="pl-addf"><button data-filter-add aria-expanded="${boardFilterMenu}">+</button>${boardFilterMenu ? `<div class="pop">${rest.map(([k, label]) => `<button data-filter-pick="${k}">${label}</button>`).join('')}</div>` : ''}</div>` : '');
  const nq = qAt && $(`#repo-filter [data-ms="${qAt[0]}"] [data-ms-q]`);
  if (nq) { nq.focus(); nq.setSelectionRange(qAt[1], qAt[2]); }
  // Show an active filter even when collapsed
  // Do not collapse while editing lanes, since the save / cancel buttons are there
  $('#board-filter').open = sideFilterOpen;
  $('#board-view-sec').open = !!laneEdit || sideViewOpen(); // Do not collapse while editing lanes, since the save / cancel buttons are there
  const sideClosed = plGet('board-side') === '0' && !laneEdit;
  $('#board-side').classList.toggle('closed', sideClosed);
  $('#board-side').classList.toggle('filtering', !!(approved || merged || hiddenAuthors.length || repos.some((r) => hidden.includes(r)) || extra.some((f) => f.active)));
  $('#board-fold').textContent = sideClosed ? '›' : '‹';
  const prs = all.filter((p) => isArchived(p) === archiveView && !hidden.includes(p.pr.repo) && !hiddenAuthors.includes(p.pr.author?.login)
    && (approved === 'only' ? isApproved(p) : approved === 'exclude' ? !isApproved(p) : true)
    && extra.every((f) => BOARD_VALUES[f.kind](p.pr).some((v) => !f.hid.includes(v)))
    && (merged === 'only' ? isMerged(p) : merged === 'exclude' ? !isMerged(p) : true)).sort((a, b) => new Date(b.pr.updatedAt) - new Date(a.pr.updatedAt));
  $('#edit-lanes').hidden = !!laneEdit;
  $('#stack-order').classList.toggle('primary', stackOrder);
  $('#lane-save').hidden = $('#lane-cancel').hidden = !laneEdit;
  $('#board').classList.toggle('editing', !!laneEdit);
  $('#board').classList.toggle('archived', archiveView);
  // Let typing continue even if a redraw happens while editing a name
  const nameAt = document.activeElement?.dataset.laneName && [document.activeElement.dataset.laneName, document.activeElement.selectionStart, document.activeElement.selectionEnd];
  // While viewing the archive, show a banner above the lanes so it is clear why there are fewer cards
  const archNote = archiveView ? `<div class="arch-note" style="grid-column:1 / span ${lanesFor(view()).length}">${ARCH_ICON}<span><b>${tr('archive')}</b> · ${tr('archive.note', { n: prs.length })}</span><button data-archive-back>${tr('archive.back')}</button></div>` : '';
  $('#board').innerHTML = archNote + lanesFor(view()).map((lane) => {
    let cards = prs.filter(laneMatch(lane));
    if (stackOrder) cards = stackSort(cards);
    else cards = [...cards.filter((c) => !c.pr.isDraft), ...cards.filter((c) => c.pr.isDraft)];
    return `<section class="lane" data-lane="${lane.id}" ${laneEdit ? 'draggable="true"' : ''}>
      <h2><span class="dot" style="border-color:${lane.color}"></span>${laneEdit
        ? `<input class="lane-name" data-lane-name="${lane.id}" value="${esc(laneNameEdit[`${view()}:${lane.id}`] || '')}" placeholder="${esc(lane.label)}">`
        : esc(laneLabel(view(), lane))}<span class="count">${cards.length}</span></h2>
      ${cards.map(mine ? mineCardHtml : cardHtml).join('') || `<div class="muted" style="padding:4px">${tr('none')}</div>`}
    </section>`;
  }).join('');
  const ni = nameAt && $(`#board [data-lane-name="${nameAt[0]}"]`);
  if (ni) { ni.focus(); ni.setSelectionRange(nameAt[1], nameAt[2]); }

  if (openKey && $('#review-dlg').open) {
    const entry = [...board.prs, ...board.mine].find((p) => p.key === openKey);
    if (!entry || !['reviewed', 'planned', 'ready'].includes(entry.status)) $('#review-dlg').close();
    else if (dlgRender?.key === openKey && JSON.stringify(entry.setupSuggestion ?? null) !== dlgRender.shown) dlgRender.render();
  }
}

// Main screen: totals come only from the board data already fetched (no extra GitHub queries)
const formatCost = (cost) => cost == null ? tr('costUnknown') : `$${cost.toFixed(2)}`;
function renderHome() {
  // Archived PRs are not counted (AI cost is counted, since it was already spent)
  const prs = unarchived('review');
  const mine = unarchived('receive');
  const count = (v, l) => (v === 'receive' ? mine : prs).filter(laneMatch(l)).length;
  const lanesSection = (v, title) => {
    const rows = lanesFor(v).map((l) => [l, count(v, l)]);
    const max = Math.max(1, ...rows.map(([, n]) => n));
    return `<section><h2>${title}<span class="muted">${tr('home.total', { n: v === 'receive' ? mine.length : prs.length })}</span><a href="#${v}">${tr('home.open')}</a></h2>
      ${rows.map(([l, n]) => `<div class="row"><span>${esc(laneLabel(v, l))}</span><span class="bar"><i style="width:${(n / max) * 100}%;background:${l.color}"></i></span><b>${n}</b></div>`).join('')}</section>`;
  };
  const left = prs.filter((p) => p.status !== 'commented');
  const byRepo = Object.entries(left.reduce((m, p) => ({ ...m, [p.pr.repo]: (m[p.pr.repo] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
  const maxRepo = Math.max(1, ...byRepo.map(([, n]) => n));
  const all = [...board.prs, ...board.mine];
  const usage = (list) => list.reduce((u, p) => ({ tokens: u.tokens + (p.usage?.tokens || 0), costUsd: u.costUsd == null || (p.usage && p.usage.costUsd == null) ? null : u.costUsd + (p.usage?.costUsd || 0) }), { tokens: 0, costUsd: 0 });
  const total = usage(all);
  const kpi = (n, label, href) => (href ? `<a class="kpi" href="${href}">` : '<div class="kpi">') + `<div class="n">${n}</div><div class="l">${label}</div>` + (href ? '</a>' : '</div>');
  $('#home').innerHTML = `<div class="kpis">
      ${kpi(left.length, tr('home.left'), '#review')}
      ${kpi(prs.filter((p) => p.status === 'reviewed').length + mine.filter((p) => ['planned', 'ready'].includes(p.status)).length, tr('home.decide'), mine.some((p) => ['planned', 'ready'].includes(p.status)) && !prs.some((p) => p.status === 'reviewed') ? '#receive' : '#review')}
      ${kpi(mine.reduce((n, p) => n + (p.pending || 0), 0), tr('home.comments'), '#receive')}
      ${kpi(formatCost(total.costUsd), tr('home.cost'))}
    </div>
    <div class="cols">${lanesSection('review', tr('tab.review'))}${lanesSection('receive', tr('tab.receive'))}</div>
    <div class="cols">
      <section><h2>${tr('home.byRepo')}</h2>${byRepo.map(([r, n]) => `<div class="row"><span>${esc(r.split('/')[1])}</span><span class="bar"><i style="width:${(n / maxRepo) * 100}%;background:var(--accent)"></i></span><b>${n}</b></div>`).join('') || `<div class="muted">${tr('none')}</div>`}</section>
      <section><h2>${tr('home.usage')}</h2>
        ${[[tr('tab.review'), usage(board.prs)], [tr('tab.receive'), usage(board.mine)]].map(([l, u]) => `<div class="row" style="grid-template-columns:minmax(90px, auto) 1fr auto"><span>${l}</span><span class="muted">${fmtTokens(u.tokens)} tok</span><b>${formatCost(u.costUsd)}</b></div>`).join('')}
        <div class="muted" style="font-size:12px;margin-top:6px">${tr('home.usageNote')}</div></section>
    </div>`;
}

const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(n / 1024)}KB`);

function fmtTokens(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

function cardHtml(e) {
  const mapping = board.config.repos[e.pr.repo] || {};
  let action = '';
  if (e.status === 'requested') {
    action = actionSkill(e.pr.repo, 'review')
      ? `${runButton(tr('btn.review'), e, 'review')}${mapping.skill && mapping.skill !== PROMPT_SKILL ? `<span class="muted">${esc(mapping.skill)}</span>` : `<a href="#settings" data-settings-pane="agent-prompts" title="${esc(tr('opt.prompt'))}">${tr('default')}</a>`}`
      : `<button disabled>${tr('btn.review')}</button><a href="#settings" data-settings>${tr('skillMissing')}</a>`;
    action += `<div class="skip-row"><button data-skip="${esc(e.key)}" title="${esc(tr('skip.title'))}">${tr('skip')}</button></div>`;
  } else if (e.status === 'queued') {
    action = `<span class="muted"><span class="spin"></span> ${tr('queued')}</span><button data-cancel="${esc(e.key)}">${armedLabel(`cancel:${e.key}`, tr('cancel'), tr('confirmCancel'))}</button>`;
  } else if (e.status === 'reviewing') {
    action = `<span class="muted"><span class="spin"></span> ${tr('reviewing')} ${tr('startedAgo', { ago: ago(e.startedAt) })}</span><button data-log="${esc(e.key)}">${tr('log')}</button><button data-cancel="${esc(e.key)}">${armedLabel(`cancel:${e.key}`, tr('cancel'), tr('confirmCancel'))}</button>`;
  } else if (e.status === 'reviewed') {
    action = `<span>${e.findings ? tr('findingsDecide', { n: e.findings.length }) : tr('checkRaw')}</span>`;
  } else if (e.status === 'posting') {
    action = `<span class="muted"><span class="spin"></span> ${tr('posting')}</span><button data-log="${esc(e.key)}">${tr('log')}</button>`;
  } else if (e.status === 'commented') {
    action = `${e.postedUrl ? `<a href="${esc(safeUrl(e.postedUrl))}" target="docket-viewer">${tr('postedReview')}</a>` : `<span class="muted">${e.skipped ? tr('skipped') : tr('posted')}</span>`}<button data-dismiss="${esc(e.key)}" title="${esc(tr('dismiss.title'))}">×</button>`;
  }

  const clickable = e.status === 'reviewed';
  // Can be moved by hand to any lane. Not moved while posting (see the drop handler for behavior)
  const draggable = e.status !== 'posting';
  return cardShell(e, action, `class="card${clickable ? ' clickable' : ''}" ${clickable ? `data-open="${esc(e.key)}"` : ''} ${draggable ? `draggable="true" data-drag="${esc(e.key)}"` : ''}`, e.status !== 'reviewed');
}

const MINE_RUNNING = { self: tr('running.self'), fix: tr('running.fix') };
// Same fallback as repoTool in server.js: review without a skill uses the shared prompt
const actionSkill = (repo, action) => board.config.repos[repo]?.[{ review: 'skill', self: 'selfSkill', fix: 'fixSkill' }[action]] || (action === 'review' ? PROMPT_SKILL : undefined);
const runButton = (label, entry, action) => `<button data-run-action="${action}" data-key="${esc(entry.key)}">${label}</button>`;
document.addEventListener('click', (ev) => {
  const button = ev.target.closest('[data-run-action]');
  if (!button || button.disabled) return;
  ev.stopPropagation();
  const { key, runAction: action } = button.dataset;
  return action === 'review' ? review(key) : action === 'fix' ? openTriage(key) : runMine(key, action);
}, true);

function mineCardHtml(e) {
  const cancel = `<button data-mine-cancel="${esc(e.key)}">${armedLabel(`cancel:${e.key}`, tr('cancel'), tr('confirmCancel'))}</button>`;
  let action = '';
  if (e.status === 'idle') {
    const buttons = [
      actionSkill(e.pr.repo, 'self') && runButton(tr('selfReview'), e, 'self'),
      actionSkill(e.pr.repo, 'fix') && runButton(tr('fixComments'), e, 'fix'),
    ].filter(Boolean);
    action = buttons.length ? `<span class="btns">${buttons.join('')}</span>` : `<a href="#settings" data-settings>${tr('skillMissing')}</a>`;
  } else if (e.status === 'queued') {
    action = `<span class="muted"><span class="spin"></span> ${tr('queued')}</span>${cancel}`;
  } else if (e.status === 'running') {
    action = `<span class="muted"><span class="spin"></span> ${MINE_RUNNING[e.mode]} ${tr('startedAgo', { ago: ago(e.startedAt) })}</span><button data-log="${esc(e.key)}">${tr('log')}</button>${cancel}`;
  } else if (e.status === 'planned') {
    action = `<span>${e.findings ? tr('findingsDecide', { n: e.findings.length }) : tr('checkRaw')}</span>`;
  } else if (e.status === 'applying') {
    action = `<span class="muted"><span class="spin"></span> ${tr('applying')}</span><button data-log="${esc(e.key)}">${tr('log')}</button>`;
  } else if (e.status === 'ready') {
    action = `<button class="primary" data-open-result="${esc(e.key)}">${tr('pub.check')}</button>`;
  } else if (e.status === 'publishing') {
    action = `<span class="muted"><span class="spin"></span> ${tr('pub.running')}</span>`;
  }
  const clickable = e.status === 'planned';
  // Can be moved by hand to any lane. Not moved while running (see the drop handler for behavior)
  const draggable = !['queued', 'running', 'applying', 'publishing'].includes(e.status);
  const open = clickable ? `data-open-mine="${esc(e.key)}"` : e.status === 'ready' ? `data-open-result="${esc(e.key)}"` : '';
  return cardShell(e, action, `class="card${open ? ' clickable' : ''}" ${open} ${draggable ? `draggable="true" data-drag="${esc(e.key)}"` : ''}`, e.status !== 'planned');
}

// PRs in the same repo on the board are stacked when base = the other's head. Order: parent -> self -> child
// Multi-select dropdown (filterable by text). Open state and search text survive redraws
// items: [{ value, text, img? }]; summary and extra (a field added below the list) are escaped HTML
const msQuery = {};
// Sidebar open/close. The roadmap side is redrawn, so remember it (Filters go back to collapsed on reload; Display saves its open state)
let sideFilterOpen = false;
const sideViewOpen = () => plGet('side-view') !== '0';
// Items added via "+" in the reviewing / being-reviewed filters (per tab)
const boardFx = { review: new Set(), receive: new Set() };
// Label and milestone filters, picked like repositories and authors: a PR is shown if any of its values is checked
// (NONE stands for "no label" / "no milestone"). Saved per tab, as the values to hide
const NONE = '-';
const BOARD_VALUES = {
  labels: (pr) => (pr.labels.length ? pr.labels.map((l) => l.name) : [NONE]),
  milestone: (pr) => [pr.milestone || NONE],
};
const filterValues = (kind, pr) => (kind === 'repos' ? [pr.repo] : kind === 'authors' ? [pr.author?.login] : BOARD_VALUES[kind](pr));
function valueFilters(all) {
  return Object.keys(BOARD_VALUES).map((kind) => {
    const hid = hiddenOf(kind, view());
    const vals = [...new Set(all.flatMap((p) => BOARD_VALUES[kind](p.pr)))].sort((a, b) => (a === NONE) - (b === NONE) || a.localeCompare(b));
    const on = vals.filter((v) => !hid.includes(v));
    const text = (v) => (v === NONE ? tr('unset') : v);
    const label = tr(`bf.${kind}`);
    const summary = on.length === vals.length ? tr('all') : on.length ? esc(on.map(text).join(', ')) : tr('none');
    return { kind, label, hid, html: multiSelect(kind, label, summary, vals.map((v) => ({ value: v, text: text(v) })), (v) => !hid.includes(v)), active: vals.some((v) => hid.includes(v)) };
  });
}
let boardFilterMenu = false;
document.addEventListener('toggle', (ev) => {
  if (ev.target.matches?.('.side-filter')) sideFilterOpen = ev.target.open;
  if (ev.target.matches?.('.side-view')) plSet('side-view', ev.target.open ? '1' : '0');
}, true);
// Small label above the select
const field = (label, html) => `<div class="ms-field"><span class="ms-label">${label}</span>${html}</div>`;
function multiSelect(key, label, summary, items, isOn, extra = '') {
  const open = document.querySelector(`details.ms[data-ms="${CSS.escape(key)}"]`)?.open;
  const q = (msQuery[key] || '').toLowerCase();
  return field(label, `<details class="ms" data-ms="${esc(key)}"${open ? ' open' : ''}><summary>${summary}</summary><div class="ms-pop">
    <input type="search" data-ms-q placeholder="${esc(tr('search'))}" value="${esc(msQuery[key] || '')}">
    <div class="ms-list">${items.map((i) => `<label data-ms-text="${esc(i.text.toLowerCase())}"${i.text.toLowerCase().includes(q) ? '' : ' hidden'} title="${esc(i.value)}"${i.disabled ? ' class="off"' : ''}><input type="checkbox" data-ms-value="${esc(i.value)}"${i.disabled ? ' disabled' : isOn(i.value) ? ' checked' : ''}>${i.img ? `<img class="avatar" src="${esc(i.img)}" alt="">` : ''}${esc(i.text)}</label>`).join('')}</div>
    <div class="ms-bulk"><button data-ms-bulk="all">${tr('selectAll')}</button><button data-ms-bulk="none">${tr('clearAll')}</button></div>${extra}</div></details>`);
}
document.addEventListener('input', (ev) => {
  if (!ev.target.matches('[data-ms-q]')) return;
  const ms = ev.target.closest('.ms');
  const q = (msQuery[ms.dataset.ms] = ev.target.value).toLowerCase();
  for (const l of ms.querySelectorAll('[data-ms-text]')) l.hidden = !l.dataset.msText.includes(q);
});
// Close on outside click
document.addEventListener('click', (ev) => {
  if (boardFilterMenu && !ev.target.closest('.pl-addf')) { boardFilterMenu = false; render(); }
  for (const d of document.querySelectorAll('details.ms[open], .user-menu[open]')) if (!d.contains(ev.target) || ev.target.closest('.user-menu a')) d.open = false;
});

const prId = (pr) => `${pr.repo}#${pr.number}`;
function stackHtml(pr) {
  const all = new Map([...board.prs, ...board.mine].map((p) => [prId(p.pr), p.pr]));
  const same = [...all.values()].filter((p) => p.repo === pr.repo && p.number !== pr.number);
  const parents = same.filter((p) => p.head === pr.base);
  const children = same.filter((p) => p.base === pr.head);
  if (!parents.length && !children.length) return '';
  const links = (ps) => ps.map((p) => `<a href="${esc(safeUrl(p.url))}" target="docket-viewer" data-jump="${esc(prId(p))}" title="${esc(p.title)}">#${p.number}</a>`).join(', ');
  return `<div class="stack">${tr('stack')}${[links(parents), `<b>#${pr.number}</b>`, links(children)].filter(Boolean).join(' → ')}</div>`;
}

// Group cards in a lane by stack, ordered parent -> child -> grandchild. Start from cards whose parent is not in the lane, keeping update order
let stackOrder = false;
function stackSort(cards) {
  const isChild = (c, p) => c !== p && c.pr.repo === p.pr.repo && c.pr.base === p.pr.head;
  const out = [];
  const seen = new Set();
  const visit = (c) => {
    if (seen.has(c)) return;
    seen.add(c);
    out.push(c);
    cards.filter((x) => isChild(x, c)).forEach(visit);
  };
  cards.filter((c) => !cards.some((p) => isChild(c, p))).forEach(visit);
  cards.forEach(visit); // Cycles with no starting point
  return out;
}

// Temporarily highlight the card a stack link points to. Kept in state so it survives redraws
let highlight = null;
// Card of the link last opened in the right tab (docket-viewer)
let viewing = null;
function jumpTo(id) {
  highlight = id;
  render();
  $(`#board [data-pr="${CSS.escape(id)}"]`).scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => { if (highlight === id) { highlight = null; render(); } }, 3000);
}

function cardShell(e, action, attrs, showError) {
  const pr = e.pr;
  const reviewed = new Set(pr.reviews.map((r) => r.login));
  const reviewers = [
    ...pr.reviews.map((r) => `<span class="rv" title="${esc(r.login)}: ${esc(r.state)}"><img class="avatar" src="${esc(r.avatarUrl)}" alt=""><span class="st">${REVIEW_ICON[r.state] || ''}</span></span>`),
    ...pr.requested.filter((r) => !reviewed.has(r.login)).map((r) => `<span class="rv pending" title="${esc(r.login)}: ${tr('rv.pending')}"><img class="avatar" src="${esc(r.avatarUrl)}" alt=""></span>`),
  ].join('');
  return `<article ${attrs.replace('class="card', `data-pr="${esc(prId(pr))}" class="card${highlight === prId(pr) ? ' hl' : ''}${viewing === prId(pr) ? ' viewing' : ''}`)}>
    <div class="top">
      ${view() === 'receive' ? '' : `<img class="avatar" src="${esc(pr.author?.avatarUrl)}" alt="" title="${esc(pr.author?.login)}">`}
      <span class="grow"><a href="${esc(safeUrl(pr.url))}" target="docket-viewer">${esc(pr.repo.split('/')[1])} #${pr.number}</a></span>
      <span class="time" title="${esc(new Date(pr.updatedAt).toLocaleString(lang))}">${tr('fetchedAgo', { ago: ago(pr.updatedAt) })}</span>
      <button class="arch" data-archive="${esc(prId(pr))}" title="${esc(tr(archiveView ? 'archive.take' : 'archive.put'))}" aria-label="${esc(tr(archiveView ? 'archive.take' : 'archive.put'))}">${archiveView ? UNARCH_ICON : ARCH_ICON}</button>
    </div>
    <div class="title">${esc(pr.title)}${e.pending ? `<span class="pending-dot" role="img" aria-label="${esc(tr('pending.title'))}"></span>` : ''}</div>
    ${pr.base ? `<div class="branch" title="base ← head">${esc(pr.base)} ← ${esc(pr.head)}</div>` : ''}
    <div class="chips">
      ${pr.isDraft ? '<span class="chip draft">Draft</span>' : ''}
      ${pr.state === 'MERGED' ? `<span class="chip merged" title="${esc(new Date(pr.mergedAt).toLocaleString(lang))}">Merged</span>` : ''}
      ${e.active === false ? `<span class="chip off">${tr('requestRemoved')}</span>` : ''}
      ${e.error ? `<span class="chip err" title="${esc(errText(e.error))}">${tr('error')}</span>` : ''}
      ${pr.labels.map((l) => `<span class="chip label" style="border-color:#${esc(l.color)}">${esc(l.name)}</span>`).join('')}
    </div>
    ${stackHtml(pr)}
    ${pr.issues.map((i) => `<a class="issue" href="${esc(safeUrl(i.url))}" target="docket-viewer">◎ ${esc(i.repo.split('/')[1])} #${i.number} ${esc(i.title)}</a>`).join('')}
    <div class="reviewers">${reviewers}</div>
    ${e.error && showError ? `<div class="muted" style="color:var(--danger)">${esc(errText(e.error))}${e.lastLog && !e.run ? ` <button data-log="${esc(e.key)}">${tr('log')}</button>` : ''}</div>` : ''}
    ${e.usage || (e.status === 'idle' && e.appliedAt) ? `<div class="chips foot">
      ${e.usage ? `<span class="usage" title="${esc(tr('usage.title'))}">${fmtTokens(e.usage.tokens)} tok · ${formatCost(e.usage.costUsd)}</span>` : ''}
      ${e.status === 'idle' && e.appliedAt ? `<span class="time" title="${esc(new Date(e.appliedAt).toLocaleString(lang))}">${tr('appliedAgo', { ago: ago(e.appliedAt) })}</span>` : ''}
      ${e.status === 'idle' && e.appliedAt && e.published ? publishedLinks(e.published) : ''}
    </div>` : ''}
    <div class="actions">${action}</div>
  </article>`;
}

// ---------- Decision dialog ----------

const draftKey = (key) => `docket:decisions:${key}`;
function loadDraft(key) {
  try { return JSON.parse(localStorage.getItem(draftKey(key))) || {}; } catch { return {}; }
}
function saveDraft(key, draft) {
  try { localStorage.setItem(draftKey(key), JSON.stringify(draft)); } catch {}
}

// What the last review couldn't check for lack of something in its folder, and the setup command AI proposes for it.
// The proposal is applied only when the user presses Apply
let dlgRender = null; // { key, render, shown }: redraws the open review dialog when its setup suggestion changes
function unverifiedHtml(e) {
  if (!e.unverified?.length) return '';
  const s = e.setupSuggestion;
  const suggest = `<button data-setup-suggest>${tr('unv.suggest')}</button> <span class="muted">${tr('unv.suggest.help')}</span>`;
  const body = !s ? suggest
    : s.status === 'failed' ? `<p style="color:var(--danger)">${esc(errText(s.error))}</p>${suggest}`
    : ['queued', 'running'].includes(s.status) ? `<p class="muted">${tr('unv.running')}</p>`
    : s.status === 'applied' ? `<p>${tr('unv.applied')}</p>`
    : !s.setup ? `<p>${esc(s.reason || tr('unv.noChange'))}</p>`
    : `<p>${esc(s.reason)}</p>
      <div class="muted">${tr('unv.current')}</div><pre class="raw">${esc(s.current || tr('unv.none'))}</pre>
      <div class="muted">${tr('unv.proposed')}</div><pre class="raw">${esc(s.setup)}</pre>
      <p>${tr('unv.warn')}</p><button data-setup-apply>${tr('unv.apply')}</button>`;
  return `<div class="finding">
    <div class="head"><span class="grow">${tr('unv.title')}</span></div>
    <ul>${e.unverified.map((u) => `<li>${esc(u.check)}${u.reason ? ` <span class="muted">${esc(u.reason)}</span>` : ''}</li>`).join('')}</ul>
    ${body}
  </div>`;
}
// Clicks on the buttons of unverifiedHtml. true: handled
async function setupClick(t, key) {
  const action = t.matches('[data-setup-suggest]') ? 'suggest' : t.matches('[data-setup-apply]') ? 'apply' : null;
  if (!action) return false;
  if (action === 'apply' && !confirmTwice(t, `setup:${key}`, tr('unv.confirmApply'))) return true;
  try {
    await api(`/api/setup/${action}`, { method: 'POST', body: { key } });
    await load();
  } catch (err) {
    toast(err.message);
  }
  return true;
}
const liveEntry = (key, fallback) => [...board.prs, ...board.mine].find((p) => p.key === key) || fallback;

function openReview(key) {
  openKey = key;
  const e = board.prs.find((p) => p.key === key);
  const draft = { decisions: {}, approve: false, humanRead: false, ...loadDraft(key) };
  const dlg = $('#review-dlg');
  const findings = e.findings;

  const renderDlg = () => {
    armed = null; // Redrawing resets the button label, so also clear any pending "press again"
    const decided = findings ? findings.filter((f) => draft.decisions[f.no]?.verdict).length : 0;
    const ready = findings && decided === findings.length;
    const live = liveEntry(key, e);
    dlgRender = { key, render: renderDlg, shown: JSON.stringify(live.setupSuggestion ?? null) };
    dlg.innerHTML = `
      <div class="dlg-head">
        <h3><a href="${esc(safeUrl(e.pr.url))}" target="docket-viewer">${esc(e.pr.repo.split('/')[1])} #${e.pr.number}</a> ${esc(e.pr.title)}</h3>
        <button data-close>${tr('close')}</button>
      </div>
      <div class="dlg-body">
        ${e.error ? `<div class="banner" style="margin:0 0 12px">${esc(errText(e.error))}</div>` : ''}
        ${e.summary ? `<p>${esc(e.summary)}</p>` : ''}
        ${unverifiedHtml(live)}
        ${findings ? (findings.length ? findings.map((f) => findingHtml(f, draft.decisions[f.no] || {}, undefined, true)).join('') : `<p class="muted">${tr('noFindings')}</p>`)
          : `<pre class="raw">${esc(e.raw || tr('noOutput'))}</pre>`}
        ${findings && e.raw ? `<details><summary class="muted">${tr('agentRaw')}</summary><pre class="raw">${esc(e.raw)}</pre></details>` : ''}
      </div>
      <div class="dlg-foot">
        <button data-rereview>${tr('rereview')}</button>
        <button data-skip-dlg title="${esc(tr('skip.title'))}">${tr('skip')}</button>
        ${e.lastLog ? `<button data-log="${esc(key)}">${tr('log')}</button>` : ''}
        <span style="flex:1"></span>
        ${findings ? `<span class="muted">${tr('decided', { n: decided, total: findings.length })}</span>` : ''}
        <label title="${esc(tr('humanRead.title'))}"><input type="checkbox" data-human-read ${draft.humanRead ? 'checked' : ''} ${findings ? '' : 'disabled'}> ${tr('humanRead')}</label>
        <label><input type="checkbox" data-approve ${draft.approve ? 'checked' : ''} ${findings ? '' : 'disabled'}> ${tr('approve')}</label>
        <button class="primary" data-submit ${ready ? '' : 'disabled'}>${tr('submit')}</button>
      </div>`;
  };

  dlg.onclick = async (ev) => {
    const t = ev.target;
    if (t.matches('[data-close]')) return dlg.close();
    if (t.matches('[data-log]')) return openLog(key);
    if (await setupClick(t, key)) return;
    if (t.matches('[data-verdict]')) {
      const no = t.dataset.no;
      draft.decisions[no] = { ...draft.decisions[no], verdict: t.dataset.verdict };
      saveDraft(key, draft);
      return renderDlg();
    }
    if (t.matches('[data-human-read]')) {
      draft.humanRead = t.checked;
      saveDraft(key, draft);
      return;
    }
    if (t.matches('[data-approve]')) {
      draft.approve = t.checked;
      saveDraft(key, draft);
      return;
    }
    if (t.matches('[data-skip-dlg]')) {
      try {
        await api('/api/skip', { method: 'POST', body: { key } });
        saveDraft(key, {});
        dlg.close();
        load();
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    if (t.matches('[data-rereview]')) {
      if (!confirmTwice(t, `rereview:${key}`, tr('confirmRereview'))) return;
      saveDraft(key, {});
      dlg.close();
      return review(key);
    }
    if (t.matches('[data-submit]')) {
      const label = draft.approve ? tr('confirmApprove') : tr('confirmPost');
      if (!confirmTwice(t, `submit:${key}`, label)) return;
      try {
        await api('/api/post', { method: 'POST', body: { key, decisions: draft.decisions, approve: draft.approve, humanRead: draft.humanRead } });
        saveDraft(key, {});
        dlg.close();
        load();
      } catch (err) {
        toast(err.message);
      }
    }
  };
  dlg.oninput = (ev) => {
    if (!ev.target.matches('[data-reason]')) return;
    const no = ev.target.dataset.no;
    draft.decisions[no] = { ...draft.decisions[no], reason: ev.target.value };
    saveDraft(key, draft);
  };

  renderDlg();
  dlg.showModal();
}

// ---------- Result of a fix run: checked here, then docket-gits pushes and posts it ----------

// Links to what the last publish created (pull requests, issues, the self-review)
const publishedLinks = (p) => [
  ...Object.values(p.pulls || {}).map((u) => [u, `PR #${u.split('/').pop()}`]),
  ...Object.values(p.issues || {}).map((u) => [u, `Issue #${u.split('/').pop()}`]),
  ...(p.review ? [[p.review, tr('pub.linkReview')]] : []),
].map(([u, label]) => `<a class="chip" href="${esc(safeUrl(u))}" target="docket-viewer">${esc(label)}</a>`).join('');

function openResult(key) {
  openKey = key;
  dlgRender = null;
  const dlg = $('#review-dlg');
  const shown = new Set(); // branch keys whose diff is open
  let patches = null; // from /api/mine/patches, loaded on the first "Show diff"
  let riskyOk = false;

  const renderDlg = () => {
    armed = null;
    const e = board.mine.find((p) => p.key === key);
    if (e?.status !== 'ready' || !e.result) return dlg.close();
    const r = e.result;
    const p = e.publishProgress || {};
    const done = (yes) => (yes ? ` <span class="chip">${tr('pub.done')}</span>` : '');
    const branch = (b) => {
      const diff = patches?.branches.find((x) => x.key === b.key);
      return `<div class="finding">
        <div class="head"><span class="grow">${esc(b.name)}</span>${b.base ? `<span class="muted">${esc(tr('pub.newBranch', { base: b.base }))}</span>` : ''}${done(p.pushed?.[b.key])}</div>
        ${b.pull ? `<div><span class="chip">${tr('pub.draftPr')}</span> <b>${esc(b.pull.title)}</b>${done(p.pulls?.[b.key])}</div><pre>${esc(b.pull.body)}</pre>` : ''}
        <ul>${b.commits.map((c) => `<li><code>${esc(c.sha.slice(0, 7))}</code> ${esc(c.subject)}</li>`).join('')}</ul>
        <details class="muted" ${b.files.length <= 5 ? 'open' : ''}><summary>${tr('pub.files', { n: b.files.length })}</summary>${b.files.map((x) => `<div><code>${esc(x)}</code></div>`).join('')}</details>
        <button data-diff="${esc(b.key)}">${tr(shown.has(b.key) ? 'pub.hideDiff' : 'pub.showDiff')}</button>
        ${!shown.has(b.key) ? '' : diff ? `<pre class="raw" style="white-space:pre;overflow:auto;max-height:60vh">${esc(diff.patch)}</pre>` : `<p class="muted">${tr('loading')}</p>`}
      </div>`;
    };
    const to = (t) => (/^finding:\d+$/.test(t) ? esc(tr('pub.toFinding', { no: t.split(':')[1] })) : `<a href="${esc(safeUrl(t))}" target="docket-viewer">${esc(t)}</a>`);
    dlg.innerHTML = `
      <div class="dlg-head">
        <h3><a href="${esc(safeUrl(e.pr.url))}" target="docket-viewer">${esc(e.pr.repo.split('/')[1])} #${e.pr.number}</a> ${esc(e.pr.title)}</h3>
        <button data-close>${tr('close')}</button>
      </div>
      <div class="dlg-body">
        <p class="muted">${tr('pub.desc')}</p>
        ${e.error ? `<div class="banner" style="margin:0 0 12px">${esc(errText(e.error))}</div>` : ''}
        ${r.risky.length ? `<div class="banner" style="margin:0 0 12px">${tr('pub.risky')}<ul>${r.risky.map((f) => `<li><code>${esc(f)}</code></li>`).join('')}</ul><label><input type="checkbox" data-risky-ok ${riskyOk ? 'checked' : ''}> ${tr('pub.riskyOk')}</label></div>` : ''}
        ${r.summary ? `<p>${esc(r.summary)}</p>` : ''}
        ${r.branches.map(branch).join('')}
        ${r.issues.length ? `<h4>${tr('pub.issues')}</h4>${r.issues.map((i) => `<div class="finding"><div class="head"><span class="grow">${esc(i.title)}</span>${i.parent ? `<span class="muted">${esc(tr('pub.parent', { n: i.parent }))}</span>` : ''}${done(p.issues?.[i.key])}</div><pre>${esc(i.body)}</pre></div>`).join('')}` : ''}
        ${r.review ? `<h4>${tr('pub.review')}${done(p.review)}</h4><div class="finding"><pre>${esc(r.review.body)}</pre>${r.review.comments.map((c) => `<div class="muted">#${esc(c.no)}</div><pre>${esc(c.body)}</pre>`).join('')}</div>` : ''}
        ${r.replies.length ? `<h4>${tr('pub.replies')}</h4>${r.replies.map((x, i) => `<div class="finding"><div class="head"><span class="grow">${to(x.to)}</span>${done(p.replies?.[i])}</div><pre>${esc(x.body)}</pre></div>`).join('')}` : ''}
      </div>
      <div class="dlg-foot">
        <button data-discard>${tr('pub.discard')}</button>
        ${e.lastLog ? `<button data-log="${esc(key)}">${tr('log')}</button>` : ''}
        <span style="flex:1"></span>
        <button class="primary" data-publish ${r.risky.length && !riskyOk ? 'disabled' : ''}>${tr('pub.publish')}</button>
      </div>`;
  };

  dlg.onclick = async (ev) => {
    const t = ev.target;
    if (t.matches('[data-close]')) return dlg.close();
    if (t.matches('[data-log]')) return openLog(key);
    if (t.matches('[data-risky-ok]')) {
      riskyOk = t.checked;
      return renderDlg();
    }
    if (t.matches('[data-diff]')) {
      const b = t.dataset.diff;
      if (!shown.delete(b)) shown.add(b);
      renderDlg();
      if (patches || !shown.size) return;
      try {
        patches = await api(`/api/mine/patches?key=${encodeURIComponent(key)}`);
      } catch (err) {
        shown.clear();
        toast(err.message);
      }
      return renderDlg();
    }
    if (t.matches('[data-publish]')) {
      if (!confirmTwice(t, `publish:${key}`, tr('pub.confirmPublish'))) return;
      try {
        await api('/api/mine/publish', { method: 'POST', body: { key, confirmRisky: riskyOk } });
        dlg.close();
        load();
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    if (t.matches('[data-discard]')) {
      if (!confirmTwice(t, `discard:${key}`, tr('pub.confirmDiscard'))) return;
      try {
        await api('/api/mine/discard', { method: 'POST', body: { key } });
        dlg.close();
        load();
      } catch (err) {
        toast(err.message);
      }
    }
  };
  dlg.oninput = null;

  renderDlg();
  dlg.showModal();
}

// Same value as PROMPT_SKILL in server.js. Use the review prompt from settings instead of a skill
const PROMPT_SKILL = '(prompt)';
const skillLabel = (s) => (s === PROMPT_SKILL ? tr('opt.prompt') : s);
// If still the default (in any language), show it as empty and put the current-language default in the placeholder
const ownPrompt = (cfg, key) => (Object.values(board.defaultPrompts).some((p) => p[key] === cfg[key]?.trim()) ? '' : cfg[key] ?? '');
const disagreeIcon = () => board.config?.disagreeIcon?.trim() || '🙅💭';
function findingHtml(f, d, placeholders = { agree: tr('ph.agree'), disagree: tr('ph.disagree', { icon: disagreeIcon() }) }, skippable = false) {
  const loc = f.path ? `${f.path}${f.line ? `:${f.line}` : ''}` : '';
  const placeholder = d.verdict === 'disagree' ? placeholders.disagree : placeholders.agree;
  return `<div class="finding ${esc(d.verdict || '')}">
    <div class="head"><strong>#${esc(f.no)}</strong>${f.severity ? `<span class="chip">${esc(f.severity)}</span>` : ''}<span class="grow">${esc(f.title)}</span></div>
    ${loc || f.url ? `<div class="muted">${esc(loc)} ${f.url ? `<a href="${esc(safeUrl(f.url))}" target="docket-viewer">${tr('origComment')}</a>` : ''}</div>` : ''}
    <pre>${esc(f.body)}</pre>
    <div class="verdict">
      <button class="agree ${d.verdict === 'agree' ? 'on' : ''}" data-verdict="agree" data-no="${esc(f.no)}">${tr('agree')}</button>
      <button class="disagree ${d.verdict === 'disagree' ? 'on' : ''}" data-verdict="disagree" data-no="${esc(f.no)}">${tr('disagree')}</button>
      ${skippable ? `<button class="skip ${d.verdict === 'skip' ? 'on' : ''}" data-verdict="skip" data-no="${esc(f.no)}">${tr('notApplicable')}</button>` : ''}
      <textarea data-reason data-no="${esc(f.no)}" placeholder="${esc(placeholder)}">${esc(d.reason || '')}</textarea>
    </div>
  </div>`;
}

// ---------- Decision dialog for my PRs ----------

const MINE_PLACEHOLDER = {
  self: { agree: tr('ph.self.agree'), disagree: tr('ph.self.disagree') },
  fix: { agree: tr('ph.fix.agree'), disagree: tr('ph.fix.disagree') },
};

// Shape the review-fix plan like comment cards
function planToFinding(item) {
  return {
    ...item,
    severity: item.category,
    title: `${item.author ? `@${item.author}: ` : ''}${item.comment || ''}`,
    body: [
      item.category === 'rebut' && item.ownReason && `${tr('planOwnReason')}\n${item.ownReason}`,
      item.rebuttal && `${tr('planRebut')}\n${item.rebuttal}`,
      item.plan && `${tr('planFix')}\n${item.plan}`,
      item.reply && `${tr('planReply')}\n${item.reply}`,
    ].filter(Boolean).join('\n\n'),
  };
}

function openMine(key) {
  openKey = key;
  const e = board.mine.find((p) => p.key === key);
  const draft = { decisions: {}, confirmed: false, ...loadDraft(key) };
  const dlg = $('#review-dlg');
  const findings = e.findings && (e.mode === 'fix' ? e.findings.map(planToFinding) : e.findings);
  const runLabel = e.mode === 'self' ? tr('rerunSelf') : tr('rerunFix');
  // New comments added to the PR while waiting for a decision. Allow starting pre-judgment -> addressing comments from here
  const newCount = actionSkill(e.pr.repo, 'fix') ? e.newCount || 0 : 0;

  const renderDlg = () => {
    armed = null; // Redrawing resets the button label, so also clear any pending "press again"
    const decided = findings ? findings.filter((f) => draft.decisions[f.no]?.verdict).length : 0;
    const ready = findings && decided === findings.length && draft.confirmed;
    const live = liveEntry(key, e);
    dlgRender = { key, render: renderDlg, shown: JSON.stringify(live.setupSuggestion ?? null) };
    dlg.innerHTML = `
      <div class="dlg-head">
        <h3><a href="${esc(safeUrl(e.pr.url))}" target="docket-viewer">${esc(e.pr.repo.split('/')[1])} #${e.pr.number}</a> ${esc(e.pr.title)}</h3>
        <button data-close>${tr('close')}</button>
      </div>
      <div class="dlg-body">
        <p class="muted">${e.mode === 'self' ? tr('desc.self') : tr('desc.fix')}</p>
        ${newCount ? `<div class="banner" style="margin:0 0 12px">${esc(tr('newComments', { n: newCount }))}</div>` : ''}
        ${e.error ? `<div class="banner" style="margin:0 0 12px">${esc(errText(e.error))}</div>` : ''}
        ${e.summary ? `<p>${esc(e.summary)}</p>` : ''}
        ${unverifiedHtml(live)}
        ${findings ? (findings.length ? findings.map((f) => findingHtml(f, draft.decisions[f.no] || {}, MINE_PLACEHOLDER[e.mode])).join('') : `<p class="muted">${tr('noMineFindings')}</p>`)
          : `<pre class="raw">${esc(e.raw || tr('noOutput'))}</pre>`}
        ${findings && e.raw ? `<details><summary class="muted">${tr('agentRaw')}</summary><pre class="raw">${esc(e.raw)}</pre></details>` : ''}
        ${e.applyRaw ? `<details><summary class="muted">${tr('prevApplyRaw')}</summary><pre class="raw">${esc(e.applyRaw)}</pre></details>` : ''}
      </div>
      <div class="dlg-foot">
        <button data-rerun>${runLabel}</button>
        ${newCount ? `<button data-fix-new>${tr('fixComments')} (${newCount})</button>` : ''}
        ${e.sessionId ? `<button data-apply-comments>${tr('applyComments')}</button>` : ''}
        ${e.lastLog ? `<button data-log="${esc(key)}">${tr('log')}</button>` : ''}
        <span style="flex:1"></span>
        ${findings ? `<span class="muted">${tr('decided', { n: decided, total: findings.length })}</span>` : ''}
        <label><input type="checkbox" data-confirmed ${draft.confirmed ? 'checked' : ''} ${findings ? '' : 'disabled'}> ${tr('confirmed')}</label>
        <button class="primary" data-submit ${ready ? '' : 'disabled'}>${tr('submit')}</button>
      </div>`;
  };

  dlg.onclick = async (ev) => {
    const t = ev.target;
    if (t.matches('[data-close]')) return dlg.close();
    if (t.matches('[data-log]')) return openLog(key);
    if (await setupClick(t, key)) return;
    if (t.matches('[data-verdict]')) {
      const no = t.dataset.no;
      draft.decisions[no] = { ...draft.decisions[no], verdict: t.dataset.verdict };
      saveDraft(key, draft);
      return renderDlg();
    }
    if (t.matches('[data-confirmed]')) {
      draft.confirmed = t.checked;
      saveDraft(key, draft);
      return renderDlg();
    }
    if (t.matches('[data-apply-comments]')) {
      if (!confirmTwice(t, `apply-comments-btn:${key}`, tr('confirmRun'))) return;
      try {
        await applyComments(key);
        dlg.close();
        load();
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    if (t.matches('[data-fix-new]')) {
      if (!confirmTwice(t, `fix-new:${key}`, tr('confirmRun'))) return;
      dlg.close();
      return openTriage(key);
    }
    if (t.matches('[data-rerun]')) {
      if (!confirmTwice(t, `rerun:${key}`, tr('confirmRerun'))) return;
      saveDraft(key, {});
      dlg.close();
      return e.mode === 'fix' ? openTriage(key) : runMine(key, e.mode);
    }
    if (t.matches('[data-submit]')) {
      if (!confirmTwice(t, `submit:${key}`, tr('confirmPush'))) return;
      try {
        await api('/api/mine/apply', { method: 'POST', body: { key, decisions: draft.decisions, confirmed: draft.confirmed } });
        saveDraft(key, {});
        dlg.close();
        load();
      } catch (err) {
        toast(err.message);
      }
    }
  };
  dlg.oninput = (ev) => {
    if (!ev.target.matches('[data-reason]')) return;
    const no = ev.target.dataset.no;
    draft.decisions[no] = { ...draft.decisions[no], reason: ev.target.value };
    saveDraft(key, draft);
  };

  renderDlg();
  dlg.showModal();
}

// ---------- Pre-judgment of review comments (before running AI) ----------

// A human judges whether each thread is valid before running AI, so as not to be swayed by the AI's take.
// Thread numbers are reassigned on every fetch, so judgments are keyed by URL
function openTriage(key) {
  openKey = null; // Opened while idle, so keep it from closing on redraw
  dlgRender = null;
  const e = board.mine.find((p) => p.key === key);
  const threads = e.threads || [];
  const draft = { decisions: {}, ...loadDraft(`triage:${key}`) };
  const dlg = $('#review-dlg');
  const urlOf = (no) => threads.find((th) => String(th.no) === String(no))?.url;
  const toFinding = (th) => ({
    no: th.no,
    severity: th.kind === 'comment' ? tr('prComment') : '',
    url: th.url,
    path: th.path,
    line: th.line,
    title: th.author ? `@${th.author}` : '',
    body: [th.comment, th.latest && `── ${tr('latestComment')}${th.latest.author ? ` (@${th.latest.author})` : ''}\n${th.latest.body}`].filter(Boolean).join('\n\n'),
  });

  // Disagree requires a reason (without one, the AI has nothing to go on). Things that are not review comments are excluded
  const tally = () => {
    const ds = threads.map((th) => draft.decisions[th.url] || {});
    const decided = ds.filter((d) => d.verdict).length;
    const targets = ds.filter((d) => d.verdict && d.verdict !== 'skip').length;
    const ready = threads.length > 0 && decided === threads.length && !ds.some((d) => d.verdict === 'disagree' && !d.reason?.trim());
    // If all are excluded, do not run AI; just remember them as excluded
    return { ds, ready, label: tr(ready && targets === 0 ? 'triageSkipAll' : 'triageSubmit'), text: `${tr('decided', { n: decided, total: threads.length })} · ${tr('triageTargets', { n: targets })}` };
  };

  const renderDlg = () => {
    armed = null; // Redrawing resets the button label, so also clear any pending "press again"
    const { ds, ready, label, text } = tally();
    dlg.innerHTML = `
      <div class="dlg-head">
        <h3><a href="${esc(safeUrl(e.pr.url))}" target="docket-viewer">${esc(e.pr.repo.split('/')[1])} #${e.pr.number}</a> ${esc(e.pr.title)}</h3>
        <button data-close>${tr('close')}</button>
      </div>
      <div class="dlg-body">
        <p class="muted">${tr('desc.triage')}</p>
        ${threads.length ? threads.map((th, i) => findingHtml(toFinding(th), ds[i], { agree: tr('ph.triage.agree'), disagree: tr('ph.triage.disagree') }, true)).join('') : `<p class="muted">${tr('noThreads')}</p>`}
      </div>
      <div class="dlg-foot">
        <span style="flex:1"></span>
        ${threads.length ? `<span class="muted">${text}</span>` : ''}
        <button class="primary" data-submit ${ready ? '' : 'disabled'}>${label}</button>
      </div>`;
  };

  dlg.onclick = async (ev) => {
    const t = ev.target;
    if (t.matches('[data-close]')) return dlg.close();
    if (t.matches('[data-verdict]')) {
      const url = urlOf(t.dataset.no);
      draft.decisions[url] = { ...draft.decisions[url], verdict: t.dataset.verdict };
      saveDraft(`triage:${key}`, draft);
      return renderDlg();
    }
    if (t.matches('[data-submit]')) {
      if (!confirmTwice(t, `triage:${key}`, tr('confirmRun'))) return;
      dlg.close();
      return runMine(key, 'fix', draft.decisions);
    }
  };
  dlg.oninput = (ev) => {
    if (!ev.target.matches('[data-reason]')) return;
    const url = urlOf(ev.target.dataset.no);
    draft.decisions[url] = { ...draft.decisions[url], reason: ev.target.value };
    saveDraft(`triage:${key}`, draft);
    // Whether it can be sent depends on the reason, but toggle only the button so the textarea being typed in is not rebuilt
    const { ready, label } = tally();
    Object.assign(dlg.querySelector('[data-submit]'), { disabled: !ready, textContent: label });
  };

  renderDlg();
  dlg.showModal();
}

// ---------- Settings dialog ----------

// Pane to open on the next visit to #settings (e.g. the card's "default" link opens the shared prompts)
let nextSettingsPane = null;
async function openSettings() {
  // If the first fetch failed, editing and saving would save empty settings and wipe things like repo mappings
  if (!board.defaults) await load();
  if (!board.defaults) return toast(board.fetchError);
  const dlg = $('#settings');
  const cfg = structuredClone(board.config);
  const { user } = await api('/api/auth');
  let uiLang = lang;
  const fetchSkills = async () => {
    const dirs = [cfg.workdir, ...Object.values(cfg.repos).map((m) => m.cwd)].filter(Boolean);
    return (await api(`/api/skills?${new URLSearchParams(dirs.map((d) => ['dir', d]))}`)).skills;
  };
  let skills = await fetchSkills();
  let logs = await api('/api/logs');
  // A line removed from the textarea and then restored uses its settings from before removal
  const known = { ...cfg.repos };

  const skillOptions = (current) => {
    const list = skills.includes(current) || !current || current === PROMPT_SKILL ? skills : [current, ...skills];
    return `<option value="">${tr('unset')}</option>`
      + `<option value="${PROMPT_SKILL}" ${current === PROMPT_SKILL ? 'selected' : ''}>${tr('opt.prompt')}</option>` + list.map((s) => `<option ${s === current ? 'selected' : ''}>${esc(s)}</option>`).join('');
  };
  // Expand the argument template with a sample PR and show the actual command below the input
  const ARG_SKILL = { args: 'skill', selfArgs: 'selfSkill', fixArgs: 'fixSkill' };
  const preview = (r, field) => {
    const m = cfg.repos[r];
    const [owner, name] = r.split('/');
    const filled = (m[field] || '{pr-number}')
      .replaceAll('{pr-number}', '123')
      .replaceAll('{pr-url}', `https://github.com/${r}/pull/123`)
      .replaceAll('{repo-name}', name)
      .replaceAll('{owner-name}', owner)
      .replaceAll('{full-repo-name}', r);
    if (m[ARG_SKILL[field]] === PROMPT_SKILL) return `→ ${tr('opt.prompt')}`;
    return `→ /${m[ARG_SKILL[field]] || tr('skillPh')} ${filled}`;
  };
  const argInput = (r, field) => `<input data-repo="${esc(r)}" data-field="${field}" value="${esc(cfg.repos[r][field] || '{pr-number}')}">`
    + `<div class="muted" data-preview="${esc(r)}|${field}">${esc(preview(r, field))}</div>`;
  const repoWorkdirs = () => {
    const repos = Object.keys(cfg.repos);
    return `
        <table class="repos"><thead><tr><th>${tr('repo')}</th><th>${tr('workdir')}</th></tr></thead><tbody>
          ${repos.map((r) => `<tr><td>${esc(r)}</td><td><input data-repo="${esc(r)}" data-field="cwd" value="${esc(cfg.repos[r]?.cwd || '')}" placeholder="${esc(tr('default'))}"></td></tr>`).join('')}
        </tbody></table>
`;
  };
  const agentToolSettings = () => {
    const repos = Object.keys(cfg.repos);
    return `
          <div class="form-row"><label title="${esc(tr('s.model.title'))}">${tr('s.model')}</label><input data-cfg="model" list="model-list" placeholder="opus" value="${esc(cfg.model || '')}"><datalist id="model-list"><option value="opus"><option value="sonnet"><option value="haiku"></datalist></div>
          <div class="form-row"><label>effort</label><select data-cfg="effort">${['', 'low', 'medium', 'high', 'xhigh', 'max'].map((v) => `<option value="${v}" ${(cfg.effort || '') === v ? 'selected' : ''}>${v || tr('defaultParen')}</option>`).join('')}</select></div>
          <p class="muted">${tr('s.claudeTools.help')}</p>
          <div class="form-row"><label title="${esc(tr('s.skillEdits.title'))}"><input type="checkbox" data-cfg="skillEdits" ${cfg.skillEdits ? 'checked' : ''}> ${tr('s.skillEdits')}</label></div>
          <h4>${tr('s.runNet')}</h4>
          <p class="muted">${tr('s.runNet.help')}</p>
          <div class="form-row"><label><input type="checkbox" data-cfg="runLocalhost" ${cfg.runLocalhost === true ? 'checked' : ''}> ${tr('s.runLocalhost')}</label></div>
          <div class="form-row"><label>${tr('s.runDomains')}</label><textarea data-cfg="runDomains" rows="6" placeholder="registry.npmjs.org">${esc((cfg.runDomains || []).join('\n'))}</textarea></div>
          <div class="form-row"><label>${tr('s.runNetRepos')}</label><div>${repos.map((r) => `<label><input type="checkbox" style="width:auto" data-repo="${esc(r)}" data-field="network"${cfg.repos[r].network === true ? 'checked' : ''}> ${esc(r)}</label>`).join('<br>') || '—'}</div></div>
          <p class="muted">${tr('s.runNetRepos.help')}</p>
          <div class="form-row"><label>${tr('s.runEnv')}</label><textarea data-cfg="runEnv" rows="3" placeholder="DB_PASSWORD=..." spellcheck="false">${esc(cfg.runEnv || '')}</textarea></div>
          <p class="muted">${tr('s.runEnv.help')}</p>
          <div class="form-row"><label><input type="checkbox" data-cfg="runBrowser" ${cfg.runBrowser === true ? 'checked' : ''}> ${tr('s.runBrowser')}</label></div>
          <p class="muted">${tr('s.runBrowser.help')}</p>
          <h4>${tr('s.repoSkills')}</h4>
          <p class="muted">${tr('s.repoSkills.help')}</p>
          <table class="repos">
            <thead><tr><th>${tr('repo')}</th><th>${tr('th.skill')}</th><th>${tr('th.args')}</th></tr></thead>
            <tbody>${repos.map((r) => {
              const m = cfg.repos[r];
              return `<tr><td>${esc(r)}</td><td><select data-repo="${esc(r)}" data-field="skill">${skillOptions(m.skill)}</select></td><td>${argInput(r, 'args')}</td></tr>`;
            }).join('')}</tbody>
          </table>
          <h4>${tr('s.mine')}</h4>
          <p class="muted">${tr('s.mine.help')}</p>
          <table class="repos">
            <thead><tr><th>${tr('repo')}</th><th>${tr('selfReview')}</th><th>${tr('th.args')}</th><th>${tr('th.fix')}</th><th>${tr('th.args')}</th></tr></thead>
            <tbody>${repos.map((r) => {
              const m = cfg.repos[r];
              return `<tr><td>${esc(r)}</td><td><select data-repo="${esc(r)}" data-field="selfSkill">${skillOptions(m.selfSkill)}</select></td><td>${argInput(r, 'selfArgs')}</td><td><select data-repo="${esc(r)}" data-field="fixSkill">${skillOptions(m.fixSkill)}</select></td><td>${argInput(r, 'fixArgs')}</td></tr>`;
            }).join('')}</tbody>
          </table>
          <h4>${tr('s.setup')}</h4>
          <p class="muted">${tr('s.setup.help')}</p>
          <table class="repos">
            <thead><tr><th>${tr('repo')}</th><th>${tr('s.setup')}</th></tr></thead>
            <tbody>${repos.map((r) => `<tr><td>${esc(r)}</td><td><input data-repo="${esc(r)}" data-field="setup" value="${esc(cfg.repos[r].setup || '')}"></td></tr>`).join('')}</tbody>
          </table>`;
  };
  const PANES = ['agent-run', 'agent-targets', 'agent-prompts', 'agent-claude', 'agent-roadmap', 'refresh', 'lang', 'theme', 'terms'];
  // Settings restored by "Reset all to defaults" (terms and UI language are handled separately)
  const PANE_KEYS = {
    agent: ['workdir', 'model', 'effort', 'skillEdits', 'runLocalhost', 'runDomains', 'runEnv', 'runBrowser', 'maxConcurrent', 'logKeepDays', 'mergedDays', 'doneKeepDays', 'authors', 'projects', 'sprintPast', 'roadmapPeriod', 'sprintFuture', 'plansDir', 'repos', 'reviewPrompt', 'fixPrompt'],
    'agent-run': ['maxConcurrent', 'logKeepDays'],
    'agent-targets': ['workdir', 'repos', 'authors', 'mergedDays', 'doneKeepDays'],
    'agent-prompts': ['reviewPrompt', 'fixPrompt'],
    'agent-roadmap': ['projects', 'sprintPast', 'roadmapPeriod', 'sprintFuture', 'plansDir'],
    'agent-claude': ['model', 'effort', 'skillEdits', 'runLocalhost', 'runDomains', 'runEnv', 'runBrowser'],
    refresh: ['refreshSeconds', 'pollMinutes', 'pollStartHour', 'pollEndHour'],
    lang: ['outputLang', 'authorLangs', 'agreeIcon', 'disagreeIcon'],
  };
  const resetBtn = (p) => `<p><button data-pane-reset="${p}">${tr('pane.reset')}</button></p>`;
  let terms = laneNames();
  const termRows = (v, lanes) => `<h4>${tr(`tab.${v}`)}</h4>${lanes.map((l) => `<div class="form-row"><label>${esc(l.label)}</label>`
    + `<input data-term="${v}:${l.id}" placeholder="${esc(l.label)}" value="${esc(terms[`${v}:${l.id}`] || '')}"></div>`).join('')}`;
  let pane = nextSettingsPane || PANES[0];
  nextSettingsPane = null;
  // Unlike other settings, the screen theme is applied and saved immediately (so you can preview while choosing)
  let uiTheme = savedTheme();
  const setTheme = (t) => {
    uiTheme = UI_THEMES.includes(t) ? t : '';
    try { if (uiTheme) localStorage.setItem(THEME_KEY, uiTheme); else localStorage.removeItem(THEME_KEY); } catch {}
    applyTheme(uiTheme);
    const grid = dlg.querySelector('.theme-grid');
    if (grid) grid.innerHTML = themeCards();
  };
  const themeCards = () => [['', [THEME_PREVIEW.light, THEME_PREVIEW.dark]], ...UI_THEMES.map((t) => [t, [THEME_PREVIEW[t]]])].map(([t, parts], i) => {
    return `<button class="theme-card${uiTheme === t ? ' on' : ''}" role="radio" aria-checked="${uiTheme === t}" aria-label="${esc(tr('nav.theme'))} ${i + 1}" data-theme-pick="${t}">
      <span class="theme-prev" aria-hidden="true">${parts.map((c) => `<span class="part" style="background:${c.bg}">
        <span class="bar" style="background:${c.bar};color:${c.barText};font-family:${c.font};box-shadow:inset 0 -1px 0 ${c.border}">${esc(c.sample)}</span>
        <span class="body"><span class="ln" style="background:${c.lane}"><span class="cd" style="background:${c.panel};box-shadow:inset 0 0 0 1px ${c.border}"></span><span class="cd" style="background:${c.panel};box-shadow:inset 0 0 0 1px ${c.border}"></span></span>
        <span class="pn" style="background:${c.panel};box-shadow:inset 0 0 0 1px ${c.border}"><span class="t1" style="background:${c.text}"></span><span class="t2" style="background:${c.muted}"></span><span class="bt" style="background:${c.accent}"></span></span></span>
      </span>`).join('')}</span>
      <svg class="ck" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>
    </button>`;
  }).join('');
  const renderDlg = () => {
    armed = null; // Redrawing resets the button label, so also clear any pending "press again"
    dlg.innerHTML = `
      <h2>${tr('settings')}</h2>
      <div class="settings-body">
        <nav class="settings-nav">
          <div class="settings-group" role="group" aria-labelledby="agent-settings-heading">
            <div class="settings-group-title" id="agent-settings-heading">${tr('nav.agent')}</div>
            <div class="settings-submenu">${['run', 'targets', 'prompts', 'claude', 'roadmap'].map((p) => `<button data-pane="agent-${p}" class="${pane === `agent-${p}` ? 'on' : ''}">${p === 'claude' ? tr('toolSettings', { tool: 'Claude' }) : p === 'roadmap' ? tr('tab.roadmap') : tr(`agent.${p}`)}</button>`).join('')}</div>
          </div>
          ${['refresh', 'lang', 'theme', 'terms', 'account'].map((p) => `<button data-pane="${p}" class="${p === pane ? 'on' : ''}">${tr(`nav.${p}`)}</button>`).join('')}
        </nav>
        <div class="settings-pane" data-pane-body="agent-run">
          <h3>${tr('agent.run')}</h3>
          <div class="form-row"><label>${tr('s.concurrent')}</label><input data-cfg="maxConcurrent" type="number" min="1" value="${esc(cfg.maxConcurrent)}"></div>
          <h4>${tr('sec.logs')}</h4>
          <div class="form-row"><label title="${esc(tr('s.logKeep.title'))}">${tr('s.logKeep')}</label><input data-cfg="logKeepDays" type="number" min="1" value="${esc(cfg.logKeepDays ?? 30)}"></div>
          <div class="form-row"><label>${tr('logs.stats', { count: logs.count, size: fmtBytes(logs.bytes) })}</label><span>
            <button data-logs-clear="old">${tr('logs.clearOld', { n: esc(cfg.logKeepDays ?? 30) })}</button>
            <button data-logs-clear="all">${tr('logs.clearAll')}</button>
          </span></div>
          ${resetBtn('agent-run')}
          <p><button data-pane-reset="agent">${tr('resetAgentAll')}</button></p>
        </div>
        <div class="settings-pane" data-pane-body="agent-targets">
          <h3>${tr('agent.targets')}</h3>
          <div class="form-row"><label>${tr('workdir')}</label><input data-cfg="workdir" value="${esc(cfg.workdir)}"></div>
          <h4>${tr('sec.repos')}</h4>
          <div class="form-row"><label>${tr('s.repos')}</label><textarea data-cfg="repos" rows="4" placeholder="docket/webapp">${esc(Object.keys(cfg.repos).join('\n'))}</textarea></div>
          <div data-repo-workdirs>${repoWorkdirs()}</div>
          <h4>${tr('sec.board')}</h4>
          <div class="form-row"><label>${tr('s.mergedDays')}</label><input data-cfg="mergedDays" type="number" min="0" value="${esc(cfg.mergedDays)}"></div>
          <div class="form-row"><label title="${esc(tr('s.doneKeep.title'))}">${tr('s.doneKeep')}</label><input data-cfg="doneKeepDays" type="number" min="1" value="${esc(cfg.doneKeepDays ?? 7)}"></div>
          <div class="form-row"><label>${tr('s.authors')}</label><textarea data-cfg="authors" rows="5" placeholder="alice&#10;dependabot[bot]">${esc((cfg.authors || []).join('\n'))}</textarea></div>
          ${resetBtn('agent-targets')}
        </div>
        <div class="settings-pane" data-pane-body="agent-prompts">
          <h3>${tr('agent.prompts')}</h3>
          <h4>${tr('s.reviewPrompt')}</h4>
          <p class="muted">${tr('s.reviewPrompt.help')}</p>
          <textarea data-cfg="reviewPrompt" rows="8" style="width:100%" placeholder="${esc(board.defaultPrompts[lang].reviewPrompt)}">${esc(ownPrompt(cfg, 'reviewPrompt'))}</textarea>
          <h4>${tr('s.fixPrompt')}</h4>
          <p class="muted">${tr('s.fixPrompt.help')}</p>
          <textarea data-cfg="fixPrompt" rows="10" style="width:100%" placeholder="${esc(board.defaultPrompts[lang].fixPrompt)}">${esc(ownPrompt(cfg, 'fixPrompt'))}</textarea>
          ${resetBtn('agent-prompts')}
        </div>
        <div class="settings-pane" data-pane-body="agent-roadmap">
          <h3>${tr('tab.roadmap')}</h3>
          <div class="form-row"><label>${tr('s.projects')}</label><textarea data-cfg="projects" rows="3" placeholder="https://github.com/orgs/acme/projects/1">${esc((cfg.projects || []).join('\n'))}</textarea></div>
          <div class="form-row"><label title="${esc(tr('s.sprintRange.title'))}">${tr('s.sprintPast')}</label><input data-cfg="sprintPast" type="number" min="0" value="${esc(cfg.sprintPast ?? 1)}"></div>
          <div class="form-row"><label>${tr('s.period')}</label><select data-cfg="roadmapPeriod">${['week', '2week', 'month'].map((v) => [v, tr(`unit.${v}`)]).map(([v, l]) => `<option value="${v}" ${(cfg.roadmapPeriod || 'month') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="form-row"><label title="${esc(tr('s.sprintRange.title'))}">${tr('s.sprintFuture')}</label><input data-cfg="sprintFuture" type="number" min="0" value="${esc(cfg.sprintFuture ?? 1)}"></div>
          <div class="form-row"><label>${tr('s.plansDir')}</label><input data-cfg="plansDir" value="${esc(cfg.plansDir ?? '')}" placeholder="~/docket-plans"></div>
          ${resetBtn('agent-roadmap')}
        </div>
        <div class="settings-pane" data-pane-body="agent-claude"><h3>${tr('toolSettings', { tool: 'Claude' })}</h3>
          <div data-agent-tools>${agentToolSettings()}</div>${resetBtn('agent-claude')}</div>
        <div class="settings-pane" data-pane-body="refresh">
          <h4>${tr('sec.screen')}</h4>
          <div class="form-row"><label>${tr('s.refresh')}</label><input data-cfg="refreshSeconds" type="number" min="1" value="${esc(cfg.refreshSeconds)}"></div>
          <h4>${tr('sec.fetch')}</h4>
          <div class="form-row"><label>${tr('s.poll')}</label><input data-cfg="pollMinutes" type="number" min="1" value="${esc(cfg.pollMinutes)}"></div>
          <div class="form-row"><label title="${esc(tr('s.pollHours.title'))}">${tr('s.pollHours')}</label><span><input data-cfg="pollStartHour" type="number" min="0" max="23" style="width:5em" value="${esc(cfg.pollStartHour ?? 9)}"> – <input data-cfg="pollEndHour" type="number" min="0" max="24" style="width:5em" value="${esc(cfg.pollEndHour ?? 19)}"></span></div>
          ${resetBtn('refresh')}
        </div>
        <div class="settings-pane" data-pane-body="lang">
          <div class="form-row"><label>${tr('s.uiLang')}</label><select data-ui-lang>${Object.entries(LANGS).map(([v, l]) => `<option value="${v}" ${uiLang === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="form-row"><label title="${esc(tr('s.outLang.title'))}">${tr('s.outLang')}</label><select data-cfg="outputLang">${Object.entries(LANGS).map(([v, l]) => `<option value="${v}" ${(cfg.outputLang || 'en') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="form-row"><label>${tr('s.authorLangs')}</label><div><textarea data-cfg="authorLangs" rows="4" placeholder="tanaka ja&#10;nguyen en">${esc(Object.entries(cfg.authorLangs || {}).map(([a, l]) => `${a} ${l}`).join('\n'))}</textarea><p class="muted" style="margin:4px 0 0">${tr('s.authorLangs.hint')}</p></div></div>
          <div class="form-row"><label title="${esc(tr('s.agreeIcon.title'))}">${tr('s.agreeIcon')}</label><input data-cfg="agreeIcon" placeholder="🙆💭" style="width:8em" value="${esc(cfg.agreeIcon ?? '🙆💭')}"></div>
          <div class="form-row"><label title="${esc(tr('s.disagreeIcon.title'))}">${tr('s.disagreeIcon')}</label><input data-cfg="disagreeIcon" placeholder="🙅💭" style="width:8em" value="${esc(cfg.disagreeIcon ?? '🙅💭')}"></div>
          ${resetBtn('lang')}
        </div>
        <div class="settings-pane" data-pane-body="theme">
          <p class="muted">${tr('theme.help')}</p>
          <div class="theme-grid" role="radiogroup" aria-label="${esc(tr('nav.theme'))}">${themeCards()}</div>
          ${resetBtn('theme')}
        </div>
        <div class="settings-pane" data-pane-body="terms">
          <p class="muted">${tr('terms.help')}</p>
          ${termRows('review', LANES)}${termRows('receive', MINE_LANES)}
          ${resetBtn('terms')}
        </div>
        <div class="settings-pane" data-pane-body="account">
          <p>${esc(tr('account.signedInAs', { name: user || '' }))}</p>
          <p><button data-sign-out>${tr('account.signOut')}</button></p>
          <p class="muted">${tr('account.resetHelp')}</p>
          <p><code>node server.js --reset-password</code></p>
        </div>
      </div>
      <div class="dlg-foot"><button data-export>${tr('cfg.export')}</button><button data-import-pick>${tr('cfg.import')}</button><input type="file" accept=".json,application/json" data-import hidden><span style="flex:1"></span><button class="primary" data-save>${tr('save')}</button></div>`;
    dlg.querySelector(`[data-pane-body="${pane}"]`).classList.add('on');
  };

  dlg.oninput = (ev) => {
    const t = ev.target;
    if (t.matches('[data-ui-lang]')) uiLang = t.value;
    if (t.dataset.term) terms[t.dataset.term] = t.value;
    if (t.dataset.cfg === 'repos') {
      const names = t.value.split('\n').map((s) => s.trim()).filter((s) => /^[\w.-]+\/[\w.-]+$/.test(s));
      Object.assign(known, cfg.repos);
      cfg.repos = Object.fromEntries(names.map((r) => [r, known[r] || { args: '{pr-number}' }]));
      dlg.querySelector('[data-repo-workdirs]').innerHTML = repoWorkdirs();
      dlg.querySelector('[data-agent-tools]').innerHTML = agentToolSettings();
    } else if (t.dataset.cfg === 'authorLangs') {
      // Pick only "login language" lines. Drop lines whose language is not ja / ko / en
      cfg.authorLangs = Object.fromEntries(t.value.split('\n').map((s) => s.trim().split(/\s+/)).filter(([a, l]) => a && LANGS[l]));
    } else if (['authors', 'projects', 'runDomains'].includes(t.dataset.cfg)) cfg[t.dataset.cfg] = t.value.split('\n').map((s) => s.trim()).filter(Boolean);
    else if (t.dataset.cfg) cfg[t.dataset.cfg] = t.type === 'number' ? Number(t.value) : t.type === 'checkbox' ? t.checked : t.value;
    if (t.dataset.cfg === 'logKeepDays') dlg.querySelector('[data-logs-clear="old"]').textContent = tr('logs.clearOld', { n: t.value });
    if (t.dataset.repo) cfg.repos[t.dataset.repo][t.dataset.field] = t.type === 'checkbox' ? t.checked : t.value;
    if (t.dataset.repo) for (const el of dlg.querySelectorAll('[data-preview]')) {
      const [r, field] = el.dataset.preview.split('|');
      if (r === t.dataset.repo) el.textContent = preview(r, field);
    }
  };
  // Refetch skill candidates when the working directory changes
  dlg.onchange = async (ev) => {
    // Only loads another PC's settings into the inputs; "Save" applies them (the server also filters with sanitizeConfig)
    if (ev.target.matches('[data-import]')) {
      const file = ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      let skipped = [];
      const localRepos = cfg.repos;
      try {
        const data = JSON.parse(await file.text());
        const kind = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
        // A shared file must not change what runs or where: agent args, tools and local folders stay as they are
        const LOCAL = ['claudeArgs', 'readOnlyTools', 'skillEdits', 'runLocalhost', 'runDomains', 'runEnv', 'runBrowser', 'workdir', 'plansDir'];
        const imported = data.config && typeof data.config === 'object' ? data.config : {};
        skipped = Object.keys(imported).filter((k) => LOCAL.includes(k));
        for (const [k, v] of Object.entries(imported)) if (k in board.defaults && k !== 'consentVersion' && !LOCAL.includes(k) && kind(v) === kind(board.defaults[k])) cfg[k] = v;
        if (kind(imported.repos) === 'object') {
          for (const [r, m] of Object.entries(cfg.repos)) {
            if (!m || typeof m !== 'object') continue;
            if (m.cwd) skipped.push(`${r} cwd`);
            delete m.cwd;
            if (localRepos[r]?.cwd) m.cwd = localRepos[r].cwd;
            // Registry access of a run stays as set on this PC
            if (m.network) skipped.push(`${r} network`);
            delete m.network;
            if (localRepos[r]?.network) m.network = true;
          }
        }
        if (data.terms && typeof data.terms === 'object') terms = data.terms;
        if (LANGS[data.uiLang]) uiLang = data.uiLang;
        if (typeof data.theme === 'string') setTheme(data.theme);
        skills = await fetchSkills();
      } catch {
        return toast(tr('cfg.badFile'));
      }
      renderDlg();
      if (skipped.length) toast(tr('cfg.importSkipped', { keys: skipped.join(', ') }));
      return toast(tr('cfg.imported'), true);
    }
    if (ev.target.dataset.cfg !== 'workdir' && ev.target.dataset.field !== 'cwd') return;
    try {
      skills = await fetchSkills();
    } catch (e) {
      return toast(e.message);
    }
    renderDlg();
  };
  dlg.onclick = async (ev) => {
    const t = ev.target;
    // A redraw would reformat the textarea being edited, so only toggle visibility
    if (t.dataset.themePick !== undefined) return setTheme(t.dataset.themePick);
    if (t.dataset.signOut !== undefined) {
      await api('/api/auth/logout', { method: 'POST' });
      return location.reload();
    }
    if (t.dataset.pane) {
      pane = t.dataset.pane;
      for (const el of dlg.querySelectorAll('[data-pane], [data-pane-body]')) el.classList.toggle('on', (el.dataset.pane || el.dataset.paneBody) === pane);
      return;
    }
    // "Old ones" are removed using the retention days currently in the input (unsaved)
    const clear = t.dataset.logsClear;
    if (clear) {
      if (!confirmTwice(t, `logs-clear:${clear}`, tr('confirmDelete'))) return;
      try {
        const { removed, ...rest } = await api('/api/logs/clear', { method: 'POST', body: clear === 'all' ? { all: true } : { days: cfg.logKeepDays } });
        logs = rest;
        renderDlg(); // Toasts go inside the open dialog, so redraw first, then show it
        toast(tr('logs.cleared', { count: removed.count, size: fmtBytes(removed.bytes) }), true);
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    // Nothing applies until saved, so reset the current pane's inputs to defaults without confirmation
    const reset = t.dataset.paneReset;
    if (reset) {
      if (reset === 'terms') terms = {};
      if (reset === 'theme') return setTheme('');
      if (reset === 'lang') uiLang = browserLang();
      for (const k of PANE_KEYS[reset] || []) cfg[k] = structuredClone(board.defaults[k]);
      if (reset === 'agent-claude') {
        for (const [repo, mapping] of Object.entries(cfg.repos)) {
          const defaults = board.defaults.repos[repo] || {};
          for (const key of ['skill', 'args', 'selfSkill', 'selfArgs', 'fixSkill', 'fixArgs', 'setup', 'network']) {
            if (key in defaults) mapping[key] = defaults[key];
            else delete mapping[key];
          }
        }
      }
      if (reset === 'agent' || reset === 'agent-targets') skills = await fetchSkills(); // because the working directory changes
      renderDlg();
      return;
    }
    if (t.matches('[data-import-pick]')) return dlg.querySelector('[data-import]').click();
    if (t.matches('[data-export]')) {
      // runEnv may hold passwords: it stays on this machine
      const { consentVersion, runEnv: _env, ...config } = cfg;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify({ config, terms, uiLang, theme: uiTheme }, null, 2)], { type: 'application/json' }));
      a.download = 'docket-settings.json';
      a.click();
      URL.revokeObjectURL(a.href);
      return;
    }
    if (t.matches('[data-save]')) {
      // On failure, keep the dialog open with the inputs intact and notify
      try {
        await api('/api/config', { method: 'PUT', body: { ...cfg, uiLang } });
      } catch (err) {
        return toast(err.message);
      }
      saveLaneNames(terms);
      if (uiLang !== lang) {
        try { localStorage.setItem('docket-lang', uiLang); } catch {}
        return location.reload();
      }
      await load();
      toast(tr('saved'), true);
    }
  };
  renderDlg();
}

// Colors for the Settings "Screen theme" samples. Keep in sync with CSS :root[data-theme]
const THEME_PREVIEW = {
  light: { bg: '#f6f8fa', panel: '#ffffff', lane: '#eef1f4', border: '#d0d7de', text: '#1f2328', muted: '#656d76', accent: '#0969da', bar: '#ffffff', barText: '#1f2328', font: 'inherit', sample: 'docket-gits' },
  dark: { bg: '#0d1117', panel: '#161b22', lane: '#10151c', border: '#30363d', text: '#e6edf3', muted: '#8d96a0', accent: '#2f81f7', bar: '#161b22', barText: '#e6edf3', font: 'inherit', sample: 'docket-gits' },
  green: { bg: '#0b1410', panel: '#111d17', lane: '#0e1913', border: '#24412f', text: '#d6f2e0', muted: '#8fb39d', accent: '#2bff88', bar: '#0b1410', barText: '#2bff88', font: "'Barlow Condensed', sans-serif", sample: 'DOCKET-GITS' },
  g6: { bg: '#e2e2e0', panel: '#f1f1ef', lane: '#e9e9e7', border: '#8a8a88', text: '#1b1b1b', muted: '#4f4f4f', accent: '#1b1b1b', bar: '#1b1b1b', barText: '#f1f1ef', font: "'Fusion Pixel KO', monospace", sample: '[docket-gits]' },
};

// Date (YYYY-MM-DD) math, and today (local time)
const spDay = (d, n = 0) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const spToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

