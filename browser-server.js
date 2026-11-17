'use strict';

// The browser server of AI runs, started by browser.js inside jail.js's sandbox: node browser-server.js <playwright-core> <proxy port>
// Prints its endpoint as one JSON line, and stops when docket-gits closes its stdin (or goes away).
// Chromium's own sandbox can't start inside another macOS sandbox, so it is off here: the outer sandbox is the
// fence (no credentials, writes only to the temp folder, loopback only), for the page and the Playwright server alike.

const [pkg, proxyPort] = process.argv.slice(2);
const { chromium } = require(pkg);

chromium.launchServer({ host: '127.0.0.1', port: 0, chromiumSandbox: false, proxy: { server: `http://127.0.0.1:${Number(proxyPort)}` },
  args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] }).then((server) => {
  process.stdout.write(`${JSON.stringify({ ws: server.wsEndpoint() })}\n`);
  const stop = () => server.close().finally(() => process.exit(0));
  process.stdin.on('end', stop);
  process.stdin.on('error', stop);
  process.stdin.resume();
}, (e) => {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
});
