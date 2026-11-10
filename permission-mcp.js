'use strict';

// Minimal MCP server (stdio) for claude's --permission-prompt-tool.
// claude treats .claude/ as a protected path and refuses edits under -p even with allow rules or hooks.
// To support PRs that fix skills, approve only Edit / Write under .claude/skills and deny everything else as before.
const path = require('node:path');

function approves(toolName, input) {
  if (!['Edit', 'Write'].includes(toolName) || typeof input?.file_path !== 'string') return false;
  // Normalize first so paths escaping skills via .. are rejected
  return /\/\.claude\/skills\/./.test(path.resolve(input.file_path));
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
      const answer = approves(toolName, input) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'docket: この操作は許可されていません' };
      return send(msg.id, { content: [{ type: 'text', text: JSON.stringify(answer) }] });
    }
    send(msg.id, {});
  });
}

if (require.main === module) main();

module.exports = { approves };
