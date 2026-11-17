'use strict';

// An OS sandbox for what docket-gits itself starts on a pull request's behalf outside Claude Code's sandbox:
// the repository's setup command and the browser for Playwright. Both handle files the pull request controls,
// so they get the same fence as a run: no reading credentials or docket data, writing only where they must,
// and the network only through docket-gits (a proxy port) or loopback.
// macOS only (sandbox-exec). Elsewhere available() is false and callers don't start what would run unfenced.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

const available = () => process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC);

// The real path of p (the sandbox matches real paths: /tmp is /private/tmp on macOS), or of its nearest
// existing parent plus the rest, so a path made later is still covered
function real(p, home = os.homedir()) {
  let abs = path.resolve(p.startsWith('~') ? path.join(home, p.slice(1)) : p);
  let rest = '';
  for (;;) {
    try {
      return path.join(fs.realpathSync(abs), rest);
    } catch {
      const up = path.dirname(abs);
      if (up === abs) return path.join(abs, rest);
      rest = path.join(path.basename(abs), rest);
      abs = up;
    }
  }
}

// A path as an SBPL string literal
const lit = (p) => `"${String(p).replace(/[\\"]/g, (c) => `\\${c}`)}"`;
const subpaths = (list, home) => [...new Set(list.filter(Boolean).map((p) => real(p, home)))].map((p) => `(subpath ${lit(p)})`).join(' ');

/**
 * The sandbox profile.
 * denyRead: paths (files or folders, ~ allowed) that can't be read.
 * allowWrite: the only paths that can be written (/dev is always writable: /dev/null, ttys); denyWrite: exceptions in them.
 * ports: loopback ports that may be reached, or '*' for any loopback port. Nothing else on the network,
 * not even name lookups, is reachable.
 */
function profile({ denyRead = [], allowWrite = [], denyWrite = [], ports = [], home = os.homedir() }) {
  const reach = ports === '*' ? ['(remote ip "localhost:*")'] : ports.map((p) => `(remote ip "localhost:${Number(p)}")`);
  return [
    '(version 1)',
    '(allow default)',
    ...(denyRead.length ? [`(deny file-read* ${subpaths(denyRead, home)})`] : []),
    '(deny file-write*)',
    `(allow file-write* ${subpaths(['/dev', ...allowWrite], home)})`,
    ...(denyWrite.length ? [`(deny file-write* ${subpaths(denyWrite, home)})`] : []),
    '(deny network-outbound)',
    ...(reach.length ? [`(allow network-outbound ${reach.join(' ')})`] : []),
    // Ways to have something start outside the sandbox: opening apps and documents (open x.command runs it in
    // Terminal), Apple events to other apps, and login items
    '(deny lsopen)',
    '(deny appleevent-send)',
    // Preferences are written by cfprefsd, not by the process, so the file rules above don't cover them
    // (a Terminal profile's CommandString runs in the next Terminal window); and no signals to other processes
    '(deny user-preference-write)',
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    // ... registering an app as the handler of a link type (lsd), the pasteboard (reading a copied password, or
    // planting a command to paste), the window server and posting key events
    '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.coreservices.appleevents") (global-name "com.apple.coreservices.sharedfilelistd") (global-name-prefix "com.apple.backgroundtaskmanagement") (global-name-prefix "com.apple.lsd.") (global-name-prefix "com.apple.windowserver") (global-name-prefix "com.apple.pasteboard") (global-name "com.apple.pbs.fetch_services"))',
    '(deny hid-control)',
  ].join('\n');
}

/** [command, args] that run cmd with args inside the profile. */
function wrap(cmd, args, opts) {
  return [SANDBOX_EXEC, ['-p', profile(opts), cmd, ...args]];
}

module.exports = { available, profile, wrap, real, SANDBOX_EXEC };
