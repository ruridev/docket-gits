'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlan, serializePlan, flatten, syncSnapshot, fieldsOf, snapshotFields, mergeRemote, slugify, validFile } = require('./plans');

const MD = String.raw`---
title: 通知機能
repo: acme/api
project: https://github.com/users/acme/projects/2
status: applied
---

# 通知設定画面 {issue=#314 start=2026-11-05 end=2026-11-13 @alice @bob labels=backend,ui sprint="Sprint 12" milestone=v0.5}

本文 1 行目
\# 見出しではない行

## API {issue=#41 repo=acme/docs start=2026-11-05 end=2026-11-07}

### スキーマ

## 画面
`;

test('parsePlan: frontmatter・見出しの階層・属性・本文を読む', () => {
  const p = parsePlan(MD);
  assert.equal(p.title, '通知機能');
  assert.equal(p.repo, 'acme/api');
  assert.equal(p.status, 'applied');
  assert.equal(p.nodes.length, 1);
  const root = p.nodes[0];
  assert.equal(root.title, '通知設定画面');
  assert.equal(root.issue, 314);
  assert.deepEqual(root.assignees, ['alice', 'bob']);
  assert.deepEqual(root.labels, ['backend', 'ui']);
  assert.equal(root.sprint, 'Sprint 12');
  assert.equal(root.milestone, 'v0.5');
  assert.equal(root.body, '本文 1 行目\n# 見出しではない行');
  assert.deepEqual(root.children.map((c) => c.title), ['API', '画面']);
  assert.equal(root.repo, null);
  assert.equal(root.children[0].repo, 'acme/docs');
  assert.equal(root.children[0].children[0].title, 'スキーマ');
  assert.equal(root.children[0].issue, 41);
});

test('serializePlan: 読んだものを書き戻すと同じ内容になる', () => {
  assert.equal(serializePlan(parsePlan(MD)), MD);
});

test('parsePlan: 階層が飛んだ見出しは 1 つ上の子にし、不正な日付は捨てる', () => {
  const p = parsePlan('# a\n### b {start=11/05}\n');
  assert.equal(p.status, 'draft');
  assert.equal(p.nodes[0].children[0].title, 'b');
  assert.equal(p.nodes[0].children[0].start, null);
});

test('flatten: 親 → 子の順に並べる', () => {
  assert.deepEqual(flatten(parsePlan(MD).nodes).map(({ node, parent }) => [node.title, parent?.title || null]), [
    ['通知設定画面', null], ['API', '通知設定画面'], ['スキーマ', 'API'], ['画面', '通知設定画面'],
  ]);
});

test('syncSnapshot: 担当者・ラベルの順番だけ違うものは同じとみなす', () => {
  const a = { title: 't', assignees: ['b', 'a'], labels: ['y', 'x'] };
  assert.equal(syncSnapshot(a), syncSnapshot({ ...a, assignees: ['a', 'b'], labels: ['x', 'y'] }));
  assert.notEqual(syncSnapshot(a), syncSnapshot({ ...a, end: '2026-11-01' }));
});

test('slugify / validFile', () => {
  assert.equal(slugify('Search Filter 2!'), 'search-filter-2');
  assert.equal(slugify('通知'), '');
  assert.ok(validFile('a-1.md'));
  assert.ok(!validFile('../a.md'));
});

test('mergeRemote: GitHub でだけ変わった項目は取り込み、両方で違う値に変わった項目は衝突にする', () => {
  const base = { title: 't', assignees: ['a'], labels: [], milestone: null, sprint: 'S1', start: '2026-11-01', end: '2026-11-05' };
  const local = { ...base, end: '2026-11-08', sprint: 'S2' };
  const remote = { ...base, assignees: ['b'], sprint: 'S3', title: 't' };
  const { take, conflicts } = mergeRemote(local, base, remote);
  assert.deepEqual(take, { assignees: ['b'] });
  assert.deepEqual(conflicts, { sprint: 'S3' });
  // 計画で直した終了日は GitHub が変わっていないのでそのまま (取り込みも衝突もしない)
  assert.ok(!('end' in take) && !('end' in conflicts));
});

test('mergeRemote: 同じ値に変わったものは何もしない。前の衝突は GitHub がそのままなら残し、計画を GitHub に合わせたら消す', () => {
  const base = { title: 't', assignees: [], labels: [], milestone: null, sprint: null, start: null, end: null };
  assert.deepEqual(mergeRemote({ ...base, title: 'u' }, base, { ...base, title: 'u' }), { take: {}, conflicts: {} });
  // 前回の取り込みで base は GitHub の値になっている
  const after = { ...base, title: 'gh' };
  assert.deepEqual(mergeRemote({ ...base, title: 'mine' }, after, after, { title: 'gh' }).conflicts, { title: 'gh' });
  assert.deepEqual(mergeRemote({ ...base, title: 'gh' }, after, after, { title: 'gh' }).conflicts, {});
});

test('snapshotFields / fieldsOf: syncSnapshot と同じ並び・同じ値になる', () => {
  const n = { title: 't', body: 'b', assignees: ['b', 'a'], labels: ['x'], milestone: 'v1', sprint: 'S', start: '2026-11-01', end: null };
  assert.deepEqual(snapshotFields(syncSnapshot(n)), fieldsOf(n));
});

test('serializePlan: 「}」で終わる題名は読み直しても題名のまま', () => {
  const plan = { title: 't', repo: 'acme/api', status: 'draft', nodes: [{ title: 'Use {pr-number}', children: [{ title: 'Ref {x}', issue: 3, children: [] }] }] };
  const md = serializePlan(plan);
  const back = parsePlan(md);
  assert.equal(back.nodes[0].title, 'Use {pr-number}');
  assert.equal(back.nodes[0].children[0].title, 'Ref {x}');
  assert.equal(back.nodes[0].children[0].issue, 3);
  assert.equal(serializePlan(back), md);
});
