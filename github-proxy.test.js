'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { isRead, startGitHubProxy } = require('./github-proxy');

const gql = (query) => Buffer.from(JSON.stringify({ query }));

test('isRead: GET and GraphQL queries read; other methods, mutations and odd requests do not', () => {
  assert.equal(isRead('GET', '/repos/o/r/pulls/1/comments', Buffer.alloc(0)), true);
  assert.equal(isRead('HEAD', '/user', Buffer.alloc(0)), true);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(isRead(m, '/repos/o/r/issues/1/comments', Buffer.from('{}')), false, m);
  assert.equal(isRead('POST', '/graphql', gql('query { viewer { login } }')), true);
  assert.equal(isRead('POST', '/graphql', gql('{ repository(owner:"o", name:"r") { pullRequest(number:1) { title } } }')), true);
  // The word anywhere in the text refuses the request, even inside a string or a comment: nothing is parsed
  assert.equal(isRead('POST', '/graphql', gql('query { search(query:"mutation testing", type:ISSUE, first:1) { issueCount } }')), false);
  assert.equal(isRead('POST', '/graphql', gql('query { viewer { login } } # no mutation here')), false);
  // An escaped \""" inside a block string must not end it early and hide the mutation after it
  assert.equal(isRead('POST', '/graphql', gql('query A { search(query: """\\"""""", type: ISSUE, first: 1) { issueCount } } mutation B { addComment(input:{subjectId:"x", body:"y"}) { clientMutationId } } query C { search(query: """x""", type: ISSUE, first: 1) { issueCount } }')), false);
  // GraphQL only by POST, whose body is checked: a GET or HEAD would carry the query unchecked in the URL
  for (const m of ['GET', 'HEAD']) {
    assert.equal(isRead(m, '/graphql?query=mutation%7BaddStar(input:%7BstarrableId:%22x%22%7D)%7BclientMutationId%7D%7D', Buffer.alloc(0)), false, m);
    assert.equal(isRead(m, '/graphql', Buffer.alloc(0)), false, m);
    assert.equal(isRead(m, '/GraphQL/?query=x', Buffer.alloc(0)), false, m);
  }
  // ... nor under another spelling of the same path
  for (const p of ['/./graphql', '/x/../graphql', '/%67raphql?query=x', '//graphql', '/%2e/graphql', '/%zz']) assert.equal(isRead('GET', p, Buffer.alloc(0)), false, p);
  assert.equal(isRead('GET', '/repos/o/r/contents/a%20b.md', Buffer.alloc(0)), true);
  // A query string on /graphql could carry another query
  assert.equal(isRead('POST', '/graphql?query=mutation%7Bx%7D', gql('{ viewer { login } }')), false);
  assert.equal(isRead('POST', '/graphql', gql('mutation { addComment(input:{subjectId:"x", body:"y"}) { clientMutationId } }')), false);
  assert.equal(isRead('POST', '/graphql', gql('query A { viewer { login } }\nmutation B { addStar(input:{starrableId:"x"}) { clientMutationId } }')), false);
  // A quote in a comment must not open a string that hides the next line
  assert.equal(isRead('POST', '/graphql', gql('query A { viewer { login } } # "\nmutation B { addComment(input:{subjectId:"x", body:"y"}) { clientMutationId } } # "')), false);
  assert.equal(isRead('POST', '/graphql', gql('query A { search(query:"# x", type:ISSUE, first:1) { issueCount } }\nmutation B { addStar(input:{starrableId:"x"}) { clientMutationId } }')), false);
  assert.equal(isRead('POST', '/graphql', gql('subscription { x }')), false);
  assert.equal(isRead('POST', '/graphql', Buffer.from('[{"query":"{ viewer { login } }"}]')), false);
  assert.equal(isRead('POST', '/graphql', Buffer.from('not json')), false);
  assert.equal(isRead('GET', 'https://evil.example/x', Buffer.alloc(0)), false);
  assert.equal(isRead('GET', '//evil.example/x', Buffer.alloc(0)), false);
});

test('startGitHubProxy: adds the user token to reads, refuses writes and other hosts, drops method overrides', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, override: req.headers['x-http-method-override'] ?? null });
    res.end('{"ok":true}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dgp-'));
  const socket = path.join(dir, 's');
  const proxy = await startGitHubProxy({ socket, getToken: async () => 'user-token', upstream: { protocol: http, host: '127.0.0.1', port: upstream.address().port } });
  t.after(() => { proxy.close(); upstream.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
  const call = (method, url, { host = 'api.github.com', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, method, path: url, headers: { host, authorization: 'token placeholder', ...headers } }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal((await call('GET', '/repos/o/r/pulls/1', { headers: { 'x-http-method-override': 'DELETE' } })).status, 200);
  assert.equal((await call('POST', '/graphql', { body: gql('{ viewer { login } }') })).status, 200);
  const write = await call('POST', '/repos/o/r/issues/1/comments', { body: '{"body":"x"}' });
  assert.equal(write.status, 403);
  assert.match(write.data, /can only read/);
  assert.equal((await call('POST', '/graphql', { body: gql('mutation { x }') })).status, 403);
  assert.equal((await call('GET', '/x', { host: 'example.com' })).status, 403);
  assert.deepEqual(seen, [
    { method: 'GET', url: '/repos/o/r/pulls/1', auth: 'token user-token', override: null },
    { method: 'POST', url: '/graphql', auth: 'token user-token', override: null },
  ]);
});
