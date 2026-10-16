# dsh-crawshrimp-browser

An independent browser plugin for DeepSeek Harness (DSH). It uses
`playwright-core` directly and owns a fresh Playwright `BrowserContext` for
each DSH session. It does not import Crawshrimp, call a Crawshrimp HTTP API,
or inspect existing merchant tabs.

## What it provides

The plugin registers these names:

- `crawshrimp_browser_open` — open an `http` or `https` URL in a new owned page.
- `crawshrimp_browser_observe` — return bounded text and actionable element references.
- `crawshrimp_browser_click` — click an observed reference or CSS selector.
- `crawshrimp_browser_fill` — fill an observed reference or CSS selector.
- `crawshrimp_browser_screenshot` — return a bounded PNG image; observation does not prompt.
- `crawshrimp_browser_close` — close one owned page.

Opening, clicking, filling, and closing are routed through the native DSH
approval service. If that service is missing, actions fail closed, and the
native DSH policy decides whether a request may proceed. Cancellation closes
the owned page and context. An uncertain action is never retried automatically.

## Browser prerequisite

This package contains Playwright's driver but no browser binary. Install a
system Chromium or Chrome and configure either `executablePath` or
`channel`. On macOS the default `channel: chrome` uses the installed Chrome;
on CI, set `executablePath` from `CHROME_PATH` when the image does not expose
the Chrome channel. `cdpEndpoint` is optional. When it is set, the plugin
connects to that browser and still creates a new context; it disconnects on
unload without closing the external browser.

## Install with the official DSH plugin loader

The repository is intentionally ready to be installed from GitHub rather than
claiming an npm publication:

```sh
dsh plugin --profile demo add -w github:howtimeschange/dsh-crawshrimp-browser#v0.1.0
```

The loader reads `package.json`'s `dsh.bundle.patch` metadata and applies the
included `cordis.patch.yml`. To test a local checkout:

```sh
git clone https://github.com/howtimeschange/dsh-crawshrimp-browser.git
cd dsh-crawshrimp-browser
npm ci
dsh plugin --profile demo add -w .
```

The resulting bundle entry is equivalent to:

```yaml
- id: crawshrimp-browser
  name: dsh-crawshrimp-browser
  config:
    channel: chrome
    headless: true
```

For a system executable, use an absolute path in the profile overlay:

```yaml
- id: crawshrimp-browser
  name: dsh-crawshrimp-browser
  config:
    executablePath: !!js process.env.CHROME_PATH ?? ''
    channel: chrome
    headless: true
```

`executablePath` takes precedence over `channel`. Use `channel: chromium` when
the host provides a Chromium channel. `cdpEndpoint` accepts an endpoint such
as `http://127.0.0.1:9222` for a user-managed Chrome; the plugin never adopts
its existing contexts or pages. Set `headless: false` when a human needs to
complete a manual sign-in in the plugin-owned context. That login stays in the
DSH session's context and is discarded with it; the plugin does not load or
persist a shared Chrome profile.

## Development

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

The test suite serves a synthetic local page and launches a real headless
Chrome. It never uses a merchant account or a real merchant site. Set
`CHROME_PATH` to override the local Chrome path used by the tests.
