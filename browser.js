'use strict';

// A browser for AI runs' Playwright tests.
// Chromium can't start inside a run's sandbox on macOS (it must register a Mach service, which the sandbox denies),
// so docket-gits starts it outside and the run's Playwright connects to it (PW_TEST_CONNECT_WS_ENDPOINT).
// Client and browser server must be the same Playwright version, and what the project has installed is only known
// when it connects, so the gateway reads the version from the connection and starts a browser of that version.
// The run drives that browser (it can open file:// URLs, and the Playwright server saves files and makes requests
// for it), so the browser server runs in jail.js's sandbox like a run: it can't read credentials or docket data,
// writes only its temp folder, and reaches only loopback. Page traffic goes through a proxy here that only lets
// through hosts resolving to loopback (the dev server the run started). Without that sandbox (not macOS) there is
// no browser, and runs are told so.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const jail = require('./jail');

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

// The loopback address for host, or null. Never asks DNS: a lookup made here, outside any sandbox, would carry
// whatever a run puts in the name to the resolver (and on to a name server anyone can run). So only loopback
// addresses, localhost and *.localhost, and names /etc/hosts maps to loopback (a dev server's local.* host)
const isLoopback = (a) => a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
async function loopback(host, hostsFile = '/etc/hosts') {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (isLoopback(name)) return name;
  if (name === 'localhost' || name.endsWith('.localhost')) return '127.0.0.1';
  let text = '';
  try {
    text = await fs.promises.readFile(hostsFile, 'utf8');
  } catch {
    return null;
  }
  const found = [];
  for (const line of text.split('\n')) {
    const [address, ...names] = line.replace(/#.*/, '').trim().split(/\s+/);
    if (names.map((n) => n.toLowerCase()).includes(name)) found.push(address);
  }
  if (!found.length || !found.every(isLoopback)) return null;
  return found.find((a) => a !== '::1') || found[0];
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

// playwright-core of that version from the registry (outside the sandbox, never the pull request's copy) and its
// Chromium. Returns the package folder
async function playwrightOf(version, home) {
  const dir = path.join(home, 'playwright', version);
  const pkg = path.join(dir, 'node_modules', 'playwright-core');
  if (!fs.existsSync(path.join(pkg, 'package.json'))) {
    await run('npm', ['install', '--prefix', dir, '--no-save', '--no-package-lock', '--ignore-scripts', '--no-audit', '--no-fund', `playwright-core@${version}`]);
  }
  await run(process.execPath, [path.join(pkg, 'cli.js'), 'install', 'chromium']);
  return pkg;
}

// Starts browser-server.js in the sandbox and resolves with { wsEndpoint(), close() } once it is listening.
// script: the server to start (tests pass a stand-in)
function launchJailed({ pkg, proxyPort, home, denyRead, script = path.join(__dirname, 'browser-server.js'), timeoutMs = 120000 }) {
  const tmp = path.join(home, 'tmp', 'browser');
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const [cmd, args] = jail.wrap(process.execPath, [script, pkg, String(proxyPort)], { denyRead, allowWrite: [tmp], ports: '*' });
  // Only what Chromium needs: none of the server's env (tokens) reaches it
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || 'en_US.UTF-8', TMPDIR: tmp };
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the browser did not start in time')); }, timeoutMs);
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.stdout.on('data', (d) => {
      out += d;
      const line = out.split('\n')[0];
      if (!out.includes('\n')) return;
      clearTimeout(timer);
      let ws;
      try {
        ws = JSON.parse(line).ws;
      } catch { /* below */ }
      if (!ws) {
        child.kill('SIGKILL');
        return reject(new Error(`the browser did not start: ${line}`));
      }
      resolve({ wsEndpoint: () => ws, close: () => child.kill(), child });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the browser stopped (${code}): ${err.trim().split('\n').pop() || ''}`));
    });
  });
}

// browserFor(version) -> ws endpoint of a browser server of that version (tests pass their own)
// denyRead: what the browser can't read (the same paths a run can't)
async function startGateway({ home, browserFor, denyRead = [] } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  let proxy = null;
  const servers = new Map();
  browserFor = browserFor || ((version) => {
    if (!servers.has(version)) {
      const started = (async () => {
        if (!jail.available()) throw new Error('the browser for AI runs needs the macOS sandbox (sandbox-exec)');
        proxy = proxy || await startEgressProxy();
        const pkg = await playwrightOf(version, home);
        const server = await launchJailed({ pkg, proxyPort: proxy.address().port, home, denyRead });
        // A browser that stopped is started again next time
        server.child.on('exit', () => servers.delete(version));
        return server;
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

module.exports = { versionOf, loopback, startEgressProxy, startGateway, launchJailed };
