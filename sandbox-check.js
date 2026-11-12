'use strict';

// Checks, with a real Claude run, that the environment docket-gits gives its runs holds:
// no credentials, no network but GitHub, no writes outside the run's folder, no web or data access.
// Costs one short run. Usage: node sandbox-check.js [model]   (default: haiku)
// Each probe prints only an exit code, so no secret ends up in the output.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { agentArgs, agentEnv, prepareWorkspace, removeWorkspace } = require('./workspace');

const TOKEN = 'github_pat_sandbox_check';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-gits-check-'));
  const workdir = path.join(root, 'workdir');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(workdir);
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'secret.txt'), 'not for runs\n');
  const ws = await prepareWorkspace({ repo: 'check/check', number: 1 }, { runId: 'check', clone: false, root: path.join(root, 'work') });

  // [what, command, expected exit is zero?]
  const probes = [
    ['gh token in the keychain', 'security find-generic-password -s gh:github.com -w >/dev/null 2>&1', false],
    ['gh login without GH_TOKEN', 'env -u GH_TOKEN gh auth token >/dev/null 2>&1', false],
    ['read ~/.ssh', 'ls ~/.ssh >/dev/null 2>&1', false],
    ['read ~/.config/gh', 'ls ~/.config/gh >/dev/null 2>&1', false],
    ['ssh to GitHub', "ssh -T -o BatchMode=yes -o ConnectTimeout=5 git@github.com 2>&1 | grep -q 'successfully authenticated'", false],
    ['reach another host', 'curl -s -m 8 -o /dev/null https://example.com', false],
    ['reach api.github.com', 'curl -s -m 8 -o /dev/null https://api.github.com/zen', true],
    ["read docket-gits' data", `cat ${dataDir}/secret.txt >/dev/null 2>&1`, false],
    ['write to the working directory', `touch ${workdir}/written >/dev/null 2>&1`, false],
    ['write to the home directory', 'touch ~/.docket-gits-sandbox-check >/dev/null 2>&1', false],
    ["write to the run's folder", 'touch inside.txt', true],
    ['secrets from the server env', 'test -z "$GITHUB_TOKEN$SSH_AUTH_SOCK$DOCKET_CHECK_SECRET"', true],
    ['GH_TOKEN is the read-only token', `test "$GH_TOKEN" = ${TOKEN}`, true],
  ];
  const prompt = `This is an automated environment check. Run each numbered command below with the Bash tool, exactly as written, one per call. Do not run anything else, do not retry, and do not work around failures.
${probes.map(([, cmd], i) => `${i + 1}) ${cmd}; echo exit=$?`).join('\n')}
Then use the Read tool on ${dataDir}/secret.txt, and the WebFetch tool on https://example.com. Report only whether each call worked.`;

  const env = { ...agentEnv({ ...process.env, GITHUB_TOKEN: 'leak', DOCKET_CHECK_SECRET: 'leak' }, { token: TOKEN, ghDir: ws.ghDir }) };
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', process.argv[2] || 'haiku',
    ...agentArgs({ runDir: ws.runDir, workdir, dataDir, envPath: process.env.PATH })];
  const run = spawnSync('claude', args, { cwd: ws.cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300e3 });

  const commands = new Map();
  const results = new Map();
  const errors = new Set();
  for (const line of (run.stdout || '').split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const c of content) {
      if (c.type === 'tool_use') commands.set(c.id, c.input?.command || c.name);
      if (c.type === 'tool_result') results.set(c.tool_use_id, String(Array.isArray(c.content) ? c.content.map((x) => x.text).join('') : c.content));
      if (c.type === 'tool_result' && c.is_error) errors.add(c.tool_use_id);
    }
  }
  // A tool is blocked when it was denied, failed, or is not offered at all
  const usedOk = (name) => [...commands].some(([id, c]) => c === name && results.has(id) && !errors.has(id));

  let failed = 0;
  const report = (ok, what, detail) => {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
  };
  probes.forEach(([what, cmd, zero]) => {
    const id = [...commands].find(([, c]) => c.startsWith(cmd))?.[0];
    const code = id && /exit=(\d+)/.exec(results.get(id) || '')?.[1];
    if (code === undefined) return report(false, what, 'not run');
    report((code === '0') === zero, zero ? what : `blocked: ${what}`, `exit=${code}`);
  });
  report(!usedOk('Read'), "blocked: Read tool on docket-gits' data");
  report(!usedOk('WebFetch'), 'blocked: WebFetch');
  report(!fs.existsSync(path.join(workdir, 'written')), 'working directory unchanged');
  if (fs.existsSync(path.join(os.homedir(), '.docket-gits-sandbox-check'))) {
    fs.rmSync(path.join(os.homedir(), '.docket-gits-sandbox-check'));
    report(false, 'home directory unchanged');
  }
  if (run.status !== 0) report(false, 'claude exited cleanly', (run.stderr || '').trim().split('\n').pop());

  removeWorkspace(ws.runDir, path.join(root, 'work'));
  fs.rmSync(root, { recursive: true, force: true });
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
