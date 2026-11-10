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

test('parsePlan: reads frontmatter, heading levels, attributes and body', () => {
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

test('serializePlan: writing back what was read gives the same content', () => {
  assert.equal(serializePlan(parsePlan(MD)), MD);
});

test('parsePlan: a heading that skips a level becomes a child one level up; invalid dates are dropped', () => {
  const p = parsePlan('# a\n### b {start=11/05}\n');
  assert.equal(p.status, 'draft');
  assert.equal(p.nodes[0].children[0].title, 'b');
  assert.equal(p.nodes[0].children[0].start, null);
});

test('flatten: orders parent -> child', () => {
  assert.deepEqual(flatten(parsePlan(MD).nodes).map(({ node, parent }) => [node.title, parent?.title || null]), [
    ['通知設定画面', null], ['API', '通知設定画面'], ['スキーマ', 'API'], ['画面', '通知設定画面'],
  ]);
});

test('syncSnapshot: treats assignees/labels differing only in order as equal', () => {
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

test('mergeRemote: takes fields changed only on GitHub; fields changed to different values on both sides are conflicts', () => {
  const base = { title: 't', assignees: ['a'], labels: [], milestone: null, sprint: 'S1', start: '2026-11-01', end: '2026-11-05' };
  const local = { ...base, end: '2026-11-08', sprint: 'S2' };
  const remote = { ...base, assignees: ['b'], sprint: 'S3', title: 't' };
  const { take, conflicts } = mergeRemote(local, base, remote);
  assert.deepEqual(take, { assignees: ['b'] });
  assert.deepEqual(conflicts, { sprint: 'S3' });
  // The end date edited in the plan stays as is since GitHub did not change (neither taken nor a conflict)
  assert.ok(!('end' in take) && !('end' in conflicts));
});

test('mergeRemote: no-op when both changed to the same value; a previous conflict stays while GitHub is unchanged and clears once the plan matches GitHub', () => {
  const base = { title: 't', assignees: [], labels: [], milestone: null, sprint: null, start: null, end: null };
  assert.deepEqual(mergeRemote({ ...base, title: 'u' }, base, { ...base, title: 'u' }), { take: {}, conflicts: {} });
  // After the previous pull, base holds the GitHub value
  const after = { ...base, title: 'gh' };
  assert.deepEqual(mergeRemote({ ...base, title: 'mine' }, after, after, { title: 'gh' }).conflicts, { title: 'gh' });
  assert.deepEqual(mergeRemote({ ...base, title: 'gh' }, after, after, { title: 'gh' }).conflicts, {});
});

test('snapshotFields / fieldsOf: same order and values as syncSnapshot', () => {
  const n = { title: 't', body: 'b', assignees: ['b', 'a'], labels: ['x'], milestone: 'v1', sprint: 'S', start: '2026-11-01', end: null };
  assert.deepEqual(snapshotFields(syncSnapshot(n)), fieldsOf(n));
});

test('serializePlan: a title ending in "}" stays the title after reading back', () => {
  const plan = { title: 't', repo: 'acme/api', status: 'draft', nodes: [{ title: 'Use {pr-number}', children: [{ title: 'Ref {x}', issue: 3, children: [] }] }] };
  const md = serializePlan(plan);
  const back = parsePlan(md);
  assert.equal(back.nodes[0].title, 'Use {pr-number}');
  assert.equal(back.nodes[0].children[0].title, 'Ref {x}');
  assert.equal(back.nodes[0].children[0].issue, 3);
  assert.equal(serializePlan(back), md);
});
