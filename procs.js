'use strict';

// The processes of AI runs: whether a saved PID is still a run, and stopping runs and what they left behind

const { execFile, execFileSync } = require('node:child_process');
const { readTail } = require('./logs');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// After a server or machine restart, a saved PID may have been reused by another process.
// Also check it's still claude, so we don't wait on or kill an unrelated process
// Also check for the stream-json flags runAgent adds, so the user's own claude isn't killed (-ww: don't truncate long prompts)
function isAgentRun(pid) {
  if (!isAlive(pid)) return false;
  try {
    const command = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    return /claude/.test(command) && /--output-format stream-json/.test(command);
  } catch {
    return false;
  }
}

// claude started detached leads its process group, so kill the whole group to leave no Bash tool children behind
// If it exited right after the check, kill throws ESRCH and cancel can't restore state, so ignore it
// pid's descendants. ps sees them from here; inside the sandbox a run can't list processes, so pkill fails there
function descendants(pid) {
  let rows = [];
  try {
    rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  } catch {}
  const out = [];
  for (let front = [pid]; front.length; ) {
    front = rows.filter(([, ppid]) => front.includes(ppid)).map(([p]) => p);
    out.push(...front);
  }
  return out;
}

// A server a run started in the background and didn't stop keeps claude waiting after its answer, and the run never
// ends. Called every few seconds: once the answer (the result line) is the last turn for afterMs, stop what is left.
// claude also answers while a background task it started (a test suite) runs, then goes on when the task ends: while
// it has one, wait taskMs instead. seen: { at, id } kept between calls
function reapLeftovers(pid, outFile, seen, afterMs = 60 * 1000, taskMs = 30 * 60 * 1000) {
  let tail = '';
  try { tail = readTail(outFile, 256 * 1024); } catch {}
  let result = null;
  let tasks = [];
  for (const line of tail.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'result') result = e;
    else if (e.type === 'assistant' || e.type === 'user') result = null;
    else if (e.subtype === 'background_tasks_changed') tasks = e.tasks || [];
  }
  if (!result) return Object.assign(seen, { at: 0, id: null });
  if (seen.id !== result.uuid || !seen.at) return Object.assign(seen, { at: Date.now(), id: result.uuid });
  if (Date.now() - seen.at < (tasks.length ? taskMs : afterMs)) return;
  for (const p of descendants(pid)) killRun(p);
}

// Processes whose working directory is in a run's worktree once the run has ended: servers it started that left
// claude's process tree (a run can't stop them itself: kill and pkill are refused or blind in the sandbox)
// lsof scans every process and can take seconds on a busy machine, so it runs async: a sync call stops the server
// answering, and the portal shows it as stopped
async function reapWorktree(dir) {
  if (!dir) return;
  // lsof exits 1 when it can't read some processes; what it printed is still good
  const out = await new Promise((resolve) => {
    const child = execFile('lsof', ['-d', 'cwd', '-Fpn'], { encoding: 'utf8' }, (err, stdout) => resolve(stdout || ''));
    child.stdin.end();
  });
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid !== process.pid && (line.slice(1) === dir || line.slice(1).startsWith(`${dir}/`))) killRun(pid);
  }
}

function killRun(pid) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
}

function waitForExit(pid) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (isAgentRun(pid)) return;
      clearInterval(timer);
      resolve();
    }, 5000);
  });
}

module.exports = { isAlive, isAgentRun, descendants, reapLeftovers, reapWorktree, killRun, waitForExit };
