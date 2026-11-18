// ---------- Plan (Draft) ----------
// Build an issue tree as a plan in an md file and apply it to GitHub in one go. Edits on screen are written to md immediately
const PL_DAY = 24; // width of one day
const PL_TREE = 320; // width of the issue name column on the left
const PL_DEPTH = 6; // up to the md heading depth
const PL_FIELDS = ['labels', 'milestone', 'sprint']; // fields that can be added with "+" in details
const PL_FILTERS = ['repo', 'as', 'st', 'state', ...PL_FIELDS]; // fields that can be added with "+" in filters
const pl = { fieldSetup: false, list: null, dir: '', doc: null, opts: null, titles: {}, ranges: null, live: null, f: { repo: '', as: '', st: '', state: '' }, fx: new Set(), filterMenu: false, addMenu: null, sel: new Set(), anchor: null, collapsed: new Set(), extra: {}, fieldMenu: false, bulk: null, range: null, drag: null, error: null, saveTimer: null, saving: Promise.resolve(), seq: 0 };
const plGet = (k) => { try { return localStorage.getItem(`docket-plan:${k}`); } catch { return null; } };
const plSet = (k, v) => { try { localStorage.setItem(`docket-plan:${k}`, v); } catch {} };
const plProject = () => {
  const list = board.config.projects || [];
  return list.includes(plGet('project')) ? plGet('project') : list[0];
};
const plFile = () => plGet(`file:${plProject()}`);
const plQuery = (extra = {}) => new URLSearchParams({ project: plProject(), ...extra });
const plNodes = () => pl.doc?.plan.nodes || [];
const plAll = () => {
  const out = [];
  const walk = (nodes, p, d) => nodes.forEach((n) => { out.push({ n, p, d }); walk(n.children, n, d + 1); });
  walk(plNodes(), null, 0);
  return out;
};
const plFind = (id) => plAll().find((x) => x.n.id === id);
// Visible rows (excluding descendants of collapsed parents and issues not matching the filter). dim = ancestors kept because a descendant matches
const plRows = () => {
  const keep = plKeep();
  const out = [];
  const walk = (nodes, p, d) => nodes.forEach((n) => {
    if (keep && !keep.has(n.id)) return;
    out.push({ n, p, d, dim: keep?.get(n.id) === 'dim' });
    if (!pl.collapsed.has(n.id)) walk(n.children, n, d + 1);
  });
  walk(plNodes(), null, 0);
  return out;
};

// Selection in "Sprint · Period" ({ kind: 's' | 'p', title, startDate, endDate }). null if nothing selected
const plWindowKey = () => `range:${plProject()}`;
function plWindow() {
  const v = plGet(plWindowKey()) || '';
  if (!pl.ranges || !v) return null;
  const id = v.slice(2);
  const hit = v[0] === 's' ? pl.ranges.sprints.find((x) => x.id === id) : pl.ranges.periods.find((x) => x.id === id);
  return hit ? { kind: v[0], ...hit } : null;
}
const plOverlap = (start, end, w) => start <= w.endDate && end >= w.startDate;
const plInWindow = (n, w) => !w || (w.kind === 's' ? n.sprint === w.title : !!plSpan(n) && plOverlap(plSpan(n).start, plSpan(n).end, w));
const plPlanInWindow = (p, w) => !w || (w.kind === 's' ? p.sprints.includes(w.title) : p.spans.some(([a, b]) => plOverlap(a, b, w)));
const plPeriodLabel = (x) => (pl.ranges.unit === 'month' ? new Date(`${x.startDate}T00:00:00Z`).toLocaleDateString(lang, { year: 'numeric', month: 'long', timeZone: 'UTC' })
  : tr(pl.ranges.unit === 'week' ? 'period.week' : 'period.2week', { date: new Date(`${x.startDate}T00:00:00Z`).toLocaleDateString(lang, { month: 'numeric', day: 'numeric', timeZone: 'UTC' }) }));

const plVals = (n, k) => [n[k]].flat().filter(Boolean);
// Project fields offered as filters (key "cf:<name>"). Status has its own filter, and the chosen date / sprint fields are the plan's own values
const plCustom = () => {
  const r = pl.ranges;
  const own = new Set(['Status', r?.choice.start, r?.choice.end, r?.choice.sprint].filter(Boolean));
  return (r?.fields || []).filter((f) => !own.has(f.name));
};
const plCustomOf = (k) => k.startsWith('cf:') && plCustom().find((f) => f.name === k.slice(3));
const plFilterKeys = () => [...PL_FILTERS, ...plCustom().map((f) => `cf:${f.name}`)];
// Text and Date / Number fields are typed in; every other filter is a multiSelect whose pl.f value is the list of hidden values
const plTyped = (k) => ['TEXT', 'DATE', 'NUMBER'].includes(plCustomOf(k)?.type);
// Status, open/closed and Project fields exist only for issues on GitHub
const plLiveKey = (k) => k === 'st' || k === 'state' || k.startsWith('cf:');
// Values of a node for a multiSelect filter (NONE = unset)
function plValuesOf(k, n, g) {
  const one = (v) => [v === undefined || v === null || v === '' ? NONE : String(v)];
  if (k === 'repo') return [n.repo || pl.doc.plan.repo];
  if (k === 'as') return n.assignees.length ? n.assignees : [NONE];
  if (k === 'st') return one(g?.status);
  if (k === 'state') return [!g || g.state === 'OPEN' ? 'OPEN' : 'CLOSED'];
  if (k.startsWith('cf:')) return one(g?.fields?.[k.slice(3)]);
  return plVals(n, k).length ? plVals(n, k) : [NONE];
}
// Choices of a multiSelect filter as [value, label]
function plOptsOf(k) {
  const nodes = plAll().map(({ n }) => n);
  const unset = [NONE, tr('unset')];
  const sorted = (vs) => [...new Set(vs.filter(Boolean))].sort();
  if (k === 'repo') return sorted([pl.doc.plan.repo, ...nodes.map((n) => n.repo)]).map((r) => [r, r.split('/')[1]]);
  if (k === 'as') return [...sorted(nodes.flatMap((n) => n.assignees)).map((a) => [a, a]), unset];
  if (k === 'st') return [...(pl.ranges?.statuses || []).map((x) => [x, x]), unset];
  if (k === 'state') return [['OPEN', 'Open'], ['CLOSED', 'Closed']];
  if (k.startsWith('cf:')) return [...(plCustomOf(k)?.options || []).map((o) => [o, o]), unset];
  return [...sorted(nodes.flatMap((n) => plVals(n, k))).map((v) => [v, v]), unset];
}
// Does a typed Project field value match? Text: contains; Date / Number: "from..to" (either end may be empty)
function plMatch(f, v, want) {
  if (v === undefined) return false;
  if (f.type === 'TEXT') return String(v).toLowerCase().includes(want.toLowerCase());
  const [a, b] = want.split('..');
  const num = (x) => (f.type === 'NUMBER' ? Number(x) : x);
  return (!a || num(v) >= num(a)) && (!b || num(v) <= num(b));
}
// When filtering, a Map of matching issues ('hit') and ancestors with matching descendants ('dim'). null if no filter
// Live filters only apply once the plan has issues on GitHub (Draft issues lack the values)
function plKeep() {
  const w = plWindow();
  const f = pl.f;
  const iss = plHasIssues();
  const keys = plFilterKeys().filter((k) => f[k]?.length && (iss || !plLiveKey(k)));
  if (!w && !keys.length) return null;
  const hit = (n) => {
    const g = plLive(n);
    return plInWindow(n, w) && keys.every((k) => (plTyped(k) ? plMatch(plCustomOf(k), g?.fields?.[k.slice(3)], f[k])
      : plValuesOf(k, n, g).some((v) => !f[k].includes(v))));
  };
  const keep = new Map();
  const walk = (n) => {
    const any = n.children.map(walk).some(Boolean);
    const h = hit(n);
    if (h || any) keep.set(n.id, h ? 'hit' : 'dim');
    return h || any;
  };
  plNodes().forEach(walk);
  return keep;
}
const plNewId = () => `c${Date.now().toString(36)}${++pl.seq}`;
const plDescendants = (n) => n.children.flatMap((c) => [c, ...plDescendants(c)]);
const plAvatar = (login) => pl.opts?.assignees.find((a) => a.login === login)?.avatarUrl || `https://github.com/${encodeURIComponent(login)}.png?size=40`;
const plIssueUrl = (n) => `https://github.com/${n.repo || pl.doc.plan.repo}/issues/${n.issue}`;
// Key that identifies an issue across plans, and the key of the server's changed (issues in the plan's repo use just the number)
const plKey = (n) => `${n.repo || pl.doc.plan.repo}#${n.issue}`;
const plSyncKey = (n) => (n.repo && n.repo !== pl.doc.plan.repo ? `${n.repo}#${n.issue}` : String(n.issue));
const plChanged = (n) => !!n.issue && pl.doc.changed.includes(plSyncKey(n));
// Fields changed both in the plan and on GitHub (field -> GitHub value)
const plConflict = (n) => (n.issue && pl.doc.conflicts?.[plSyncKey(n)]) || null;
const plFieldLabel = (f) => ({ title: tr('pl.title'), assignees: tr('sp.assignee'), labels: tr('pl.f.labels'), milestone: tr('pl.f.milestone'), sprint: tr('sp.sprint'), start: tr('pl.start'), end: tr('pl.end') })[f];
const plFieldText = (v) => (Array.isArray(v) ? v.join(', ') : v) || tr('none');
// Current Status, open state and PRs of issues that exist on GitHub
const plLive = (n) => (n.issue && pl.live?.issues[plKey(n)]) || null;
const plHasIssues = () => plAll().some(({ n }) => n.issue);
// Issues to create on GitHub, and issues changed after applying
const plTargets = () => plAll().filter(({ n }) => !n.issue || plChanged(n));

async function loadPlans() {
  const url = plProject();
  pl.error = null;
  if (!url) return renderPlan();
  try {
    const res = await api(`/api/plans?${plQuery()}`);
    // If the project was switched while waiting, do not overwrite the current project's memory with the old list
    if (plProject() !== url) return;
    pl.list = res.plans;
    pl.dir = res.dir;
    if (pl.ranges?.project !== url) loadPlanRanges(url);
    const file = plFile();
    const open = pl.list.find((p) => p.file === file) || pl.list[0];
    if (open) await openPlan(open.file, false);
    else pl.doc = null;
  } catch (e) {
    if (plProject() !== url) return;
    pl.error = e.message;
  }
  renderPlan();
}

// When plans are selected in quick succession, open only the last one
let plOpenSeq = 0;
async function openPlan(file, render = true) {
  const seq = ++plOpenSeq;
  const url = plProject();
  const stale = () => seq !== plOpenSeq || plProject() !== url;
  await plFlush();
  if (stale()) return;
  plSet(`file:${url}`, file);
  const doc = await api(`/api/plan?${plQuery({ file })}`);
  if (stale()) return;
  pl.doc = doc;
  pl.sel.clear();
  pl.anchor = null;
  pl.bulk = null;
  pl.extra = {};
  pl.live = null;
  pl.addMenu = null;
  loadPlanOptions();
  loadPlanLive();
  if (render) renderPlan();
}

// Options for "Sprint · Period" (Project sprints and periods of the unit set in settings)
async function loadPlanRanges(url, refresh = false) {
  try {
    const ranges = await api(`/api/plan/ranges?${new URLSearchParams({ project: url, ...(refresh && { refresh: '1' }) })}`);
    if (ranges.title) pl.titles[url] = ranges.title;
    if (plProject() !== url) return;
    const setup = plSetupOpen();
    pl.ranges = { ...ranges, project: url };
    if (setup !== plSetupOpen() || setup) renderPlan();
    else plRefresh(['side', 'body']);
  } catch {}
}

// Current state of plan issues. Like the Project cache, refetched only when ↻ is pressed (or when there is no cache)
// On refetch the server pulls values changed on GitHub into the plan, so reload the plan
async function loadPlanLive(refresh = false) {
  const doc = pl.doc;
  if (!doc) return;
  try {
    if (refresh) await plFlush();
    const live = await api(`/api/plan/live?${plQuery({ file: doc.file, ...(refresh && { refresh: '1' }) })}`);
    if (pl.doc !== doc) return;
    pl.live = live;
    const p = live.pulled;
    if (p && (p.updated || p.added || p.conflicts)) {
      // Reselect the previously selected issue by number (node ids change on reload)
      const keys = new Set([...pl.sel].map((id) => plFind(id)?.n).filter((n) => n?.issue).map(plKey));
      const [next, list] = await Promise.all([api(`/api/plan?${plQuery({ file: doc.file })}`), api(`/api/plans?${plQuery()}`)]);
      if (pl.doc !== doc) return;
      pl.doc = next;
      pl.list = list.plans;
      pl.sel = new Set(plAll().filter(({ n }) => n.issue && keys.has(plKey(n))).map(({ n }) => n.id));
      pl.bulk = null;
      const msg = [...(p.updated || p.added ? [tr('pl.pulled', p)] : []), ...(p.conflicts ? [tr('pl.conflicts', { n: p.conflicts })] : [])].join('\n');
      toast(msg, !p.conflicts);
      return renderPlan();
    }
    plRefresh(['body', 'detail']);
  } catch (e) {
    if (refresh) toast(e.message);
  }
}

async function loadPlanOptions() {
  const repo = pl.doc?.plan.repo || '';
  try {
    const opts = await api(`/api/plan/options?${plQuery({ repo })}`);
    // The sidebar project name is also available here
    if (pl.doc?.plan.repo === repo) { pl.opts = opts; plRefresh(['side', 'detail', 'bulk', 'body']); }
  } catch {}
}

// Batch writes while typing continues. Wait for the previous save so saves land in order
function plSave() {
  clearTimeout(pl.saveTimer);
  pl.saveTimer = setTimeout(plFlush, 400);
}
function plFlush() {
  clearTimeout(pl.saveTimer);
  pl.saveTimer = null;
  const doc = pl.doc;
  if (!doc?.pending) return pl.saving;
  doc.pending = false;
  const plan = JSON.parse(JSON.stringify(doc.plan));
  pl.saving = pl.saving.then(async () => {
    try {
      const res = await api('/api/plan', { method: 'PUT', body: { project: plProject(), file: doc.file, plan } });
      // Keep using the tree on screen (switching to the ids the server reloaded would drop the selection)
      Object.assign(doc, { md: res.md, base: res.base, git: res.git, changed: res.changed, conflicts: res.conflicts, rel: res.rel });
      if (pl.doc === doc) plRefresh(['detail']);
      const item = pl.list?.find((p) => p.file === doc.file);
      if (item) item.title = doc.plan.title || doc.file;
      if (pl.doc === doc) plRefresh(['side', 'head', 'body']);
    } catch (e) {
      toast(e.message);
    }
  });
  return pl.saving;
}
const plEdited = (parts = ['head', 'body', 'detail', 'side']) => {
  pl.doc.pending = true;
  plSave();
  plRefresh(parts);
};

// Visible date range. Pad both ends, and keep it fixed while dragging (otherwise the bar drifts from the cursor)
function plRange() {
  if (pl.drag && pl.range) return pl.range;
  const today = spToday();
  const w = plWindow();
  const dates = [...plAll().flatMap(({ n }) => [n.start, n.end]), w?.startDate, w?.endDate].filter(Boolean);
  const min = dates.reduce((a, b) => (b < a ? b : a), today);
  const max = dates.reduce((a, b) => (b > a ? b : a), today);
  const from = spDay(min, -7);
  const days = Math.max(42, (Date.parse(max) - Date.parse(from)) / 86400000 + 22);
  return (pl.range = { from, days });
}
const plIdx = (d) => (Date.parse(d) - Date.parse(pl.range.from)) / 86400000;
const plSpan = (n) => (n.start || n.end) && { start: n.start || n.end, end: n.end || n.start };
const plMd = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

const plFiltering = () => Object.values(pl.f).some((v) => v?.length);
// Ask for the date and sprint fields before anything else on a project where they were never chosen
// (not when the Project could not be read: the roadmap still works, just without syncing those fields)
const plSetupOpen = () => !!pl.ranges?.readable && pl.ranges.project === plProject() && (pl.fieldSetup || !pl.ranges.chosen);
function renderPlan() {
  const el = $('#plan');
  // Use all the space left after the header and footer
  el.style.setProperty('--pl-top', `${document.querySelector('header').offsetHeight + $('#banner').offsetHeight}px`);
  el.style.setProperty('--pl-foot', `${document.querySelector('.site-foot').offsetHeight}px`);
  if (!(board.config.projects || []).length) {
    el.innerHTML = `<p class="muted">${tr('sp.noProjects')}</p>`;
    return;
  }
  const closed = plGet('side') === '0';
  el.innerHTML = `<aside class="pl-side${closed ? ' closed' : ''}${plFiltering() ? ' filtering' : ''}">${closed ? '' : `
      <div class="pl-side-top"><span class="ms-label">${tr('sideData')}</span><button class="pl-fold" data-pl-side="0">‹</button></div>
      <div class="pl-side-part" data-pl="filter"></div>`}
      <div class="pl-side-part" data-pl="side"></div></aside>
    <section class="pl-main">${plSetupOpen() ? '<div class="pl-setup" data-pl="setup"></div>' : pl.error ? `<div class="banner">${esc(pl.error)}</div>` : !pl.doc ? '' : `
      <div class="pl-head" data-pl="head"></div>
      <div data-pl="bulk"></div>
      <div class="pl-work"><div class="pl-body" data-pl="body"></div><aside class="pl-detail" data-pl="detail"></aside></div>
      <div class="pl-foot" data-pl="foot"></div>`}</section>`;
  plRefresh(['side', 'setup', 'head', 'filter', 'bulk', 'body', 'detail']);
}

// Do not redraw parts containing the focused input (focus and the typed value would be lost)
const PL_PARTS = { setup: () => plSetupHtml(), side: () => plSideHtml(), head: () => plHeadHtml(), filter: () => plFilterHtml(), bulk: () => plBulkHtml(), body: () => plBodyHtml(), detail: () => plDetailHtml(), foot: () => esc(pl.doc?.rel || '') };
function plRefresh(parts) {
  // The footer is redrawn with the headings, and filter candidates (assignees etc.) with the list
  const all = [...parts, ...(parts.includes('head') ? ['foot'] : []), ...(parts.includes('body') && !parts.includes('filter') ? ['filter'] : [])];
  for (const part of all) {
    const box = $(`#plan [data-pl="${part}"]`);
    if (!box || (!['side', 'setup'].includes(part) && !pl.doc)) continue;
    const a = document.activeElement;
    if (box.contains(a) && a.matches('input:not([type=checkbox]), textarea, select')) continue;
    const scroll = box.querySelector('.pl-road, .pl-md');
    const pos = scroll && [scroll.scrollLeft, scroll.scrollTop];
    const from = pl.range?.from;
    box.innerHTML = PL_PARTS[part]();
    const next = box.querySelector('.pl-road, .pl-md');
    // Scroll by however much the range start grew backward, so bars do not move on screen
    if (pos && from && next?.matches('.pl-road')) pos[0] += ((Date.parse(from) - Date.parse(pl.range.from)) / 86400000) * PL_DAY;
    if (pos && next) [next.scrollLeft, next.scrollTop] = pos;
  }
}

function plSetupHtml() {
  const r = pl.ranges;
  const of = (type) => r.fields.filter((f) => f.type === type);
  const sel = (k, type) => `<select data-pl-setup="${k}"><option value="">${tr('pl.notUsed')}</option>${of(type).map((f) => `<option value="${esc(f.name)}"${r.choice[k] === f.name ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</select>`;
  return `<h3>${tr('pl.fieldsTitle')} · ${esc(r.title || plProject())}</h3>
    <p>${tr('pl.fieldsHelp')}</p>
    ${of('DATE').length ? '' : `<p class="notice" role="status">${tr('pl.noDateFields')}</p>`}
    ${field(tr('pl.start'), sel('start', 'DATE'))}
    ${field(tr('pl.end'), sel('end', 'DATE'))}
    ${field(tr('sp.sprint'), sel('sprint', 'ITERATION'))}
    <div class="row"><button class="primary" data-pl-setup-save>${tr('pl.fieldsSave')}</button><button data-pl-setup-reload>${tr('pl.fieldsReload')}</button>${r.chosen ? `<button data-pl-setup-close>${tr('cancel')}</button>` : ''}</div>`;
}

async function plSaveFields() {
  const url = plProject();
  const pick = (k) => $(`#plan [data-pl-setup="${k}"]`).value || null;
  try {
    const ranges = await api('/api/plan/fields', { method: 'PUT', body: { project: url, start: pick('start'), end: pick('end'), sprint: pick('sprint') } });
    if (plProject() !== url) return;
    pl.ranges = { ...ranges, project: url };
    pl.fieldSetup = false;
    toast(tr('pl.fieldsSaved'), true);
    renderPlan();
    loadPlanLive(true);
  } catch (e) {
    toast(e.message);
  }
}

function plSideHtml() {
  if (plGet('side') === '0') return `<button class="pl-fold" data-pl-side="1" title="${esc(tr('pl.plans'))}">›</button><span class="pl-rail">${tr('pl.plans')}</span>`;
  const url = plProject();
  const projects = board.config.projects || [];
  const select = `<select data-pl-project title="${esc(url)}">${projects.map((u) => `<option value="${esc(u)}"${u === url ? ' selected' : ''}>${esc(pl.titles[u] || u.replace(/^.*github\.com\//, ''))}</option>`).join('')}</select>`;
  const item = (p) => `<button class="pl-item${p.file === pl.doc?.file ? ' on' : ''}" data-pl-open="${esc(p.file)}" title="${esc(p.file)}"><span class="t">${esc(p.title)}</span></button>`;
  const group = (label, list) => (list.length ? `<div class="grp">${label}</div>${list.map(item).join('')}` : '');
  // Show only plans with issues overlapping the selected sprint / period (keep open plans shown)
  const w = plWindow();
  const list = (pl.list || []).filter((p) => p.file === pl.doc?.file || plPlanInWindow(p, w));
  const cur = plGet(plWindowKey()) || '';
  const opt = (v, label) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const ranges = pl.ranges;
  const range = `<div><span class="ms-label">${tr('pl.range')}</span><select data-pl-range><option value="">${tr('all')}</option>${ranges?.sprints.length ? `<optgroup label="${esc(tr('sp.sprint'))}">${ranges.sprints.map((x) => opt(`s:${x.id}`, `${x.title} · ${plMd(x.startDate)} – ${plMd(x.endDate)}`)).join('')}</optgroup>` : ''}${ranges ? `<optgroup label="${esc(tr('sp.period'))}">${ranges.periods.map((x) => opt(`p:${x.id}`, plPeriodLabel(x))).join('')}</optgroup>` : ''}</select></div>`;
  return `<span class="ms-label side-sec">GitHub Projects</span>${select}
    ${ranges?.chosen ? `<button class="pl-new" data-pl-setup-open>⚙ ${tr('pl.fields')}</button>` : ''}
    ${range}
    <div class="pl-side-head"><b>${tr('pl.plans')}</b><button class="pl-new" data-pl-new>+ ${tr('pl.new')}</button></div>
    <div class="pl-list">${group('Draft', list.filter((p) => p.status !== 'applied'))}${group(tr('pl.applied'), list.filter((p) => p.status === 'applied'))}${!list.length && w ? `<p class="pl-none">${tr('pl.noneInRange')}</p>` : ''}</div>
    <div class="pl-dir">${esc(pl.dir)}</div>`;
}

function plHeadHtml() {
  const { plan } = pl.doc;
  const applied = plan.status === 'applied';
  const n = plTargets().length;
  const hasIssue = plAll().some(({ n: x }) => x.issue);
  // The repository can be changed as long as no issue has been created yet
  const repo = hasIssue ? `<span class="chip">${esc(plan.repo)}</span>`
    : `<select class="pl-repo" data-pl-repo>${plRepoOptions(plRepoCandidates(pl.opts?.fields), plan.repo)}</select>`;
  const label = !applied ? tr('pl.apply', { n }) : n ? tr('pl.update', { n }) : tr('pl.applied');
  return `<input class="pl-title" data-pl-title value="${esc(plan.title)}" aria-label="${esc(tr('pl.title'))}">
    ${applied ? `<span class="chip ok">${tr('pl.applied')}</span>` : '<span class="chip draft">Draft</span>'}
    ${repo}
    <span class="right"><button class="primary" data-pl-apply ${n ? '' : 'disabled'}>${label}</button></span>`;
}

function plFilterHtml() {
  const live = pl.live?.fetchedAt ? `<button class="refetch" data-pl-live title="${esc(new Date(pl.live.fetchedAt).toLocaleString(lang))} — ${esc(tr('sp.refetchTitle'))}"><span class="hint">↻ </span>${tr('fetchedAgo', { ago: ago(pl.live.fetchedAt) })}</button>` : '';
  const md = plGet('view') === 'md';
  const viewSec = (extra = '') => `<details class="side-fold side-view side-sec"${sideViewOpen() ? ' open' : ''}><summary><span class="ms-label">${tr('sideView')}</span></summary>
    <div class="board-filters"><span class="seg"><button data-pl-view="timeline"${md ? '' : ' class="primary"'}>${tr('pl.timeline')}</button><button data-pl-view="md"${md ? ' class="primary"' : ''}>Markdown</button></span>${extra}</div></details>`;
  if (md) return live + viewSec();
  const iss = plHasIssues();
  const f = pl.f;
  // Showing everything at first is too much, so show only ones added with "+"
  const shown = (k) => pl.fx.has(k) || f[k]?.length;
  const label = (k) => ({ repo: tr('repo'), as: tr('sp.assignee'), st: 'Status', state: 'Open / Closed' })[k] || (plCustomOf(k) ? esc(plCustomOf(k).name) : plFieldLabel(k));
  // Text: contains. Date / Number: from - to. Everything else: multiSelect (unchecked = hidden)
  const control = (k) => {
    const off = !iss && plLiveKey(k);
    if (!plTyped(k)) {
      const hid = off ? [] : f[k] || [];
      const opts = plOptsOf(k);
      const on = opts.filter(([v]) => !hid.includes(v));
      // Assignees show avatars like the board's author filter
      const img = (v) => (k === 'as' && v !== NONE ? plAvatar(v) : undefined);
      const summary = on.length === opts.length ? tr('all') : !on.length ? tr('none')
        : k === 'as' && on.every(([v]) => v !== NONE) ? plAvatars(on.map(([v]) => v)) : esc(on.map(([, l]) => l).join(', '));
      return multiSelect(`plf:${k}`, label(k), summary, opts.map(([v, l]) => ({ value: v, text: l, img: img(v), disabled: off })), (v) => !hid.includes(v));
    }
    const dis = off ? ' disabled' : '';
    if (plCustomOf(k).type === 'TEXT') return field(label(k), `<input data-pl-filter="${esc(k)}" value="${esc(f[k] || '')}" placeholder="${esc(tr('pl.contains'))}"${dis}>`);
    const [a = '', b = ''] = (f[k] || '').split('..');
    const type = plCustomOf(k).type === 'DATE' ? 'date' : 'number';
    return field(label(k), `<span class="pl-range"><input type="${type}" data-pl-frange="${esc(k)}" value="${esc(a)}"${dis}><input type="${type}" data-pl-frange="${esc(k)}" value="${esc(b)}"${dis}></span>`);
  };
  const rest = plFilterKeys().filter((k) => !shown(k));
  return `${live}${viewSec(`<button data-pl-display>${tr('cardDisplay')}</button>`)}
    <details class="side-fold side-filter side-sec"${sideFilterOpen ? ' open' : ''}><summary><span class="ms-label">${tr('filter')}</span><span class="side-dot"></span></summary>
    <div class="board-filters">${plFilterKeys().filter(shown).map((k) => `<div class="pl-xf">${control(k)}<button data-pl-fdel="${esc(k)}" title="${esc(tr('pl.removeField'))}">×</button></div>`).join('')}
    ${rest.length ? `<div class="pl-addf"><button data-pl-fadd aria-expanded="${pl.filterMenu}">+</button>${pl.filterMenu ? `<div class="pop">${rest.map((k) => `<button data-pl-fadd-pick="${esc(k)}" title="${label(k)}">${label(k)}</button>`).join('')}</div>` : ''}</div>` : ''}</div></details>`;
}

function plBodyHtml() {
  if (plGet('view') === 'md') {
    // Mark lines changed since the last commit (skipped if not under git)
    const base = new Map();
    for (const l of pl.doc.base == null ? [] : pl.doc.base.split('\n')) base.set(l, (base.get(l) || 0) + 1);
    const lines = pl.doc.md.replace(/\n$/, '').split('\n').map((l) => {
      const left = base.get(l) || 0;
      if (left) base.set(l, left - 1);
      return `<span${pl.doc.git && !left ? ' class="add"' : ''}>${esc(l) || ' '}</span>`;
    });
    return `<pre class="pl-md">${lines.join('')}</pre>`;
  }
  const { from, days } = plRange();
  const today = spToday();
  const dayList = Array.from({ length: days }, (_, i) => spDay(from, i));
  const isWe = (d) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
  const w = plWindow();
  const out = (d) => w && (d < w.startDate || d > w.endDate);
  const head = dayList.map((d, i) => `<div class="${isWe(d) ? 'we' : ''}${d === today ? ' today' : ''}${out(d) ? ' out' : ''}">${i === 0 || d.endsWith('-01') ? new Date(`${d}T00:00:00Z`).toLocaleDateString(lang, { month: 'short', timeZone: 'UTC' }) : ''}<br>${Number(d.slice(8))}</div>`).join('');
  const bg = dayList.map((d, i) => (isWe(d) ? `<i class="we" style="left:${i * PL_DAY}px"></i>` : '')).join('')
    + (today >= from && plIdx(today) < days ? `<i class="today" style="left:${plIdx(today) * PL_DAY + PL_DAY / 2}px"></i>` : '')
    // Shade outside the selected sprint / period
    + (w ? `<i class="out" style="left:0;width:${Math.max(0, plIdx(w.startDate)) * PL_DAY}px"></i><i class="out" style="left:${Math.min(days, plIdx(w.endDate) + 1) * PL_DAY}px;width:${Math.max(0, days - plIdx(w.endDate) - 1) * PL_DAY}px"></i>` : '');
  const hide = new Set(cardHiddenOf('plan'));
  const rows = plRows().map(({ n, d, dim }) => {
    const g = plLive(n);
    const menu = pl.addMenu === n.id;
    const toggle = d && n.children.length ? `<span class="tg" data-pl-toggle="${esc(n.id)}">${pl.collapsed.has(n.id) ? '▸' : '▾'}</span>` : '<span class="tg"></span>';
    const avatars = hide.has('assignees') ? '' : n.assignees.map((a) => `<img class="avatar" src="${esc(plAvatar(a))}" alt="" title="${esc(a)}">`).join('');
    const changed = plChanged(n);
    const tree = `<div class="pl-tree" style="padding-left:${6 + d * 16}px">${toggle}<span class="pl-dot${n.issue ? ' iss' : ''}"></span>${avatars}
      <button class="pl-t${n.title ? '' : ' empty'}" data-pl-row="${esc(n.id)}">${esc(n.title || tr('pl.untitled'))}</button>
      ${plConflict(n) ? `<span class="chip bad">${tr('pl.conflict')}</span>` : changed ? `<span class="chip warn">${tr('pl.changed')}</span>` : ''}
      ${n.issue && !hide.has('number') ? `<a class="num" href="${esc(safeUrl(plIssueUrl(n)))}" target="docket-viewer">${n.repo ? esc(n.repo.split('/')[1]) : ''}#${n.issue}</a>` : ''}
      ${d + 1 < PL_DEPTH ? `<span class="pl-addw"><button class="pl-add" data-pl-menu="${esc(n.id)}" title="${esc(tr('pl.addChild'))}" aria-expanded="${menu}">+</button>${menu ? `<span class="pop"><button data-pl-add="${esc(n.id)}">${tr('pl.addNew')}</button><button data-pl-import="${esc(n.id)}">${tr('pl.import')}</button></span>` : ''}</span>` : ''}</div>`;
    const span = plSpan(n);
    let bar = '';
    if (span) {
      const len = plIdx(span.end) - plIdx(span.start) + 1;
      // Show the title on the bar so you need not look at the list (dates via the title attribute and details). Even short bars show the full title / PR, overflowing outside the bar
      bar = `<div class="pl-bar${n.issue ? ' iss' : ''}${changed ? ' changed' : ''}" data-pl-bar="${esc(n.id)}" style="left:${plIdx(span.start) * PL_DAY}px;width:${len * PL_DAY}px" title="${esc(`${span.start} – ${span.end}`)}"><i class="h l" data-pl-h="l"></i><span class="t">${esc(n.title || tr('pl.untitled'))}</span>${g?.status && !hide.has('status') ? `<span class="pl-st st st-${esc(String(g.color || '').toLowerCase())}">${esc(g.status)}</span>` : ''}${n.sprint && !hide.has('sprint') ? `<span class="pl-sp">${esc(n.sprint)}</span>` : ''}${hide.has('prs') ? '' : (g?.prs || []).map((pr) => `<span class="pl-pr ${esc(pr.kind)}">#${pr.number}</span>`).join('')}<i class="h r" data-pl-h="r"></i></div>`;
    }
    return `<div class="pl-row${d ? '' : ' d0'}${pl.sel.has(n.id) ? ' sel' : ''}${dim ? ' dim' : ''}${g?.state === 'CLOSED' ? ' closed' : ''}${menu ? ' menu' : ''}">${tree}<div class="pl-track" data-pl-track="${esc(n.id)}" style="width:${days * PL_DAY}px">${bar}</div></div>`;
  }).join('');
  // Top level is not collapsible (pointless). "Collapse all" collapses its direct children
  const foldable = plNodes().flatMap((r) => r.children).filter((n) => n.children.length);
  const allFolded = foldable.every((n) => pl.collapsed.has(n.id));
  const foldAll = foldable.length ? `<button class="fold-all" data-pl-fold="${allFolded ? 'open' : 'fold'}">${allFolded ? tr('sp.openAll') : tr('sp.foldAll')}</button>` : '';
  return `<div class="pl-road"><div class="pl-grid" style="--d:${PL_DAY}px;--tree:${PL_TREE}px;width:${PL_TREE + days * PL_DAY}px">
    <div class="pl-bg" style="left:${PL_TREE}px">${bg}</div>
    <div class="pl-hdr"><div class="pl-tree"><span>${tr('pl.issue')}</span>${foldAll}</div><div class="pl-days">${head}</div></div>
    ${rows || (plNodes().length ? `<p class="pl-none" style="padding:8px">${tr('pl.noRows')}</p>` : '')}
    ${plNodes().length ? '' : `<div class="pl-row add-root"><div class="pl-tree"><button class="pl-add" data-pl-add="">+ ${tr('pl.issue')}</button></div></div>`}
  </div></div>`;
}

// Assignees and labels are chosen with multiSelect. Values not in the candidates (written directly in md) are kept selectable
const plPeople = (extra = []) => [...new Set([...(pl.opts?.assignees || []).map((a) => a.login), ...extra])];
const plLabels = (extra = []) => [...new Set([...(pl.opts?.labels || []).map((l) => l.name), ...extra])];
const plAvatars = (list) => list.map((a) => `<img class="avatar" src="${esc(plAvatar(a))}" alt="" title="${esc(a)}">`).join('');
const plOptions = (values, current, empty) => `<option value="">${empty}</option>${[...new Set([...values, ...(current ? [current] : [])])].map((v) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(v)}</option>`).join('')}`;
const plRepoCandidates = (fields) => [...new Set([...(fields?.repos || []), ...Object.keys(board.config.repos || {})])];
// If unset, put an empty option first (so the first candidate does not look selected while not actually saved)
const plRepoOptions = (repos, current) => [...new Set([current || '', ...repos])].map((r) => `<option value="${esc(r)}"${r === current ? ' selected' : ''}>${esc(r)}</option>`).join('');
const plSprints = () => (pl.opts?.fields?.iterations || []).map((i) => i.title);

function plDetailHtml() {
  if (pl.sel.size !== 1) return '';
  const hit = plFind([...pl.sel][0]);
  if (!hit) return '';
  const { n } = hit;
  const shown = (f) => pl.extra[n.id]?.has(f) || (f === 'labels' ? n.labels.length : n[f]);
  const remove = (f) => `<button data-pl-unf="${f}" title="${esc(tr('pl.removeField'))}">×</button>`;
  const fieldHtml = {
    labels: () => multiSelect('pl-labels', tr('pl.f.labels'), n.labels.length ? esc(n.labels.join(', ')) : tr('none'), plLabels(n.labels).map((l) => ({ value: l, text: l })), (l) => n.labels.includes(l)),
    milestone: () => field(tr('pl.f.milestone'), `<select data-pl-f="milestone">${plOptions((pl.opts?.milestones || []).map((m) => m.title), n.milestone, tr('unset'))}</select>`),
    sprint: () => field(tr('sp.sprint'), `<select data-pl-f="sprint">${plOptions(plSprints(), n.sprint, tr('unset'))}</select>`),
  };
  const rest = PL_FIELDS.filter((f) => !shown(f));
  const fieldLabel = { labels: tr('pl.f.labels'), milestone: tr('pl.f.milestone'), sprint: tr('sp.sprint') };
  const g = plLive(n);
  const live = n.issue ? `<div class="pl-live"><a href="${esc(safeUrl(plIssueUrl(n)))}" target="docket-viewer">${esc(n.repo || '')}#${n.issue}</a>${g?.status ? `<span class="st st-${esc(String(g.color || '').toLowerCase())}">${esc(g.status)}</span>` : ''}${g?.state === 'CLOSED' ? '<span class="chip">Closed</span>' : ''}${(g?.prs || []).map((pr) => `<a class="pl-pr ${esc(pr.kind)}" href="${esc(safeUrl(pr.url))}" target="docket-viewer">#${pr.number}</a>`).join('')}</div>` : '';
  const c = plConflict(n);
  const conflict = c ? `<div class="pl-conflict"><b>${tr('pl.conflictHead')}</b>${Object.entries(c).map(([f, v]) => `<div class="r"><span class="k">${esc(plFieldLabel(f))}</span><span class="v">${esc(plFieldText(v))}</span><button data-pl-take="${f}">${tr('pl.takeGh')}</button></div>`).join('')}</div>` : '';
  return `${live}${conflict}${field(tr('pl.title'), `<input data-pl-f="title" value="${esc(n.title)}">`)}
    <div class="pl-dates">${field(tr('pl.start'), `<input type="date" data-pl-f="start" value="${esc(n.start || '')}">`)}${field(tr('pl.end'), `<input type="date" data-pl-f="end" value="${esc(n.end || '')}">`)}</div>
    ${multiSelect('pl-assignees', tr('sp.assignee'), n.assignees.length ? plAvatars(n.assignees) : tr('none'), plPeople(n.assignees).map((a) => ({ value: a, text: a, img: plAvatar(a) })), (a) => n.assignees.includes(a))}
    ${PL_FIELDS.filter(shown).map((f) => `<div class="pl-xf">${fieldHtml[f]()}${remove(f)}</div>`).join('')}
    ${rest.length ? `<div class="pl-addf"><button data-pl-addf aria-expanded="${pl.fieldMenu}">+</button>${pl.fieldMenu ? `<div class="pop">${rest.map((f) => `<button data-pl-addf-pick="${f}">${fieldLabel[f]}</button>`).join('')}</div>` : ''}</div>` : ''}
    ${n.issue ? `<a class="pl-body-link" href="${esc(safeUrl(plIssueUrl(n)))}" target="_blank" rel="noopener">${tr('pl.openBody')} ↗</a>`
    : field(tr('pl.body'), `<textarea data-pl-f="body" rows="10">${esc(n.body)}</textarea>`)}
    <div style="display:flex"><button data-pl-del style="margin-left:auto;color:var(--danger)" ${n.issue || !hit.p ? `disabled title="${esc(tr(n.issue ? 'pl.cantDelete' : 'pl.cantDeleteRoot'))}"` : ''}>${tr('pl.delete')}</button></div>`;
}

// Bulk input shown only when 2 or more are selected. Empty fields are left unchanged
function plBulkHtml() {
  if (pl.sel.size < 2) return '';
  const b = (pl.bulk ||= { start: '', end: '', assignees: null, labels: null, sprint: '' });
  const keep = tr('pl.keep');
  return `<div class="pl-bulk"><b>${tr('pl.selected', { n: pl.sel.size })}</b>
    ${field(tr('pl.start'), `<input type="date" data-pl-b="start" value="${esc(b.start)}">`)}
    ${field(tr('pl.end'), `<input type="date" data-pl-b="end" value="${esc(b.end)}">`)}
    ${multiSelect('pl-b-assignees', tr('sp.assignee'), !b.assignees ? keep : b.assignees.size ? plAvatars([...b.assignees]) : tr('none'), plPeople().map((a) => ({ value: a, text: a, img: plAvatar(a) })), (a) => !!b.assignees?.has(a))}
    ${multiSelect('pl-b-labels', tr('pl.f.labels'), !b.labels ? keep : b.labels.size ? esc([...b.labels].join(', ')) : tr('none'), plLabels().map((l) => ({ value: l, text: l })), (l) => !!b.labels?.has(l))}
    ${field(tr('sp.sprint'), `<select data-pl-b="sprint">${plOptions(plSprints(), b.sprint, keep)}</select>`)}
    <button class="primary" data-pl-bulk-apply>${tr('pl.bulkApply')}</button><button data-pl-bulk-clear>${tr('pl.clearSel')}</button></div>`;
}

function plApplyBulk() {
  const b = pl.bulk;
  for (const id of pl.sel) {
    const n = plFind(id)?.n;
    if (!n) continue;
    if (b.start) n.start = b.start;
    if (b.end) n.end = b.end;
    // If only one is set and the start date ends up after the end date, adjust the other
    if (n.start && n.end && n.start > n.end) b.start ? (n.end = n.start) : (n.start = n.end);
    if (b.assignees) n.assignees = [...b.assignees];
    if (b.labels) n.labels = [...b.labels];
    if (b.sprint) n.sprint = b.sprint;
  }
  pl.bulk = null;
  plEdited(['head', 'bulk', 'body', 'detail']);
}

function plSelect(id, ev) {
  if (ev.ctrlKey || ev.metaKey) {
    pl.sel.has(id) ? pl.sel.delete(id) : pl.sel.add(id);
    pl.anchor = id;
  } else if (ev.shiftKey && pl.anchor) {
    const ids = plRows().map(({ n }) => n.id);
    const [a, b] = [ids.indexOf(pl.anchor), ids.indexOf(id)].sort((x, y) => x - y);
    pl.sel = new Set(a < 0 ? [id] : ids.slice(a, b + 1));
  } else {
    pl.sel = new Set([id]);
    pl.anchor = id;
  }
  if (pl.sel.size < 2) pl.bulk = null;
  pl.fieldMenu = false;
  plRefresh(['bulk', 'body', 'detail']);
}

function plAdd(parentId) {
  const node = { id: plNewId(), title: '', body: '', issue: null, start: null, end: null, assignees: [], labels: [], milestone: null, sprint: null, children: [] };
  const parent = parentId && plFind(parentId)?.n;
  (parent ? parent.children : pl.doc.plan.nodes).push(node);
  if (parent) pl.collapsed.delete(parent.id);
  pl.sel = new Set([node.id]);
  pl.anchor = node.id;
  pl.bulk = null;
  plEdited(['head', 'bulk', 'body', 'detail']);
  $('#plan [data-pl-f="title"]')?.focus();
}

$('#plan').addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.closest('a[target]')) return;
  const side = t.closest('[data-pl-side]');
  if (side) { plSet('side', side.dataset.plSide); return renderPlan(); }
  const open = t.closest('[data-pl-open]');
  if (open) return openPlan(open.dataset.plOpen).catch((e) => toast(e.message));
  if (t.closest('[data-pl-new]')) return openNewPlan();
  if (t.closest('[data-pl-setup-open]')) { pl.fieldSetup = true; return renderPlan(); }
  if (t.closest('[data-pl-setup-close]')) { pl.fieldSetup = false; return renderPlan(); }
  if (t.closest('[data-pl-setup-save]')) return plSaveFields();
  if (t.closest('[data-pl-setup-reload]')) return loadPlanRanges(plProject(), true);
  const v = t.closest('[data-pl-view]');
  if (v) { plSet('view', v.dataset.plView); return plRefresh(['head', 'body']); }
  if (t.closest('[data-pl-apply]')) return openApplyPlan();
  const fold = t.closest('[data-pl-fold]');
  if (fold) {
    if (fold.dataset.plFold === 'open') pl.collapsed.clear();
    else plNodes().forEach((r) => r.children.forEach((n) => n.children.length && pl.collapsed.add(n.id)));
    return plRefresh(['body']);
  }
  const toggle = t.closest('[data-pl-toggle]');
  if (toggle) {
    const id = toggle.dataset.plToggle;
    pl.collapsed.has(id) ? pl.collapsed.delete(id) : pl.collapsed.add(id);
    return plRefresh(['body']);
  }
  const menu = t.closest('[data-pl-menu]');
  if (menu) {
    pl.addMenu = pl.addMenu === menu.dataset.plMenu ? null : menu.dataset.plMenu;
    return plRefresh(['body']);
  }
  const add = t.closest('[data-pl-add]');
  if (add) { pl.addMenu = null; return plAdd(add.dataset.plAdd); }
  const imp = t.closest('[data-pl-import]');
  if (imp) return openImportIssue(imp.dataset.plImport);
  if (t.closest('[data-pl-live]')) return loadPlanLive(true);
  if (t.closest('[data-pl-display]')) return openCardDisplay();
  const take = t.closest('[data-pl-take]');
  if (take) {
    const n = plFind([...pl.sel][0])?.n;
    const v = n && plConflict(n)?.[take.dataset.plTake];
    if (v === undefined) return;
    n[take.dataset.plTake] = Array.isArray(v) ? [...v] : v;
    return plEdited(['head', 'body', 'detail']);
  }
  const row = t.closest('[data-pl-row]');
  if (row) return plSelect(row.dataset.plRow, ev);
  if (t.closest('[data-pl-fadd]')) { pl.filterMenu = !pl.filterMenu; return plRefresh(['filter']); }
  const fadd = t.closest('[data-pl-fadd-pick]');
  if (fadd) { pl.fx.add(fadd.dataset.plFaddPick); pl.filterMenu = false; return plRefresh(['filter']); }
  const fdel = t.closest('[data-pl-fdel]');
  if (fdel) {
    pl.fx.delete(fdel.dataset.plFdel);
    pl.f[fdel.dataset.plFdel] = '';
    $('#plan .pl-side').classList.toggle('filtering', plFiltering());
    return plRefresh(['filter', 'body']);
  }
  if (t.closest('[data-pl-addf]')) { pl.fieldMenu = !pl.fieldMenu; return plRefresh(['detail']); }
  const pick = t.closest('[data-pl-addf-pick]');
  if (pick) {
    const id = [...pl.sel][0];
    (pl.extra[id] ||= new Set()).add(pick.dataset.plAddfPick);
    pl.fieldMenu = false;
    return plRefresh(['detail']);
  }
  const unf = t.closest('[data-pl-unf]');
  if (unf) {
    const n = plFind([...pl.sel][0])?.n;
    const f = unf.dataset.plUnf;
    pl.extra[n.id]?.delete(f);
    n[f] = f === 'labels' ? [] : null;
    return plEdited(['head', 'body', 'detail']);
  }
  if (t.closest('[data-pl-del]')) {
    const hit = plFind([...pl.sel][0]);
    if (!hit || hit.n.issue || !hit.p) return;
    const list = hit.p ? hit.p.children : pl.doc.plan.nodes;
    list.splice(list.indexOf(hit.n), 1);
    pl.sel.clear();
    return plEdited(['head', 'bulk', 'body', 'detail']);
  }
  if (t.closest('[data-pl-bulk-apply]')) return plApplyBulk();
  if (t.closest('[data-pl-bulk-clear]')) { pl.sel.clear(); pl.bulk = null; return plRefresh(['bulk', 'body', 'detail']); }
  // "Select all / Clear all" for assignees and labels
  const fBulk = t.closest('[data-ms^="plf:"] [data-ms-bulk]');
  if (fBulk) {
    const k = fBulk.closest('[data-ms]').dataset.ms.slice(4);
    pl.f[k] = fBulk.dataset.msBulk === 'all' ? [] : plOptsOf(k).map(([v]) => v);
    $('#plan .pl-side').classList.toggle('filtering', plFiltering());
    return plRefresh(['filter', 'body']);
  }
  const bulkMs = t.closest('[data-ms^="pl-"] [data-ms-bulk]');
  if (bulkMs) {
    const key = bulkMs.closest('[data-ms]').dataset.ms;
    const all = bulkMs.dataset.msBulk === 'all';
    const values = key.endsWith('labels') ? plLabels() : plPeople();
    if (key.startsWith('pl-b-')) {
      pl.bulk[key.slice(5)] = new Set(all ? values : []);
      return plRefresh(['bulk']);
    }
    const n = plFind([...pl.sel][0])?.n;
    if (n) n[key.slice(3)] = all ? values : [];
    return plEdited(['head', 'body', 'detail']);
  }
  if (pl.fieldMenu && !t.closest('.pl-addf')) { pl.fieldMenu = false; plRefresh(['detail']); }
  if (pl.filterMenu && !t.closest('.pl-addf')) { pl.filterMenu = false; plRefresh(['filter']); }
  if (pl.addMenu && !t.closest('.pl-addw')) { pl.addMenu = null; plRefresh(['body']); }
});

$('#plan').addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.matches('[data-pl-title]')) {
    pl.doc.plan.title = t.value;
    return plEdited(['side']);
  }
  const f = t.dataset.plF;
  if (f === 'title' || f === 'body') {
    plFind([...pl.sel][0]).n[f] = t.value;
    return plEdited(f === 'title' ? ['head', 'body'] : ['head']);
  }
});

$('#plan').addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.matches('[data-pl-project]')) { plSet('project', t.value); pl.doc = null; pl.list = null; pl.opts = null; pl.ranges = null; pl.fieldSetup = false; pl.f = { repo: '', as: '', st: '', state: '' }; pl.fx.clear(); return loadPlans(); }
  if (t.matches('[data-pl-frange]')) {
    const [a, b] = [...t.parentElement.querySelectorAll('input')].map((x) => x.value);
    pl.f[t.dataset.plFrange] = a || b ? `${a}..${b}` : '';
    $('#plan .pl-side').classList.toggle('filtering', plFiltering());
    return plRefresh(['body']);
  }
  if (t.matches('[data-pl-range]')) { plSet(plWindowKey(), t.value); return plRefresh(['side', 'body']); }
  if (t.matches('[data-pl-filter]')) {
    pl.f[t.dataset.plFilter] = t.value;
    $('#plan .pl-side').classList.toggle('filtering', plFiltering());
    return plRefresh(['filter', 'body']);
  }
  if (t.matches('[data-pl-repo]')) {
    pl.doc.plan.repo = t.value.trim();
    pl.opts = null;
    loadPlanOptions();
    return plEdited(['head']);
  }
  const n = pl.sel.size === 1 && plFind([...pl.sel][0])?.n;
  const f = t.dataset.plF;
  if (n && (f === 'start' || f === 'end')) {
    n[f] = t.value || null;
    if (n.start && n.end && n.start > n.end) f === 'start' ? (n.end = n.start) : (n.start = n.end);
    return plEdited(['head', 'body']);
  }
  if (n && (f === 'milestone' || f === 'sprint')) { n[f] = t.value || null; return plEdited(['head', 'body']); }
  const b = t.dataset.plB;
  if (b) { pl.bulk[b] = t.value; return; }
  const fms = t.closest('[data-ms^="plf:"]');
  if (fms && t.matches('[data-ms-value]')) {
    const k = fms.dataset.ms.slice(4);
    const hid = pl.f[k] || [];
    pl.f[k] = t.checked ? hid.filter((x) => x !== t.dataset.msValue) : [...hid, t.dataset.msValue];
    $('#plan .pl-side').classList.toggle('filtering', plFiltering());
    return plRefresh(['filter', 'body']);
  }
  const ms = t.closest('[data-ms^="pl-"]');
  if (ms && t.matches('[data-ms-value]')) {
    const key = ms.dataset.ms;
    const value = t.dataset.msValue;
    if (key.startsWith('pl-b-')) {
      const set = (pl.bulk[key.slice(5)] ||= new Set());
      t.checked ? set.add(value) : set.delete(value);
      return plRefresh(['bulk']);
    }
    const list = n[key.slice(3)];
    n[key.slice(3)] = t.checked ? [...list, value] : list.filter((x) => x !== value);
    return plEdited(['head', 'body', 'detail']);
  }
});

// Bar drag: body moves (Shift moves descendants too), ends change start / end date, on rows without a bar the dragged range becomes the period
$('#plan').addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  const track = ev.target.closest('[data-pl-track]');
  if (!track) return;
  const id = track.dataset.plTrack;
  const n = plFind(id)?.n;
  const span = plSpan(n);
  const bar = ev.target.closest('[data-pl-bar]');
  const mode = bar ? ev.target.dataset.plH || 'move' : 'create';
  const at = Math.floor((ev.clientX - track.getBoundingClientRect().left) / PL_DAY);
  const group = mode === 'move' && ev.shiftKey ? [n, ...plDescendants(n)] : [n];
  pl.drag = { id, mode, x: ev.clientX, at, moved: false, mods: { ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, shiftKey: ev.shiftKey && mode !== 'move' }, orig: group.map((x) => ({ n: x, start: x.start, end: x.end })), span };
  plRange();
  ev.preventDefault();
  document.activeElement?.blur(); // If focus stays in a details input, that field is not redrawn and shows a stale date
});
window.addEventListener('pointermove', (ev) => {
  const d = pl.drag;
  if (!d) return;
  const dd = Math.round((ev.clientX - d.x) / PL_DAY);
  if (!dd && !d.moved) return;
  // Dates only change per PL_DAY, so skip redraws until they do (rebuilding rows x days cells every time is heavy)
  if (d.moved && dd === d.lastDd) return;
  d.lastDd = dd;
  if (!d.moved) document.body.classList.add('pl-dragging');
  d.moved = true;
  const [first] = d.orig;
  if (d.mode === 'create') {
    const a = spDay(pl.range.from, d.at);
    const b = spDay(pl.range.from, d.at + dd);
    [first.n.start, first.n.end] = a <= b ? [a, b] : [b, a];
  } else if (d.mode === 'move') {
    for (const o of d.orig) {
      if (o.start) o.n.start = spDay(o.start, dd);
      if (o.end) o.n.end = spDay(o.end, dd);
    }
  } else {
    const { start, end } = d.span;
    if (d.mode === 'l') [first.n.start, first.n.end] = [spDay(start, dd) > end ? end : spDay(start, dd), end];
    else [first.n.start, first.n.end] = [start, spDay(end, dd) < start ? start : spDay(end, dd)];
  }
  // Draw at most once per frame even when moving fast
  if (!d.frame) d.frame = requestAnimationFrame(() => {
    d.frame = 0;
    if (pl.drag === d) plRefresh(['body', 'detail']);
  });
});
window.addEventListener('pointerup', (ev) => {
  const d = pl.drag;
  if (!d) return;
  pl.drag = null;
  document.body.classList.remove('pl-dragging');
  if (d.moved) return plEdited(['head', 'body', 'detail']);
  // Release without moving selects the row
  plSelect(d.id, { ...d.mods, shiftKey: d.mods.shiftKey || (ev.shiftKey && d.mode !== 'move') });
});

// Issues are taken as URLs (https://github.com/owner/name/issues/123). Content is fetched from GitHub only when importing or creating
const plIssueRef = (v) => {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?(?:[?#].*)?$/.exec(String(v || '').trim());
  return m && { repo: m[1], number: Number(m[2]) };
};
const plIssueUrlField = () => `<div class="form-row"><label>${tr('pl.issueUrl')}</label><input type="url" data-pk-url placeholder="https://github.com/owner/name/issues/123"></div>`;
// Report in the input if it cannot be read as a URL
function plCheckIssueUrl(input) {
  const ref = plIssueRef(input.value);
  input.setCustomValidity(ref ? '' : tr('pl.needIssue'));
  input.reportValidity();
  return ref;
}

// Put an existing issue, with its sub issues, under targetId. Re-parenting on GitHub happens at the next "Apply changes"
function openImportIssue(targetId) {
  const hit = plFind(targetId);
  if (!hit) return;
  pl.addMenu = null;
  plRefresh(['body']);
  const dlg = $('#plan-dlg');
  dlg.innerHTML = `<form method="dialog" class="dlg-head"><h3>${tr('pl.import')}</h3><button>${tr('close')}</button></form>
    <div class="dlg-body"><p class="muted" style="margin:0 0 8px">${esc(hit.n.title || tr('pl.untitled'))} ›</p>${plIssueUrlField()}</div>
    <div class="dlg-foot"><span style="flex:1"></span><button class="primary" data-pk-ok>${tr('pl.importBtn')}</button></div>`;
  const ok = dlg.querySelector('[data-pk-ok]');
  const url = dlg.querySelector('[data-pk-url]');
  url.oninput = () => url.setCustomValidity('');
  ok.onclick = async () => {
    const picked = plCheckIssueUrl(url);
    if (!picked) return;
    ok.disabled = true;
    ok.innerHTML = `<span class="spin"></span> ${tr('pl.importBtn')}`;
    try {
      await plFlush();
      const doc = pl.doc;
      const { node } = await api('/api/plan/import', { method: 'POST', body: { project: plProject(), file: doc.file, repo: picked.repo, number: picked.number, level: hit.d + 2 } });
      const target = plFind(targetId)?.n;
      dlg.close();
      if (!target || pl.doc !== doc) return;
      const adopt = (x) => ({ ...x, id: plNewId(), repo: x.repo || null, children: x.children.map(adopt) });
      const added = adopt(node);
      target.children.push(added);
      pl.collapsed.delete(target.id);
      pl.sel = new Set([added.id]);
      pl.anchor = added.id;
      pl.bulk = null;
      // Also update "which plan it is in" for subsequent imports
      const item = pl.list?.find((x) => x.file === doc.file);
      const walk = (x) => { item?.issues.push(plKey(x)); x.children.forEach(walk); };
      walk(added);
      plEdited(['head', 'bulk', 'body', 'detail']);
      await plFlush();
      loadPlanLive();
    } catch (e) {
      toast(e.message);
      ok.disabled = false;
      ok.textContent = tr('pl.importBtn');
    }
  };
  dlg.showModal();
  url.focus();
}

async function openNewPlan() {
  const dlg = $('#plan-dlg');
  // List repos linked to the project first, then repos registered in settings
  const fields = pl.opts?.fields || (await api(`/api/plan/options?${plQuery()}`).catch(() => ({}))).fields;
  const repos = plRepoCandidates(fields);
  dlg.innerHTML = `<form method="dialog" class="dlg-head"><h3>${tr('pl.new')}</h3><button data-i18n="close">${tr('close')}</button></form>
    <div class="dlg-body">
      <span class="seg pl-kind"><button type="button" class="primary" data-pl-kind="blank">${tr('pl.fromBlank')}</button><button type="button" data-pl-kind="issue">${tr('pl.fromIssue')}</button></span>
      <div data-pl-k="blank">
        <div class="form-row"><label>${tr('pl.title')}</label><input data-pl-new-title required></div>
        <div class="form-row"><label>${tr('repo')}</label><select data-pl-new-repo>${[...new Set(repos)].map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select></div>
      </div>
      <div data-pl-k="issue" hidden>${plIssueUrlField()}</div>
      <div class="form-row"><label>${tr('pl.file')}</label><input data-pl-new-file placeholder="feature-name.md" pattern="[a-z0-9][a-z0-9\\-]*\\.md" required></div>
    </div>
    <div class="dlg-foot"><span style="flex:1"></span><button class="primary" data-pl-create>${tr('pl.create')}</button></div>`;
  const title = dlg.querySelector('[data-pl-new-title]');
  const file = dlg.querySelector('[data-pl-new-file]');
  const url = dlg.querySelector('[data-pk-url]');
  let kind = 'blank';
  // File name comes from the title (issue number when starting from an existing issue). Titles with no Latin letters or digits must be named by hand
  const fill = (v) => { if (!file.dataset.touched) file.value = v; };
  title.oninput = () => {
    const slug = title.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    fill(slug ? `${slug}.md` : '');
  };
  url.oninput = () => {
    url.setCustomValidity('');
    const ref = plIssueRef(url.value);
    if (ref) fill(`issue-${ref.number}.md`);
  };
  file.oninput = () => (file.dataset.touched = '1');
  dlg.querySelector('.pl-kind').onclick = (ev) => {
    const b = ev.target.closest('[data-pl-kind]');
    if (!b) return;
    kind = b.dataset.plKind;
    dlg.querySelectorAll('[data-pl-kind]').forEach((x) => x.classList.toggle('primary', x === b));
    dlg.querySelectorAll('[data-pl-k]').forEach((x) => (x.hidden = x.dataset.plK !== kind));
    title.required = kind === 'blank';
    (kind === 'issue' ? url : title).focus();
  };
  dlg.querySelector('[data-pl-create]').onclick = async () => {
    if (kind === 'blank' && !title.reportValidity()) return;
    const picked = kind === 'issue' && plCheckIssueUrl(url);
    if (kind === 'issue' && !picked) return;
    if (!file.reportValidity()) return;
    const btn = dlg.querySelector('[data-pl-create]');
    btn.disabled = true;
    try {
      const body = kind === 'issue'
        ? { project: plProject(), file: file.value, issue: { repo: picked.repo, number: picked.number } }
        : { project: plProject(), file: file.value, title: title.value.trim(), repo: dlg.querySelector('[data-pl-new-repo]').value.trim() };
      const doc = await api('/api/plan/new', { method: 'POST', body });
      dlg.close();
      plSet(`file:${plProject()}`, doc.file);
      await loadPlans();
      // Select the top-level issue (so sub issues can be added right away)
      const root = plNodes()[0];
      if (root) plSelect(root.id, {});
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
    }
  };
  dlg.showModal();
  title.focus();
}

async function openApplyPlan() {
  await plFlush();
  const targets = plTargets();
  if (!targets.length) return;
  const dlg = $('#plan-dlg');
  const { plan, git } = pl.doc;
  const applied = plan.status === 'applied';
  dlg.innerHTML = `<form method="dialog" class="dlg-head"><h3>${applied ? tr('pl.update', { n: targets.length }) : tr('pl.apply', { n: targets.length })}</h3><button>${tr('close')}</button></form>
    <div class="dlg-body">
      <p class="muted" style="margin:0 0 8px">${esc(plan.repo || '')}</p>
      <ol>${targets.map(({ n, d }) => `<li style="padding-left:${d * 16}px"><span class="chip${n.issue ? ' warn' : ' draft'}">${n.issue ? tr('pl.editIssue', { n: n.issue }) : tr('pl.newIssue')}</span>${esc(n.title || tr('pl.untitled'))}</li>`).join('')}</ol>
      <label class="opt"><input type="checkbox" data-pl-opt="addToProject" checked>${tr('pl.optProject')}</label>
      <label class="opt"${git ? '' : ` title="${esc(tr('pl.noGit'))}"`}><input type="checkbox" data-pl-opt="commit" ${git ? 'checked' : 'disabled'}>${tr('pl.optCommit')}</label>
    </div>
    <div class="dlg-foot"><span style="flex:1"></span><button class="primary" data-pl-run ${targets.some(({ n }) => !n.title.trim()) || !plan.repo ? 'disabled' : ''}>${tr('pl.run')}</button></div>`;
  const run = dlg.querySelector('[data-pl-run]');
  if (!plan.repo) run.title = tr('err.planRepoMissing');
  else if (run.disabled) run.title = tr('pl.needTitle');
  run.onclick = async () => {
    run.disabled = true;
    run.innerHTML = `<span class="spin"></span> ${tr('pl.run')}`;
    const opt = (k) => dlg.querySelector(`[data-pl-opt="${k}"]`).checked;
    try {
      const res = await api('/api/plan/apply', { method: 'POST', body: { project: plProject(), file: pl.doc.file, addToProject: opt('addToProject'), commit: opt('commit') } });
      dlg.close();
      const warn = res.warnings.map(errText);
      toast([tr('pl.done', { created: res.created, updated: res.updated }) + (res.committed ? ` · ${tr('pl.committed')}` : ''), ...warn].join('\n'), !warn.length);
      await loadPlans();
    } catch (e) {
      // Even if it fails midway, numbers of created issues are written in the md, so reload
      dlg.close();
      toast(e.message);
      await loadPlans();
    }
  };
  dlg.showModal();
}

