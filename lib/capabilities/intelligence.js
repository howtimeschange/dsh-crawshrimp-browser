import { randomUUID } from 'node:crypto'
import { CapabilityError, boundedInt, redact, boundedJson } from './common.js'

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_CONFIG_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_EXPRESSION_BYTES = 256 * 1024
const MAX_REQUEST_BODY_BYTES = 1024 * 1024
const MAX_CAPTURE_BODY_BYTES = 64 * 1024
const MAX_CAPTURE_TOTAL_BODY_BYTES = 2 * 1024 * 1024
const MAX_CAPTURE_ENTRIES = 100
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function fail(code, message) {
  throw new CapabilityError(code, message)
}

function output(value, maxBytes = MAX_OUTPUT_BYTES) {
  // Redact before serialisation so a large secret cannot bypass the output
  // budget through a later JSON transformation.
  return boundedJson(redact(value), maxBytes)
}

function pageMethod(page, method) {
  if (!page || typeof page[method] !== 'function') fail('PAGE_INVALID', `raw page 缺少 ${method}() 能力`)
  return page[method].bind(page)
}

function checkAbort(signal) {
  if (signal?.aborted) fail('ABORTED', '浏览器智能操作已取消')
}

function pageUrl(page) {
  const value = String(pageMethod(page, 'url')() || '').trim()
  if (!value) fail('PAGE_URL_UNAVAILABLE', '无法读取当前页面 URL')
  return value
}

function parseHttpUrl(raw, base, field = 'url') {
  const text = String(raw ?? '').trim()
  if (!text) fail('INVALID_URL', `${field} 不能为空`)
  let parsed
  try { parsed = new URL(text, base) } catch { fail('INVALID_URL', `${field} 不是有效的 http(s) URL`) }
  if (!['http:', 'https:'].includes(parsed.protocol)) fail('INVALID_URL', `${field} 必须使用 http 或 https`)
  if (parsed.username || parsed.password) fail('CREDENTIALS_URL', `${field} 不允许携带 URL 用户名或密码`)
  return parsed
}

function assertSameOrigin(target, current) {
  let pageOrigin
  try { pageOrigin = new URL(current) } catch { fail('PAGE_ORIGIN_UNAVAILABLE', '当前页面没有有效 origin') }
  if (!['http:', 'https:'].includes(pageOrigin.protocol)) fail('PAGE_ORIGIN_UNAVAILABLE', '当前页面不是 http(s) origin')
  if (target.origin !== pageOrigin.origin) fail('CROSS_ORIGIN', '请求必须与当前页面同源')
}

function timeoutError() {
  return new CapabilityError('TIMEOUT', '浏览器智能操作超时')
}

function abortError() {
  return new CapabilityError('ABORTED', '浏览器智能操作已取消')
}

function unknownOutcomeError(attemptId) {
  const error = new CapabilityError('OUTCOME_UNKNOWN', `请求可能已提交，请先读回业务状态，勿自动重试（attemptId: ${attemptId}）`)
  error.attemptId = attemptId
  error.outcome = 'unknown'
  return error
}

function abortAwareDelay(ms, signal) {
  const duration = Math.max(0, Number(ms) || 0)
  if (!duration) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, duration)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

async function scopedCdp(page) {
  try {
    const context = typeof page?.context === 'function' ? page.context() : undefined
    if (context && typeof context.newCDPSession === 'function') return await context.newCDPSession(page)
  } catch {
    // Non-Chromium pages and test doubles can use page.evaluate below.
  }
  return undefined
}

async function closeCdp(cdp) {
  try { await cdp?.detach?.() } catch {}
}

async function terminateCdp(cdp) {
  try { await cdp?.send?.('Runtime.terminateExecution') } catch {}
}

async function closeOwnedPage(page) {
  try { await page?.close?.({ runBeforeUnload: false }) } catch {
    try { await page?.close?.() } catch {}
  }
}

async function evaluateCdp(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (response?.exceptionDetails) {
    const detail = response.exceptionDetails
    fail('EVALUATE_FAILED', detail.text || detail.exception?.description || '页面 JavaScript 执行失败')
  }
  const result = response?.result || {}
  if (Object.hasOwn(result, 'value')) return result.value
  if (result.unserializableValue !== undefined) return result.unserializableValue
  return result.description
}

async function runWithDeadline(operation, signal, timeoutMs, onCancel) {
  checkAbort(signal)
  const timeout = boundedInt(timeoutMs, 100, 120000, 10000)
  let timer
  let cancelled = false
  let reason
  let rejectCancel
  const cancelledPromise = new Promise((_, reject) => { rejectCancel = reject })
  const abortListener = () => {
    if (cancelled) return
    cancelled = true
    reason = abortError()
    rejectCancel(reason)
  }
  signal?.addEventListener('abort', abortListener, { once: true })
  timer = setTimeout(() => {
    if (cancelled) return
    cancelled = true
    reason = timeoutError()
    rejectCancel(reason)
  }, timeout)

  let pending
  try {
    pending = Promise.resolve().then(operation)
    pending.catch(() => {})
    return await Promise.race([pending, cancelledPromise])
  } catch (error) {
    if (!cancelled) throw error
    try { await onCancel?.(reason) } catch {}
    // Runtime.terminateExecution normally resolves the pending evaluation;
    // this bounded wait also prevents an abandoned promise from surfacing as
    // an unhandled rejection.  The operation is never replayed.
    await Promise.race([pending?.catch(() => {}), abortAwareDelay(250)])
    throw reason
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortListener)
  }
}

async function evaluatePage(page, expression, signal, timeoutMs) {
  const evaluate = pageMethod(page, 'evaluate')
  let cdp
  try {
    cdp = await scopedCdp(page)
    return await runWithDeadline(
      () => cdp ? evaluateCdp(cdp, expression) : evaluate(expression),
      signal,
      timeoutMs,
      async () => {
        await terminateCdp(cdp)
        await closeOwnedPage(page)
      },
    )
  } finally {
    await closeCdp(cdp)
  }
}

function validateExpression(expression) {
  if (typeof expression !== 'string' || !expression.trim()) fail('INVALID_EXPRESSION', 'expression 必须是非空字符串')
  if (Buffer.byteLength(expression, 'utf8') > MAX_EXPRESSION_BYTES) fail('EXPRESSION_TOO_LARGE', `expression 超过 ${MAX_EXPRESSION_BYTES} 字节`)
  return expression
}

function validateHeaders(headers) {
  if (headers === undefined) return undefined
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) fail('INVALID_HEADERS', 'headers 必须是对象')
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!name || name.length > 256) fail('INVALID_HEADERS', 'headers 包含无效名称')
    const text = String(value ?? '')
    if (text.length > 65536) fail('INVALID_HEADERS', 'header value 过长')
    result[name] = text
  }
  if (Object.keys(result).length > 100) fail('INVALID_HEADERS', 'headers 数量超过上限')
  return result
}

function validateMethod(method) {
  const value = String(method || 'GET').trim().toUpperCase()
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/u.test(value)) fail('INVALID_METHOD', `不支持的 HTTP method: ${value}`)
  return value
}

function validateBody(body) {
  if (body === undefined || body === null) return undefined
  const value = typeof body === 'string' ? body : JSON.stringify(body)
  if (Buffer.byteLength(value, 'utf8') > MAX_REQUEST_BODY_BYTES) fail('REQUEST_BODY_TOO_LARGE', `request body 超过 ${MAX_REQUEST_BODY_BYTES} 字节`)
  return value
}

function collectProbeInPage() {
  const textOf = (element) => String(element?.innerText || element?.textContent || '').replace(/\s+/gu, ' ').trim()
  const visible = (element) => Boolean(element && typeof element.getClientRects === 'function' && element.getClientRects().length)
  const selectorOf = (element) => {
    if (!element?.tagName) return ''
    const tag = String(element.tagName).toLowerCase()
    const id = String(element.id || '').trim()
    if (id) return `${tag}#${id}`
    const testId = String(element.getAttribute?.('data-testid') || '').trim()
    if (testId) return `${tag}[data-testid="${testId}"]`
    const aria = String(element.getAttribute?.('aria-label') || '').trim()
    if (aria) return `${tag}[aria-label="${aria.replaceAll('"', '\\"')}"]`
    return tag
  }
  const collect = (selector, limit, map) => [...document.querySelectorAll(selector)].filter(visible).slice(0, limit).map(map).filter(Boolean)
  const buttons = collect('button,[role="button"],a,[role="tab"]', 80, (element) => ({
    text: textOf(element).slice(0, 300), selector: selectorOf(element), tag: String(element.tagName || '').toLowerCase(),
  }))
  const inputs = collect('input,textarea,select,[role="combobox"]', 50, (element) => ({
    selector: selectorOf(element), type: String(element.getAttribute?.('type') || element.tagName || 'text').slice(0, 40),
    name: String(element.getAttribute?.('name') || '').slice(0, 200),
    placeholder: String(element.getAttribute?.('placeholder') || '').slice(0, 300),
    ariaLabel: String(element.getAttribute?.('aria-label') || '').slice(0, 300),
  }))
  const headings = collect('h1,h2,h3,[role="heading"]', 20, (element) => textOf(element).slice(0, 500))
  const links = collect('a[href]', 80, (element) => ({ text: textOf(element).slice(0, 300), href: String(element.href || '').slice(0, 4096) }))
  const scripts = [...document.scripts].slice(0, 100).map((script) => String(script.src || '')).filter(Boolean)
  const performanceEntries = typeof performance?.getEntriesByType === 'function'
    ? performance.getEntriesByType('resource').slice(0, 100).map((entry) => ({
      url: String(entry.name || '').slice(0, 4096), initiatorType: String(entry.initiatorType || '').slice(0, 80),
      duration: Number.isFinite(entry.duration) ? Math.round(entry.duration * 100) / 100 : 0,
      transferSize: Number.isFinite(entry.transferSize) ? entry.transferSize : 0,
      encodedBodySize: Number.isFinite(entry.encodedBodySize) ? entry.encodedBodySize : 0,
      decodedBodySize: Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : 0,
    })) : []
  const app = document.querySelector('#app')
  const framework = {
    vue: Boolean(window.Vue || window.__VUE__ || app?.__vue__ || app?.__vue_app__ || document.querySelector('[data-v-app]')),
    vue2: Boolean(app?.__vue__), vue3: Boolean(app?.__vue_app__ || document.querySelector('[data-v-app]')),
    react: Boolean(window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-reactroot]')),
    next: Boolean(window.__NEXT_DATA__), nuxt: Boolean(window.__NUXT__),
  }
  // Describe page-owned entry points without invoking getters or reading
  // client/store values, which may contain auth or private business state.
  const modules = []
  for (const name of Object.getOwnPropertyNames(window).filter(name => /client|request|axios|graphql|(?:^|_)api|service/i.test(name)).slice(0, 60)) {
    const descriptor = Object.getOwnPropertyDescriptor(window, name)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue
    const value = descriptor.value
    if (!value || !['object', 'function'].includes(typeof value)) continue
    let methods = []
    try {
      methods = Object.entries(Object.getOwnPropertyDescriptors(value)).filter(([, item]) => Object.hasOwn(item, 'value') && typeof item.value === 'function').map(([key]) => key).slice(0, 30)
    } catch {}
    modules.push({ name, type: typeof value, methods })
  }
  return {
    url: String(location.href || ''), title: String(document.title || '').slice(0, 1000),
    dom: {
      headings, buttons, links, inputs, bodyText: textOf(document.body).slice(0, 8000),
      tableCount: document.querySelectorAll('table').length, formCount: document.querySelectorAll('form').length,
    },
    framework,
    modules,
    globals: {
      Vue: Boolean(window.Vue), React: Boolean(window.React), ReactDevTools: Boolean(window.__REACT_DEVTOOLS_GLOBAL_HOOK__),
      NextData: Boolean(window.__NEXT_DATA__), Nuxt: Boolean(window.__NUXT__),
    },
    scriptUrls: scripts,
    performance: performanceEntries,
  }
}

function strategyFor(pageModel) {
  const targets = [...(pageModel?.dom?.buttons || []).slice(0, 20), ...(pageModel?.dom?.inputs || []).slice(0, 20)]
  return {
    preferredActions: ['observe', 'probe', 'page-owned-client', 'capture_requests', 'same-origin-request', 'dom-fallback', 'verify', 'journal'],
    decision: 'Prefer an understood page-owned module/client or observed same-origin API; use DOM controls when API semantics or business verification are unclear.',
    moduleCandidates: pageModel?.modules || [],
    targetCount: targets.length, targets,
    apiEvidence: 'hints-only; capture actual request method, payload and business response before using an unknown endpoint',
    endpointCount: (pageModel?.performance || []).filter(entry => ['fetch', 'xmlhttprequest'].includes(entry.initiatorType)).length,
    pageKind: pageModel?.dom?.formCount ? 'interactive' : 'document',
  }
}

async function requestInPage(input) {
  const controller = new AbortController()
  const maxResponseBytes = 2 * 1024 * 1024
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, input.timeoutMs)
  let reader
  try {
    const response = await fetch(input.url, {
      method: input.method, headers: input.headers, body: input.body,
      credentials: 'same-origin', redirect: 'error', signal: controller.signal,
    })
    const contentLength = Number(response.headers?.get?.('content-length'))
    if (Number.isSafeInteger(contentLength) && contentLength > maxResponseBytes) {
      return { errorCode: 'RESPONSE_TOO_LARGE', error: `response body exceeds ${maxResponseBytes} bytes` }
    }
    const headers = {}
    response.headers?.forEach?.((value, key) => { headers[key] = value })
    const chunks = []
    let bytes = 0
    reader = response.body?.getReader?.()
    if (reader) {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        const chunk = item.value instanceof Uint8Array ? item.value : new Uint8Array(item.value || [])
        bytes += chunk.byteLength
        if (bytes > maxResponseBytes) {
          await reader.cancel().catch(() => {})
          return { errorCode: 'RESPONSE_TOO_LARGE', error: `response body exceeds ${maxResponseBytes} bytes` }
        }
        chunks.push(chunk)
      }
    }
    const body = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
    const text = new TextDecoder().decode(body)
    let data = text
    if (String(response.headers?.get?.('content-type') || '').toLowerCase().includes('json')) {
      try { data = JSON.parse(text) } catch {}
    }
    return { url: String(response.url || input.url), status: response.status, statusText: response.statusText, ok: response.ok, headers, data, bytes }
  } catch (error) {
    if (timedOut) return { errorCode: 'TIMEOUT', error: 'response body read timed out' }
    return { errorCode: 'REQUEST_FAILED', error: String(error?.message || error) }
  } finally {
    clearTimeout(timer)
    try { await reader?.cancel?.() } catch {}
    controller.abort()
  }
}

function addListener(page, name, listener) {
  if (typeof page?.on !== 'function') fail('PAGE_INVALID', `raw page 缺少 ${name} 监听能力`)
  page.on(name, listener)
}

function removeListener(page, name, listener) {
  try {
    if (typeof page?.off === 'function') page.off(name, listener)
    else page?.removeListener?.(name, listener)
  } catch {}
}

function requestMeta(request) {
  const read = (method, fallback = undefined) => { try { return request?.[method]?.() ?? fallback } catch { return fallback } }
  return {
    url: String(read('url', '') || ''), method: String(read('method', '') || ''),
    headers: read('headers', {}) || {}, postData: read('postData'), resourceType: String(read('resourceType', '') || ''),
  }
}

function captureRequestBody(raw, headers, limit = MAX_CAPTURE_BODY_BYTES) {
  if (raw === undefined || raw === null) return undefined
  const text = typeof raw === 'string' ? raw : String(raw)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > limit) return { bytes, truncated: true }
  const contentType = responseHeader(headers, 'content-type').toLowerCase()
  let data = text
  if (contentType.includes('json') || /^[\[{]/u.test(text.trim())) {
    try { data = JSON.parse(text) } catch {}
  }
  return { data: redact(data), bytes, truncated: false }
}

function responseMeta(response) {
  const read = (method, fallback = undefined) => { try { return response?.[method]?.() ?? fallback } catch { return fallback } }
  return {
    url: String(read('url', '') || ''), status: Number(read('status', 0) || 0), statusText: String(read('statusText', '') || ''),
    headers: read('headers', {}) || {}, request: read('request'),
  }
}

function responseBody(raw, headers, limit) {
  const input = raw?.body ?? raw
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || '')
  if (buffer.byteLength > limit) return undefined
  const slice = buffer.subarray(0, limit)
  const text = slice.toString('utf8')
  let data = text
  const contentType = String(headers?.['content-type'] || headers?.['Content-Type'] || '').toLowerCase()
  if (contentType.includes('json')) {
    try { data = JSON.parse(text) } catch {}
  }
  return { data, bytes: buffer.byteLength, truncated: false }
}

function responseHeader(headers, name) {
  const wanted = String(name).toLowerCase()
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) return String(value ?? '')
  }
  return ''
}

function responseContentLength(headers) {
  const raw = responseHeader(headers, 'content-length')
  if (!raw.trim()) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function captureKey(url, status) {
  return `${String(url || '')}\n${Number(status || 0)}`
}

async function takeCdpRecord(queues, key, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const queue = queues.get(key)
    if (queue?.length) {
      const record = queue.shift()
      if (!queue.length) queues.delete(key)
      return record
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return undefined
}

function boundedCdpBody(cdp, record, limit) {
  const encoding = responseHeader(record.headers, 'content-encoding').trim().toLowerCase()
  if (encoding && encoding !== 'identity') return Promise.resolve(undefined)
  const waitForFinished = record.finished
    ? Promise.resolve()
    : record.finishedPromise
  const body = waitForFinished.then(async () => {
    if (!record.finished || record.contentLength === undefined || record.contentLength > limit
      || !Number.isSafeInteger(record.encodedDataLength) || record.encodedDataLength > limit) return undefined
    const raw = await cdp.send('Network.getResponseBody', { requestId: record.requestId })
    const bytes = raw?.base64Encoded ? Buffer.from(String(raw.body || ''), 'base64') : Buffer.from(String(raw?.body || ''), 'utf8')
    return responseBody(bytes, record.headers, limit)
  })
  body.catch(() => {})
  return Promise.race([body, new Promise(resolve => setTimeout(() => resolve(undefined), 250))])
}

function matches(entry, args) {
  const urlIncludes = String(args.urlIncludes || '').trim()
  if (urlIncludes && !entry.url.includes(urlIncludes)) return false
  const method = String(args.method || '').trim().toUpperCase()
  if (method && entry.method.toUpperCase() !== method) return false
  if (args.status !== undefined && Number(args.status) !== entry.status) return false
  return true
}

async function trigger(page, value, signal, timeoutMs) {
  if (!value) return
  const type = String(value.type || '').trim().toLowerCase()
  if (!['reload', 'click', 'scroll'].includes(type)) fail('INVALID_TRIGGER', 'trigger.type 必须是 reload、click 或 scroll')
  checkAbort(signal)
  const timeout = boundedInt(timeoutMs, 100, 60000, 10000)
  const selector = typeof value.selector === 'string' ? value.selector.trim() : ''
  const coordinates = Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y))
  if (type === 'reload') {
    if (typeof page.reload !== 'function') fail('PAGE_INVALID', 'raw page 缺少 reload() 能力')
    await page.reload({ waitUntil: 'domcontentloaded', timeout })
    return
  }
  if (type === 'click') {
    if (selector) {
      if (typeof page.locator !== 'function') fail('PAGE_INVALID', 'raw page 缺少 locator() 能力')
      await page.locator(selector).click({ timeout })
      return
    }
    if (!coordinates || typeof page.mouse?.click !== 'function') fail('INVALID_TRIGGER', 'click trigger 需要 selector 或 x/y')
    await page.mouse.click(Number(value.x), Number(value.y))
    return
  }
  if (selector) {
    if (typeof page.locator !== 'function') fail('PAGE_INVALID', 'raw page 缺少 locator() 能力')
    await page.locator(selector).scrollIntoViewIfNeeded({ timeout })
  }
  if (typeof page.mouse?.wheel === 'function') {
    if (coordinates && typeof page.mouse.move === 'function') await page.mouse.move(Number(value.x), Number(value.y))
    await page.mouse.wheel(Number(value.deltaX || 0), Number(value.deltaY ?? 700))
  } else if (!selector) fail('PAGE_INVALID', 'raw page 缺少滚动能力')
}

export class BrowserIntelligence {
  constructor(config = {}) {
    this.config = {
      maxOutputBytes: Math.min(boundedInt(config.maxOutputBytes, 1024, MAX_CONFIG_OUTPUT_BYTES, MAX_OUTPUT_BYTES), MAX_OUTPUT_BYTES),
      probeTimeoutMs: boundedInt(config.probeTimeoutMs, 100, 120000, 10000),
      evaluateTimeoutMs: boundedInt(config.evaluateTimeoutMs, 100, 120000, 10000),
      requestTimeoutMs: boundedInt(config.requestTimeoutMs, 100, 120000, 15000),
      captureDurationMs: boundedInt(config.captureDurationMs, 0, 10000, 1000),
      captureMaxEntries: boundedInt(config.captureMaxEntries, 1, MAX_CAPTURE_ENTRIES, MAX_CAPTURE_ENTRIES),
    }
  }

  async probe(page, args = {}, signal) {
    checkAbort(signal)
    const model = await evaluatePage(page, `(${collectProbeInPage.toString()})()`, signal, boundedInt(args.timeoutMs, 100, 120000, this.config.probeTimeoutMs))
    const pageModel = output(model, this.config.maxOutputBytes)
    return output({ success: true, pageModel, strategy: strategyFor(pageModel) }, this.config.maxOutputBytes)
  }

  async evaluate(page, args = {}, signal) {
    const expression = validateExpression(args.expression)
    const timeoutMs = boundedInt(args.timeoutMs, 100, 120000, this.config.evaluateTimeoutMs)
    checkAbort(signal)
    const value = await evaluatePage(page, expression, signal, timeoutMs)
    return output({ success: true, value }, this.config.maxOutputBytes)
  }

  async request(page, args = {}, signal) {
    const current = pageUrl(page)
    const target = parseHttpUrl(args.url, current)
    assertSameOrigin(target, current)
    const method = validateMethod(args.method)
    const body = validateBody(args.body)
    if ((method === 'GET' || method === 'HEAD') && body !== undefined) fail('INVALID_REQUEST', `${method} 请求不能携带 body`)
    const headers = validateHeaders(args.headers)
    const timeoutMs = boundedInt(args.timeoutMs, 100, 120000, this.config.requestTimeoutMs)
    const attemptId = randomUUID()
    let response
    try {
      response = await evaluatePage(page, `(${requestInPage.toString()})(${JSON.stringify({
        url: target.toString(), origin: target.origin, method, headers, body, timeoutMs,
      })})`, signal, timeoutMs + 500)
    } catch (error) {
      if (MUTATING_METHODS.has(method) && ['TIMEOUT', 'REQUEST_FAILED'].includes(error?.code)) throw unknownOutcomeError(attemptId)
      throw error
    }
    if (response?.errorCode) {
      if (MUTATING_METHODS.has(method)) throw unknownOutcomeError(attemptId)
      fail(response.errorCode, response.error || '页面请求失败')
    }
    return output(response, this.config.maxOutputBytes)
  }

  async capture(page, args = {}, signal) {
    pageMethod(page, 'url')
    const durationMs = boundedInt(args.durationMs, 0, 10000, this.config.captureDurationMs)
    const maxEntries = boundedInt(args.maxEntries, 1, MAX_CAPTURE_ENTRIES, this.config.captureMaxEntries)
    const includeBodies = args.includeBodies === true
    const entries = []
    const pending = new Set()
    const requests = new WeakMap()
    const cdpQueues = new Map()
    const cdpRecords = new Map()
    let cdp
    let bodyBytes = 0
    let listenerError
    const onRequest = (request) => {
      try { requests.set(request, requestMeta(request)) } catch (error) { listenerError ||= error }
    }
    const onCdpResponse = (event) => {
      const response = event?.response || {}
      const record = {
        requestId: event?.requestId,
        url: String(response.url || ''), status: Number(response.status || 0),
        headers: response.headers || {}, contentLength: responseContentLength(response.headers || {}),
        encodedDataLength: undefined, finished: false, resolveFinished: undefined,
      }
      record.finishedPromise = new Promise(resolve => { record.resolveFinished = resolve })
      cdpRecords.set(String(event?.requestId || ''), record)
      const key = captureKey(record.url, record.status)
      const queue = cdpQueues.get(key) || []
      queue.push(record)
      cdpQueues.set(key, queue)
    }
    const onCdpFinished = (event) => {
      const record = cdpRecords.get(String(event?.requestId || ''))
      if (!record) return
      record.encodedDataLength = Number(event?.encodedDataLength)
      record.finished = true
      record.resolveFinished?.()
    }
    const onCdpFailed = (event) => {
      const record = cdpRecords.get(String(event?.requestId || ''))
      if (!record) return
      record.finished = true
      record.encodedDataLength = Number.MAX_SAFE_INTEGER
      record.resolveFinished?.()
    }
    const onResponse = (response) => {
      const task = (async () => {
        if (entries.length >= maxEntries) return
        const metadata = responseMeta(response)
        const request = metadata.request
        const requestData = (request && requests.get(request)) || (request ? requestMeta(request) : {})
        const entry = {
          url: metadata.url, method: requestData.method || '', status: metadata.status, statusText: metadata.statusText,
          headers: metadata.headers, requestHeaders: requestData.headers, resourceType: requestData.resourceType || '',
        }
        if (!matches(entry, args)) return
        if (includeBodies) {
          const requestBody = captureRequestBody(requestData.postData, requestData.headers)
          if (requestBody) {
            entry.postDataBytes = requestBody.bytes
            entry.postDataTruncated = requestBody.truncated
            if (!requestBody.truncated) entry.postData = requestBody.data
          }
        }
        if (includeBodies && bodyBytes < MAX_CAPTURE_TOTAL_BODY_BYTES && cdp) {
          const key = captureKey(metadata.url, metadata.status)
          const record = await takeCdpRecord(cdpQueues, key)
          if (record) {
            const remaining = MAX_CAPTURE_TOTAL_BODY_BYTES - bodyBytes
            const body = await boundedCdpBody(cdp, record, Math.min(MAX_CAPTURE_BODY_BYTES, remaining))
            if (body) {
              bodyBytes += body.bytes
              entry.body = body.data
              entry.bodyBytes = body.bytes
              entry.bodyTruncated = body.truncated
            }
          }
        }
        if (includeBodies && !Object.hasOwn(entry, 'body')) entry.bodyOmitted = 'body unavailable, unfinished, compressed, or outside capture byte/time limits'
        if (entries.length < maxEntries) entries.push(entry)
      })()
      pending.add(task)
      task.catch((error) => { listenerError ||= error }).finally(() => pending.delete(task)).catch(() => {})
    }
    try {
      cdp = await scopedCdp(page)
      if (cdp) {
        await cdp.send('Network.enable')
        cdp.on('Network.responseReceived', onCdpResponse)
        cdp.on('Network.loadingFinished', onCdpFinished)
        cdp.on('Network.loadingFailed', onCdpFailed)
      }
    } catch {
      await closeCdp(cdp)
      cdp = undefined
    }
    addListener(page, 'request', onRequest)
    addListener(page, 'response', onResponse)
    let triggerError
    try {
      checkAbort(signal)
      await runWithDeadline(
        () => trigger(page, args.trigger, signal, args.timeoutMs),
        signal,
        boundedInt(args.timeoutMs, 100, 60000, 10000),
        async () => { await closeOwnedPage(page) },
      )
      await abortAwareDelay(durationMs, signal)
    } catch (error) {
      triggerError = error
    } finally {
      removeListener(page, 'request', onRequest)
      removeListener(page, 'response', onResponse)
      if (cdp) {
        try { cdp.off('Network.responseReceived', onCdpResponse) } catch {}
        try { cdp.off('Network.loadingFinished', onCdpFinished) } catch {}
        try { cdp.off('Network.loadingFailed', onCdpFailed) } catch {}
      }
      await Promise.race([
        Promise.allSettled([...pending]),
        abortAwareDelay(500),
      ])
      try { await cdp?.send?.('Network.disable') } catch {}
      await closeCdp(cdp)
    }
    if (triggerError) throw triggerError
    if (listenerError) fail('CAPTURE_FAILED', listenerError.message || String(listenerError))
    return output({
      success: true, entries, meta: { durationMs, maxEntries, includeBodies, bodyBytes, truncated: entries.length >= maxEntries },
    }, this.config.maxOutputBytes)
  }
}
