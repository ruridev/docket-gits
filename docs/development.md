# Development

```bash
npm test
npm run check:sandbox   # one short real Claude run: checks what runs can and can't reach
```

The whole app is `server.js`, `workspace.js` (where and how AI runs work), `github-proxy.js` (their read-only way to GitHub), `publish.js` (checking and publishing their work), `browser.js` (the browser for Playwright), `jail.js` and `setup-proxy.js` (the sandbox and the way out of the setup command and the browser) and `index.html`, with no build step.
