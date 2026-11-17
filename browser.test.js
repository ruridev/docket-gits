'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { versionOf, startEgressProxy, startGateway } = require('./browser');

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

// Send raw bytes to a port and collect what comes back until the other side closes or `until` matches
function raw(port, text, until = null) {
  return new Promise((resolve) => {
    let got = '';
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    s.on('data', (d) => {
      got += d;
      if (until && until.test(got)) s.destroy();
    });
    s.on('close', () => resolve(got));
    s.on('error', () => resolve(got));
  });
}

test('versionOf: the Playwright version a chromium client sends, nothing else', () => {
  assert.equal(versionOf({ 'user-agent': 'Playwright/1.64.0 (arm64; macOS 26.3) node/24.13', 'x-playwright-browser': 'chromium' }), '1.64.0');
  assert.equal(versionOf({ 'user-agent': 'Playwright/1.64.0 (arm64)', 'x-playwright-browser': 'firefox' }), null);
  assert.equal(versionOf({ 'user-agent': 'Playwright/1.64.0;rm -rf (arm64)', 'x-playwright-browser': 'chromium' }), null);
  assert.equal(versionOf({ 'user-agent': 'Playwright/1.30.0 (arm64)', 'x-playwright-browser': 'chromium' }), null, 'too old');
  assert.equal(versionOf({}), null);
});

test('startEgressProxy: tunnels and forwards only to hosts that resolve to loopback', async (t) => {
  const site = http.createServer((q, s) => s.end(`site ${q.url}`));
  const sitePort = await listen(site);
  const proxy = await startEgressProxy();
  t.after(() => { site.close(); proxy.close(); });
  const pp = proxy.address().port;

  const ok = await raw(pp, `CONNECT localhost:${sitePort} HTTP/1.1\r\nHost: localhost:${sitePort}\r\n\r\nGET /t HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
  assert.match(ok, /^HTTP\/1\.1 200/);
  assert.match(ok, /site \/t/);
  const denied = await raw(pp, 'CONNECT 8.8.8.8:443 HTTP/1.1\r\nHost: 8.8.8.8:443\r\n\r\n');
  assert.match(denied, /^HTTP\/1\.1 403/);
  const plain = await raw(pp, `GET http://127.0.0.1:${sitePort}/p HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  assert.match(plain, /site \/p/);
  const plainDenied = await raw(pp, 'GET http://8.8.8.8/ HTTP/1.1\r\nHost: 8.8.8.8\r\nConnection: close\r\n\r\n');
  assert.match(plainDenied, /^HTTP\/1\.1 403/);
});

test('startGateway: hands a client with the token to a browser of its version, refuses others', async (t) => {
  // A stand-in for a browser server: answers the upgrade and echoes what follows
  const seen = [];
  const backend = http.createServer().on('upgrade', (req, sock, head) => {
    seen.push(req.url);
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    if (head.length) sock.write(`echo:${head}`);
    sock.on('data', (d) => sock.write(`echo:${d}`));
    sock.on('end', () => sock.destroy());
  });
  const backendPort = await listen(backend);
  const versions = [];
  const gw = await startGateway({ browserFor: async (v) => { versions.push(v); return `ws://127.0.0.1:${backendPort}/backend`; } });
  t.after(() => { backend.close(); gw.close(); });
  const { port, pathname } = new URL(gw.endpoint);
  const hello = (p, ua = 'Playwright/1.64.0 (arm64)') => `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nUser-Agent: ${ua}\r\nx-playwright-browser: chromium\r\n\r\nping`;

  const got = await raw(port, hello(pathname), /echo:ping/);
  assert.match(got, /^HTTP\/1\.1 101/);
  assert.match(got, /echo:ping/);
  assert.deepEqual(versions, ['1.64.0']);
  assert.deepEqual(seen, ['/backend']);
  assert.match(await raw(port, hello('/wrong-token')), /^HTTP\/1\.1 403/);
  assert.match(await raw(port, hello(pathname, 'curl/8')), /^HTTP\/1\.1 403/);
});

test('launchJailed: the browser server can read no credentials, write only its temp folder, reach only loopback', { skip: !require('./jail').available() && 'macOS only' }, async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docket-br-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secret = path.join(root, 'secret');
  fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, 'token'), 'TOKEN');
  const lo = http.createServer((q, s) => s.end('loopback'));
  const loPort = await listen(lo);
  t.after(() => lo.close());
  // A stand-in for browser-server.js: tries what a hostile client could make the real one do, then reports
  const script = path.join(root, 'stub.js');
  fs.writeFileSync(script, `
const fs = require('fs'), http = require('http'), net = require('net');
const r = { env: process.env.GITHUB_TOKEN || null };
try { fs.readFileSync(${JSON.stringify(path.join(secret, 'token'))}); r.read = 'ok'; } catch (e) { r.read = e.code; }
try { fs.writeFileSync(${JSON.stringify(path.join(root, 'outside.txt'))}, 'x'); r.write = 'ok'; } catch (e) { r.write = e.code; }
fs.writeFileSync(process.env.TMPDIR + '/inside.txt', 'x');
http.get('http://127.0.0.1:${loPort}/', (res) => { r.loopback = res.statusCode;
  const c = net.connect(443, '1.1.1.1', () => { r.net = 'ok'; done(); }); c.on('error', (e) => { r.net = e.code; done(); }); });
function done() { fs.writeFileSync(process.env.TMPDIR + '/result.json', JSON.stringify(r)); console.log(JSON.stringify({ ws: 'ws://127.0.0.1:1/stub' })); process.stdin.resume(); }
`);
  process.env.GITHUB_TOKEN = 'server-token';
  t.after(() => { delete process.env.GITHUB_TOKEN; });
  const home = path.join(root, 'home');
  const { launchJailed } = require('./browser');
  const b = await launchJailed({ pkg: 'unused', proxyPort: 1, home, denyRead: [secret], script });
  t.after(() => b.close());
  assert.equal(b.wsEndpoint(), 'ws://127.0.0.1:1/stub');
  const r = JSON.parse(fs.readFileSync(path.join(home, 'tmp', 'browser', 'result.json'), 'utf8'));
  assert.deepEqual(r, { env: null, read: 'EPERM', write: 'EPERM', loopback: 200, net: 'EPERM' });
  assert.equal(fs.existsSync(path.join(root, 'outside.txt')), false);
});

test('loopback: loopback addresses, localhost and /etc/hosts names only; DNS is never asked', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loopback } = require('./browser');
  const hosts = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'docket-hosts-')), 'hosts');
  t.after(() => fs.rmSync(path.dirname(hosts), { recursive: true, force: true }));
  fs.writeFileSync(hosts, '127.0.0.1 local.example.com\n::1 local.example.com\n10.0.0.5 lan.example.com\n127.0.0.1 mixed.example.com\n10.0.0.6 mixed.example.com # x\n');
  assert.equal(await loopback('127.0.0.1', hosts), '127.0.0.1');
  assert.equal(await loopback('[::1]', hosts), '::1');
  assert.equal(await loopback('localhost', hosts), '127.0.0.1');
  assert.equal(await loopback('app.localhost', hosts), '127.0.0.1');
  assert.equal(await loopback('Local.Example.com', hosts), '127.0.0.1');
  assert.equal(await loopback('lan.example.com', hosts), null);
  assert.equal(await loopback('mixed.example.com', hosts), null);
  // A name only DNS knows (the way data would leave through a lookup) is not looked up
  assert.equal(await loopback('636f6e74656e74.exfil.example.com', hosts), null);
  assert.equal(await loopback('10.0.0.5', hosts), null);
});
