import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { gzipSync } from 'node:zlib'

import { BrowserIntelligence } from '../lib/capabilities/intelligence.js'

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
let browser
let context
let page
let delayedMutations = 0
let crossOriginHits = 0

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

before(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/api/state') {
      let body = ''
      for await (const chunk of request) body += chunk
      let payload = {}
      try { payload = body ? JSON.parse(body) : {} } catch {}
      sendJson(response, 200, { quantity: payload.quantity || 0, token: 'api-secret-token', nested: { authorization: 'Bearer nested-secret' } })
      return
    }
    if (url.pathname === '/api/compressed') {
      const body = gzipSync(JSON.stringify({ payload: 'z'.repeat(4 * 1024 * 1024) }))
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': body.length })
      response.end(body); return
    }
    if (url.pathname === '/api/record-mutation') {
      delayedMutations += 1
      sendJson(response, 200, { recorded: delayedMutations })
      return
    }
    if (url.pathname === '/api/slow') {
      await new Promise((resolve) => setTimeout(resolve, 2500))
      sendJson(response, 200, { token: 'slow-secret' })
      return
    }
    if (url.pathname === '/api/large-fixed') {
      const body = 'x'.repeat(2 * 1024 * 1024 + 1)
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    if (url.pathname === '/api/large-chunked') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      for (let index = 0; index < 33; index += 1) response.write('y'.repeat(64 * 1024))
      response.end('z')
      return
    }
    if (url.pathname === '/api/stalled') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('stalled')
      return
    }
    if (url.pathname === '/api/large-capture') {
      const body = JSON.stringify({ payload: 'capture-oversize-'.repeat(6000) })
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    if (url.pathname === '/api/large-request') {
      sendJson(response, 200, { received: true })
      return
    }
    if (url.pathname === '/redirect-cross-origin') {
      response.writeHead(302, { location: `http://localhost:${server.address().port}/cross-target` })
      response.end()
      return
    }
    if (url.pathname === '/cross-target') {
      crossOriginHits += 1
      sendJson(response, 200, { reached: true })
      return
    }
    if (url.pathname === '/app.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      response.end(`
        window.Vue = {}; window.React = {}; window.__APP_SECRET__ = 'do-not-read-this-global'
        document.querySelector('#load').addEventListener('click', async () => {
          const response = await fetch('/api/state?token=click-secret', {
            method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ quantity: 4, authorization: 'Bearer click-request-secret', cookie: 'session-cookie-secret' }),
          })
          const value = await response.json(); document.querySelector('#state').textContent = String(value.quantity)
        })
        document.querySelector('#large').addEventListener('click', () => fetch('/api/large-capture'))
        document.querySelector('#compressed').addEventListener('click', () => fetch('/api/compressed'))
        document.querySelector('#large-request').addEventListener('click', () => fetch('/api/large-request', {
          method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'request-oversize-'.repeat(5000),
        }))
      `)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>API first fixture</title><main>
      <h1>Intelligence fixture</h1><p id="state">0</p>
      <input id="quantity" aria-label="Quantity" placeholder="quantity">
      <button id="load" type="button">Load state</button>
      <button id="large" type="button">Large</button>
      <button id="compressed" type="button">Compressed</button>
      <button id="large-request" type="button">Large request</button>
      <div id="scroll" style="height:80px;overflow:auto"><div style="height:1400px"></div></div>
      </main><script src="/app.js"></script>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  if (!chromePath) return
  browser = await chromium.launch({ executablePath: chromePath, headless: true })
  context = await browser.newContext()
  page = await context.newPage()
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
})

after(async () => {
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await new Promise((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()))
})

function chromeOnly() {
  return chromePath ? {} : { skip: 'Chrome executable is not available in this environment' }
}

test('probe returns bounded redacted PageModel and strategy', chromeOnly(), async () => {
  const intelligence = new BrowserIntelligence({ maxOutputBytes: 256 * 1024 })
  const result = await intelligence.probe(page)
  assert.equal(result.success, true)
  assert.equal(result.pageModel.framework.vue, true)
  assert.equal(result.pageModel.framework.react, true)
  assert.ok(result.pageModel.scriptUrls.some((url) => url.endsWith('/app.js')))
  assert.ok(result.pageModel.performance.some((entry) => entry.url.endsWith('/app.js')))
  assert.ok(result.strategy.targetCount >= 2)
  assert.doesNotMatch(JSON.stringify(result), /do-not-read-this-global|api-secret-token|click-secret/)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 256 * 1024)
})

test('request mutates API state in page context and redacts response data', chromeOnly(), async () => {
  const result = await new BrowserIntelligence().request(page, {
    url: `${baseUrl}/api/state`, method: 'POST',
    headers: { 'content-type': 'application/json' }, body: { quantity: 3 },
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.data, { quantity: 3, token: '[REDACTED]', nested: { authorization: '[REDACTED]' } })
})

test('capture listens before click and bounds/redacts response bodies', chromeOnly(), async () => {
  const result = await new BrowserIntelligence().capture(page, {
    durationMs: 350, maxEntries: 10, includeBodies: true, urlIncludes: '/api/state',
    trigger: { type: 'click', selector: '#load' },
  })
  assert.equal(result.success, true)
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].status, 200)
  assert.match(result.entries[0].url, /token=\[REDACTED\]/i)
  assert.equal(result.entries[0].body.token, '[REDACTED]')
  assert.ok(result.entries[0].bodyBytes <= 64 * 1024)
  assert.deepEqual(result.entries[0].postData, {
    quantity: 4, authorization: '[REDACTED]', cookie: '[REDACTED]',
  })
  assert.doesNotMatch(JSON.stringify(result.entries[0]), /click-request-secret|session-cookie-secret/)
})

test('capture reload/scroll triggers respect entry cap', chromeOnly(), async () => {
  const reload = await new BrowserIntelligence().capture(page, { durationMs: 200, maxEntries: 1, trigger: { type: 'reload' } })
  assert.ok(reload.entries.length <= 1)
  const scroll = await new BrowserIntelligence().capture(page, { durationMs: 150, maxEntries: 5, trigger: { type: 'scroll', selector: '#scroll', deltaY: 500 } })
  assert.ok(scroll.entries.length <= 5)
})

test('evaluate terminates timeout and capture abort removes listeners', chromeOnly(), async () => {
  const intelligence = new BrowserIntelligence({ evaluateTimeoutMs: 500 })
  delayedMutations = 0
  await assert.rejects(intelligence.evaluate(page, {
    expression: "new Promise((resolve) => setTimeout(() => fetch('/api/record-mutation').then(resolve), 500))",
    timeoutMs: 150,
  }), (error) => error.code === 'TIMEOUT')
  assert.equal(page.isClosed(), true)
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(delayedMutations, 0)

  page = await context.newPage()
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  assert.equal((await intelligence.evaluate(page, { expression: '1 + 1' })).value, 2)
  const controller = new AbortController()
  const running = intelligence.capture(page, { durationMs: 10000 }, controller.signal)
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(running, (error) => error.code === 'ABORTED')
  assert.equal((await intelligence.capture(page, { durationMs: 50, maxEntries: 1 })).success, true)
})

test('request rejects credential URLs and cross-origin targets', chromeOnly(), async () => {
  const intelligence = new BrowserIntelligence()
  await assert.rejects(intelligence.request(page, { url: `http://user:pass@127.0.0.1:${server.address().port}/api/state` }), (error) => error.code === 'CREDENTIALS_URL')
  await assert.rejects(intelligence.request(page, { url: 'https://example.com/api/state' }), (error) => error.code === 'CROSS_ORIGIN')
})

test('runtime output config accepts 16 MiB and caps intelligence output at 2 MiB', () => {
  const intelligence = new BrowserIntelligence({ maxOutputBytes: 16 * 1024 * 1024 })
  assert.equal(intelligence.config.maxOutputBytes, 2 * 1024 * 1024)
})

test('request rejects fixed and chunked responses above the 2 MiB body cap', chromeOnly(), async () => {
  const intelligence = new BrowserIntelligence({ requestTimeoutMs: 1000 })
  await assert.rejects(intelligence.request(page, { url: `${baseUrl}/api/large-fixed`, timeoutMs: 1000 }), (error) => error.code === 'RESPONSE_TOO_LARGE')
  await assert.rejects(intelligence.request(page, { url: `${baseUrl}/api/large-chunked`, timeoutMs: 1000 }), (error) => error.code === 'RESPONSE_TOO_LARGE')
})

test('request body deadline aborts a stalled response', chromeOnly(), async () => {
  const intelligence = new BrowserIntelligence({ requestTimeoutMs: 300 })
  const started = Date.now()
  await assert.rejects(intelligence.request(page, { url: `${baseUrl}/api/stalled`, timeoutMs: 300 }), (error) => error.code === 'TIMEOUT')
  assert.ok(Date.now() - started < 2000)
})

test('mutating request failures return an unknown outcome with an attempt id', chromeOnly(), async () => {
  const intelligence = new BrowserIntelligence({ requestTimeoutMs: 300 })
  await assert.rejects(intelligence.request(page, {
    url: `${baseUrl}/api/stalled`, method: 'POST', body: { quantity: 7 }, timeoutMs: 300,
  }), (error) => {
    assert.equal(error.code, 'OUTCOME_UNKNOWN')
    assert.equal(error.outcome, 'unknown')
    assert.match(error.attemptId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    assert.match(error.message, /请求可能已提交，请先读回业务状态，勿自动重试/)
    assert.match(error.message, new RegExp(error.attemptId))
    return true
  })
})

test('same-origin request rejects redirects before a cross-origin target is requested', chromeOnly(), async () => {
  crossOriginHits = 0
  const intelligence = new BrowserIntelligence()
  await assert.rejects(intelligence.request(page, { url: `${baseUrl}/redirect-cross-origin` }), (error) => error.code === 'REQUEST_FAILED')
  assert.equal(crossOriginHits, 0)
})

test('capture omits response and request bodies above the 64 KiB cap', chromeOnly(), async () => {
  const intelligence = new BrowserIntelligence()
  const result = await intelligence.capture(page, {
    durationMs: 350, maxEntries: 10, includeBodies: true, urlIncludes: '/api/large-capture',
    trigger: { type: 'click', selector: '#large' },
  })
  assert.equal(result.success, true)
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].body, undefined)
  assert.equal(result.entries[0].bodyBytes, undefined)

  const requestResult = await intelligence.capture(page, {
    durationMs: 350, maxEntries: 10, includeBodies: true, urlIncludes: '/api/large-request',
    trigger: { type: 'click', selector: '#large-request' },
  })
  assert.equal(requestResult.entries.length, 1)
  assert.equal(requestResult.entries[0].postData, undefined)
  assert.ok(requestResult.entries[0].postDataBytes > 64 * 1024)
  assert.equal(requestResult.entries[0].postDataTruncated, true)
})

test('capture keeps compressed responses as metadata without inflating the body', chromeOnly(), async () => {
  const result = await new BrowserIntelligence().capture(page, {
    durationMs: 350, includeBodies: true, urlIncludes: '/api/compressed',
    trigger: { type: 'click', selector: '#compressed' },
  })
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].body, undefined)
  assert.match(result.entries[0].bodyOmitted, /compressed/)
})
