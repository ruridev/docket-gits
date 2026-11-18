// ---------- Events ----------

async function applyComments(key) {
  await api('/api/mine/apply-comments', { method: 'POST', body: { key } });
  saveDraft(key, {});
}

async function runMine(key, mode, decisions) {
  try {
    await api('/api/mine/run', { method: 'POST', body: { key, mode, decisions } });
    saveDraft(key, {}); // Keep the previous judgments from attaching to the same numbers in the new result
  } catch (e) {
    toast(e.message);
  }
  load();
}

// Refetch only while open. Auto-follow the end only when already viewing the end
async function openLog(key) {
  const dlg = $('#log-dlg');
  const pre = dlg.querySelector('pre');
  pre.textContent = tr('loading');
  dlg.showModal();
  const token = (openLog.token = {});
  while (dlg.open && openLog.token === token) {
    try {
      const { running, lines } = await api(`/api/log?key=${encodeURIComponent(key)}`);
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
      pre.textContent = lines.length ? lines.join('\n') : running ? tr('noOutputYet') : tr('runEnded');
      if (atBottom) pre.scrollTop = pre.scrollHeight;
      if (!running) return;
    } catch (e) {
      pre.textContent = e.message;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function review(key) {
  try {
    await api('/api/review', { method: 'POST', body: { key } });
    saveDraft(key, {}); // Keep the previous judgments from attaching to the same numbers in the new comments
  } catch (e) {
    toast(e.message);
  }
  load();
}

$('#banner').addEventListener('click', (ev) => { if (ev.target.matches('[data-settings-pane]')) nextSettingsPane = ev.target.dataset.settingsPane; });
$('#board').addEventListener('click', async (ev) => {
  const t = ev.target;
  if (t.matches('[data-settings-pane]')) nextSettingsPane = t.dataset.settingsPane;
  if (t.closest('[data-archive-back]')) { archiveView = false; return render(); }
  const arch = t.closest('[data-archive]')?.dataset.archive;
  if (arch) {
    // Each press toggles archive in ⇄ out
    const list = archivedOf(view());
    try { localStorage.setItem(`docket-archived:${view()}`, JSON.stringify(list.includes(arch) ? list.filter((x) => x !== arch) : [...list, arch])); } catch {}
    return render();
  }
  const jump = t.closest('[data-jump]');
  if (jump && $(`#board [data-pr="${CSS.escape(jump.dataset.jump)}"]`)) { ev.preventDefault(); return jumpTo(jump.dataset.jump); }
  if (t.closest('a[target]')) {
    viewing = jump?.dataset.jump ?? t.closest('[data-pr]')?.dataset.pr ?? viewing;
    // Swap the class without redrawing so the link's default action is not blocked
    document.querySelectorAll('#board .card.viewing').forEach((c) => c.classList.remove('viewing'));
    if (viewing) $(`#board [data-pr="${CSS.escape(viewing)}"]`)?.classList.add('viewing');
    return;
  }
  if (t.matches('[data-cancel]')) {
    if (!confirmTwice(t, `cancel:${t.dataset.cancel}`, tr('confirmCancel'))) return;
    try {
      await api('/api/cancel', { method: 'POST', body: { key: t.dataset.cancel } });
    } catch (e) {
      toast(e.message);
    }
    return load();
  }
  if (t.matches('[data-skip]')) {
    try {
      await api('/api/skip', { method: 'POST', body: { key: t.dataset.skip } });
    } catch (e) {
      toast(e.message);
    }
    return load();
  }
  if (t.matches('[data-dismiss]')) {
    try {
      await api('/api/dismiss', { method: 'POST', body: { key: t.dataset.dismiss } });
    } catch (e) {
      toast(e.message);
    }
    return load();
  }
  if (t.matches('[data-log]')) return openLog(t.dataset.log);
  if (t.matches('[data-mine-cancel]')) {
    if (!confirmTwice(t, `cancel:${t.dataset.mineCancel}`, tr('confirmCancel'))) return;
    try {
      await api('/api/mine/cancel', { method: 'POST', body: { key: t.dataset.mineCancel } });
    } catch (e) {
      toast(e.message);
    }
    return load();
  }
  const card = t.closest('[data-open]');
  if (card) return openReview(card.dataset.open);
  const mineCard = t.closest('[data-open-mine]');
  if (mineCard) return openMine(mineCard.dataset.openMine);
  const resultCard = t.closest('[data-open-result]');
  if (resultCard) openResult(resultCard.dataset.openResult);
});

let dragging = null;
const dropLane = (ev) => {
  const lane = ev.target.closest('[data-lane]');
  if (laneEdit) return laneDrag && lane?.dataset.lane !== laneDrag ? lane : null;
  if (!dragging || !lane || lane.dataset.lane === dragging.from) return null;
  // A running review can only be canceled (back to Requested)
  return ['queued', 'reviewing'].includes(dragging.entry.status) && lane.dataset.lane !== 'requested' ? null : lane;
};
$('#board').addEventListener('dragstart', (ev) => {
  if (laneEdit) {
    laneDrag = ev.target.closest('[data-lane]')?.dataset.lane;
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', laneDrag);
    return;
  }
  const card = ev.target.closest('[data-drag]');
  if (!card) return;
  const key = card.dataset.drag;
  dragging = { key, from: card.closest('[data-lane]').dataset.lane, entry: [...board.prs, ...board.mine].find((e) => e.key === key) };
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', dragging.key);
});
$('#board').addEventListener('dragover', (ev) => {
  const lane = dropLane(ev);
  if (!lane) return;
  ev.preventDefault();
  lane.classList.add('drop');
});
$('#board').addEventListener('dragleave', (ev) => {
  const lane = ev.target.closest('[data-lane]');
  if (lane && !lane.contains(ev.relatedTarget)) lane.classList.remove('drop');
});
$('#board').addEventListener('drop', async (ev) => {
  const lane = dropLane(ev);
  if (!lane) return;
  ev.preventDefault();
  if (laneEdit) {
    const from = laneEdit.indexOf(laneDrag);
    const to = laneEdit.indexOf(lane.dataset.lane);
    laneEdit.splice(to, 0, ...laneEdit.splice(from, 1));
    laneDrag = null;
    return render();
  }
  // Moves to lanes with an action run as before; any other move only changes the displayed lane
  // To Reviewing: review. Requested / Reviewed -> Done: finish without posting. Running -> Requested: cancel. Needs decision -> Running: address as per the PR comments
  const { key, entry } = dragging;
  const to = lane.dataset.lane;
  dragging = null;
  if (to === 'reviewing') return review(key);
  try {
    if (to === 'commented' && ['requested', 'reviewed'].includes(entry.status)) await api('/api/skip', { method: 'POST', body: { key } });
    else if (['queued', 'reviewing'].includes(entry.status)) await api('/api/cancel', { method: 'POST', body: { key } });
    else if (to === 'running' && entry.status === 'planned' && entry.sessionId) {
      // confirm() does not work in embedded browsers, so a second drag executes, like confirmTwice on buttons
      const id = `apply-comments:${key}`;
      if (armed?.id !== id || Date.now() >= armed.until) {
        armed = { id, until: Date.now() + CONFIRM_MS };
        return toast(tr('confirmApplyComments'));
      }
      armed = null;
      await applyComments(key);
    }
    else await api('/api/move', { method: 'POST', body: { key, lane: to } });
  } catch (e) {
    toast(e.message);
  }
  load();
});
$('#board').addEventListener('dragend', () => {
  if (!dragging && !laneDrag) return;
  dragging = laneDrag = null;
  render();
});
$('#refresh').onclick = async () => {
  refreshing = true;
  render();
  await load(true);
  refreshing = false;
  render();
};
$('#stack-order').onclick = () => { stackOrder = !stackOrder; render(); };
$('#archive-toggle').onclick = () => { archiveView = !archiveView; render(); };
$('#board-fold').onclick = () => { plSet('board-side', plGet('board-side') === '0' ? '1' : '0'); render(); };
$('#repo-filter').onclick = $('#repo-filter').onchange = (ev) => {
  if (ev.type === 'click' && ev.target.closest('[data-filter-add]')) { boardFilterMenu = !boardFilterMenu; return render(); }
  const pick = ev.type === 'click' && ev.target.closest('[data-filter-pick]');
  if (pick) { boardFx[view()].add(pick.dataset.filterPick); boardFilterMenu = false; return render(); }
  const del = ev.type === 'click' && ev.target.closest('[data-filter-del]')?.dataset.filterDel;
  if (del) {
    boardFx[view()].delete(del);
    // Merged falls back to exclude when nothing is saved, so save "All" when clearing
    try { del === 'merged' ? localStorage.setItem('docket-merged:review', '') : localStorage.removeItem(del === 'approved' ? `docket-approved:${view()}` : hiddenKey(del, view())); } catch {}
    return render();
  }
  const seg = ev.type === 'click' && ev.target.closest('[data-approved], [data-merged]');
  if (seg) {
    const isM = 'merged' in seg.dataset;
    if (isM) boardFx.review.add('merged'); // This row is shown from the start, so treat it as added so it does not vanish when set to "All"
    const cur = isM ? seg.dataset.merged : seg.dataset.approved;
    const next = { '': 'only', only: 'exclude', exclude: '' }[cur];
    try { localStorage.setItem(isM ? 'docket-merged:review' : `docket-approved:${view()}`, next); } catch {}
    return render();
  }
  const r = ev.type === 'change' && ev.target.dataset.msValue;
  const bulk = ev.type === 'click' && ev.target.closest('[data-ms-bulk]')?.dataset.msBulk;
  if (!r && !bulk) return;
  const kind = ev.target.closest('[data-ms]').dataset.ms;
  const hidden = hiddenOf(kind, view());
  const next = bulk === 'all' ? [] : bulk === 'none' ? [...new Set((view() === 'receive' ? board.mine : board.prs).flatMap((p) => filterValues(kind, p.pr)))]
    : ev.target.checked ? hidden.filter((x) => x !== r) : [...hidden, r];
  try { localStorage.setItem(hiddenKey(kind, view()), JSON.stringify(next)); } catch {}
  render();
};
window.addEventListener('hashchange', () => {
  if (OLD_ROADMAP.includes(location.hash)) return location.replace('#plan');
  laneEdit = null; // Switching tabs discards edits
  archiveView = false;
  applyCardHidden();
  render();
  enterView();
});
// Draw only when entering the screen (drawing on every render would lose values being typed in settings)
function enterView() {
  if (view() === 'plan') loadPlans();
  if (view() === 'settings') openSettings().catch((e) => toast(e.message));
  if (view() === 'tips') renderTipShots();
}
$('#edit-lanes').onclick = () => {
  laneEdit = lanesFor(view()).map((l) => l.id);
  laneNameEdit = laneNames();
  render();
};
$('#board').addEventListener('input', (ev) => {
  const id = ev.target.dataset.laneName;
  if (id) laneNameEdit[`${view()}:${id}`] = ev.target.value;
});
$('#lane-save').onclick = () => {
  try { localStorage.setItem(laneOrderKey(view()), JSON.stringify(laneEdit)); } catch {}
  saveLaneNames(laneNameEdit);
  laneEdit = null;
  render();
};
$('#lane-cancel').onclick = () => {
  laneEdit = null;
  render();
};
// "Before you start". Cannot be closed before agreeing (the server also blocks the API that starts claude)
function openConsent(required) {
  const dlg = $('#consent-dlg');
  dlg.querySelector('[data-close]').hidden = required;
  dlg.querySelector('[data-agree]').hidden = !required;
  dlg.oncancel = (ev) => required && ev.preventDefault(); // Do not allow closing with Esc
  if (dlg.open) return; // Called on every reload, so do not clear the checks while it is open
  dlg.querySelectorAll('.got input').forEach((cb) => (cb.checked = false));
  dlg.querySelector('[data-agree]').disabled = true;
  dlg.showModal();
}
// The agree button stays disabled until every item is marked "I understand"
$('#consent-dlg').onchange = () => ($('#consent-dlg [data-agree]').disabled = [...$('#consent-dlg').querySelectorAll('.got input')].some((cb) => !cb.checked));
$('#consent-dlg').onclick = async (ev) => {
  if (ev.target.matches('[data-close]')) return $('#consent-dlg').close();
  if (!ev.target.matches('[data-agree]')) return;
  try {
    await api('/api/consent', { method: 'POST' });
    $('#consent-dlg').close();
    load();
  } catch (e) {
    toast(e.message);
  }
};
$('#tips').addEventListener('click', (ev) => ev.target.matches('[data-open-consent]') && openConsent(false));
// ---------- Tip illustrations ----------
// Draws by passing fake data to the real card, lane and roadmap render functions. All names and images are made up
const TIP_TEXT = {
  ja: { t: ['ログイン画面のエラー表示を改善', '注文一覧に CSV 出力を追加', '商品検索の並び替えを修正', '決済 API のタイムアウト設定', 'カートの数量変更を即時反映', 'お知らせ機能の下書き', 'README の手順を更新', '配送先住所の入力チェック', '会員ランク機能', 'ランク判定バッチ', 'ランク表示画面'],
    f: ['null のときに例外になります', 'items が空だと items[0] で TypeError になります。先に空配列をチェックしてください。', 'テストが足りません', '境界値 (0 件) のテストを追加してください。'], r: '別 PR で対応予定です',
    g: ['数量が 0 のときも考慮が必要では?', '関数名を calcTotal に変えませんか?', 'チームの規約で既存の名前に合わせています', 'Coverage: 82.4% (+0.3%)'] },
  ko: { t: ['로그인 화면의 오류 표시 개선', '주문 목록에 CSV 내보내기 추가', '상품 검색 정렬 수정', '결제 API 타임아웃 설정', '장바구니 수량 변경 즉시 반영', '공지 기능 초안', 'README 절차 갱신', '배송지 주소 입력 검사', '회원 등급 기능', '등급 판정 배치', '등급 표시 화면'],
    f: ['null일 때 예외가 납니다', 'items가 비어 있으면 items[0]에서 TypeError가 납니다. 먼저 빈 배열인지 확인하세요.', '테스트가 부족합니다', '경곗값(0건) 테스트를 추가하세요.'], r: '별도 PR에서 처리할 예정입니다',
    g: ['수량이 0일 때도 고려해야 하지 않을까요?', '함수 이름을 calcTotal로 바꾸면 어떨까요?', '팀 규칙상 기존 이름에 맞추고 있습니다', 'Coverage: 82.4% (+0.3%)'] },
  en: { t: ['Improve error messages on the login screen', 'Add CSV export to the order list', 'Fix sorting in product search', 'Set a timeout for the payment API', 'Apply cart quantity changes instantly', 'Draft of the notice feature', 'Update the steps in README', 'Validate the shipping address', 'Member rank feature', 'Rank calculation batch', 'Rank display screen'],
    f: ['Throws when the value is null', 'If items is empty, items[0] throws a TypeError. Check for an empty array first.', 'Tests are missing', 'Add a test for the boundary case (0 items).'], r: 'Will handle this in a separate PR',
    g: ["Shouldn't this also handle a quantity of 0?", 'How about renaming this to calcTotal?', 'Our team convention keeps the existing name', 'Coverage: 82.4% (+0.3%)'] },
};
const TIP_REPO = 'acme/shop-web';
const tipAvatar = (name, color) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="${color}"/><text x="10" y="14" font-size="11" text-anchor="middle" fill="#fff" font-family="sans-serif">${name[0].toUpperCase()}</text></svg>`)}`;
const TIP_USERS = [['sakura', '#d1567a'], ['minho', '#2f81f7'], ['alex', '#1a7f37'], ['yuki', '#9a6700']].map(([login, c]) => ({ login, avatarUrl: tipAvatar(login, c) }));
const tipAgo = (min) => new Date(Date.now() - min * 60000).toISOString();
function tipPr(i, extra = {}) {
  const [me, a, b, c] = TIP_USERS;
  return {
    repo: TIP_REPO, number: 120 + i, url: '#', title: (TIP_TEXT[lang] || TIP_TEXT.ja).t[i], author: [a, b, c][i % 3], updatedAt: tipAgo(5 + i * 37),
    base: 'main', head: `feature/topic-${120 + i}`, labels: [], issues: [], state: 'OPEN', isDraft: false,
    reviews: i % 2 ? [{ ...me, state: 'APPROVED' }] : [], requested: [me, b], ...extra,
  };
}
const tipFindings = () => { const f = (TIP_TEXT[lang] || TIP_TEXT.ja).f; return [{ no: '1', severity: 'major', title: f[0], path: 'src/cart.js', line: 42, body: f[1] }, { no: '2', severity: 'minor', title: f[2], path: 'test/cart.test.js', body: f[3] }]; };
const tipUsage = { tokens: 184000, costUsd: 0.62 };
const TIP_ENTRIES = {
  review: () => [
    { status: 'requested', pr: tipPr(0) },
    { status: 'reviewing', startedAt: tipAgo(2), pr: tipPr(1) },
    { status: 'reviewed', findings: tipFindings(), usage: tipUsage, pr: tipPr(2) },
    { status: 'commented', postedUrl: '#', usage: tipUsage, pr: tipPr(3) },
  ],
  receive: () => [
    { status: 'idle', pr: tipPr(5, { isDraft: true }) },
    { status: 'idle', pr: tipPr(0) },
    { status: 'idle', pending: 2, pr: tipPr(1) },
    { status: 'running', mode: 'self', startedAt: tipAgo(3), pr: tipPr(2) },
    { status: 'planned', mode: 'self', findings: tipFindings(), pr: tipPr(3) },
    { status: 'idle', appliedAt: tipAgo(90), usage: tipUsage, pr: tipPr(4) },
  ],
};
function tipLanes(v) {
  const entries = TIP_ENTRIES[v]().map((e, i) => ({ key: `tip:${i}`, ...e }));
  return `<div class="board">${lanesFor(v).map((lane) => {
    const cards = entries.filter(laneMatch(lane));
    return `<section class="lane"><h2><span class="dot" style="border-color:${lane.color}"></span>${esc(laneLabel(v, lane))}<span class="count">${cards.length}</span></h2>
      ${cards.map(v === 'receive' ? mineCardHtml : cardHtml).join('') || `<div class="muted" style="padding:4px">${tr('none')}</div>`}</section>`;
  }).join('')}</div>`;
}
const TIP_SHOTS = {
  review: () => [tipLanes('review'), 0.6],
  receive: () => [tipLanes('receive'), 0.5],
  findings: () => {
    const fs = tipFindings();
    return [`<div class="dlg-body">${findingHtml(fs[0], { verdict: 'agree' }, undefined, true)}${findingHtml(fs[1], { verdict: 'disagree', reason: (TIP_TEXT[lang] || TIP_TEXT.ja).r }, undefined, true)}</div>
      <div class="dlg-foot"><span style="flex:1"></span><span class="muted">${tr('decided', { n: 2, total: 2 })}</span>
      <label><input type="checkbox" checked> ${tr('humanRead')}</label><label><input type="checkbox"> ${tr('approve')}</label><button class="primary">${tr('submit')}</button></div>`, 0.8];
  },
  // Pre-judgment when "Address comments" is pressed (before running AI)
  triage: () => {
    const g = (TIP_TEXT[lang] || TIP_TEXT.ja).g;
    const items = [
      [{ no: 1, title: '@minho', path: 'src/cart.js', line: 42, body: g[0] }, { verdict: 'agree' }],
      [{ no: 2, title: '@alex', path: 'src/order.js', line: 8, body: g[1] }, { verdict: 'disagree', reason: g[2] }],
      [{ no: 3, severity: tr('prComment'), title: '@ci-bot', body: g[3] }, { verdict: 'skip' }],
    ];
    const ph = { agree: tr('ph.triage.agree'), disagree: tr('ph.triage.disagree') };
    return [`<div class="dlg-body">${items.map(([f, d]) => findingHtml(f, d, ph, true)).join('')}</div>
      <div class="dlg-foot"><span style="flex:1"></span><span class="muted">${tr('decided', { n: 3, total: 3 })} · ${tr('triageTargets', { n: 2 })}</span><button class="primary">${tr('triageSubmit')}</button></div>`, 0.65];
  },
  bar: () => {
    const bar = $('#board-bar').cloneNode(true);
    for (const el of [bar, ...bar.querySelectorAll('[id]')]) el.removeAttribute('id');
    return [bar.outerHTML, 0.9];
  },
  cost: () => {
    const [, , , running, , applied] = TIP_ENTRIES.receive();
    return [`<div class="cards">${[{ ...running, usage: tipUsage }, applied].map((e, i) => mineCardHtml({ key: `tip:c${i}`, ...e })).join('')}</div>`, 0.8];
  },
};
// Redraw on every open (to reflect language, settings and lane name changes).
// Cards show buttons based on repo-to-skill mapping, so temporarily assign skills to the fake repos too
function withTipRepo(fn) {
  const repos = board.config.repos;
  board.config.repos = { ...repos, [TIP_REPO]: { skill: 'review', selfSkill: 'self-review', fixSkill: 'review-fix' } };
  try { return fn(); } finally { board.config.repos = repos; }
}
function tipShotEl(name) {
  const [html, zoom] = TIP_SHOTS[name]();
  const el = document.createElement('div');
  el.className = 'tip-shot';
  el.inert = true;
  el.innerHTML = `<div style="zoom:${zoom}">${html}</div>`;
  return el;
}
function renderTipShots() {
  withTipRepo(() => {
    for (const d of $('#tips').querySelectorAll('[data-shots]')) {
      d.querySelectorAll('.tip-shot').forEach((el) => el.remove());
      const lists = d.querySelectorAll(':scope > ul, :scope > ol');
      d.dataset.shots.split(',').forEach((name, i) => d.insertBefore(tipShotEl(name), lists[i] || null));
    }
  });
}
// About body text lives in the translations; Tip illustrations are drawn at each <div data-shot="..."> position
function renderAbout() {
  const el = $('#about');
  el.innerHTML = tr('about.html');
  withTipRepo(() => el.querySelectorAll('[data-shot]').forEach((d) => d.replaceWith(tipShotEl(d.dataset.shot))));
}
// Clicking outside a modal (backdrop) acts like pressing that modal's close button
// Do not close when the press started inside and ended outside (text selection etc.), or when the close button is hidden (e.g. before agreeing)
const onBackdrop = (ev) => {
  if (ev.target.tagName !== 'DIALOG') return false;
  const r = ev.target.getBoundingClientRect();
  return ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom;
};
let downOnBackdrop = false;
document.addEventListener('mousedown', (ev) => (downOnBackdrop = onBackdrop(ev)));
document.addEventListener('click', (ev) => {
  if (downOnBackdrop && onBackdrop(ev)) ev.target.querySelector('.dlg-head [data-close]:not([hidden]), form.dlg-head button')?.click();
});
// Card fields to hide. Saved per tab in the browser, hidden by CSS via body classes
const CARD_PARTS = ['branch', 'issue', 'stack', 'updated', 'applied', 'usage', 'reviewers', 'author', 'draft', 'labels', 'removed'];
// The roadmap reads this at render time. Status and sprint start hidden since bars get crowded
const PLAN_PARTS = ['assignees', 'number', 'prs', 'status', 'sprint'];
const PLAN_HIDDEN_DEFAULT = ['status', 'sprint'];
const partsOf = (v) => (v === 'plan' ? PLAN_PARTS : CARD_PARTS);
const cardHiddenKey = (v) => `docket-card-hidden:${v}`;
const cardHiddenOf = (v) => { try { return JSON.parse(localStorage.getItem(cardHiddenKey(v))) || (v === 'plan' ? PLAN_HIDDEN_DEFAULT : []); } catch { return v === 'plan' ? PLAN_HIDDEN_DEFAULT : []; } };
const saveCardHidden = (v, list) => { try { localStorage.setItem(cardHiddenKey(v), JSON.stringify(list)); } catch {} };
const applyCardHidden = () => { const h = cardHiddenOf(view()); CARD_PARTS.forEach((p) => document.body.classList.toggle(`hide-${p}`, h.includes(p))); };
applyCardHidden();
const otherBoard = () => (view() === 'review' ? 'receive' : 'review');
let cardDisplayChanged = false;
// Where each display setting appears on the card (same places as the body.hide-* CSS)
const PART_SEL = { branch: '.branch', issue: '.issue', stack: '.stack', updated: '.top .time', applied: '.foot .time', usage: '.usage', reviewers: '.reviewers', author: '.top .avatar', draft: '.chip.draft', labels: '.chip.label', removed: '.chip.off' };
// Sample card with every field. Display settings work via body classes, so toggling them changes this card too
function cardDisplayPreview() {
  const t = TIP_TEXT[lang] || TIP_TEXT.ja;
  const pr = tipPr(1, { isDraft: true, labels: [{ name: 'no-pr-activity', color: 'd4c5f9' }], issues: [{ repo: TIP_REPO, number: 98, title: t.t[4], url: '#' }] });
  const e = { key: 'tip:cd', active: false, usage: tipUsage, appliedAt: tipAgo(90), status: view() === 'receive' ? 'idle' : 'commented', postedUrl: '#', pr };
  const el = document.createElement('div');
  el.className = 'cd-preview';
  el.inert = true;
  el.innerHTML = withTipRepo(() => (view() === 'receive' ? mineCardHtml : cardHtml)(e));
  // Stacks are built from PRs on the real board, so the sample adds them by hand
  el.querySelector('.branch')?.insertAdjacentHTML('afterend', `<div class="stack">${tr('stack')}<a>#120</a> → <b>#121</b></div>`);
  return el;
}
function openCardDisplay() {
  const h = cardHiddenOf(view());
  const body = $('#display-dlg .dlg-body');
  body.innerHTML = partsOf(view()).map((p) => `<label data-part-row="${p}"><input type="checkbox" data-part="${p}"${h.includes(p) ? '' : ' checked'}> ${esc(tr(`cd.${p}`))}</label>`).join('');
  if (view() !== 'plan') {
    const preview = cardDisplayPreview();
    body.prepend(preview);
    for (const row of body.querySelectorAll('[data-part-row]')) {
      const src = preview.querySelector(PART_SEL[row.dataset.partRow]);
      if (src) row.insertAdjacentHTML('beforeend', `<span class="cd-sample" aria-hidden="true">${src.outerHTML}</span>`);
      const hl = (on) => preview.querySelectorAll(PART_SEL[row.dataset.partRow]).forEach((x) => x.classList.toggle('cd-hl', on));
      row.onmouseenter = () => hl(true);
      row.onmouseleave = () => hl(false);
    }
  }
  $('#display-dlg .dlg-foot').hidden = true;
  cardDisplayChanged = false;
  $('#display-dlg').showModal();
}
$('#card-display').onclick = openCardDisplay;
$('#display-dlg').onchange = (ev) => {
  const p = ev.target.dataset.part;
  const h = cardHiddenOf(view());
  saveCardHidden(view(), ev.target.checked ? h.filter((x) => x !== p) : [...h, p]);
  cardDisplayChanged = true;
  if (view() === 'plan') return plRefresh(['body']);
  applyCardHidden();
};
// On close, if something changed and the other board's settings differ, ask whether to make them the same
function closeCardDisplay() {
  const dlg = $('#display-dlg');
  const same = (a, b) => [...a].sort().join() === [...b].sort().join();
  if (view() === 'plan' || !cardDisplayChanged || !dlg.querySelector('.dlg-foot').hidden || same(cardHiddenOf(view()), cardHiddenOf(otherBoard()))) return dlg.close();
  dlg.querySelector('.dlg-body').innerHTML = `<p>${esc(tr('cd.copy', { view: tr(`tab.${otherBoard()}`) }))}</p>`;
  dlg.querySelector('.dlg-foot').hidden = false;
}
$('#display-dlg').oncancel = (ev) => { ev.preventDefault(); closeCardDisplay(); };
$('#display-dlg').onclick = (ev) => {
  if (ev.target.matches('[data-close]')) return closeCardDisplay();
  if (!ev.target.matches('[data-copy]')) return;
  if (ev.target.dataset.copy) saveCardHidden(otherBoard(), cardHiddenOf(view()));
  $('#display-dlg').close();
};

load().then(() => { enterView(); });
// Local state uses the configured interval; GitHub is left to the server's periodic fetch
// Re-read the interval every time so settings changes apply immediately
(function poll() {
  // setTimeout becomes 1 ms beyond about 24.8 days, so cap at 1 day
  setTimeout(() => load(false, true).finally(poll), Math.min(Math.max(1, Number(board.config.refreshSeconds) || 5), 86400) * 1000);
})();
