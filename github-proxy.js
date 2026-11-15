'use strict';

// The only way AI runs reach GitHub. gh in a run is set up (http_unix_socket) to send every API request
// to this Unix socket; the sandbox blocks all other network. Requests that read go on to api.github.com
// with the user's gh token, added here, so a run never holds a token. Requests that could write are refused:
// the check is on the kind of HTTP request, not on the command a run used to make it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { execFile } = require('node:child_process');

const SOCKET_DIR = path.join(os.tmpdir(), `docket-gits-${process.getuid?.() ?? 'user'}`);
// One per server (port), so a second instance (another account) has its own
const SOCKET = path.join(SOCKET_DIR, `github-${process.env.PORT || 4649}.sock`);
const MAX_BODY = 1024 * 1024;

// GraphQL text without strings and comments: an operation keyword can't hide in a string, and a string
// that says "mutation" doesn't block a query. One left-to-right pass, so a quote inside a comment (or a #
// inside a string) can't open a fake string or comment that hides the next line
function graphqlKeywords(query) {
  return query.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|#[^\n]*/g, '');
}

// Whether a request only reads: GET / HEAD, or a GraphQL query. Anything unclear is refused
function isRead(method, url, body) {
  if (!url.startsWith('/') || url.startsWith('//')) return false;
  if (method === 'GET' || method === 'HEAD') return true;
  if (method !== 'POST' || url.split('?')[0] !== '/graphql') return false;
  let doc;
  try {
    doc = JSON.parse(body.toString('utf8') || 'null');
  } catch {
    return false;
  }
  if (!doc || Array.isArray(doc) || typeof doc.query !== 'string') return false;
  return !/\b(mutation|subscription)\b/.test(graphqlKeywords(doc.query));
}

// The user's gh token, asked from gh outside the sandbox and kept for a few minutes
function tokenSource(ttlMs = 5 * 60e3) {
  let cached = null;
  let at = 0;
  return () => new Promise((resolve, reject) => {
    if (cached && Date.now() - at < ttlMs) return resolve(cached);
    execFile('gh', ['auth', 'token'], (err, stdout) => {
      if (err || !stdout.trim()) return reject(new Error('gh is not logged in'));
      cached = stdout.trim();
      at = Date.now();
      resolve(cached);
    });
  });
}

// Headers that some servers read as another method
const DROP = new Set(['authorization', 'host', 'x-http-method-override', 'x-http-method', 'x-method-override', 'proxy-authorization', 'connection']);

function startGitHubProxy({ socket = SOCKET, getToken = tokenSource(), upstream = { protocol: https, host: 'api.github.com' }, log = () => {} } = {}) {
  fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(socket), 0o700);
  fs.rmSync(socket, { force: true });
  const refuse = (res, status, message) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: `docket-gits: ${message}` }));
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size <= MAX_BODY) chunks.push(d);
    });
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      if (size > MAX_BODY) return refuse(res, 413, 'request too large');
      if ((req.headers.host || '').toLowerCase() !== 'api.github.com') return refuse(res, 403, 'runs can only reach api.github.com');
      if (!isRead(req.method, req.url, body)) {
        log(`refused ${req.method} ${req.url.split('?')[0]}`);
        return refuse(res, 403, 'runs can only read from GitHub; docket-gits posts and pushes after you check the result');
      }
      let token;
      try {
        token = await getToken();
      } catch (e) {
        return refuse(res, 502, e.message);
      }
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !DROP.has(k.toLowerCase())));
      const up = upstream.protocol.request({ host: upstream.host, port: upstream.port, method: req.method, path: req.url,
        headers: { ...headers, host: upstream.host, authorization: `token ${token}`, ...(body.length && { 'content-length': body.length }) } }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on('error', (e) => refuse(res, 502, e.message));
      up.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => {
      fs.chmodSync(socket, 0o600);
      resolve(server);
    });
  });
}

// The gh config of a run: every request goes to the socket
const ghConfig = (socket = SOCKET) => `http_unix_socket: ${socket}\n`;

module.exports = { SOCKET, isRead, graphqlKeywords, startGitHubProxy, tokenSource, ghConfig };
