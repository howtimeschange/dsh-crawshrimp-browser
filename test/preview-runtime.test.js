import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { EventEmitter } from 'node:events'
import { PreviewManager } from '../lib/preview/manager.js'
import { createBrowserInputSession, inputCommand } from '../lib/preview/input.js'

const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate))

let browser

before(async () => {
  if (!chromePath) return
  browser = await chromium.launch({ executablePath: chromePath, headless: true })
})

after(async () => {
  await browser?.close()
})

function pageSkip() {
  return chromePath ? {} : { skip: 'Chrome executable is not available in this environment' }
}

test('navigation rejects stale titles and bounds page metadata before transport', async () => {
  const page = new EventEmitter()
  let resolveOldTitle
  let titleCalls = 0
  page.url = () => `https://example.test/${'x'.repeat(8000)}`
  page.title = () => ++titleCalls === 1
    ? new Promise((resolve) => { resolveOldTitle = resolve })
    : Promise.resolve('New title ' + 'x'.repeat(2000))
  const preview = new PreviewManager()
  const unregister = preview.registerPage({ sessionId: 's', pageId: 'p', page })
  assert.equal(preview.list('s')[0].url.length, 4096)
  page.emit('framenavigated', { parentFrame: () => null, url: () => `https://new.test/${'y'.repeat(8000)}` })
  await Promise.resolve()
  assert.equal(preview.list('s')[0].title.length, 512)
  assert.ok(preview.list('s')[0].title.startsWith('New title'))
  resolveOldTitle('Old title')
  await Promise.resolve()
  assert.ok(preview.list('s')[0].title.startsWith('New title'))
  assert.equal(preview.list('s')[0].url.length, 4096)
  assert.ok(preview.list('s')[0].url.startsWith('https://new.test/'))
  await unregister()
  await preview.dispose()
})

function waitForFrame(events, timeoutMs = 5000) {
  const existing = events.find((event) => event.type === 'frame')
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preview frame timeout')), timeoutMs)
    const check = () => {
      const frame = events.find((event) => event.type === 'frame')
      if (!frame) return
      clearTimeout(timer)
      resolve(frame)
    }
    const interval = setInterval(() => {
      try { check() } catch (error) { clearInterval(interval); reject(error) }
      if (events.some((event) => event.type === 'frame')) clearInterval(interval)
    }, 10)
  })
}

test('input schema is restricted and release compensates a timed out command', async () => {
  assert.deepEqual(
    inputCommand({ kind: 'text', text: '中文输入' }, { width: 100, height: 80 }),
    ['Input.insertText', { text: '中文输入' }],
  )
  assert.throws(() => inputCommand({ kind: 'mouse', type: 'mouseMoved', x: 100, y: 0 }, { width: 100, height: 80 }), /坐标/)
  assert.throws(() => inputCommand({ kind: 'key', type: 'rawKeyDown', key: 'A', code: 'KeyA', command: 'paste' }), /编辑命令/)

  const calls = []
  let first = true
  const session = createBrowserInputSession(async (method, params) => {
    calls.push([method, params])
    if (first && params.type === 'mousePressed') {
      first = false
      throw new Error('simulated timeout')
    }
  }, () => true, { width: 100, height: 80 })
  const pressed = await session.dispatch({ kind: 'mouse', type: 'mousePressed', x: 1, y: 2, button: 'left' })
  assert.equal(pressed.ok, false)
  await session.dispose()
  assert.equal(calls.at(-1)[0], 'Input.dispatchMouseEvent')
  assert.equal(calls.at(-1)[1].type, 'mouseReleased')
})

test('real CDP preview streams frames, ACKs every frame, and sends Chinese text and wheel input', pageSkip(), async () => {
  const context = await browser.newContext({ viewport: { width: 360, height: 240 } })
  const page = await context.newPage()
  await page.setContent(`<!doctype html><title>Preview fixture</title>
    <input id="editor" autofocus>
    <div id="scroll" style="height:100px;overflow:auto"><div style="height:1800px;background:linear-gradient(#fff,#cdf)"></div></div>`)
  const cdpCalls = []
  const newCDPSession = context.newCDPSession.bind(context)
  context.newCDPSession = async (...args) => {
    const cdp = await newCDPSession(...args)
    const send = cdp.send.bind(cdp)
    cdp.send = (method, params) => {
      cdpCalls.push([method, params])
      return send(method, params)
    }
    return cdp
  }
  const manager = new PreviewManager({ frameThrottleMs: 0, fallbackIntervalMs: 30 })
  const unregister = manager.registerPage({ sessionId: 'session-a', pageId: 'page-a', page })
  const events = []
  const unsubscribe = await manager.subscribe('session-a', 'page-a', (event) => events.push(event))
  const frame = await waitForFrame(events)
  assert.match(frame.dataUrl, /^data:image\/jpeg;base64,/)
  assert.ok(frame.width > 0)
  assert.ok(frame.height > 0)
  assert.ok(events.some((event) => event.type === 'status' && event.status === 'connected'))
  assert.ok(cdpCalls.some(([method]) => method === 'Page.screencastFrameAck'))

  // A second subscription shares the stream; the browser still produces the
  // same frames for both listeners, rather than opening another screencast.
  const secondEvents = []
  const secondUnsubscribe = await manager.subscribe('session-a', 'page-a', (event) => secondEvents.push(event))
  assert.equal(manager.records.get('session-a\u0000page-a').subscribers.size, 2)

  const claim = manager.claimControl('session-a', 'page-a', 'panel-a')
  assert.equal(claim.ok, true)
  await page.locator('#editor').focus()
  assert.deepEqual(await manager.input('session-a', 'page-a', 'panel-a', { kind: 'text', text: '中文商品' }), { ok: true })
  assert.equal(await page.locator('#editor').inputValue(), '中文商品')
  const wheelResult = await manager.input('session-a', 'page-a', 'panel-a', { kind: 'wheel', x: 12, y: 100, deltaX: 0, deltaY: 500 })
  assert.deepEqual(wheelResult, { ok: true })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(await page.locator('#scroll').evaluate((element) => element.scrollTop > 0))

  await secondUnsubscribe()
  assert.equal(manager.records.get('session-a\u0000page-a').subscribers.size, 1)
  assert.ok(manager.records.get('session-a\u0000page-a').cdp)
  await unsubscribe()
  assert.equal(manager.records.get('session-a\u0000page-a').cdp, undefined)
  await unregister()
  assert.deepEqual(manager.list('session-a'), [])
  await manager.dispose()
  await context.close()
})

test('page ownership, human control, automation busy state, and script read-only mode are isolated', pageSkip(), async () => {
  const context = await browser.newContext({ viewport: { width: 320, height: 200 } })
  const page = await context.newPage()
  const scriptPage = await context.newPage()
  await page.setContent('<title>interactive</title><button>go</button>')
  await scriptPage.setContent('<title>script</title><p>running</p>')
  const manager = new PreviewManager({ frameThrottleMs: 0 })
  const unregister = manager.registerPage({ sessionId: 's1', pageId: 'interactive', page })
  const unregisterScript = manager.registerPage({ sessionId: 's1', pageId: 'script', page: scriptPage, kind: 'script', runId: 'run-1' })
  assert.deepEqual(manager.list('other'), [])
  assert.equal(manager.list('s1').find((entry) => entry.pageId === 'script').runId, 'run-1')
  assert.throws(() => manager.claimControl('s1', 'script', 'owner'), /脚本页面/)

  const events = []
  const unsubscribe = await manager.subscribe('s1', 'interactive', (event) => events.push(event))
  manager.claimControl('s1', 'interactive', 'owner')
  await assert.rejects(() => manager.withAutomation('s1', 'interactive', async () => {}), /用户接管/)
  await manager.releaseControl('owner', 'interactive')
  let sawBusy = false
  const result = await manager.withAutomation('s1', 'interactive', async () => {
    sawBusy = manager.list('s1').find((entry) => entry.pageId === 'interactive').busy === 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return 'done'
  })
  assert.equal(result, 'done')
  assert.equal(sawBusy, true)
  assert.equal(manager.list('s1').find((entry) => entry.pageId === 'interactive').busy, 0)
  assert.ok(events.some((event) => event.type === 'status' && event.busy === 1))
  await manager.withAutomation('s1', 'script', async () => {
    assert.equal(manager.list('s1').find((entry) => entry.pageId === 'script').busy, 1)
  })
  await unsubscribe()
  await unregister()
  await unregisterScript()
  await manager.dispose()
  await context.close()
})

test('fallback screenshot stream emits frames and stops on the final unsubscribe', async () => {
  let frames = 0
  let screenshotCalls = 0
  const listeners = new Map()
  const fakePage = {
    url: () => 'https://fallback.test/',
    title: () => Promise.resolve('Fallback'),
    viewportSize: () => ({ width: 80, height: 60 }),
    on(name, listener) { listeners.set(name, listener) },
    screenshot: async () => { screenshotCalls += 1; return Buffer.from('jpeg') },
    context: () => ({ newCDPSession: async () => { throw new Error('CDP disabled') } }),
  }
  const manager = new PreviewManager({ fallbackIntervalMs: 10, frameThrottleMs: 0 })
  const unregister = manager.registerPage({ sessionId: 'fallback', pageId: 'page', page: fakePage })
  const unsubscribe = await manager.subscribe('fallback', 'page', (event) => { if (event.type === 'frame') frames += 1 })
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.ok(frames >= 1)
  assert.ok(screenshotCalls >= 1)
  await unsubscribe()
  const afterStop = screenshotCalls
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(screenshotCalls, afterStop)
  listeners.get('close')?.()
  await unregister()
  await manager.dispose()
})

test('control handoff invalidates queued old-owner input before the release barrier', async () => {
  let unblockPressed
  let pressedBlocked = true
  const calls = []
  const listeners = new Map()
  const cdp = {
    on(name, listener) { listeners.set(name, listener) },
    off() {},
    async send(method, params = {}) {
      calls.push([method, params])
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 100, clientHeight: 80 } }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' && pressedBlocked) {
        pressedBlocked = false
        return new Promise((resolve) => { unblockPressed = resolve })
      }
      return {}
    },
    async detach() {},
  }
  const page = {
    url: () => 'https://handoff.test/',
    title: () => Promise.resolve('Handoff'),
    viewportSize: () => ({ width: 100, height: 80 }),
    on(name, listener) { listeners.set(`page:${name}`, listener) },
    context: () => ({ newCDPSession: async () => cdp }),
    screenshot: async () => Buffer.from('jpeg'),
  }
  const manager = new PreviewManager({ frameThrottleMs: 0 })
  const unregister = manager.registerPage({ sessionId: 'handoff', pageId: 'page', page })
  const unsubscribe = await manager.subscribe('handoff', 'page', () => {})
  manager.claimControl('handoff', 'page', 'old-owner')
  const first = manager.input('handoff', 'page', 'old-owner', { kind: 'mouse', type: 'mousePressed', x: 1, y: 1, button: 'left' })
  await new Promise((resolve) => setImmediate(resolve))
  const second = manager.input('handoff', 'page', 'old-owner', { kind: 'mouse', type: 'mouseMoved', x: 2, y: 2 })
  const releasing = manager.releaseControl('old-owner', 'page')
  assert.throws(() => manager.claimControl('handoff', 'page', 'new-owner'), /释放控制/)
  await assert.rejects(
    () => manager.withAutomation('handoff', 'page', async () => {}),
    /用户接管|释放控制/,
  )
  assert.deepEqual(calls.filter(([method]) => method === 'Input.dispatchMouseEvent').map(([, params]) => params.type), ['mousePressed'])
  unblockPressed()
  assert.deepEqual(await first, { ok: true })
  assert.equal((await second).ok, false)
  await releasing
  manager.claimControl('handoff', 'page', 'new-owner')
  const third = manager.input('handoff', 'page', 'new-owner', { kind: 'mouse', type: 'mousePressed', x: 3, y: 3, button: 'left' })
  assert.deepEqual(await third, { ok: true })
  const mouseTypes = calls.filter(([method]) => method === 'Input.dispatchMouseEvent').map(([, params]) => params.type)
  assert.deepEqual(mouseTypes, ['mousePressed', 'mouseReleased', 'mousePressed'])
  await unsubscribe()
  await unregister()
  await manager.dispose()
})

test('CDP disconnect revokes the human lease before key compensation and falls back to screenshots', async () => {
  const cdpListeners = new Map()
  const pageListeners = new Map()
  const calls = []
  let resolveKeyUp
  let keyUpStartedResolve
  const keyUpStarted = new Promise((resolve) => { keyUpStartedResolve = resolve })
  const cdp = {
    on(name, listener) { cdpListeners.set(name, listener) },
    off() {},
    async send(method, params = {}) {
      calls.push([method, params])
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 100, clientHeight: 80 } }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') {
        keyUpStartedResolve()
        return new Promise((resolve) => { resolveKeyUp = resolve })
      }
      return {}
    },
    async detach() {},
  }
  let screenshotCalls = 0
  const page = {
    url: () => 'https://disconnect.test/',
    title: () => Promise.resolve('Disconnect'),
    viewportSize: () => ({ width: 100, height: 80 }),
    on(name, listener) { pageListeners.set(name, listener) },
    context: () => ({ newCDPSession: async () => cdp }),
    screenshot: async () => { screenshotCalls += 1; return Buffer.from('jpeg') },
  }
  const manager = new PreviewManager({ fallbackIntervalMs: 10, frameThrottleMs: 0 })
  const unregister = manager.registerPage({ sessionId: 'disconnect', pageId: 'page', page })
  const events = []
  let resolveDisconnected
  const disconnected = new Promise((resolve) => { resolveDisconnected = resolve })
  const unsubscribe = await manager.subscribe('disconnect', 'page', (event) => {
    events.push(event)
    if (event.type === 'status' && event.status === 'disconnected') {
      resolveDisconnected()
    }
  })
  manager.claimControl('disconnect', 'page', 'old-owner')
  assert.deepEqual(
    await manager.input('disconnect', 'page', 'old-owner', { kind: 'key', type: 'rawKeyDown', key: 'A', code: 'KeyA' }),
    { ok: true },
  )

  cdpListeners.get('close')?.()
  await keyUpStarted
  assert.equal(manager.list('disconnect')[0].control, 'free')
  assert.equal(manager.records.get('disconnect\u0000page').controlOwner, undefined)
  assert.throws(() => manager.claimControl('disconnect', 'page', 'new-owner'), /断开/)
  await assert.rejects(
    () => manager.input('disconnect', 'page', 'old-owner', { kind: 'text', text: 'stale' }),
    /未由该用户接管/,
  )
  assert.equal(await manager.withAutomation('disconnect', 'page', async () => 'agent-available'), 'agent-available')
  assert.ok(calls.some(([method, params]) => method === 'Input.dispatchKeyEvent' && params.type === 'keyUp'))

  resolveKeyUp()
  await disconnected
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(events.some((event) => event.type === 'status' && event.status === 'disconnected'))
  assert.equal(manager.records.get('disconnect\u0000page').cdp, undefined)
  assert.equal(manager.records.get('disconnect\u0000page').input, undefined)
  assert.ok(screenshotCalls >= 1)
  manager.claimControl('disconnect', 'page', 'new-owner')
  assert.deepEqual(
    await manager.input('disconnect', 'page', 'new-owner', { kind: 'text', text: 'after disconnect' }),
    { ok: false, error: '浏览器画面未连接，请重新打开' },
  )
  await manager.releaseControl('new-owner', 'page')
  await unsubscribe()
  await unregister()
  await manager.dispose()
})

test('page close and dispose share cleanup and wait for input release and CDP detach', async () => {
  const cdpListeners = new Map()
  const pageListeners = new Map()
  let resolveKeyUp
  let keyUpStartedResolve
  const keyUpStarted = new Promise((resolve) => { keyUpStartedResolve = resolve })
  let resolveDetach
  let detachStartedResolve
  const detachStarted = new Promise((resolve) => { detachStartedResolve = resolve })
  let detachCalls = 0
  const cdp = {
    on(name, listener) { cdpListeners.set(name, listener) },
    off(name) { cdpListeners.delete(name) },
    async send(method, params = {}) {
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 100, clientHeight: 80 } }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') {
        keyUpStartedResolve()
        return new Promise((resolve) => { resolveKeyUp = resolve })
      }
      return {}
    },
    async detach() {
      detachCalls += 1
      detachStartedResolve()
      return new Promise((resolve) => { resolveDetach = resolve })
    },
  }
  const page = {
    url: () => 'https://cleanup.test/',
    title: () => Promise.resolve('Cleanup'),
    viewportSize: () => ({ width: 100, height: 80 }),
    on(name, listener) { pageListeners.set(name, listener) },
    context: () => ({ newCDPSession: async () => cdp }),
    screenshot: async () => Buffer.from('jpeg'),
  }
  const manager = new PreviewManager({ frameThrottleMs: 0 })
  const unregister = manager.registerPage({ sessionId: 'cleanup', pageId: 'page', page })
  const unsubscribe = await manager.subscribe('cleanup', 'page', () => {})
  manager.claimControl('cleanup', 'page', 'owner')
  assert.deepEqual(
    await manager.input('cleanup', 'page', 'owner', { kind: 'key', type: 'rawKeyDown', key: 'A', code: 'KeyA' }),
    { ok: true },
  )

  pageListeners.get('close')?.()
  const unregisterAgain = unregister()
  let disposed = false
  const disposePromise = manager.dispose().then(() => { disposed = true })
  await keyUpStarted
  assert.equal(manager.records.has('cleanup\u0000page'), true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(disposed, false)
  assert.equal(detachCalls, 0)

  resolveKeyUp()
  await detachStarted
  assert.equal(disposed, false)
  assert.equal(manager.records.has('cleanup\u0000page'), true)
  resolveDetach()
  await Promise.all([unregisterAgain, disposePromise, unsubscribe()])
  assert.equal(detachCalls, 1)
  assert.equal(manager.records.has('cleanup\u0000page'), false)
  assert.deepEqual(manager.list('cleanup'), [])
  assert.equal(cdpListeners.has('close'), false)
})
