'use strict';

// Minimal MCP server (stdio) for claude's --permission-prompt-tool.
// claude treats .claude/ as a protected path and refuses edits under -p even with allow rules or hooks.
// To support PRs that fix skills, approve only Edit / Write under <run cwd>/.claude/skills and deny everything else as before.
// The run's cwd comes in DOCKET_SKILLS_ROOT (set by server.js), so global ~/.claude/skills and other repos stay protected
const fs = require('node:fs');
const path = require('node:path');

// Real path of p, or of its nearest existing parent plus the rest (for new files)
function realish(p) {
  let rest = '';
  for (;;) {
    try {
      return path.join(fs.realpathSync(p), rest);
    } catch (e) {
      if (e.code !== 'ENOENT' || path.dirname(p) === p) return null;
      rest = path.join(path.basename(p), rest);
      p = path.dirname(p);
    }
  }
}

function approves(toolName, input, root = process.env.DOCKET_SKILLS_ROOT) {
  const file = input?.file_path;
  if (!['Edit', 'Write'].includes(toolName) || typeof file !== 'string' || !root) return false;
  // Reject .. outright: symlinks make lexical and real resolution disagree
  if (file.split(/[\\/]/).includes('..')) return false;
  let skills;
  try {
    skills = fs.realpathSync(path.join(root, '.claude', 'skills'));
  } catch {
    return false;
  }
  const target = realish(path.resolve(root, file));
  return !!target && target.startsWith(skills + path.sep);
}

function main() {
  const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id === undefined) return;
    if (msg.method === 'initialize') return send(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'docket', version: '1' } });
    if (msg.method === 'tools/list') return send(msg.id, { tools: [{ name: 'approve', description: 'Approve or deny a tool call', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' } } } }] });
    if (msg.method === 'tools/call') {
      const { tool_name: toolName, input } = msg.params.arguments || {};
      const answer = approves(toolName, input) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'docket: this action is not allowed' };
      return send(msg.id, { content: [{ type: 'text', text: JSON.stringify(answer) }] });
    }
    send(msg.id, {});
  });
}

if (require.main === module) main();

module.exports = { approves };
