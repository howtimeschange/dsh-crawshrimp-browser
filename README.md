# dsh-crawshrimp-browser

The plugin card, Live Browser tab and guide use the bundled Crawshrimp application icon.

An independent browser plugin for DeepSeek Harness (DSH). It uses
`playwright-core` directly and owns a fresh Playwright `BrowserContext` for
each DSH session. It does not import Crawshrimp, call a Crawshrimp HTTP API,
or inspect existing merchant tabs.

## What it provides

The plugin registers these names:

- `crawshrimp_browser_open` — open an `http` or `https` URL in a new owned page.
- `crawshrimp_browser_pages` — list only pages owned by the current DSH session.
- `crawshrimp_browser_navigate` — navigate an owned page to an `http` or `https` URL.
- `crawshrimp_browser_observe` — return bounded text and actionable element references.
- `crawshrimp_browser_click` — click an observed reference or CSS selector.
- `crawshrimp_browser_fill` — fill an observed reference or CSS selector.
- `crawshrimp_browser_select` — select an HTML option by its `value`.
- `crawshrimp_browser_press` — press a Playwright key or `Modifier+Key` shortcut.
- `crawshrimp_browser_wait` — wait for selector visibility or bounded text.
- `crawshrimp_browser_screenshot` — return a bounded PNG image; observation does not prompt.
- `crawshrimp_browser_close` — close one owned page.
- `crawshrimp_browser_script_list` — discover portable Crawshrimp script adapters.
- `crawshrimp_browser_script_validate` — validate a task and its parameters without approval or browser startup.
- `crawshrimp_browser_script_run` — run a declared page script in a fresh isolated context and save its JSON artifact.

Opening, navigating, clicking, filling, selecting, pressing, and closing are
governed by native DSH permissions. The Full Access preset (`danger-full-access`
with approval policy `never`) is a standing grant and runs automatically; other
combinations use the native DSH approval service. Listing pages, observing,
waiting, and taking screenshots are read-only tools and do not prompt. If the
approval service is missing, actions fail closed, and the native DSH policy
decides whether a request may proceed. Cancellation closes the owned page and
context. An uncertain action is never retried automatically. Observation refs
are scoped to one observation round; after a new observation, call observe
again before using its refs.

Script runs use the same native approval gate and the same shared browser
connection, but create a new context and page owned only by that run. They
never use the interactive DSH page. The script validator is offline. Script
runs support bounded pagination and Crawshrimp-compatible parameter and
shared-state globals; backend CDP/local actions and scheduling are rejected.

## Bundled Crawshrimp Skill

The package registers **crawshrimp-browser** in the native DSH skill catalog. Agents
can load it with the `skill` tool or you can select it from the skill menu. It
teaches observe → ref-based action → verify, manual login handoff and portable
script reuse, using only this package’s tools. No separate install or Crawshrimp
backend is needed. The skill registry is optional in minimal CLI compositions.

## Live preview in DSH Web

The same package includes a DSH client panel. It streams the **actual Playwright page** through Chromium CDP, with a bounded screenshot fallback. No Crawshrimp backend or separate preview project is involved.

1. Install this package in a DSH **Web** profile and open a Session.
2. Ask the Agent to open a page with `crawshrimp_browser_open`, or run a configured portable script.
3. In the right Sidebar's add/guide menu, choose **Live Browser**. Horizontal browser-style tabs are scoped to that Session; follow-latest selects newly created pages.
4. Choose **Take over** to click, drag, scroll, type or paste into an interactive page. Agent write tools reject calls to that page until **Return to Agent**. Watching alone does not grant input control.
5. Script-run pages appear with their run identity and support read-only viewing. They disappear when the run ends or is cancelled; interactive pages remain independent.

The panel uses DSH's docked/floating tab surface. Switching pages, hiding the panel, losing focus or disconnecting releases manual control; reconnecting restores observation only. The authenticated WebSocket uses the existing DSH Host/Origin and signed-browser admission checks and accepts owner peers only. No raw CDP URL or storage-state contents are exposed to the panel.

`previewEnabled` defaults to `true`. Set it to `false` to disable preview registration. CLI-only profiles retain all tools; preview requires the Web profile's native `connection` and `webServer` services. Chrome/Chromium is still required. See the [preview design](docs/live-preview-architecture.zh-CN.md) for the original source analysis and lifecycle contract.

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
dsh plugin --profile demo add -w github:howtimeschange/dsh-crawshrimp-browser#v0.2.1
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
    adapterRoots:
      - /absolute/path/to/adapters
    workspaceDir: /absolute/path/to/dsh-crawshrimp-browser
    maxPages: 1
    scriptTimeoutMs: 120000
    maxScriptBytes: 524288
    maxOutputBytes: 2097152
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

For a login state that the user explicitly exports from Playwright, set
`storageStatePath` to a private JSON file. The file is read-only, checked to be
a regular file no larger than 5 MiB, and loaded into every new DSH session:

```yaml
- id: crawshrimp-browser
  name: dsh-crawshrimp-browser
  config:
    channel: chrome
    headless: true
    storageStatePath: /absolute/path/to/private/storage-state.json
```

The default is empty. Cookies, tokens, and storage-state contents are never
returned by the browser tools. A missing, unreadable, oversized, or malformed
file fails session creation with an explicit error.

## Portable script adapters

Each adapter directory contains a strict `manifest.yaml` and one or more
relative `.js` task scripts. The supported portable manifest fields are
`id`, `name`, `version`, `description`, `author`, `entry_url`, `skip_auth`,
`trigger: { type: manual }`, and `tasks`. A task may override `entry_url` and
declare `params` using `text`, `textarea`, `number`, `select`, `radio`,
`checkbox`, or `date`. File, directory, model-chain, and other backend-only
controls return a migration diagnostic. A task without `params` keeps the
legacy behavior and accepts any JSON object.

Task scripts are async IIFEs that return `{ success, data, meta }`. The runtime
injects the same JSON-cloned object at `window.__PARAMS__` and
`window.__CRAWSHRIMP_PARAMS__`, plus `window.__CRAWSHRIMP_PAGE__`,
`window.__CRAWSHRIMP_PHASE__`, and `window.__CRAWSHRIMP_SHARED__`. Return
`meta.has_more: true` to request another evaluation in the same page; the
runtime carries `meta.shared` forward and aggregates `data`. The configured
`maxPages` is 1–100 and a run can override it with `max_pages`. Unsupported
`meta.action`, `meta.next_phase`, CDP actions, and local actions fail clearly.

Use the bundled [demo adapter](examples/demo-adapter) and
`node examples/save-storage-state.js` helper as starting points. Keep storage
state files private and outside source control.

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

## Functional packages and migration

Browser owns all webpage work, including portable scripts. [Data](https://github.com/howtimeschange/dsh-crawshrimp-data) handles record/table cleanup and [Office](https://github.com/howtimeschange/dsh-crawshrimp-office) handles document jobs. Each package works independently.

Standalone Scripts users should follow the [migration guide](docs/migration-from-scripts.md). See the [source-based functional roadmap (Chinese)](docs/functional-map.zh-CN.md) for future additions; page probing/network/downloads are Browser work, and PDF/labels/rendering are Office work. These roadmap items are not included in 0.2.0.

Version 0.2.0 adds live preview/manual takeover, page management/navigation/select/press/wait, explicit login state, and the merged portable script runtime with validation, parameters and bounded pagination.
