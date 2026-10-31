'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlan, serializePlan, flatten, syncSnapshot, slugify, validFile } = require('./plans');

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
