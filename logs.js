'use strict';

// Logs of AI runs: claude's stream-json output, read for the log view, and the finished .log files kept in the log folder

const fs = require('node:fs');
const path = require('node:path');

function parseLines(text) {
  return text.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

// From a running stream-json output, make one line each for the last `limit` Claude messages and tool calls
function logLines(text, limit = 50) {
  const lines = [];
  for (const ev of parseLines(text)) {
    if (ev.type === 'item.completed' || ev.type === 'item.started') {
      const item = ev.item || {};
      if (ev.type === 'item.completed' && item.type === 'agent_message' && item.text?.trim()) lines.push(`💬 ${item.text.trim()}`);
      if (ev.type === 'item.started' && item.type === 'command_execution') lines.push(`🔧 ${item.command}`);
      if (ev.type === 'item.completed' && item.type === 'file_change') lines.push(`🔧 ${JSON.stringify(item.changes)}`);
    }
    if (ev.type !== 'assistant') continue;
    const indent = ev.parent_tool_use_id ? '  ↳ ' : '';
    for (const c of ev.message?.content || []) {
      if (c.type === 'text' && c.text.trim()) lines.push(`${indent}💬 ${c.text.trim()}`);
      if (c.type === 'tool_use') lines.push(`${indent}🔧 ${c.name} ${JSON.stringify(c.input).slice(0, 200)}`);
    }
  }
  return lines.slice(-limit);
}

// The log view shows only recent lines, so read just the tail instead of the whole file every 3s (drop the cut-off first line)
function readTail(file, bytes = 1024 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

// Count / delete only .log files of finished runs (leave running .out / .err alone)
function logFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  // Skip broken links and files deleted meanwhile (throwing in the daily cleanup takes down the server)
  return names.filter((n) => n.endsWith('.log')).flatMap((n) => {
    const file = path.join(dir, n);
    try {
      const { size, mtimeMs } = fs.statSync(file);
      return [{ file, size, mtimeMs }];
    } catch {
      return [];
    }
  });
}

const sumLogs = (list) => ({ count: list.length, bytes: list.reduce((n, f) => n + f.size, 0) });
const logStats = (dir) => sumLogs(logFiles(dir));

// These pile up, so delete ones older than keepMs. 0 deletes all finished .log files ("Delete all" in settings)
function pruneLogs(dir, now, keepMs) {
  // With 0, don't compare times (mtime right after writing can be slightly after now)
  const old = logFiles(dir).filter((f) => keepMs === 0 || now - f.mtimeMs >= keepMs);
  for (const f of old) fs.rmSync(f.file, { force: true });
  return sumLogs(old);
}

module.exports = { parseLines, logLines, readTail, logFiles, logStats, pruneLogs };
