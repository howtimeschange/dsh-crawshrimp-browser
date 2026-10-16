import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

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

before(async () => {
  server = createServer((request, response) => {
    if (request.url === '/slow') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<title>Slow fixture</title><p>slow</p>')
      }, 1000)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
      <title>DSH browser fixture</title>
      <main><h1>Fixture product</h1><p id="status">ready</p>
      <label>Search <input id="search" name="search" placeholder="search fixture"></label>
      <button id="apply" type="button">Apply</button></main>
      <script>document.querySelector('#apply').addEventListener('click', () => {
        document.querySelector('#status').textContent = document.querySelector('#search').value || 'empty'
      })</script>`)
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

function waitForDevtoolsEndpoint(child, timeoutMs = 15000) {
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
    TOOL_NAMES.open,
  ].sort())
  for (const name of Object.values(TOOL_NAMES)) assert.match(name, /^crawshrimp_browser_[a-z]+$/)
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
  assert.equal(registrations.length, 6)

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
      name: TOOL_NAMES.fill,
      callId: 'approval-call',
      agent: { session: {} },
      arguments: { pageId: 'crb-page-1', ref: 'crb-ref-1', value: 'hello' },
    }, async () => ({ kind: 'allow' })),
    { kind: 'allow' },
  )
  assert.deepEqual(approvalRequest.arguments, { pageId: 'crb-page-1', ref: 'crb-ref-1', value: 'hello' })
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

    const observed = await manager.observe({ pageId: openedA.pageId }, execution(agentA))
    assert.match(observed.text, /Fixture product/)
    const input = observed.actionableElements.find((item) => item.label === 'search' || item.placeholder === 'search fixture')
    const button = observed.actionableElements.find((item) => item.text === 'Apply')
    assert(input?.ref)
    assert(button?.ref)

    await manager.fill({ pageId: openedA.pageId, ref: input.ref, value: 'blue shirt' }, execution(agentA))
    await manager.click({ pageId: openedA.pageId, ref: button.ref }, execution(agentA))
    const afterClick = await manager.observe({ pageId: openedA.pageId }, execution(agentA))
    assert.match(afterClick.text, /blue shirt/)
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

test('plugin loads into the real ToolRuntime and unload removes all tools', { skip: !chromePath && process.platform !== 'darwin' }, async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const Tools = (await import('@deepseek-ai/dsh-tools')).default
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  ctx.provide('approval', { effectivePolicy: () => 'ask', request: async () => 'allowed-once' })
  try {
    await ctx.plugin(Tools)
    const fiber = ctx.plugin(browserPlugin, browserConfig())
    await fiber
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
    await fiber.dispose()
    assert.equal(ctx.tools.get(TOOL_NAMES.open), undefined)
    assert.equal(ctx.tools.get(TOOL_NAMES.observe), undefined)
  } finally {
    if (ctx.fiber.uid !== null) await ctx.fiber.dispose()
  }
})
