import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { stringify } from 'yaml'

import {
  ACTION_TOOLS,
  BrowserManager,
  Config,
  TOOL_NAMES,
  apply,
} from '../lib/index.js'
import * as browserPlugin from '../lib/index.js'

const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate))

let server
let baseUrl

const scriptPaginationSource = `;(async () => {
  const page = window.__CRAWSHRIMP_PAGE__
  const previous = window.__CRAWSHRIMP_SHARED__ || {}
  return {
    success: true,
    data: [{
      page,
      paramsAlias: window.__PARAMS__ === window.__CRAWSHRIMP_PARAMS__,
      label: window.__PARAMS__?.label || '',
      previousCount: previous.count || 0,
    }],
    meta: { has_more: page < 3, shared: { count: page } },
  }
})()`

async function createScriptAdapter(root) {
  const adapter = join(root, 'fixture-adapter')
  await mkdir(adapter, { recursive: true })
  await writeFile(join(adapter, 'pagination.js'), scriptPaginationSource)
  await writeFile(join(adapter, 'manifest.yaml'), stringify({
    id: 'fixture-adapter',
    name: 'Fixture adapter',
    version: '1.0.0',
    entry_url: baseUrl,
    trigger: { type: 'manual' },
    tasks: [{
      id: 'pagination',
      name: 'Pagination',
      script: 'pagination.js',
      params: [{ id: 'label', type: 'text', label: 'Label', default: 'default' }],
    }],
  }))
}

before(async () => {
  server = createServer((request, response) => {
    if (request.url === '/slow') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<title>Slow fixture</title><p>slow</p>')
      }, 1000)
      return
    }
    if (request.url === '/details') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html>
        <title>Fixture product details</title>
        <main><h1>Blue shirt details</h1><p id="detail-copy">Product detail page</p></main>`)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
      <title>DSH browser fixture</title>
      <main><h1>Fixture product</h1><p id="status">ready</p>
      <label>Search <input id="search" name="search" placeholder="search fixture"></label>
      <label>Category <select id="category" name="category">
        <option value="all">All</option><option value="blue">Blue shirts</option><option value="red">Red shirts</option>
      </select></label>
      <button id="apply" type="button">Apply</button>
      <a id="details" href="/details">Open details</a>
      <ul id="results"><li data-product="blue">Blue shirt</li><li data-product="red">Red shirt</li></ul>
      <p id="no-results" hidden>No matching products</p>
      <p id="delayed" hidden>Delayed promotion</p></main>
      <script>
        const search = document.querySelector('#search')
        const category = document.querySelector('#category')
        const results = document.querySelector('#results')
        const empty = document.querySelector('#no-results')
        function applyFilter() {
          const needle = search.value.trim().toLowerCase()
          let visible = 0
          for (const item of results.children) {
            const match = (!needle || item.textContent.toLowerCase().includes(needle))
              && (category.value === 'all' || item.dataset.product === category.value)
            item.hidden = !match
            if (match) visible += 1
          }
          results.hidden = visible === 0
          empty.hidden = visible !== 0
          document.querySelector('#status').textContent = needle || category.value
        }
        document.querySelector('#apply').addEventListener('click', applyFilter)
        search.addEventListener('keydown', (event) => { if (event.key === 'Enter') applyFilter() })
        category.addEventListener('change', applyFilter)
        setTimeout(() => { document.querySelector('#delayed').hidden = false }, 40)
      </script>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

function browserConfig(extra = {}) {
  return Config({
    ...(chromePath ? { executablePath: chromePath } : {}),
    channel: 'chrome',
    headless: true,
    actionTimeoutMs: 5000,
    navigationTimeoutMs: 5000,
    ...extra,
  })
}

function execution(agent, signal = new AbortController().signal) {
  return { agent, signal, callId: `test-${Math.random().toString(16).slice(2)}` }
}

// A fresh Chrome profile can start slowly on a cold hosted CI runner.
function waitForDevtoolsEndpoint(child, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error(`Chrome did not report a DevTools endpoint: ${output.slice(-500)}`)), timeoutMs)
    const finish = (error, endpoint) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(endpoint)
    }
    const onOutput = (chunk) => {
      output += chunk.toString()
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/)
      if (!match) return
      const websocket = new URL(match[1])
      finish(undefined, `http://${websocket.host}`)
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)
    child.once('error', (error) => finish(error))
    child.once('exit', (code, signal) => finish(new Error(`Chrome exited before DevTools startup (code=${code}, signal=${signal})`)))
  })
}

async function waitForDevtoolsVersion(endpoint, timeoutMs = 10000) {
  const url = new URL('/json/version', endpoint)
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return response.json()
      lastError = new Error(`DevTools returned HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw lastError || new Error('DevTools endpoint did not become ready')
}

async function stopChrome(child) {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined) || child.signalCode) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

test('tool names are namespaced and browser actions are an explicit approval set', () => {
  assert.deepEqual([...ACTION_TOOLS].sort(), [
    TOOL_NAMES.click,
    TOOL_NAMES.close,
    TOOL_NAMES.fill,
    TOOL_NAMES.navigate,
    TOOL_NAMES.open,
    TOOL_NAMES.press,
    TOOL_NAMES.select,
    TOOL_NAMES.scriptRun,
    TOOL_NAMES.evaluate, TOOL_NAMES.request, TOOL_NAMES.capture_requests,
    TOOL_NAMES.upload, TOOL_NAMES.download, TOOL_NAMES.workflow, TOOL_NAMES.adapter,
  ].sort())
  assert.deepEqual(Object.keys(TOOL_NAMES).sort(), [
    'click', 'close', 'fill', 'navigate', 'open', 'pages', 'press', 'screenshot', 'select', 'wait', 'observe', 'scriptList', 'scriptValidate', 'scriptRun',
    'probe', 'evaluate', 'request', 'capture_requests', 'upload', 'download', 'verify', 'journal', 'workflow', 'adapter',
  ].sort())
  for (const name of Object.values(TOOL_NAMES)) assert.match(name, /^crawshrimp_browser_[a-z_]+$/)
})

test('approval gate fails closed without DSH approval and honors native approval decisions', async () => {
  let hook
  const registrations = []
  const ctx = {
    tools: { register(definition) { registrations.push(definition); return () => {} } },
    on(name, listener) { assert.equal(name, 'tools/pre-execute'); hook = listener; return () => {} },
    effect() {},
    get() { return undefined },
  }
  apply(ctx, { executablePath: '/does/not/launch' })
  const denied = await hook({ name: TOOL_NAMES.click, agent: { id: 'a' }, callId: '1' }, async () => ({ kind: 'allow' }))
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /no native DSH approval service/i)
  assert.equal(registrations.length, Object.keys(TOOL_NAMES).length)

  const nonActions = await hook({ name: TOOL_NAMES.pages, agent: { id: 'a' }, callId: 'pages' }, async () => ({ kind: 'allow' }))
  assert.deepEqual(nonActions, { kind: 'allow' })
  const nonActionWait = await hook({ name: TOOL_NAMES.wait, agent: { id: 'a' }, callId: 'wait' }, async () => ({ kind: 'allow' }))
  assert.deepEqual(nonActionWait, { kind: 'allow' })

  let neverHook
  const nativeNeverCtx = {
    tools: { register() { return () => {} } },
    on(_name, listener) { neverHook = listener; return () => {} },
    effect() {},
    get() { return { effectivePolicy: () => 'never', request: async () => 'rejected' } },
  }
  apply(nativeNeverCtx, { executablePath: '/does/not/launch' })
  const nativeNever = await neverHook({ name: TOOL_NAMES.fill, agent: { session: {} } }, async () => ({ kind: 'allow' }))
  assert.equal(nativeNever.kind, 'deny')

  let approvalRequest
  let allowedHook
  const approvalCtx = {
    tools: { register() { return () => {} } },
    on(_name, listener) { allowedHook = listener; return () => {} },
    effect() {},
    get() {
      return { request: async (args) => { approvalRequest = args; return 'allowed-once' } }
    },
  }
  apply(approvalCtx, { executablePath: '/does/not/launch' })
  assert.deepEqual(
    await allowedHook({
      name: TOOL_NAMES.navigate,
      callId: 'approval-call',
      agent: { session: {} },
      arguments: { pageId: 'crb-page-1', url: 'https://example.com' },
    }, async () => ({ kind: 'allow' })),
    { kind: 'allow' },
  )
  assert.deepEqual(approvalRequest.arguments, { pageId: 'crb-page-1', url: 'https://example.com' })
})

test('native Full Access grants actions without an ask, while restricted never and explicit ask retain native decisions', async () => {
  for (const row of [
    { mode: 'danger-full-access', policy: 'never', expected: 'allow', requests: 0 },
    { mode: 'danger-full-access', policy: 'ask', expected: 'deny', requests: 1 },
    { mode: 'workspace-write', policy: 'never', expected: 'deny', requests: 1 },
    { mode: 'read-only', policy: 'never', expected: 'deny', requests: 1 },
    { mode: undefined, policy: 'never', expected: 'deny', requests: 1 },
    { mode: 'danger-full-access', policy: undefined, expected: 'deny', requests: 1 },
    { mode: 'danger-full-access', policy: 'never', aborted: true, expected: 'cancel', requests: 0 },
  ]) {
    const session = { id: 'native-session' }
    let hook, requests = 0
    const approval = {
      effectivePolicy(value) { assert.equal(value, session); return row.policy },
      async request() { requests += 1; return 'rejected' },
    }
    const sandbox = { resolve({ session: value }) { assert.equal(value, session); return { mode: row.mode } } }
    const ctx = {
      tools: { register() { return () => {} } },
      on(_name, listener) { hook = listener; return () => {} }, effect() {},
      get(name) { return name === 'approval' ? approval : name === 'sandboxPolicy' ? sandbox : undefined },
    }
    apply(ctx, { executablePath: '/does/not/launch' })
    const controller = new AbortController()
    if (row.aborted) controller.abort()
    const result = await hook({ name: TOOL_NAMES.scriptRun, agent: { session }, signal: controller.signal }, async () => ({ kind: 'allow' }))
    assert.equal(result.kind, row.expected, JSON.stringify(row))
    assert.equal(requests, row.requests, JSON.stringify(row))
  }
})

test('concurrent sessions share browser setup and disposal waits for pending launch', async () => {
  let launchCalls = 0
  let closeCalls = 0
  let releaseLaunch
  const launchStarted = new Promise((resolve) => {
    releaseLaunch = resolve
  })
  const browser = {
    async newContext() {
      return { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, async close() {} }
    },
    async close() { closeCalls += 1 },
  }
  const factory = {
    async launch() {
      launchCalls += 1
      await launchStarted
      return browser
    },
  }
  const manager = new BrowserManager(browserConfig({ executablePath: '' }), undefined, factory)
  const agentA = { id: 'race-a', session: {} }
  const agentB = { id: 'race-b', session: {} }
  const openingA = manager.sessionFor(agentA, new AbortController().signal)
  const openingB = manager.sessionFor(agentB, new AbortController().signal)
  await new Promise((resolve) => setImmediate(resolve))
  const disposing = manager.dispose()
  releaseLaunch()
  await disposing
  await assert.rejects(openingA, /disposed/)
  await assert.rejects(openingB, /disposed/)
  assert.equal(launchCalls, 1)
  assert.equal(closeCalls, 1)
  assert.equal(manager.sessions.size, 0)
})

test('page limit reserves in-flight page creation', async () => {
  let releasePage
  let pageStarted
  const pageReady = new Promise((resolve) => { pageStarted = resolve })
  const pageGate = new Promise((resolve) => { releasePage = resolve })
  const page = {
    async goto() {},
    url() { return baseUrl },
    async title() { return 'fake page' },
    async close() {},
  }
  const context = {
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    async newPage() {
      pageStarted()
      await pageGate
      return page
    },
    async close() {},
  }
  const browser = {
    async newContext() { return context },
    async close() {},
  }
  const manager = new BrowserManager(browserConfig({ maxPagesPerSession: 1 }), undefined, {
    async launch() { return browser },
  })
  const agent = { id: 'page-limit-agent', session: {} }
  try {
    const opening = manager.open({ url: baseUrl }, execution(agent))
    await pageReady
    await assert.rejects(manager.open({ url: baseUrl }, execution(agent)), /already owns 1 pages/)
    releasePage()
    assert.match((await opening).pageId, /^crb-page-/)
  } finally {
    releasePage()
    await manager.dispose()
  }
})

test('pages and wait do not create a browser session implicitly', async () => {
  let launchCalls = 0
  const manager = new BrowserManager(browserConfig(), undefined, {
    async launch() {
      launchCalls += 1
      throw new Error('browser should not launch')
    },
  })
  const agent = { id: 'list-only-agent', session: {} }
  try {
    assert.deepEqual(await manager.pages({}, execution(agent)), { pages: [] })
    await assert.rejects(
      manager.wait({ selector: '#result' }, execution(agent)),
      /No existing DSH browser session/,
    )
    assert.equal(launchCalls, 0)
  } finally {
    await manager.dispose()
  }
})

test('storage state is loaded per DSH session and never included in page output', { skip: !chromePath && process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-crawshrimp-storage-'))
  const storageStatePath = join(root, 'state.json')
  await writeFile(storageStatePath, JSON.stringify({
    cookies: [{
      name: 'fixture_auth',
      value: 'state-cookie-token',
      domain: '127.0.0.1',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    }],
    origins: [],
  }))
  const withState = new BrowserManager(browserConfig({ storageStatePath }))
  const withoutState = new BrowserManager(browserConfig())
  const agentWithState = { id: 'state-agent', session: {} }
  const agentWithoutState = { id: 'default-agent', session: {} }
  try {
    const loaded = await withState.open({ url: baseUrl }, execution(agentWithState))
    const loadedState = withState.sessionFrom({ object: agentWithState.session })
    const loadedPage = loadedState.pages.get(loaded.pageId).page
    assert.equal(await loadedPage.evaluate(() => document.cookie), 'fixture_auth=state-cookie-token')
    const listed = await withState.pages({}, execution(agentWithState))
    assert.doesNotMatch(JSON.stringify(listed), /state-cookie-token|fixture_auth/)

    const isolated = await withoutState.open({ url: baseUrl }, execution(agentWithoutState))
    const isolatedState = withoutState.sessionFrom({ object: agentWithoutState.session })
    const isolatedPage = isolatedState.pages.get(isolated.pageId).page
    assert.equal(await isolatedPage.evaluate(() => document.cookie), '')
  } finally {
    await withState.dispose()
    await withoutState.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('storage state failures are clear and do not create a context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-crawshrimp-storage-invalid-'))
  const storageStatePath = join(root, 'invalid.json')
  await writeFile(storageStatePath, '{not json')
  let contextCalls = 0
  const browser = {
    async newContext() {
      contextCalls += 1
      throw new Error('context should not be created')
    },
    async close() {},
  }
  const manager = new BrowserManager(browserConfig({ storageStatePath }), undefined, {
    async launch() { return browser },
  })
  try {
    await assert.rejects(
      manager.open({ url: baseUrl }, execution({ id: 'invalid-state-agent', session: {} })),
      /storageStatePath must contain a valid Playwright storage-state JSON object/,
    )
    assert.equal(contextCalls, 0)
  } finally {
    await manager.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('connected browser is closed through Playwright close on disposal', async () => {
  let closeCalls = 0
  const externalBrowser = { connected: true }
  const browser = {
    async newContext() {
      return { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, async close() {} }
    },
    async close() {
      closeCalls += 1
      externalBrowser.connected = true
    },
    disconnect() {
      throw new Error('disconnect should not be called')
    },
  }
  const manager = new BrowserManager(browserConfig({ cdpEndpoint: 'http://127.0.0.1:9222' }), undefined, {
    async connectOverCDP() { return browser },
  })
  await manager.sessionFor({ id: 'cdp-agent', session: {} }, new AbortController().signal)
  await manager.dispose()
  assert.equal(closeCalls, 1)
  assert.equal(externalBrowser.connected, true)
})

test('real external CDP browser keeps its existing page after plugin disposal', { skip: !chromePath }, async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-crawshrimp-cdp-'))
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let connected
  let manager
  try {
    const endpoint = await waitForDevtoolsEndpoint(chrome)
    const version = await waitForDevtoolsVersion(endpoint)
    assert.match(version.Browser, /Chrome|Chromium/i)

    connected = await chromium.connectOverCDP(endpoint)
    const externalContext = connected.contexts()[0]
    assert.ok(externalContext)
    const externalPage = externalContext.pages()[0] || await externalContext.newPage()
    await externalPage.goto(`${baseUrl}/?external=before`)
    assert.equal(await externalPage.title(), 'DSH browser fixture')
    assert.equal(await externalPage.locator('#status').textContent(), 'ready')

    manager = new BrowserManager(browserConfig({ cdpEndpoint: endpoint }))
    const agent = { id: 'external-cdp-agent', session: {} }
    const opened = await manager.open({ url: `${baseUrl}/?owned=plugin` }, execution(agent))
    assert.match(opened.pageId, /^crb-page-/)
    const state = manager.sessionFrom({ object: agent.session })
    const ownedRecord = state.pages.get(opened.pageId)
    assert.equal(ownedRecord.page.context(), state.context)
    assert.notEqual(state.context, externalContext)
    assert.equal(await externalPage.url(), `${baseUrl}/?external=before`)

    await manager.dispose()
    manager = undefined

    const afterDispose = await waitForDevtoolsVersion(endpoint)
    assert.match(afterDispose.Browser, /Chrome|Chromium/i)
    assert.equal(await externalPage.title(), 'DSH browser fixture')
    await externalPage.goto(`${baseUrl}/?external=after`)
    assert.equal(await externalPage.locator('#status').textContent(), 'ready')
  } finally {
    if (manager) await manager.dispose()
    if (connected) await connected.close()
    await stopChrome(chrome)
    await rm(profileDir, { recursive: true, force: true })
  }
})

test('real headless Chrome keeps DSH sessions and page ids isolated', { skip: !chromePath && process.platform !== 'darwin' }, async () => {
  const manager = new BrowserManager(browserConfig())
  const agentA = { id: 'agent-a', session: {} }
  const agentB = { id: 'agent-b', session: {} }
  try {
    const openedA = await manager.open({ url: baseUrl }, execution(agentA))
    const openedB = await manager.open({ url: baseUrl }, execution(agentB))
    assert.notEqual(openedA.pageId, openedB.pageId)
    assert.equal(manager.sessions.size, 2)

    const pagesA = await manager.pages({}, execution(agentA))
    const pagesB = await manager.pages({}, execution(agentB))
    assert.deepEqual(pagesA.pages.map((item) => item.pageId), [openedA.pageId])
    assert.deepEqual(pagesB.pages.map((item) => item.pageId), [openedB.pageId])

    const observed = await manager.observe({ pageId: openedA.pageId }, execution(agentA))
    assert.match(observed.text, /Fixture product/)
    const input = observed.actionableElements.find((item) => item.label === 'search' || item.placeholder === 'search fixture')
    const button = observed.actionableElements.find((item) => item.text === 'Apply')
    const category = observed.actionableElements.find((item) => item.tag === 'select')
    assert(input?.ref)
    assert(button?.ref)
    assert(category?.ref)

    await manager.fill({ pageId: openedA.pageId, ref: input.ref, value: 'blue shirt' }, execution(agentA))
    const selected = await manager.select({ pageId: openedA.pageId, ref: category.ref, value: 'blue' }, execution(agentA))
    assert.deepEqual(selected.selected, ['blue'])
    await manager.press({ pageId: openedA.pageId, ref: input.ref, key: 'Enter' }, execution(agentA))
    await manager.wait({ pageId: openedA.pageId, selector: '#results', state: 'visible' }, execution(agentA))
    await manager.wait({ pageId: openedA.pageId, text: 'blue shirt' }, execution(agentA))
    await manager.click({ pageId: openedA.pageId, ref: button.ref }, execution(agentA))
    const afterClick = await manager.observe({ pageId: openedA.pageId }, execution(agentA))
    assert.match(afterClick.text, /blue shirt/)
    const oldRef = afterClick.actionableElements.find((item) => item.tag === 'input')?.ref
    assert(oldRef)
    const refreshed = await manager.observe({ pageId: openedA.pageId }, execution(agentA))
    assert.notEqual(refreshed.actionableElements.find((item) => item.tag === 'input')?.ref, oldRef)
    await assert.rejects(
      manager.fill({ pageId: openedA.pageId, ref: oldRef, value: 'stale' }, execution(agentA)),
      /Stale or unknown observation ref|Stale observation ref/,
    )
    const detailLink = refreshed.actionableElements.find((item) => item.text === 'Open details')
    assert(detailLink?.ref)
    await manager.click({ pageId: openedA.pageId, ref: detailLink.ref }, execution(agentA))
    await manager.wait({ pageId: openedA.pageId, text: 'Product detail page' }, execution(agentA))
    await manager.navigate({ pageId: openedA.pageId, url: baseUrl }, execution(agentA))
    await manager.wait({ pageId: openedA.pageId, selector: '#delayed', state: 'visible', timeoutMs: 5000 }, execution(agentA))
    await manager.fill({ pageId: openedA.pageId, selector: '#search', value: 'missing product' }, execution(agentA))
    await manager.press({ pageId: openedA.pageId, key: 'Enter' }, execution(agentA))
    await manager.wait({ pageId: openedA.pageId, selector: '#results', state: 'hidden' }, execution(agentA))
    await manager.wait({ pageId: openedA.pageId, selector: '#no-results', state: 'visible' }, execution(agentA))
    await manager.press({ pageId: openedA.pageId, key: 'Escape' }, execution(agentA))
    await assert.rejects(manager.navigate({ pageId: openedA.pageId, url: 'javascript:alert(1)' }, execution(agentA)), /http:\/\//i)
    assert.equal((await manager.observe({ pageId: openedB.pageId }, execution(agentB))).pageId, openedB.pageId)
    await assert.rejects(
      manager.observe({ pageId: openedA.pageId }, execution(agentB)),
      /Unknown owned page|No owned browser page/,
    )

    const screenshot = await manager.screenshot({ pageId: openedA.pageId }, execution(agentA))
    assert.equal(screenshot.mimeType, 'image/png')
    assert.ok(screenshot.data.length > 100)
    assert.ok(screenshot.bytes <= manager.config.maxScreenshotBytes)
  } finally {
    await manager.dispose()
  }
})

test('abort closes the owned context and plugin disposal releases its own browser', { skip: !chromePath && process.platform !== 'darwin' }, async () => {
  const manager = new BrowserManager(browserConfig())
  const agent = { id: 'cancel-agent', session: {} }
  try {
    const opened = await manager.open({ url: baseUrl }, execution(agent))
    const state = manager.sessionFrom({ object: agent.session })
    const record = state.pages.get(opened.pageId)
    const controller = new AbortController()
    const pending = manager.withCancellation(
      state,
      record.page,
      controller.signal,
      () => new Promise((resolve) => setTimeout(resolve, 1000)),
    )
    controller.abort()
    await assert.rejects(pending, { name: 'AbortError' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(state.closed, true)
    assert.equal(manager.sessions.size, 0)
  } finally {
    await manager.dispose()
  }
})

test('plugin loads into the real ToolRuntime and SkillRegistry, and unload removes tools and skill', { skip: !chromePath && process.platform !== 'darwin' }, async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const Tools = (await import('@deepseek-ai/dsh-tools')).default
  const Skills = (await import('@deepseek-ai/dsh-skill')).default
  const scriptRoot = await mkdtemp(join(tmpdir(), 'dsh-browser-scripts-'))
  const workspaceDir = await mkdtemp(join(tmpdir(), 'dsh-browser-script-workspace-'))
  await createScriptAdapter(scriptRoot)
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  ctx.provide('approval', { effectivePolicy: () => 'ask', request: async () => 'allowed-once' })
  try {
    await ctx.plugin(Tools)
    await ctx.plugin(Skills)
    const fiber = ctx.plugin(browserPlugin, browserConfig({
      adapterRoots: [scriptRoot],
      workspaceDir,
      maxPages: 3,
    }))
    await fiber
    const skill = await ctx.skills.get('crawshrimp-browser', { cwd: workspaceDir })
    assert.ok(skill)
    assert.equal(skill.source, 'bundled')
    assert.equal(skill.invocation.modelInvocable, true)
    assert.equal(skill.invocation.userInvocable, true)
    assert.ok(skill.content.includes(TOOL_NAMES.observe))
    assert.ok(skill.path.endsWith('/skills/crawshrimp-browser/SKILL.md'))
    for (const name of Object.values(TOOL_NAMES)) assert.ok(ctx.tools.get(name), `missing tool ${name}`)
    const agent = { id: 'runtime-agent', session: {} }
    const signal = new AbortController().signal
    const opened = await ctx.tools.execute({
      callId: 'runtime-open',
      name: TOOL_NAMES.open,
      arguments: { url: baseUrl },
      agent,
      signal,
    })
    assert.equal(opened.isError, false)
    const openedValue = JSON.parse(opened.content[0].text)
    assert.match(openedValue.pageId, /^crb-page-/)
    assert.match(openedValue.title, /DSH browser fixture/i)
    const observed = await ctx.tools.execute({
      callId: 'runtime-observe',
      name: TOOL_NAMES.observe,
      arguments: { pageId: openedValue.pageId },
      agent,
      signal,
    })
    assert.equal(observed.isError, false)
    assert.match(observed.content[0].text, /Fixture product/)
    const listed = await ctx.tools.execute({
      callId: 'runtime-script-list',
      name: TOOL_NAMES.scriptList,
      arguments: {},
      agent,
      signal,
    })
    assert.equal(listed.isError, false)
    assert.equal(JSON.parse(listed.content[0].text).adapters[0].tasks[0].id, 'pagination')
    const validation = await ctx.tools.execute({
      callId: 'runtime-script-validate',
      name: TOOL_NAMES.scriptValidate,
      arguments: { adapter_id: 'fixture-adapter', task_id: 'pagination', params: {} },
      agent,
      signal,
    })
    assert.equal(validation.isError, false)
    assert.equal(JSON.parse(validation.content[0].text).valid, true)
    const failedScripts = await ctx.tools.execute({
      callId: 'runtime-script-pagination-limit',
      name: TOOL_NAMES.scriptRun,
      arguments: { adapter_id: 'fixture-adapter', task_id: 'pagination', params: { label: 'limit' }, max_pages: 2 },
      agent,
      signal,
    })
    assert.equal(failedScripts.isError, true, JSON.stringify(failedScripts))
    assert.match(JSON.stringify(failedScripts), /pagination exceeded maxPages/i)
    const pagesAfterPaginationFailure = await ctx.tools.execute({
      callId: 'runtime-pages-after-pagination-failure',
      name: TOOL_NAMES.pages,
      arguments: {},
      agent,
      signal,
    })
    assert.equal(pagesAfterPaginationFailure.isError, false)
    assert.equal(JSON.parse(pagesAfterPaginationFailure.content[0].text).pages.length, 1)
    const observedAfterPaginationFailure = await ctx.tools.execute({
      callId: 'runtime-observe-after-pagination-failure',
      name: TOOL_NAMES.observe,
      arguments: { pageId: openedValue.pageId },
      agent,
      signal,
    })
    assert.equal(observedAfterPaginationFailure.isError, false)
    assert.match(observedAfterPaginationFailure.content[0].text, /Fixture product/)
    const scripts = await ctx.tools.execute({
      callId: 'runtime-script-run',
      name: TOOL_NAMES.scriptRun,
      arguments: { adapter_id: 'fixture-adapter', task_id: 'pagination', params: { label: 'runtime' } },
      agent,
      signal,
    })
    assert.equal(scripts.isError, false, JSON.stringify(scripts))
    const scriptValue = JSON.parse(scripts.content[0].text)
    assert.deepEqual(scriptValue.data.map((row) => row.page), [1, 2, 3])
    assert.deepEqual(scriptValue.data.map((row) => row.previousCount), [0, 1, 2])
    assert.deepEqual(scriptValue.data.map((row) => row.paramsAlias), [true, true, true])
    assert.deepEqual(scriptValue.data.map((row) => row.label), ['runtime', 'runtime', 'runtime'])
    const pagesAfterScript = await ctx.tools.execute({
      callId: 'runtime-pages-after-script',
      name: TOOL_NAMES.pages,
      arguments: {},
      agent,
      signal,
    })
    assert.equal(pagesAfterScript.isError, false)
    assert.equal(JSON.parse(pagesAfterScript.content[0].text).pages.length, 1)
    await fiber.dispose()
    for (const name of Object.values(TOOL_NAMES)) assert.equal(ctx.tools.get(name), undefined, `tool still registered: ${name}`)
    assert.equal(await ctx.skills.get('crawshrimp-browser', { cwd: workspaceDir }), undefined)
  } finally {
    if (ctx.fiber.uid !== null) await ctx.fiber.dispose()
    await rm(scriptRoot, { recursive: true, force: true })
    await rm(workspaceDir, { recursive: true, force: true })
  }
})

test('invalid login-state diagnostics do not quote cookie or token values', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-browser-private-state-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pathname = join(dir, 'private-state.json')
  const secret = 'PRIVATE_COOKIE_SHOULD_NOT_APPEAR'
  await writeFile(pathname, `${secret}{not-json`)
  const manager = new BrowserManager(browserConfig({ storageStatePath: pathname }), undefined, {
    async launch() { return { async close() {} } },
  })
  try {
    await assert.rejects(manager.sessionFor({ id: 'invalid-state', session: {} }), error => {
      assert.match(error.message, /valid Playwright storage-state JSON/)
      assert.equal(error.message.includes(secret), false)
      return true
    })
  } finally { await manager.dispose() }
})
