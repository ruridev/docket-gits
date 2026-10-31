'use strict';

// 計画 (Draft) の md ファイルの読み書き。GitHub には触らない
//
// ---
// title: 通知機能
// repo: owner/name
// project: https://github.com/users/owner/projects/2
// status: draft
// ---
//
// # 親 issue {issue=#314 start=2026-11-05 end=2026-11-13 @alice labels=backend,ui sprint="Sprint 12" milestone=v0.5}
//
// 本文 (次の見出しまで)
//
// ## 子 issue
//
// 見出しの深さがツリーの階層。属性はすべて省略できる

const MAX_DEPTH = 6;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const unquote = (v) => (v.startsWith('"') ? v.slice(1, -1).replace(/\\(["\\])/g, '$1') : v);
const quote = (v) => (/^[^\s"{}=]+$/.test(v) ? v : `"${v.replace(/(["\\])/g, '\\$1')}"`);
const list = (v) => unquote(v).split(',').map((s) => s.trim()).filter(Boolean);

function parseAttrs(text) {
  const node = { issue: null, start: null, end: null, assignees: [], labels: [], milestone: null, sprint: null };
  for (const [, tok] of text.matchAll(/((?:[^\s"]|"(?:[^"\\]|\\.)*")+)/g)) {
    if (tok.startsWith('@')) { node.assignees.push(tok.slice(1)); continue; }
    const eq = tok.indexOf('=');
    if (eq < 0) continue;
    const k = tok.slice(0, eq);
    const v = tok.slice(eq + 1);
    if (k === 'issue') node.issue = Number(v.replace(/^#/, '')) || null;
    else if ((k === 'start' || k === 'end') && DATE.test(v)) node[k] = v;
    else if (k === 'labels') node.labels = list(v);
    else if (k === 'milestone' || k === 'sprint') node[k] = unquote(v) || null;
  }
  return node;
}

function attrsText(n) {
  const parts = [];
  if (n.issue) parts.push(`issue=#${n.issue}`);
  if (n.start) parts.push(`start=${n.start}`);
  if (n.end) parts.push(`end=${n.end}`);
  for (const a of n.assignees || []) parts.push(`@${a}`);
  if (n.labels?.length) parts.push(`labels=${quote(n.labels.join(','))}`);
  if (n.sprint) parts.push(`sprint=${quote(n.sprint)}`);
  if (n.milestone) parts.push(`milestone=${quote(n.milestone)}`);
  return parts.length ? ` {${parts.join(' ')}}` : '';
}

// 階層が飛んだ見出し (# の次に ###) は 1 つ上の階層の子にする
function parsePlan(text) {
  const plan = { title: '', repo: '', project: '', status: 'draft', nodes: [] };
  let lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        const m = /^(\w+):\s*(.*)$/.exec(l);
        if (m && m[1] in plan && m[1] !== 'nodes') plan[m[1]] = unquote(m[2].trim());
      }
      lines = lines.slice(end + 1);
    }
  }
  if (plan.status !== 'applied') plan.status = 'draft';
  const stack = [];
  let cur = null;
  let body = [];
  const flush = () => {
    if (cur) cur.body = body.join('\n').replace(/^\n+|\s+$/g, '');
    body = [];
  };
  let seq = 0;
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!h) {
      // 本文の行頭の # は見出しと区別するため \ を付けて書いている
      body.push(line.replace(/^\\(?=#)/, ''));
      continue;
    }
    flush();
    const a = /\s*\{([^{}]*)\}\s*$/.exec(h[2]);
    cur = { id: `n${++seq}`, title: (a ? h[2].slice(0, a.index) : h[2]).trim(), body: '', ...parseAttrs(a ? a[1] : ''), children: [] };
    const depth = Math.min(h[1].length, stack.length + 1);
    stack.length = depth - 1;
    (stack.length ? stack.at(-1).children : plan.nodes).push(cur);
    stack.push(cur);
  }
  flush();
  return plan;
}

function serializePlan(plan) {
  const out = ['---'];
  for (const k of ['title', 'repo', 'project', 'status']) out.push(`${k}: ${plan[k] || ''}`.trimEnd());
  out.push('---', '');
  const walk = (n, depth) => {
    const title = String(n.title || '').replace(/\s+/g, ' ').trim();
    out.push(`${'#'.repeat(Math.min(depth, MAX_DEPTH))} ${title}${attrsText(n)}`, '');
    const body = String(n.body || '').replace(/\r\n/g, '\n').replace(/^\n+|\s+$/g, '');
    if (body) out.push(...body.split('\n').map((l) => l.replace(/^(?=#)/, '\\')), '');
    for (const c of n.children || []) walk(c, depth + 1);
  };
  for (const n of plan.nodes || []) walk(n, 1);
  return `${out.join('\n').trimEnd()}\n`;
}

// 親 → 子の順に並べる (作成順)。parent は親ノード
function flatten(nodes, parent = null, out = []) {
  for (const n of nodes) {
    out.push({ node: n, parent });
    flatten(n.children || [], n, out);
  }
  return out;
}

// GitHub に反映した内容と比べる値 (前回の反映後に変わったかの判定に使う)
const syncSnapshot = (n) => JSON.stringify([n.title, n.body || '', [...(n.assignees || [])].sort(), [...(n.labels || [])].sort(), n.milestone || null, n.sprint || null, n.start || null, n.end || null]);

// 英数字だけのファイル名にする (使えなければ空)
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const validFile = (f) => /^[a-z0-9][a-z0-9-]*\.md$/.test(f || '');

module.exports = { MAX_DEPTH, parsePlan, serializePlan, flatten, syncSnapshot, slugify, validFile };
