'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { repoTool, listSkills, readCodexResult, readRun, codexOptions, sessionProvider, sanitizeConfig, addUsage, logLines, skillInvocation, runForTag } = require('./server');

const jsonl = (events) => events.map((event) => JSON.stringify(event)).join('\n');
const codexEvents = (text = 'answer') => [
  { type: 'thread.started', thread_id: 'codex-thread' },
  { type: 'item.completed', item: { type: 'agent_message', text } },
  { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 } },
];

test('Codex JSONL: success requires a completed turn, preserves the thread, and counts cached input once', () => {
  const result = readCodexResult(jsonl(codexEvents()), '', 0);
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'codex-thread');
  assert.equal(result.result, 'answer');
  assert.deepEqual(result.usage, { tokens: 120, costUsd: null });
  assert.equal(readCodexResult(jsonl(codexEvents()), '', 1).ok, false);
  assert.equal(readCodexResult(jsonl(codexEvents().slice(0, 2)), 'interrupted', 0).ok, false);
  const failed = readCodexResult(jsonl([{ type: 'turn.failed', error: { message: 'denied' } }]), '', 0);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'denied');
});

test('Codex logs and restart recovery parse the saved provider format', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-codex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const text = jsonl(codexEvents('<docket-findings>{"findings":[]}</docket-findings>'));
  fs.writeFileSync(path.join(dir, 'run.out'), text);
  fs.writeFileSync(path.join(dir, 'run.err'), '');
  assert.equal(readRun(dir, 'run', 0, 'codex').ok, true);
  assert.deepEqual(fs.readdirSync(dir), ['run.log']);
  assert.match(logLines(text)[0], /docket-findings/);
});

test('Provider settings reject unknown tools; legacy sessions remain Claude; unknown cost stays unknown', () => {
  assert.deepEqual(sanitizeConfig({ provider: 'shell', codexModel: 42 }), {});
  assert.deepEqual(sanitizeConfig({ provider: 'codex', codexModel: 'test-model' }), { provider: 'codex', codexModel: 'test-model' });
  assert.equal(sessionProvider({}), 'claude');
  assert.equal(sessionProvider({ provider: 'codex' }), 'codex');
  assert.deepEqual(addUsage({ tokens: 1, costUsd: 1 }, { tokens: 2, costUsd: null }), { tokens: 3, costUsd: null });
  assert.deepEqual(addUsage({ tokens: 1, costUsd: null }, { tokens: 2, costUsd: 1 }), { tokens: 3, costUsd: null });
});

test('Codex command uses its own settings and resumes an explicit session', () => {
  const args = codexOptions({ codexArgs: '--approve-for-me', codexModel: 'codex-model', codexEffort: 'high', model: 'opus' }, 'prompt', 'thread-123');
  assert.deepEqual(args, ['--approve-for-me', 'exec', 'resume', 'thread-123', '--json', '--skip-git-repo-check', '--model', 'codex-model', '-c', 'model_reasoning_effort="high"', 'prompt']);
  assert.equal(codexOptions({}, 'prompt').includes('resume'), false);
});

test('Skill discovery and invocation use only the selected tool directories', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-skill-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.claude', 'skills', 'example', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'review instructions');
  assert.equal(listSkills([dir], 'codex').includes('example'), false);
  const codexFile = path.join(dir, '.agents', 'skills', 'codex-example', 'SKILL.md');
  fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  fs.writeFileSync(codexFile, 'Codex review instructions');
  assert.equal(listSkills([dir], 'claude').includes('codex-example'), false);
  assert.equal(listSkills([dir], 'codex').includes('codex-example'), true);
  assert.equal(listSkills([dir], 'claude').includes('example'), true);
  const prompt = skillInvocation('codex-example', '42', 'codex', dir);
  assert.ok(prompt.includes(JSON.stringify(codexFile)));
  assert.match(prompt, /42/);
  assert.equal(skillInvocation('example', '42', 'claude', dir), '/example 42');
});

test('Repository mappings preserve Claude settings and keep Codex skills and arguments independent', () => {
  const mapping = { skill: 'claude-review', args: 'claude-args', selfSkill: 'claude-self', fixSkill: 'claude-fix', cwd: '/repo', codex: { skill: 'codex-review', args: 'codex-args', selfSkill: 'codex-self', fixSkill: 'codex-fix' } };
  assert.equal(repoTool(mapping, 'claude').skill, 'claude-review');
  assert.deepEqual(repoTool(mapping, 'codex'), { ...mapping.codex, cwd: '/repo' });
  assert.equal(repoTool({ skill: 'claude-only' }, 'codex').skill, undefined);
  assert.equal(repoTool(undefined, 'claude').skill, undefined);
});

test('Tag retry keeps the selected provider and explicit session', async () => {
  const calls = [];
  await runForTag('test', 'prompt', { provider: 'codex', logName: 'r' }, async (_, opts) => {
    calls.push(opts);
    return { ok: true, sessionId: 'thread', result: calls.length === 1 ? 'missing' : '<test>{}</test>' };
  });
  assert.equal(calls[1].provider, 'codex');
  assert.equal(calls[1].resume, 'thread');
});

test('HTTP flow: default and explicit tools, triage, posting and applying retain the original provider', { timeout: 20000 }, async (t) => {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(__dirname, 'data', 'test-providers-'));
  const preload = path.join(dir, 'mock.cjs');
  // Only the agent subprocess is simulated. Exercise the real server, queue, state and HTTP handlers.
  const agentScript = `
    const fs = require('node:fs');
    const { command, args, calls } = JSON.parse(process.argv[1]);
    fs.appendFileSync(calls, JSON.stringify({ command, args }) + '\\n');
    const prompt = command === 'codex' ? args.at(-1) : args[args.indexOf('-p') + 1];
    const result = prompt.includes('<docket-posted>') ? '<docket-posted>{"posted":true}</docket-posted>'
      : prompt.includes('<docket-applied>') ? '<docket-applied>{"done":true}</docket-applied>'
      : prompt.includes('<docket-fix-plan>') ? '<docket-fix-plan>{"items":[]}</docket-fix-plan>'
      : '<docket-findings>{"findings":[]}</docket-findings>';
    const events = command === 'codex'
      ? [{type:'thread.started',thread_id:'codex-thread'},{type:'item.completed',item:{type:'agent_message',text:result}},{type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}]
      : [{type:'result',result,session_id:'claude-session'}];
    for (const event of events) console.log(JSON.stringify(event));
  `;
  fs.writeFileSync(preload, `
    const cp = require('node:child_process');
    const original = cp.spawn;
    cp.spawn = (command, args, options) => ['claude', 'codex'].includes(command)
      ? original(process.execPath, ['-e', ${JSON.stringify(agentScript)}, JSON.stringify({command,args,calls:${JSON.stringify(path.join(dir, 'calls.jsonl'))}})], options)
      : original(command, args, options);
    cp.execFile = (command, args, options, callback) => process.nextTick(() => callback(new Error('GitHub disabled in test')));
  `);
  const pr = { repo: 'acme/api', number: 1, url: 'https://github.com/acme/api/pull/1', reviews: [], requested: [], labels: [], issues: [], author: {} };
  const mineKey = 'mine:acme/api#1';
  const mapping = { skill: '(prompt)', selfSkill: '(prompt)', fixSkill: '(prompt)' };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ consentVersion: 2, provider: 'codex', workdir: dir, repos: { 'acme/api': mapping } }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ prs: { 'acme/api#1': { status: 'requested', pr } }, mine: { [mineKey]: { status: 'idle', pr, threads: [{ no: 1, url: 'https://github.com/acme/api/pull/1#discussion_r1', comment: 'fix this', author: 'reviewer' }] } } }));
  const port = await new Promise((resolve) => {
    const server = require('node:net').createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  const child = spawn(process.execPath, ['--require', preload, path.join(__dirname, 'server.js')], { env: { ...process.env, DOCKET_DATA: dir, PORT: String(port) } });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const address = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', (chunk) => { const match = /docket-gits: (http:\/\/localhost:\d+)/.exec(String(chunk)); if (match) resolve(match[1]); });
    child.once('exit', () => reject(new Error(stderr)));
  });
  const api = async (route, body, method = 'POST') => {
    const response = await fetch(address + route, { method: body === undefined ? 'GET' : method, headers: { 'X-Docket': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const wait = async (kind, status) => {
    for (let i = 0; i < 100; i++) {
      const { data } = await api('/api/board');
      if (data[kind][0].status === status) return data[kind][0];
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.fail(`Did not reach ${status}: ${stderr}`);
  };
  assert.equal((await api('/api/review', { key: 'acme/api#1', provider: 'shell' })).status, 400);
  assert.equal((await api('/api/config', { provider: 'shell' }, 'PUT')).status, 400);
  assert.equal((await api('/api/skills?provider=shell')).status, 400);
  assert.equal((await api('/api/review', { key: 'acme/api#1', provider: 'codex' })).status, 400);
  assert.equal((await api('/api/mine/run', { key: mineKey, mode: 'self', provider: 'codex' })).status, 400);
  await api('/api/config', { repos: { 'acme/api': { ...mapping, codex: { ...mapping, args: 'codex-args' } } } }, 'PUT');
  assert.equal((await api('/api/board')).data.config.repos['acme/api'].codex.args, 'codex-args');
  assert.equal((await api('/api/review', { key: 'acme/api#1' })).status, 200);
  assert.equal((await wait('prs', 'reviewed')).provider, 'codex');
  await api('/api/config', { provider: 'claude' }, 'PUT');
  await api('/api/post', { key: 'acme/api#1', decisions: {}, humanRead: true });
  await wait('prs', 'commented');
  await api('/api/mine/run', { key: mineKey, mode: 'self', provider: 'codex' });
  assert.equal((await wait('mine', 'planned')).provider, 'codex');
  await api('/api/mine/apply', { key: mineKey, decisions: {}, confirmed: true });
  await wait('mine', 'idle');
  await api('/api/mine/run', { key: mineKey, mode: 'fix', provider: 'claude', decisions: { 'https://github.com/acme/api/pull/1#discussion_r1': { verdict: 'agree' } } });
  assert.equal((await wait('mine', 'planned')).provider, 'claude');
  const calls = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map((c) => c.command), ['codex', 'codex', 'codex', 'codex', 'claude']);
  assert.deepEqual(calls[1].args.slice(calls[1].args.indexOf('exec'), calls[1].args.indexOf('exec') + 3), ['exec', 'resume', 'codex-thread']);
  assert.ok(calls[3].args.includes('codex-thread'));
  for (const [scope, name] of [['.claude', 'docket-claude-review'], ['.agents', 'docket-codex-review']]) {
    const file = path.join(dir, scope, 'skills', name, 'SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'Review instructions');
  }
  await api('/api/config', { repos: { 'acme/api': {
    ...mapping, skill: 'docket-claude-review', args: 'CLAUDE-{pr-number}',
    codex: { ...mapping, skill: 'docket-codex-review', args: 'CODEX-{pr-number}' },
  } } }, 'PUT');
  const claudeSkills = (await api('/api/skills?provider=claude')).data.skills;
  const codexSkills = (await api('/api/skills?provider=codex')).data.skills;
  assert.ok(claudeSkills.includes('docket-claude-review'));
  assert.ok(!claudeSkills.includes('docket-codex-review'));
  assert.ok(codexSkills.includes('docket-codex-review'));
  assert.ok(!codexSkills.includes('docket-claude-review'));
  await api('/api/review', { key: 'acme/api#1', provider: 'codex' });
  await wait('prs', 'reviewed');
  await api('/api/review', { key: 'acme/api#1', provider: 'claude' });
  await wait('prs', 'reviewed');
  const finalCalls = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.match(finalCalls.at(-2).args.at(-1), /docket-codex-review[\s\S]*CODEX-1/);
  const claudeArgs = finalCalls.at(-1).args;
  assert.match(claudeArgs[claudeArgs.indexOf('-p') + 1], /^\/docket-claude-review CLAUDE-1/);
});
