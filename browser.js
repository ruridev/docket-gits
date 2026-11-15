'use strict';

// A browser for AI runs' Playwright tests.
// Chromium can't start inside a run's sandbox on macOS (it must register a Mach service, which the sandbox denies),
// so docket-gits starts it outside and the run's Playwright connects to it (PW_TEST_CONNECT_WS_ENDPOINT).
// Client and browser server must be the same Playwright version, and what the project has installed is only known
// when it connects, so the gateway reads the version from the connection and starts a browser of that version.
// The browser runs the pull request's front-end code: Chromium's own sandbox stays on, and all its traffic goes
// through a proxy here that only lets through hosts resolving to loopback (the dev server the run started).

const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Older Playwright brings an older Chromium. ponytail: fixed floor, raise it as old versions age out
const MIN = [1, 45];

function versionOf(headers) {
  const m = /^Playwright\/(\d+)\.(\d+)\.(\d+) /.exec(headers['user-agent'] || '');
  if (!m || headers['x-playwright-browser'] !== 'chromium') return null;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > MIN[0] || (major === MIN[0] && minor >= MIN[1]) ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

// Pipe two sockets both ways; when either side ends, close both (http servers keep sockets half-open otherwise)
function splice(a, b) {
  const done = () => { a.destroy(); b.destroy(); };
  for (const s of [a, b]) for (const ev of ['end', 'close', 'error']) s.on(ev, done);
  a.pipe(b);
  b.pipe(a);
}

// The address host resolves to, if it is loopback (connecting to that address, not the name, so it can't change)
async function loopback(host) {
  try {
    const { address } = await dns.promises.lookup(host.replace(/^\[|\]$/g, ''));
    return address === '::1' || address.startsWith('127.') ? address : null;
  } catch {
    return null;
  }
}

function startEgressProxy() {
  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url); } catch { return res.writeHead(400).end(); }
    const address = await loopback(url.hostname);
    if (!address) return res.writeHead(403).end();
    const up = http.request({ host: address, port: url.port || 80, path: url.pathname + url.search, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  server.on('connect', async (req, sock, head) => {
    sock.on('error', () => {});
    const i = req.url.lastIndexOf(':');
    const address = await loopback(req.url.slice(0, i));
    if (!address) return sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    const up = net.connect(Number(req.url.slice(i + 1)), address, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      splice(sock, up);
    });
    up.on('error', () => sock.destroy());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60 * 1000 },
  (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n').pop())) : resolve(stdout))));

// playwright-core of that version from the registry (outside the sandbox, never the pull request's copy) and its Chromium
async function playwrightOf(version, home) {
  const dir = path.join(home, 'playwright', version);
  const pkg = path.join(dir, 'node_modules', 'playwright-core');
  if (!fs.existsSync(path.join(pkg, 'package.json'))) {
    await run('npm', ['install', '--prefix', dir, '--no-save', '--no-package-lock', '--ignore-scripts', '--no-audit', '--no-fund', `playwright-core@${version}`]);
  }
  await run(process.execPath, [path.join(pkg, 'cli.js'), 'install', 'chromium']);
  return require(pkg);
}

// browserFor(version) -> ws endpoint of a browser server of that version (tests pass their own)
async function startGateway({ home, browserFor } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  let proxy = null;
  const servers = new Map();
  browserFor = browserFor || ((version) => {
    if (!servers.has(version)) {
      const started = (async () => {
        proxy = proxy || await startEgressProxy();
        const { chromium } = await playwrightOf(version, home);
        return chromium.launchServer({ host: '127.0.0.1', port: 0, chromiumSandbox: true, proxy: { server: `http://127.0.0.1:${proxy.address().port}` },
          args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
      })();
      // A failed start (no network, ...) is tried again next time
      started.catch(() => servers.delete(version));
      servers.set(version, started);
    }
    return servers.get(version).then((s) => s.wsEndpoint());
  });
  const gateway = http.createServer((req, res) => res.writeHead(404).end());
  gateway.on('upgrade', async (req, sock, head) => {
    sock.on('error', () => {});
    const version = versionOf(req.headers);
    if (req.url !== `/${token}` || !version) return sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    let target;
    try {
      target = new URL(await browserFor(version));
    } catch (e) {
      console.error(`browser ${version}: ${e.message}`);
      return sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    }
    // Replay the upgrade request to the browser server with its path, then just pass bytes both ways
    const lines = [`GET ${target.pathname} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${/^host$/i.test(req.rawHeaders[i]) ? target.host : req.rawHeaders[i + 1]}`);
    const up = net.connect(Number(target.port), target.hostname, () => {
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      up.write(head);
      splice(sock, up);
    });
    up.on('error', () => sock.destroy());
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `ws://127.0.0.1:${gateway.address().port}/${token}`,
    close() {
      gateway.close();
      proxy?.close();
      for (const s of servers.values()) s.then((b) => b.close(), () => {});
    },
  };
}

module.exports = { versionOf, startEgressProxy, startGateway };
