'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const jail = require('./jail');

test('profile: real paths, quoted; ~ is the home folder; only the listed ports', () => {
  const p = jail.profile({ denyRead: ['~/.ssh', '/tmp/a "b"\\c'], allowWrite: ['/tmp/w'], ports: [8080], home: '/Users/u' });
  assert.match(p, /\(deny file-read\* \(subpath "\/Users\/u\/\.ssh"\)/);
  assert.match(p, /\(subpath "[^"]*\/a \\"b\\"\\\\c"\)/);
  assert.match(p, /\(allow file-write\* \(subpath "\/dev"\) \(subpath "[^"]*\/tmp\/w"\)\)/);
  assert.match(p, /\(allow network-outbound \(remote ip "localhost:8080"\)\)/);
  assert.doesNotMatch(jail.profile({}), /allow network-outbound/);
  assert.match(jail.profile({ ports: '*' }), /\(remote ip "localhost:\*"\)/);
});

test('the sandbox: nothing it runs can start outside it (apps, documents, Apple events, launchd)', { skip: !jail.available() && 'macOS only' }, (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docket-jail-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (cmd, args) => {
    const [c, a] = jail.wrap(cmd, args, { allowWrite: [dir] });
    return spawnSync(c, a, { encoding: 'utf8', timeout: 20000 });
  };
  const running = () => spawnSync('pgrep', ['-x', 'Calculator']).status === 0;
  const before = running();
  assert.notEqual(run('/usr/bin/open', ['-g', '-j', '-a', 'Calculator']).status, 0);
  if (!before) {
    const escaped = running();
    if (escaped) execFileSync('osascript', ['-e', 'quit app "Calculator"']);
    assert.equal(escaped, false, 'open started an app outside the sandbox');
  }
  assert.notEqual(run('/usr/bin/osascript', ['-e', 'tell application "Finder" to get name of startup disk']).status, 0);
  const plist = path.join(dir, 'x.plist');
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>dev.docket.jail-test</string><key>ProgramArguments</key><array><string>/usr/bin/true</string></array></dict></plist>`);
  const boot = run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]);
  spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/dev.docket.jail-test`]);
  assert.notEqual(boot.status, 0);

  // Preferences go through cfprefsd (a Terminal profile's CommandString would run unsandboxed), signals to others
  assert.notEqual(run('/usr/bin/defaults', ['write', 'dev.docket.jail-test', 'k', 'v']).status, 0);
  assert.notEqual(spawnSync('defaults', ['read', 'dev.docket.jail-test', 'k']).status, 0, 'the preference was written');
  const sleeper = require('node:child_process').spawn('sleep', ['30']);
  t.after(() => sleeper.kill());
  assert.notEqual(run('/bin/kill', ['-TERM', String(sleeper.pid)]).status, 0);
  assert.equal(sleeper.exitCode, null);
  // The pasteboard (a copied password; a command planted for pasting)
  assert.notEqual(run('/usr/bin/pbpaste', []).status, 0);
  // ... while its own processes it can still stop
  assert.equal(run('/bin/sh', ['-c', 'sleep 20 & kill $!']).status, 0);
});
