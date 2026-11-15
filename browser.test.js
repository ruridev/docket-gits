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
