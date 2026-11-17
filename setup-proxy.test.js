'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');
const { parseNpmrc, hostMatches, startSetupProxy } = require('./setup-proxy');

const tmpdir = (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docket-sp-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('parseNpmrc: the config without credentials, the tokens by registry, and the registries it names', () => {
  const r = parseNpmrc([
    'registry=https://mirror.example.com/',
    '@acme:registry=https://npm.pkg.github.com',
    '//npm.pkg.github.com/:_authToken=${GH_PKG}',
    '//private.example.com/npm/:_auth=dTpw',
    '//basic.example.com/:username=u',
    '//basic.example.com/:_password=cA==',
    '_authToken=legacy',
    'strict-peer-dependencies=false',
    'strict-ssl=false',
    'cafile=/x/ca.pem',
    'key=-----BEGIN PRIVATE KEY-----',
    '; a comment',
  ].join('\n'), { GH_PKG: 'ghp-secret' });
  assert.equal(r.config, 'registry=https://mirror.example.com/\n@acme:registry=https://npm.pkg.github.com\nstrict-peer-dependencies=false\n; a comment\n');
  assert.doesNotMatch(r.config, /secret|legacy|dTpw|cA==/);
  assert.deepEqual(Object.fromEntries(r.auth.map((a) => [a.prefix, a.header])), {
    '//npm.pkg.github.com/': 'Bearer ghp-secret',
    '//private.example.com/npm/': 'Basic dTpw',
    '//basic.example.com/': `Basic ${Buffer.from('u:p').toString('base64')}`,
    '//mirror.example.com/': 'Bearer legacy',
  });
  assert.deepEqual(r.hosts.sort(), ['basic.example.com', 'mirror.example.com', 'npm.pkg.github.com', 'private.example.com']);
  assert.deepEqual(parseNpmrc(''), { config: '\n', auth: [], hosts: [] });
});

test('hostMatches: exact names and *.suffix only', () => {
  assert.equal(hostMatches('a.githubusercontent.com', ['*.githubusercontent.com']), true);
  assert.equal(hostMatches('githubusercontent.com.evil.com', ['*.githubusercontent.com']), false);
  assert.equal(hostMatches('registry.npmjs.org', ['registry.npmjs.org']), true);
  assert.equal(hostMatches('xregistry.npmjs.org', ['registry.npmjs.org']), false);
});

// A registry over TLS on loopback, reached by its name through a lookup the proxy is given
async function fakeRegistry(t, dir, names) {
  const key = path.join(dir, 'up.key');
  const cert = path.join(dir, 'up.pem');
  const cnf = path.join(dir, 'up.cnf');
  fs.writeFileSync(cnf, `[req]\ndistinguished_name=dn\n[dn]\n[x]\nsubjectAltName=${names.map((n) => `DNS:${n}`).join(',')}\n`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=up', '-config', cnf, '-extensions', 'x'], { stdio: 'ignore' });
  const seen = [];
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    seen.push({ method: req.method, url: req.url, host: req.headers.host, auth: req.headers.authorization || null });
    res.end(`pkg ${req.url}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const lookup = (host, opts, cb) => {
    seen.push({ lookup: host });
    return opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
  };
  return { seen, upstream: { port: server.address().port, ca: fs.readFileSync(cert), lookup } };
}

// An https request through the proxy, trusting only the proxy's authority
// lease: the proxy URL with a setup's secret (http://docket:<secret>@127.0.0.1:<port>), or a port for no secret
const proxyAuth = (lease) => (typeof lease === 'string' ? { 'proxy-authorization': `Basic ${Buffer.from(decodeURIComponent(new URL(lease).username) + ':' + new URL(lease).password).toString('base64')}` } : {});
const portOf = (lease) => (typeof lease === 'string' ? Number(new URL(lease).port) : lease);
function viaProxy(lease, host, { method = 'GET', path: p = '/', ca, servername = host, headers = {}, anyName = false }) {
  return new Promise((resolve) => {
    const c = http.request({ host: '127.0.0.1', port: portOf(lease), method: 'CONNECT', path: `${host}:443`, headers: proxyAuth(lease) });
    c.on('connect', (res, sock) => {
      if (res.statusCode !== 200) return resolve({ connect: res.statusCode });
      const t = tls.connect({ socket: sock, servername, ca, ...(anyName && { checkServerIdentity: () => undefined }) }, () => {
        const r = https.request({ createConnection: () => t, host, method, path: p, headers }, (rr) => {
          let body = '';
          rr.on('data', (d) => (body += d));
          rr.on('end', () => resolve({ status: rr.statusCode, body }));
        });
        r.on('error', (e) => resolve({ error: e.message }));
        r.end();
      });
      t.on('error', (e) => resolve({ error: e.message }));
    });
    c.on('error', (e) => resolve({ error: e.message }));
    c.end();
  });
}

test('startSetupProxy: reads a signed-in registry with the user\'s token, refuses writes and every other host', async (t) => {
  const dir = tmpdir(t);
  const reg = await fakeRegistry(t, dir, ['npm.pkg.github.com', 'registry.npmjs.org', 'a.example-cdn.com', 'b.example-cdn.com']);
  const logs = [];
  const proxy = await startSetupProxy({ keyDir: path.join(dir, 'key'), certFile: path.join(dir, 'public', 'ca.pem'), upstream: reg.upstream, log: (m) => logs.push(m) });
  t.after(() => proxy.close());
  const { auth, hosts } = parseNpmrc('//npm.pkg.github.com/:_authToken=user-token\n@acme:registry=https://npm.pkg.github.com\n');
  await proxy.update({ auth });
  const ca = fs.readFileSync(proxy.certFile);
  const lease = proxy.lease(['registry.npmjs.org', '*.example-cdn.com', ...hosts]);
  const L = lease.url;
  // Another setup's lease lets in only its own hosts
  assert.deepEqual(await viaProxy(proxy.lease(['npm.pkg.github.com']).url, 'registry.npmjs.org', { ca }), { connect: 403 });
  assert.equal(fs.statSync(path.join(dir, 'key', 'ca.key')).mode & 0o777, 0o600);

  // GET: the token is added here; the client never had it
  const got = await viaProxy(L, 'npm.pkg.github.com', { path: '/@acme%2flib', ca, headers: { authorization: 'Bearer attacker' } });
  assert.deepEqual(got, { status: 200, body: 'pkg /@acme%2flib' });
  assert.deepEqual(reg.seen.at(-1), { method: 'GET', url: '/@acme%2flib', host: 'npm.pkg.github.com', auth: 'Bearer user-token' });

  // Publishing with the token is refused before it leaves
  const n = reg.seen.length;
  const put = await viaProxy(L, 'npm.pkg.github.com', { method: 'PUT', path: '/@acme%2flib', ca });
  assert.equal(put.status, 403);
  assert.equal(reg.seen.length, n);

  // The name sent inside TLS can't move the request to another host
  const sni = await viaProxy(L, 'npm.pkg.github.com', { path: '/x', ca, servername: 'evil.example.com', headers: { host: 'evil.example.com' }, anyName: true });
  assert.equal(sni.status, 200);
  assert.equal(reg.seen.at(-1).host, 'npm.pkg.github.com');
  assert.ok(!reg.seen.some((s) => s.lookup === 'evil.example.com'));

  // Hosts not in the list, other ports, and plain http elsewhere are refused
  assert.deepEqual(await viaProxy(L, 'evil.example.com', { ca }), { connect: 403 });
  const port80 = await new Promise((r) => {
    const s = net.connect(proxy.port, '127.0.0.1', () => s.write(`CONNECT registry.npmjs.org:22 HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${proxyAuth(L)['proxy-authorization']}\r\n\r\n`));
    s.on('data', (d) => { r(String(d)); s.destroy(); });
  });
  assert.match(port80, /^HTTP\/1\.1 403/);
  const plain = await new Promise((r) => http.get({ host: '127.0.0.1', port: proxy.port, path: 'http://evil.example.com/x', headers: proxyAuth(L) }, (res) => r(res.statusCode)));
  assert.equal(plain, 403);
  const plainPort = await new Promise((r) => http.get({ host: '127.0.0.1', port: proxy.port, path: 'http://registry.npmjs.org:22/x', headers: proxyAuth(L) }, (res) => r(res.statusCode)));
  assert.equal(plainPort, 403);
  assert.ok(logs.some((l) => /evil\.example\.com/.test(l)));

  // A registry without a token: also read through the proxy, with no token
  const public_ = await viaProxy(L, 'registry.npmjs.org', { path: '/is-number', ca });
  assert.deepEqual(public_, { status: 200, body: 'pkg /is-number' });
  assert.equal(reg.seen.at(-1).auth, null);
  // ... and nothing can be uploaded there either (an npm publish with a token of the attacker's own)
  const m = reg.seen.length;
  assert.equal((await viaProxy(L, 'registry.npmjs.org', { method: 'PUT', path: '/x', ca, headers: { authorization: 'Bearer attacker' } })).status, 403);
  assert.equal(reg.seen.length, m);

  // A second request hidden in the body of a GET never reaches the registry with the token
  const smuggled = 'GET /b HTTP/1.1\r\nx-a: ';
  const raw = await new Promise((resolve) => {
    const c = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: 'npm.pkg.github.com:443', headers: proxyAuth(L) });
    c.on('connect', (res, sock) => {
      const t = tls.connect({ socket: sock, servername: 'npm.pkg.github.com', ca }, () => {
        let got = '';
        t.on('data', (d) => (got += d));
        t.on('close', () => resolve(got));
        t.write(`GET /a HTTP/1.1\r\nHost: npm.pkg.github.com\r\nContent-Length: ${smuggled.length}\r\n\r\n${smuggled}DELETE /@acme%2flib/-rev/1 HTTP/1.1\r\nHost: npm.pkg.github.com\r\n\r\n`);
      });
      t.on('error', () => resolve(''));
    });
    c.end();
  });
  assert.match(raw, /^HTTP\/1\.1 403/);
  assert.equal(reg.seen.length, m, 'nothing reached the registry');


  // An absolute URI in the request line could be routed to another site by a CDN: refused
  const absolute = await new Promise((resolve) => {
    const c = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: 'registry.npmjs.org:443', headers: proxyAuth(L) });
    c.on('connect', (res, sock) => {
      const t = tls.connect({ socket: sock, servername: 'registry.npmjs.org', ca }, () => {
        let got = '';
        t.on('data', (d) => (got += d));
        t.on('close', () => resolve(got));
        t.write('GET https://evil.example.com/x HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n');
      });
      t.on('error', () => resolve(''));
    });
    c.end();
  });
  assert.match(absolute, /^HTTP\/1\.1 403/);
  // Hosts under a *.name entry share its one *.name certificate
  const san = (host) => new Promise((resolve) => {
    const c = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: `${host}:443`, headers: proxyAuth(L) });
    c.on('connect', (res, sock) => { const t = tls.connect({ socket: sock, servername: host, ca }, () => { resolve(t.getPeerCertificate().subjectaltname); t.destroy(); }); t.on('error', (e) => resolve(e.message)); });
    c.end();
  });
  assert.equal(await san('a.example-cdn.com'), 'DNS:*.example-cdn.com');
  assert.equal(await san('b.example-cdn.com'), 'DNS:*.example-cdn.com');

  // Without the secret of a running setup (an AI run or the browser on a loopback port) nothing goes through
  assert.deepEqual(await viaProxy(proxy.port, 'npm.pkg.github.com', { ca }), { connect: 407 });
  assert.deepEqual(await viaProxy(`http://docket:wrong@127.0.0.1:${proxy.port}`, 'npm.pkg.github.com', { ca }), { connect: 407 });
  const plain407 = await new Promise((r) => http.get({ host: '127.0.0.1', port: proxy.port, path: 'http://registry.npmjs.org/x' }, (res) => r(res.statusCode)));
  assert.equal(plain407, 407);
  lease.release();
  assert.deepEqual(await viaProxy(L, 'npm.pkg.github.com', { ca }), { connect: 407 });
});

test('startSetupProxy: a token removed from ~/.npmrc is no longer added', async (t) => {
  const dir = tmpdir(t);
  const reg = await fakeRegistry(t, dir, ['npm.pkg.github.com']);
  const proxy = await startSetupProxy({ keyDir: path.join(dir, 'key'), certFile: path.join(dir, 'ca.pem'), upstream: reg.upstream });
  t.after(() => proxy.close());
  await proxy.update(parseNpmrc('//npm.pkg.github.com/:_authToken=old\n'));
  await proxy.update(parseNpmrc('@acme:registry=https://npm.pkg.github.com\n'));
  const r = await viaProxy(proxy.lease(['npm.pkg.github.com']).url, 'npm.pkg.github.com', { ca: fs.readFileSync(proxy.certFile) });
  assert.equal(r.status, 200);
  assert.equal(reg.seen.at(-1).auth, null);
});
