'use strict';

// The only way out for a repository's setup command (runSetup in workspace.js). The command installs what
// the pull request's lockfile and config files ask for, so it runs in jail.js's sandbox with no credentials,
// and its network goes only through this proxy:
// - only to package registries: the user's list, the registries named in the user's ~/.npmrc, and GitHub's
//   download hosts (git dependencies as tarballs, GitHub Packages downloads);
// - only to read: the proxy ends TLS with its own certificate authority, which only the setup command trusts, and
//   lets through GET and HEAD without a body, so nothing can be uploaded anywhere;
// - a registry the user signs in to (an auth line in ~/.npmrc) gets the user's token added here.
// So a .npmrc, lockfile or install code from a pull request can't send the token anywhere, or upload what it read.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const tls = require('node:tls');
const { execFile } = require('node:child_process');

// Git dependencies as tarballs and GitHub Packages downloads (npm.pkg.github.com redirects to *.githubusercontent.com).
// Not github.com: git over http needs POST, and setup only reads
const GITHUB_HOSTS = ['codeload.github.com', '*.githubusercontent.com'];

// Keys of ~/.npmrc that carry credentials: kept out of the config the setup command reads
const AUTH_KEY = /(^|:)(_authToken|_auth|_password|username|certfile|keyfile|key|cert)$/;

const expand = (v, env) => v.replace(/\$\{([^}?]+)\??\}/g, (m, k) => env[k] ?? '');
const unquote = (v) => (/^(["']).*\1$/.test(v) ? v.slice(1, -1) : v);
// npm's "nerf dart" of a URL: //host/path/
const nerf = (u) => {
  try {
    const x = new URL(u);
    return `//${x.host}${x.pathname.replace(/\/?$/, '/')}`;
  } catch {
    return null;
  }
};

/**
 * Reads the user's ~/.npmrc. config: the same file without credentials, for the setup command.
 * auth: [{ prefix: "//host/path/", header }], longest prefix first. hosts: the registries it names.
 */
function parseNpmrc(text, env = process.env) {
  const keep = [];
  const values = {};
  const hosts = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([^=;#\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) {
      keep.push(line);
      continue;
    }
    const [, key, raw] = m;
    const value = expand(unquote(raw), env);
    values[key] = value;
    // The setup command trusts only the proxy's authority, which a ca / cafile / strict-ssl line would undo
    if (/^(ca|cafile|strict-ssl|proxy|https-proxy|noproxy)$/.test(key)) continue;
    if (AUTH_KEY.test(key)) {
      const host = /^\/\/([^/:]+)/.exec(key)?.[1];
      if (host) hosts.add(host.toLowerCase());
    } else {
      keep.push(line);
      if (/(^|:)registry$/.test(key)) {
        try {
          hosts.add(new URL(value).hostname.toLowerCase());
        } catch { /* not a URL */ }
      }
    }
  }
  const registry = nerf(values.registry || 'https://registry.npmjs.org/');
  const byPrefix = {};
  for (const [key, value] of Object.entries(values)) {
    const m = /^(\/\/.+?:)?(_authToken|_auth|_password|username)$/.exec(key);
    if (!m) continue;
    // A key without a //host/ prefix (old style) belongs to the default registry
    const prefix = m[1] ? m[1].slice(0, -1).replace(/\/?$/, '/') : registry;
    (byPrefix[prefix] ||= {})[m[2]] = value;
  }
  const auth = Object.entries(byPrefix).map(([prefix, a]) => {
    if (a._authToken) return { prefix, header: `Bearer ${a._authToken}` };
    if (a._auth) return { prefix, header: `Basic ${a._auth}` };
    if (a.username && a._password) return { prefix, header: `Basic ${Buffer.from(`${a.username}:${Buffer.from(a._password, 'base64').toString()}`).toString('base64')}` };
    return null;
  }).filter(Boolean).sort((a, b) => b.prefix.length - a.prefix.length);
  return { config: `${keep.join('\n').trim()}\n`, auth, hosts: [...hosts] };
}

const hostMatches = (host, list) => list.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h));

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout))));

// openssl's settings for the authority and the certificates it signs
const OPENSSL_CONFIG = (names) => `[req]
distinguished_name = dn
[dn]
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = ${names.map((n) => `DNS:${n}`).join(',') || 'DNS:localhost'}
`;

const pemKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });

/**
 * The proxy's certificate authority, made once. keyDir is private (docket-gits' data/, which runs and the setup
 * sandbox can't read); certFile is where the setup command reads the certificate from.
 */
async function ensureCa(keyDir, certFile) {
  const keyFile = path.join(keyDir, 'ca.key');
  const ownCert = path.join(keyDir, 'ca.pem');
  if (!fs.existsSync(keyFile) || !fs.existsSync(ownCert)) {
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const cnf = path.join(keyDir, 'openssl.cnf');
    fs.writeFileSync(cnf, OPENSSL_CONFIG([]), { mode: 0o600 });
    fs.writeFileSync(keyFile, pemKey(), { mode: 0o600 });
    await run('openssl', ['req', '-new', '-x509', '-key', keyFile, '-out', ownCert, '-days', '3650', '-subj', '/CN=docket-gits setup proxy', '-config', cnf, '-extensions', 'ca']);
  }
  fs.mkdirSync(path.dirname(certFile), { recursive: true });
  fs.copyFileSync(ownCert, certFile);
  return { keyFile, certFile: ownCert };
}

// A certificate for names, signed by the authority. Made in keyDir and only kept in memory
async function leafFor(names, ca, keyDir) {
  const id = crypto.randomBytes(6).toString('hex');
  const f = (ext) => path.join(keyDir, `leaf-${id}.${ext}`);
  try {
    fs.writeFileSync(f('cnf'), OPENSSL_CONFIG(names), { mode: 0o600 });
    const key = pemKey();
    fs.writeFileSync(f('key'), key, { mode: 0o600 });
    await run('openssl', ['req', '-new', '-key', f('key'), '-subj', '/CN=docket-gits', '-out', f('csr'), '-config', f('cnf')]);
    await run('openssl', ['x509', '-req', '-in', f('csr'), '-CA', ca.certFile, '-CAkey', ca.keyFile, '-set_serial', `0x${crypto.randomBytes(8).toString('hex')}`,
      '-days', '30', '-extfile', f('cnf'), '-extensions', 'leaf', '-out', f('pem')]);
    return { key, cert: fs.readFileSync(f('pem'), 'utf8') };
  } finally {
    for (const ext of ['cnf', 'key', 'csr', 'pem']) fs.rmSync(f(ext), { force: true });
  }
}

// Hop-by-hop headers, the body framing (requests here have no body) and the ones the proxy sets itself
const DROP = new Set(['host', 'authorization', 'proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade',
  'transfer-encoding', 'content-length', 'expect']);
const LEAF_DAYS = 7;

/**
 * Starts the proxy on a loopback port. update({ auth }) sets the tokens, lease(hosts) lets one setup command in. keyDir: private folder for the authority's key. certFile: the certificate
 * the setup command trusts. upstream: { port, ca, lookup } for tests.
 * Every https request ends TLS here, so the proxy sees each request: only GET and HEAD without a body go on, one
 * upstream connection each. Nothing can be uploaded (a publish, a git push, a request smuggled in a body), and a
 * token from ~/.npmrc is added only to the registry it belongs to.
 */
async function startSetupProxy({ keyDir, certFile, upstream = {}, log = () => {} }) {
  const ca = await ensureCa(keyDir, certFile);
  let auth = [];
  // Certificates by host, made when first needed and again before they expire
  // A host under a *.name entry gets the one *.name certificate, so there is at most one per entry
  const leaves = new Map();
  const leafOf = async (host, hosts) => {
    const name = hosts.includes(host) ? host : hosts.find((h) => h.startsWith('*.') && host.endsWith(h.slice(1)));
    const l = leaves.get(name);
    if (l && Date.now() - l.at < LEAF_DAYS * 86400e3) return l.context;
    const context = (async () => tls.createSecureContext(await leafFor([name], ca, keyDir)))();
    leaves.set(name, { context, at: Date.now() });
    context.catch(() => leaves.delete(name));
    return context;
  };
  // One secret per setup command, in its proxy URL, with the hosts that command may reach: AI runs and the
  // browser can reach loopback ports too, and must not get the user's tokens added through here
  const secrets = new Map();
  const hostsOf = (req) => {
    const m = /^Basic\s+(\S+)$/i.exec(req.headers['proxy-authorization'] || '');
    const pass = m && Buffer.from(m[1], 'base64').toString().replace(/^[^:]*:/, '');
    if (!pass) return null;
    for (const [x, hosts] of secrets) if (x.length === pass.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(pass))) return hosts;
    return null;
  };
  const authFor = (host, pathname) => auth.find((a) => `//${host}${pathname}`.startsWith(a.prefix));
  // Only reading, and nothing that could carry a second request along
  const readOnly = (req) => (req.method === 'GET' || req.method === 'HEAD') && !req.headers['transfer-encoding']
    && !(Number(req.headers['content-length']) > 0) && !req.headers.expect;

  const refuse = (sock, why) => {
    log(why);
    sock.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\ndocket-gits: ${why}\n`);
  };
  const pass = (lib, opts, req, res) => {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !DROP.has(k)));
    const up = lib.request({ ...opts, agent: false, method: req.method, headers: { ...headers, ...opts.headers } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`docket-gits: ${opts.host}: ${e.message}\n`);
    });
    up.end();
  };

  // https requests, after TLS ends here
  const inner = http.createServer((req, res) => {
    // The host of the CONNECT that was checked, never the name the client sends inside TLS (SNI, Host)
    const host = req.socket.docketHost;
    // Origin-form only: an absolute URI (GET https://other/...) could be routed elsewhere by a CDN in front
    if (!req.url.startsWith('/') || req.url.startsWith('//') || !readOnly(req)) {
      log(`setup refused ${req.method} https://${host}${req.url.split('?')[0]}`);
      res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
      res.end(`docket-gits: the setup command can only read from ${host}\n`);
      return req.socket.destroy();
    }
    const a = authFor(host, req.url);
    pass(https, { host, port: upstream.port || 443, ca: upstream.ca, lookup: upstream.lookup, path: req.url, headers: { host, ...(a && { authorization: a.header }) } }, req, res);
  });

  const server = http.createServer((req, res) => {
    const hosts = hostsOf(req);
    if (!hosts) return res.writeHead(407, { 'proxy-authenticate': 'Basic realm="docket-gits"' }).end();
    // Plain http: only to an allowed host on port 80, only reading, never with credentials
    let url;
    try {
      url = new URL(req.url);
    } catch {
      return res.writeHead(400).end();
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'http:' || (url.port && url.port !== '80') || !hostMatches(host, hosts) || !readOnly(req)) {
      log(`setup refused ${req.method} ${url.origin}`);
      return res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' }).end(`docket-gits: the setup command may not reach ${url.origin}\n`);
    }
    pass(http, { host, port: 80, lookup: upstream.lookup, path: url.pathname + url.search, headers: { host } }, req, res);
  });

  server.on('connect', async (req, sock, head) => {
    sock.on('error', () => {});
    const hosts = hostsOf(req);
    if (!hosts) return sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="docket-gits"\r\nConnection: close\r\n\r\n');
    const m = /^([a-z0-9.-]+):(\d+)$/i.exec(req.url || '');
    const host = m?.[1].toLowerCase();
    if (!m || m[2] !== '443' || !hostMatches(host, hosts)) return refuse(sock, `the setup command may not reach ${req.url}`);
    let secureContext;
    try {
      secureContext = await leafOf(host, hosts);
    } catch (e) {
      return refuse(sock, `no certificate for ${host}: ${e.message}`);
    }
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) sock.unshift(head);
    const t = new tls.TLSSocket(sock, { isServer: true, secureContext });
    t.docketHost = host;
    t.on('error', () => sock.destroy());
    inner.emit('connection', t);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    port: server.address().port,
    certFile,
    /** The registry tokens to add (parseNpmrc().auth). Call it before each setup: ~/.npmrc may have changed. */
    async update(next) {
      auth = next.auth || [];
    },
    /**
     * A secret for one setup command and the hosts it may reach (the registries of the tokens are added):
     * its proxy URL is http://docket:<secret>@127.0.0.1:<port>. Release it when the command ends.
     */
    lease(allowed = []) {
      const secret = crypto.randomBytes(18).toString('hex');
      const names = auth.map((a) => /^\/\/([^/:]+)/.exec(a.prefix)?.[1]).filter(Boolean);
      secrets.set(secret, [...new Set([...allowed, ...names].map((h) => h.toLowerCase()))]);
      return { url: `http://docket:${secret}@127.0.0.1:${server.address().port}`, release: () => secrets.delete(secret) };
    },
    close: () => server.close(),
  };
}

module.exports = { GITHUB_HOSTS, parseNpmrc, hostMatches, startSetupProxy };
