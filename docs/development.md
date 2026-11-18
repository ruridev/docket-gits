# Development

```bash
npm test
npm run check:sandbox   # one short real Claude run: checks what runs can and can't reach
```

The whole app is `server.js`, `defaults.js` (default settings and prompts), `board.js` (what the board fetches from GitHub and how it merges into the cards), `prompts.js` (what AI runs are told and the review posted from their answers), `logs.js` and `procs.js` (the output and processes of AI runs), `workspace.js` (where and how AI runs work), `github-proxy.js` (their read-only way to GitHub), `publish.js` (checking and publishing their work), `browser.js` (the browser for Playwright), `jail.js` and `setup-proxy.js` (the sandbox and the way out of the setup command and the browser) and the page: `index.html` with `style.css`, `theme.js` (applied before the page draws), `i18n.js`, `app.js`, `plan.js` (the plan screen) and `main.js` (event handlers and startup), loaded in that order, with no build step.
