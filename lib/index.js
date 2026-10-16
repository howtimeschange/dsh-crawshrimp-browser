import z from '@deepseek-ai/schemastery'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { readFile, stat } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { nativeFullAccess } from './permissions.js'
import { loadBundledSkill } from './skill.js'
import { createScriptToolDefinitions, SCRIPT_TOOL_NAMES } from './scripts/index.js'
import { ScriptsRuntime } from './scripts/runtime.js'
import { PreviewManager } from './preview/manager.js'
import { installPreviewTransport } from './preview/transport.js'

/**
 * The browser plugin is deliberately self contained. It owns one Playwright
 * BrowserContext per DSH session and never discovers or adopts a pre-existing
 * page. A CDP endpoint is an optional browser transport; pages are still
 * created in a fresh context owned by this plugin.
 */

export const name = 'crawshrimp-browser'
export const inject = ['tools']

export const Config = z.object({
  executablePath: z.string().default(''),
  channel: z.union(['chrome', 'chromium']).default('chrome'),
  headless: z.boolean().default(true),
  cdpEndpoint: z.string().default(''),
  navigationTimeoutMs: z.number().min(1000).max(120000).default(30000),
  actionTimeoutMs: z.number().min(500).max(60000).default(10000),
  maxPagesPerSession: z.number().min(1).max(32).default(8),
  maxTextChars: z.number().min(1000).max(100000).default(16000),
  maxElements: z.number().min(1).max(200).default(80),
  maxScreenshotBytes: z.number().min(100000).max(20000000).default(8000000),
  storageStatePath: z.string().default(''),
  adapterRoots: z.array(z.string()).default([]),
  workspaceDir: z.string().default('~/.dsh-crawshrimp-browser'),
  maxPages: z.number().min(1).max(100).default(1),
  scriptTimeoutMs: z.number().min(1000).max(1800000).default(120000),
  maxScriptBytes: z.number().min(1024).max(4 * 1024 * 1024).default(512 * 1024),
  maxOutputBytes: z.number().min(1024).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
  previewEnabled: z.boolean().default(true),
})

const ACTION_TOOLS = new Set([
  'crawshrimp_browser_open',
  'crawshrimp_browser_navigate',
  'crawshrimp_browser_click',
  'crawshrimp_browser_fill',
  'crawshrimp_browser_select',
  'crawshrimp_browser_press',
  'crawshrimp_browser_close',
  SCRIPT_TOOL_NAMES.run,
])

const TOOL_NAMES = Object.freeze({
  open: 'crawshrimp_browser_open',
  pages: 'crawshrimp_browser_pages',
  navigate: 'crawshrimp_browser_navigate',
  observe: 'crawshrimp_browser_observe',
  click: 'crawshrimp_browser_click',
  fill: 'crawshrimp_browser_fill',
  select: 'crawshrimp_browser_select',
  press: 'crawshrimp_browser_press',
  wait: 'crawshrimp_browser_wait',
  screenshot: 'crawshrimp_browser_screenshot',
  close: 'crawshrimp_browser_close',
  scriptList: SCRIPT_TOOL_NAMES.list,
  scriptValidate: SCRIPT_TOOL_NAMES.validate,
  scriptRun: SCRIPT_TOOL_NAMES.run,
})

const DEFAULT_PAGE_VIEWPORT = { width: 1280, height: 900 }
const MAX_STORAGE_STATE_BYTES = 5 * 1024 * 1024
const MAX_WAIT_TEXT_CHARS = 5000
const MAX_KEY_LENGTH = 64

function asText(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function trimText(value, max) {
  const text = String(value ?? '')
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 32))}\n[… truncated by crawshrimp-browser …]`
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Browser operation cancelled')
    error.name = 'AbortError'
    throw error
  }
}

function jsonText(value) {
  return JSON.stringify(value, (_key, item) => (
    typeof item === 'bigint' ? Number(item) : item
  ))
}

function pageIdFor(counter) {
  return `crb-page-${counter.toString(36)}`
}

function sessionIdFor(counter) {
  return `crb-session-${counter.toString(36)}`
}

function validateHttpUrl(value, field = 'url') {
  const url = asText(value).trim()
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${field} must be a valid http:// or https:// URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${field} must use http:// or https://`)
  }
  return url
}

function validateKey(value) {
  const key = asText(value).trim()
  if (!key || key.length > MAX_KEY_LENGTH) {
    throw new Error(`key must be a non-empty shortcut of at most ${MAX_KEY_LENGTH} characters`)
  }
  // Playwright accepts a key or a `Modifier+Key` shortcut. Keep the accepted
  // grammar deliberately narrow so a malformed value cannot be interpreted as
  // multiple unrelated key sequences by a browser implementation.
  if (!/^[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*$/.test(key)) {
    throw new Error('key must use Playwright key names separated by + (for example Enter or Control+Enter)')
  }
  return key
}

async function readStorageState(pathname) {
  const path = asText(pathname).trim()
  if (!path) return undefined
  let info
  try {
    info = await stat(path)
  } catch (error) {
    throw new Error(`storageStatePath is not readable: ${error.message}`)
  }
  if (!info.isFile()) throw new Error('storageStatePath must point to a regular file')
  if (info.size > MAX_STORAGE_STATE_BYTES) {
    throw new Error(`storageStatePath exceeds ${MAX_STORAGE_STATE_BYTES} bytes`)
  }
  let source
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`storageStatePath is not readable: ${error.message}`)
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_STORAGE_STATE_BYTES) {
    throw new Error(`storageStatePath exceeds ${MAX_STORAGE_STATE_BYTES} bytes`)
  }
  try {
    const state = JSON.parse(source)
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('state must be a JSON object')
    }
    return state
  } catch {
    // JSON parser diagnostics can quote cookie/token content from a bad file.
    throw new Error('storageStatePath must contain a valid Playwright storage-state JSON object')
  }
}

function getSessionKey(agent) {
  if (agent?.session && (typeof agent.session === 'object' || typeof agent.session === 'function')) {
    return { object: agent.session }
  }
  const id = asText(agent?.id).trim()
  if (id) return { id }
  throw new Error('crawshrimp-browser requires a DSH agent session')
}

function configuredApproval(ctx) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get('approval', false)
  } catch {
    // An optional service lookup must fail closed below.
  }
  try {
    return ctx?.approval
  } catch {
    return undefined
  }
}

/**
 * Owns all browser state for one plugin fiber. It is exported to make the
 * resource and session boundaries testable without starting a full DSH host.
 */
export class BrowserManager {
  constructor(config, ctx = undefined, browserFactory = chromium, preview = undefined) {
    this.config = config
    this.ctx = ctx
    this.browserFactory = browserFactory
    this.browser = undefined
    this.browserPromise = undefined
    this.disposePromise = undefined
    this.disposed = false
    this.counter = 0
    this.pageCounter = 0
    this.sessions = new Set()
    this.objectSessions = new WeakMap()
    this.idSessions = new Map()
    this.pendingObjectSessions = new WeakMap()
    this.pendingIdSessions = new Map()
    this.pendingSessions = new Set()
    this.preview = preview
    this.previewObjectIds = new WeakMap()
    this.previewCounter = 0
  }

  previewSessionForKey(key) {
    if (key.id) return key.id
    if (typeof key.object?.id === 'string' && key.object.id) return key.object.id
    let id = this.previewObjectIds.get(key.object)
    if (!id) {
      id = `crb-preview-session-${++this.previewCounter}`
      this.previewObjectIds.set(key.object, id)
    }
    return id
  }

  previewSessionFor(agent) { return this.previewSessionForKey(getSessionKey(agent)) }

  async withPreviewAutomation(args, execution, operation) {
    if (!this.preview) return operation()
    const state = await this.existingSessionFor(execution?.agent, execution?.signal)
    if (!state) return operation()
    const record = this.pageFor(state, args?.pageId)
    return this.preview.withAutomation(state.ownerSessionId, record.id, operation)
  }

  async ensureBrowser(signal) {
    throwIfAborted(signal)
    if (this.disposed) throw new Error('crawshrimp-browser is disposed')
    if (this.browser) return this.browser
    if (this.browserPromise) return this.browserPromise
    const promise = (async () => {
      let browser
      try {
        if (this.config.cdpEndpoint.trim()) {
          browser = await this.browserFactory.connectOverCDP(this.config.cdpEndpoint.trim())
        } else {
          const launch = { headless: this.config.headless }
          if (this.config.executablePath.trim()) launch.executablePath = this.config.executablePath.trim()
          else if (this.config.channel) launch.channel = this.config.channel
          browser = await this.browserFactory.launch(launch)
        }
        throwIfAborted(signal)
        if (this.disposed) throw new Error('crawshrimp-browser is disposed')
        this.browser = browser
        return browser
      } catch (error) {
        if (browser) {
          try { await browser.close() } catch {}
        }
        throw error
      }
    })()
    this.browserPromise = promise
    promise.finally(() => {
      if (this.browserPromise === promise) this.browserPromise = undefined
    }).catch(() => {})
    return promise
  }

  async createIsolatedContext(signal) {
    const browser = await this.ensureBrowser(signal)
    throwIfAborted(signal)
    if (this.disposed) throw new Error('crawshrimp-browser is disposed')
    let context
    try {
      const storageState = await readStorageState(this.config.storageStatePath)
      throwIfAborted(signal)
      const options = { viewport: DEFAULT_PAGE_VIEWPORT }
      if (storageState) options.storageState = storageState
      context = await browser.newContext(options)
      context.setDefaultTimeout(this.config.actionTimeoutMs)
      context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs)
      throwIfAborted(signal)
      if (this.disposed) throw new Error('crawshrimp-browser is disposed')
      return context
    } catch (error) {
      if (context) {
        try { await context.close() } catch {}
      }
      throw error
    }
  }

  sessionFrom(key) {
    if (key.object) return this.objectSessions.get(key.object)
    return this.idSessions.get(key.id)
  }

  pendingFrom(key) {
    if (key.object) return this.pendingObjectSessions.get(key.object)
    return this.pendingIdSessions.get(key.id)
  }

  async existingSessionFor(agent, signal) {
    if (this.disposed) throw new Error('crawshrimp-browser is disposed')
    const key = getSessionKey(agent)
    let state = this.sessionFrom(key)
    if (state?.closed) {
      this.clearSession(key, state)
      state = undefined
    }
    if (!state) {
      const pending = this.pendingFrom(key)
      if (pending) state = await pending
    }
    throwIfAborted(signal)
    return state
  }

  setPending(key, value) {
    if (key.object) this.pendingObjectSessions.set(key.object, value)
    else this.pendingIdSessions.set(key.id, value)
  }

  clearPending(key) {
    if (key.object) this.pendingObjectSessions.delete(key.object)
    else this.pendingIdSessions.delete(key.id)
  }

  setSession(key, value) {
    if (key.object) this.objectSessions.set(key.object, value)
    else this.idSessions.set(key.id, value)
  }

  clearSession(key, state) {
    if (key.object) {
      if (this.objectSessions.get(key.object) === state) this.objectSessions.delete(key.object)
    } else if (this.idSessions.get(key.id) === state) {
      this.idSessions.delete(key.id)
    }
  }

  async createSession(key, signal) {
    const browser = await this.ensureBrowser(signal)
    throwIfAborted(signal)
    if (this.disposed) throw new Error('crawshrimp-browser is disposed')
    // Do not inspect browser.contexts() or pages: a context created here is
    // the only context this plugin can ever use.
    let context
    try {
      const storageState = await readStorageState(this.config.storageStatePath)
      throwIfAborted(signal)
      const options = { viewport: DEFAULT_PAGE_VIEWPORT }
      if (storageState) options.storageState = storageState
      context = await browser.newContext(options)
      throwIfAborted(signal)
      if (this.disposed) throw new Error('crawshrimp-browser is disposed')
      context.setDefaultTimeout(this.config.actionTimeoutMs)
      context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs)
      const state = {
        id: sessionIdFor(++this.counter),
        ownerSessionId: this.previewSessionForKey(key),
        key,
        context,
        pages: new Map(),
        openingPages: 0,
        observationCounter: 0,
        closed: false,
      }
      this.sessions.add(state)
      return state
    } catch (error) {
      if (context) {
        try { await context.close() } catch {}
      }
      throw error
    }
  }

  async sessionFor(agent, signal) {
    const key = getSessionKey(agent)
    let state = this.sessionFrom(key)
    if (state && !state.closed) {
      if (signal?.aborted) await this.closeSession(state)
      throwIfAborted(signal)
      return state
    }
    if (state?.closed) this.clearSession(key, state)
    const pending = this.pendingFrom(key)
    if (pending) {
      const created = await pending
      throwIfAborted(signal)
      return created
    }
    const create = this.createSession(key, signal)
      .then(async (created) => {
        this.clearPending(key)
        this.setSession(key, created)
        if (signal?.aborted) {
          await this.closeSession(created)
          throwIfAborted(signal)
        }
        return created
      })
      .catch((error) => {
        this.clearPending(key)
        throw error
      })
    this.setPending(key, create)
    this.pendingSessions.add(create)
    create.finally(() => this.pendingSessions.delete(create)).catch(() => {})
    return create
  }

  async closeSession(state) {
    if (!state || state.closed) return
    state.closed = true
    const records = [...state.pages.values()]
    for (const record of records) record.closed = true
    state.pages.clear()
    await Promise.allSettled(records.map(record => record.unregisterPreview?.()))
    try {
      await state.context.close()
    } catch {
      // Browser teardown is best effort; the caller must still observe the
      // original cancellation or operation error.
    }
    this.clearSession(state.key, state)
    this.sessions.delete(state)
  }

  async withCancellation(state, page, signal, operation) {
    throwIfAborted(signal)
    if (!signal) return operation()
    let abort
    const aborted = new Promise((_, reject) => {
      abort = async () => {
        try {
          await this.closeSession(state)
        } finally {
          const error = new Error('Browser operation cancelled')
          error.name = 'AbortError'
          reject(error)
        }
      }
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      return await Promise.race([Promise.resolve().then(operation), aborted])
    } finally {
      signal.removeEventListener('abort', abort)
      // Keep the page argument in the signature to make the ownership intent
      // explicit at every call site; closeSession owns page closure as well.
      void page
    }
  }

  pageFor(state, pageId, { allowSingle = true } = {}) {
    if (state.closed) throw new Error('DSH session browser context is closed')
    const requested = asText(pageId).trim()
    if (requested) {
      const record = state.pages.get(requested)
      if (!record || record.closed) throw new Error(`Unknown owned page: ${requested}`)
      return record
    }
    if (allowSingle && state.pages.size === 1) return state.pages.values().next().value
    if (!state.pages.size) throw new Error('No owned browser page; call crawshrimp_browser_open first')
    throw new Error('pageId is required when the DSH session owns multiple pages')
  }

  async ownedPageMetadata(record) {
    if (record.closed || (typeof record.page.isClosed === 'function' && record.page.isClosed())) {
      record.closed = true
      if (record.state.pages.get(record.id) === record) record.state.pages.delete(record.id)
      return undefined
    }
    let title = ''
    try { title = await record.page.title() } catch {}
    return {
      pageId: record.id,
      url: record.page.url(),
      title,
    }
  }

  async pages(_args, execution) {
    const signal = execution?.signal
    const state = await this.existingSessionFor(execution?.agent, signal)
    if (!state) return { pages: [] }
    const pages = await this.withCancellation(state, undefined, signal, async () => {
      const result = []
      for (const record of [...state.pages.values()]) {
        const metadata = await this.ownedPageMetadata(record)
        if (metadata) result.push(metadata)
      }
      return result
    })
    return { sessionId: state.id, pages }
  }

  registerOwnedPage(state, page) {
    const existing = [...state.pages.values()].find(record => record.page === page)
    if (existing) return existing
    if (state.closed || state.pages.size >= this.config.maxPagesPerSession) throw new Error('The DSH session browser page limit was reached')
    const record = { id: pageIdFor(++this.pageCounter), page, state, closed: false, observation: undefined }
    state.pages.set(record.id, record)
    record.unregisterPreview = this.preview?.registerPage({ sessionId: state.ownerSessionId, pageId: record.id, page, kind: 'interactive' })
    if (typeof page.on === 'function') {
      page.on('close', () => {
        record.closed = true
        if (state.pages.get(record.id) === record) state.pages.delete(record.id)
        void Promise.resolve(record.unregisterPreview?.()).catch(() => {})
      })
      // A popup inherits this plugin-owned context. Register only popups from
      // an already owned page; never discover pages from an external browser.
      page.on('popup', popup => {
        try { this.registerOwnedPage(state, popup) }
        catch { void popup.close().catch(() => {}) }
      })
    }
    return record
  }

  async open(args, execution) {
    const signal = execution?.signal
    const state = await this.sessionFor(execution?.agent, signal)
    throwIfAborted(signal)
    if (state.pages.size + state.openingPages >= this.config.maxPagesPerSession) {
      throw new Error(`The DSH session already owns ${this.config.maxPagesPerSession} pages`)
    }
    const url = validateHttpUrl(args?.url)
    state.openingPages += 1
    let page
    let record
    try {
      page = await this.withCancellation(state, undefined, signal, () => state.context.newPage())
      throwIfAborted(signal)
      record = this.registerOwnedPage(state, page)
      const id = record.id
      const navigate = () => this.withCancellation(state, page, signal, () => page.goto(url, { waitUntil: 'domcontentloaded' }))
      if (this.preview) await this.preview.withAutomation(state.ownerSessionId, id, navigate)
      else await navigate()
      throwIfAborted(signal)
      return {
        pageId: id,
        url: page.url(),
        title: await page.title(),
        sessionId: state.id,
      }
    } catch (error) {
      if (record) {
        await record.unregisterPreview?.()
        state.pages.delete(record.id)
        record.closed = true
      }
      if (page) {
        try { await page.close() } catch {}
      }
      throw error
    } finally {
      state.openingPages -= 1
    }
  }

  async navigate(args, execution) {
    const signal = execution?.signal
    const state = await this.sessionFor(execution?.agent, signal)
    const record = this.pageFor(state, args?.pageId)
    const url = validateHttpUrl(args?.url)
    await this.withCancellation(state, record.page, signal, () => record.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: this.config.navigationTimeoutMs,
    }))
    throwIfAborted(signal)
    return {
      pageId: record.id,
      url: record.page.url(),
      title: await record.page.title(),
    }
  }

  async observe(args, execution) {
    const signal = execution?.signal
    const state = await this.sessionFor(execution?.agent, signal)
    const record = this.pageFor(state, args?.pageId)
    const prefix = `crb-ref-${state.id}-${++state.observationCounter}`
    const result = await this.withCancellation(state, record.page, signal, async () => {
      const text = await record.page.locator('body').innerText({ timeout: this.config.actionTimeoutMs })
      const observed = await record.page.evaluate(({ max, refPrefix }) => {
        for (const previous of document.querySelectorAll('[data-crawshrimp-ref]')) {
          previous.removeAttribute('data-crawshrimp-ref')
        }
        const candidates = [...document.querySelectorAll(
          'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]',
        )]
        const rows = []
        for (let index = 0; index < candidates.length && rows.length < max; index += 1) {
          const element = candidates[index]
          if (!(element instanceof HTMLElement)) continue
          const ref = `${refPrefix}-${rows.length + 1}`
          element.setAttribute('data-crawshrimp-ref', ref)
          const label = element.getAttribute('aria-label') || element.getAttribute('name') || ''
          rows.push({
            ref,
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute('role') || '',
            text: (element.innerText || element.textContent || '').trim().slice(0, 240),
            label: label.slice(0, 240),
            type: element.getAttribute('type') || '',
            placeholder: (element.getAttribute('placeholder') || '').slice(0, 240),
            disabled: Boolean(element.disabled),
          })
        }
        return { rows, refs: rows.map((row) => row.ref) }
      }, { max: this.config.maxElements, refPrefix: prefix })
      record.observation = { prefix, refs: new Set(observed.refs) }
      return {
        pageId: record.id,
        url: record.page.url(),
        title: await record.page.title(),
        text: trimText(text, this.config.maxTextChars),
        actionableElements: observed.rows,
      }
    })
    return result
  }

  async locatorFor(record, args) {
    const ref = asText(args?.ref).trim()
    const selector = asText(args?.selector).trim()
    if (!ref && !selector) throw new Error('ref or selector is required; observe the page first when possible')
    if (ref) {
      if (!/^crb-ref-[A-Za-z0-9_-]+$/.test(ref)) throw new Error('ref is not an owned observation reference')
      if (!record.observation?.refs.has(ref)) {
        throw new Error(`Stale or unknown observation ref: ${ref}; call crawshrimp_browser_observe again`)
      }
      const locator = record.page.locator(`[data-crawshrimp-ref="${ref}"]`)
      const count = await locator.count()
      if (count !== 1) {
        throw new Error(`Stale observation ref: ${ref}; call crawshrimp_browser_observe again`)
      }
      return locator
    }
    if (selector.length > 1000) throw new Error('selector is too long')
    return record.page.locator(selector).first()
  }

  async click(args, execution) {
    const signal = execution?.signal
    const state = await this.sessionFor(execution?.agent, signal)
    const record = this.pageFor(state, args?.pageId)
    const locator = await this.locatorFor(record, args)
    await this.withCancellation(state, record.page, signal, () => locator.click({ timeout: this.config.actionTimeoutMs }))
    throwIfAborted(signal)
    return { pageId: record.id, clicked: true, url: record.page.url() }
  }

  async fill(args, execution) {
    const signal = execution?.signal
    const state = await this.sessionFor(execution?.agent, signal)
    const record = this.pageFor(state, args?.pageId)
    const value = asText(args?.value)
    if (value.length > 10000) throw new Error('value is too long')
    const locator = await this.locatorFor(record, args)
    await this.withCancellation(state, record.page, signal, () => locator.fill(value, { timeout: this.config.actionTimeoutMs }))
    throwIfAborted(signal)
    return { pageId: record.id, filled: true, url: record.page.url() }
  }

  async select(args, execution) {
    const signal = execution?.signal
    const state = await this.sessionFor(execution?.agent, signal)
    const record = this.pageFor(state, args?.pageId)
    if (typeof args?.value !== 'string') throw new Error('value is required for browser_select')
    if (args.value.length > 1000) throw new Error('value is too long')
    const locator = await this.locatorFor(record, args)
    const selectedValues = await this.withCancellation(state, record.page, signal, () => locator.selectOption(
      { value: args.value },
      { timeout: this.config.actionTimeoutMs },
    ))
    throwIfAborted(signal)
    return { pageId: record.id, selected: selectedValues, url: record.page.url() }
  }

  async press(args, execution) {
    const signal = execution?.signal
    const state = await this.sessionFor(execution?.agent, signal)
    const record = this.pageFor(state, args?.pageId)
    const key = validateKey(args?.key)
    const hasTarget = Boolean(asText(args?.ref).trim() || asText(args?.selector).trim())
    if (hasTarget) {
      const locator = await this.locatorFor(record, args)
      await this.withCancellation(state, record.page, signal, () => locator.press(key, { timeout: this.config.actionTimeoutMs }))
    } else {
      await this.withCancellation(state, record.page, signal, () => record.page.keyboard.press(key))
    }
    throwIfAborted(signal)
    return { pageId: record.id, pressed: key, url: record.page.url() }
  }

  async wait(args, execution) {
    const signal = execution?.signal
    const state = await this.existingSessionFor(execution?.agent, signal)
    if (!state) throw new Error('No existing DSH browser session; call crawshrimp_browser_open first')
    const record = this.pageFor(state, args?.pageId)
    const selector = asText(args?.selector).trim()
    const text = asText(args?.text)
    if (selector && text) throw new Error('selector and text are mutually exclusive')
    if (!selector && !text) throw new Error('selector or text is required')
    if (selector.length > 1000) throw new Error('selector is too long')
    if (text.length > MAX_WAIT_TEXT_CHARS) throw new Error(`text is too long; maximum is ${MAX_WAIT_TEXT_CHARS} characters`)
    const stateValue = args?.state === undefined ? 'visible' : args.state
    if (stateValue !== 'visible' && stateValue !== 'hidden') throw new Error('state must be visible or hidden')
    const timeoutValue = args?.timeoutMs === undefined ? this.config.actionTimeoutMs : Number(args.timeoutMs)
    if (!Number.isSafeInteger(timeoutValue) || timeoutValue < 100 || timeoutValue > 60000) {
      throw new Error('timeoutMs must be an integer from 100 to 60000')
    }
    const locator = selector
      ? record.page.locator(selector).first()
      : record.page.getByText(text, { exact: false }).first()
    await this.withCancellation(state, record.page, signal, () => locator.waitFor({ state: stateValue, timeout: timeoutValue }))
    throwIfAborted(signal)
    return {
      pageId: record.id,
      matched: true,
      state: stateValue,
      ...(selector ? { selector } : { text }),
    }
  }

  async screenshot(args, execution) {
    const signal = execution?.signal
    const state = await this.sessionFor(execution?.agent, signal)
    const record = this.pageFor(state, args?.pageId)
    const image = await this.withCancellation(state, record.page, signal, () => record.page.screenshot({
      type: 'png',
      fullPage: Boolean(args?.fullPage),
      animations: 'disabled',
      timeout: this.config.actionTimeoutMs,
    }))
    throwIfAborted(signal)
    if (image.byteLength > this.config.maxScreenshotBytes) {
      throw new Error(`screenshot exceeds ${this.config.maxScreenshotBytes} bytes`)
    }
    return {
      pageId: record.id,
      url: record.page.url(),
      title: await record.page.title(),
      mimeType: 'image/png',
      data: image.toString('base64'),
      bytes: image.byteLength,
    }
  }

  async close(args, execution) {
    const signal = execution?.signal
    const state = await this.sessionFor(execution?.agent, signal)
    const record = this.pageFor(state, args?.pageId, { allowSingle: false })
    await this.withCancellation(state, record.page, signal, () => record.page.close())
    record.closed = true
    state.pages.delete(record.id)
    return { pageId: record.id, closed: true, remainingPages: state.pages.size }
  }

  async dispose() {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.disposePromise = (async () => {
      // A session may still be creating its browser context. Wait for all
      // in-flight setup before closing the resources that did get registered.
      while (this.pendingSessions.size || this.browserPromise) {
        const pending = [
          ...this.pendingSessions,
          ...(this.browserPromise ? [this.browserPromise] : []),
        ]
        await Promise.allSettled(pending)
      }
      const states = [...this.sessions]
      await Promise.all(states.map((state) => this.closeSession(state)))
      if (this.browser) {
        try {
          await this.browser.close()
        } catch {
          // Browser teardown is best effort; a disposed external CDP
          // connection is not ours to terminate.
        }
      }
      this.browser = undefined
      this.browserPromise = undefined
      this.sessions.clear()
    })()
    return this.disposePromise
  }
}

function mcpResult(value) {
  if (value && value.mimeType === 'image/png' && typeof value.data === 'string') {
    const { mimeType, data, ...metadata } = value
    return {
      content: [
        { type: 'image', mimeType, data },
        { type: 'text', text: jsonText(metadata) },
      ],
      structuredContent: metadata,
    }
  }
  return {
    content: [{ type: 'text', text: jsonText(value) }],
    structuredContent: value,
  }
}

const SCHEMAS = Object.freeze({
  open: {
    type: 'object',
    properties: { url: { type: 'string', description: 'An http(s) URL to open in a new owned page.' } },
    required: ['url'],
    additionalProperties: false,
  },
  pages: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  page: {
    type: 'object',
    properties: { pageId: { type: 'string', description: 'Owned page id returned by browser_open.' } },
    additionalProperties: false,
  },
  navigate: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Owned page id returned by browser_open.' },
      url: { type: 'string', description: 'An http(s) URL to load in the owned page.' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  target: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Owned page id returned by browser_open.' },
      ref: { type: 'string', description: 'Reference returned by browser_observe.' },
      selector: { type: 'string', description: 'Optional CSS selector for the owned page.' },
    },
    additionalProperties: false,
  },
  fill: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Owned page id returned by browser_open.' },
      ref: { type: 'string', description: 'Reference returned by browser_observe.' },
      selector: { type: 'string', description: 'Optional CSS selector for the owned page.' },
      value: { type: 'string', description: 'Text to fill into the owned page.' },
    },
    required: ['value'],
    additionalProperties: false,
  },
  select: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Owned page id returned by browser_open.' },
      ref: { type: 'string', description: 'Reference returned by browser_observe.' },
      selector: { type: 'string', description: 'Optional CSS selector for the owned page.' },
      value: { type: 'string', description: 'The option value to select.' },
    },
    required: ['value'],
    additionalProperties: false,
  },
  press: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Owned page id returned by browser_open.' },
      ref: { type: 'string', description: 'Optional reference returned by browser_observe.' },
      selector: { type: 'string', description: 'Optional CSS selector for the owned page.' },
      key: { type: 'string', description: 'Playwright key name or + separated shortcut.' },
    },
    required: ['key'],
    additionalProperties: false,
  },
  wait: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Owned page id returned by browser_open.' },
      selector: { type: 'string', description: 'CSS selector whose visibility should change.' },
      text: { type: 'string', description: 'Bounded text to wait for on the owned page.' },
      state: { type: 'string', enum: ['visible', 'hidden'], description: 'The target state; defaults to visible.' },
      timeoutMs: { type: 'integer', minimum: 100, maximum: 60000, description: 'Wait timeout in milliseconds.' },
    },
    additionalProperties: false,
  },
  screenshot: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Owned page id returned by browser_open.' },
      fullPage: { type: 'boolean', description: 'Capture the complete page when true.' },
    },
    additionalProperties: false,
  },
  close: {
    type: 'object',
    properties: { pageId: { type: 'string', description: 'Owned page id returned by browser_open.' } },
    required: ['pageId'],
    additionalProperties: false,
  },
})

function toolDefinition(ctx, manager, nameValue, description, inputSchema, method) {
  return createMcpToolDefinition(ctx, {
    name: nameValue,
    rawName: nameValue,
    description,
    inputSchema,
    call: async (args, execution) => {
      const run = () => method.call(manager, args, execution)
      return mcpResult(await (ACTION_TOOLS.has(nameValue) && nameValue !== TOOL_NAMES.open
        ? manager.withPreviewAutomation(args, execution, run) : run()))
    },
  })
}

export function createToolDefinitions(ctx, manager, scriptsRuntime = undefined) {
  const definitions = [
    toolDefinition(ctx, manager, TOOL_NAMES.open, 'Open a URL in a new browser page owned by this DSH session.', SCHEMAS.open, manager.open),
    toolDefinition(ctx, manager, TOOL_NAMES.pages, 'List only the browser pages owned by this DSH session.', SCHEMAS.pages, manager.pages),
    toolDefinition(ctx, manager, TOOL_NAMES.navigate, 'Navigate an owned browser page to an http(s) URL.', SCHEMAS.navigate, manager.navigate),
    toolDefinition(ctx, manager, TOOL_NAMES.observe, 'Read bounded page text and actionable elements from an owned browser page.', SCHEMAS.page, manager.observe),
    toolDefinition(ctx, manager, TOOL_NAMES.click, 'Click one observed or explicitly selected element on an owned browser page.', SCHEMAS.target, manager.click),
    toolDefinition(ctx, manager, TOOL_NAMES.fill, 'Fill text into one observed or explicitly selected element on an owned browser page.', SCHEMAS.fill, manager.fill),
    toolDefinition(ctx, manager, TOOL_NAMES.select, 'Select an option by value in an owned browser page.', SCHEMAS.select, manager.select),
    toolDefinition(ctx, manager, TOOL_NAMES.press, 'Press a key or shortcut on an owned browser page.', SCHEMAS.press, manager.press),
    toolDefinition(ctx, manager, TOOL_NAMES.wait, 'Wait for owned page selector visibility or bounded text without an approval prompt.', SCHEMAS.wait, manager.wait),
    toolDefinition(ctx, manager, TOOL_NAMES.screenshot, 'Capture an owned page as a bounded PNG image without a write approval prompt.', SCHEMAS.screenshot, manager.screenshot),
    toolDefinition(ctx, manager, TOOL_NAMES.close, 'Close one browser page owned by this DSH session.', SCHEMAS.close, manager.close),
  ]
  if (scriptsRuntime) definitions.push(...createScriptToolDefinitions(ctx, scriptsRuntime))
  return definitions
}

function approvalReason(nameValue) {
  switch (nameValue) {
    case TOOL_NAMES.open: return 'Open a new browser page and navigate it to the requested URL.'
    case TOOL_NAMES.navigate: return 'Navigate an owned browser page to the requested URL.'
    case TOOL_NAMES.click: return 'Click an element in an owned browser page.'
    case TOOL_NAMES.fill: return 'Enter text into an element in an owned browser page.'
    case TOOL_NAMES.select: return 'Select an option in an owned browser page.'
    case TOOL_NAMES.press: return 'Press a key or shortcut in an owned browser page.'
    case TOOL_NAMES.close: return 'Close an owned browser page.'
    case TOOL_NAMES.scriptRun: return 'Run a portable Crawshrimp page script in a new isolated browser context.'
    default: return 'Perform a browser action in an owned DSH page.'
  }
}

function installApprovalGate(ctx) {
  if (typeof ctx?.on !== 'function') return () => {}
  const handler = async (execution, next) => {
    if (!ACTION_TOOLS.has(execution?.name)) return next()
    const approval = configuredApproval(ctx)
    if (!approval || typeof approval.request !== 'function') {
      return { kind: 'deny', reason: 'Browser action denied: no native DSH approval service is composed.' }
    }
    if (!execution.agent) {
      return { kind: 'deny', reason: 'Browser action denied: the call has no DSH agent/session for approval routing.' }
    }
    if (execution.signal?.aborted) return { kind: 'cancel' }
    if (nativeFullAccess(ctx, execution.agent)) return next()
    let outcome
    try {
      outcome = await approval.request({
        agent: execution.agent,
        toolName: execution.name,
        callId: execution.callId,
        reason: approvalReason(execution.name),
        arguments: execution.arguments,
        signal: execution.signal,
      })
    } catch {
      return { kind: 'deny', reason: 'Browser action denied: native DSH approval failed closed.' }
    }
    if (outcome === 'allowed-once') return next()
    if (outcome === 'cancelled') return { kind: 'cancel' }
    if (outcome === 'rejected') return { kind: 'deny', reason: 'Browser action rejected by the user.' }
    return { kind: 'deny', reason: 'Browser action denied: native DSH approval is unavailable.' }
  }
  return ctx.on('tools/pre-execute', handler, { prepend: true }) || (() => {})
}

export function apply(ctx, rawConfig = {}) {
  const config = Config(rawConfig)
  const preview = config.previewEnabled ? new PreviewManager() : undefined
  const manager = new BrowserManager(config, ctx, chromium, preview)
  const scriptsRuntime = new ScriptsRuntime(ctx, config, manager)
  const definitions = createToolDefinitions(ctx, manager, scriptsRuntime)
  const disposers = definitions.map((definition) => ctx.tools.register(definition))
  const removeApprovalGate = installApprovalGate(ctx)
  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], scope => {
      scope.skills.register(loadBundledSkill())
    })
  }
  if (preview && typeof ctx.inject === 'function') {
    ctx.inject(['connection', 'webServer'], scope => {
      const dispose = installPreviewTransport(scope, preview)
      scope.effect(() => dispose, 'crawshrimp-browser preview transport')
    })
  }
  ctx.effect(() => async () => {
    try { removeApprovalGate() } catch {}
    await scriptsRuntime.dispose()
    await preview?.dispose()
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
    await manager.dispose()
  }, 'crawshrimp-browser resources')
}

export { ACTION_TOOLS, TOOL_NAMES }
