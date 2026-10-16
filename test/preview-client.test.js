import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const clientSource = readFileSync(clientPath, 'utf8')

function loadClient() {
  let declaration
  const sandbox = {
    clearInterval,
    clearTimeout,
    setInterval,
    setTimeout,
    window: {
      __ModuleLoader__: {
        load(value) {
          declaration = value
        },
      },
    },
  }
  vm.runInNewContext(clientSource, sandbox, { filename: clientPath })
  assert.equal(declaration?.id, 'dsh-crawshrimp-browser')
  const React = {
    createElement() {},
    useEffect() {},
    useRef() {},
    useState() {},
  }
  const client = declaration.factory((name) => {
    assert.equal(name, 'react')
    return React
  })
  return client
}

class FakeSocket {
  constructor() {
    this.readyState = 0
    this.listeners = new Map()
    this.sent = []
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || new Set()
    listeners.add(listener)
    this.listeners.set(name, listeners)
  }

  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener)
  }

  emit(name, event = {}) {
    for (const listener of this.listeners.get(name) || []) listener(event)
  }

  open() {
    this.readyState = 1
    this.emit('open')
  }

  send(value) {
    assert.equal(this.readyState, 1)
    this.sent.push(JSON.parse(value))
  }

  message(value) {
    this.emit('message', { data: JSON.stringify(value) })
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', { code, reason })
  }
}

test('preview client normalizes page metadata, script pages, and bounded frame payloads', () => {
  const { __test: preview } = loadClient()

  assert.equal(preview.normalizePage(null), null)
  assert.equal(preview.normalizePage({ title: 'missing id' }), null)
  assert.deepEqual(JSON.parse(JSON.stringify(preview.normalizePage({
    id: ' page-1 ',
    kind: 'interactive',
    runId: 'run-1',
    url: 'https://example.test/products',
    title: 'Products',
    status: 'connected',
    control: 'human',
    busy: 1,
  }))), {
    pageId: 'page-1',
    kind: 'interactive',
    runId: 'run-1',
    url: 'https://example.test/products',
    title: 'Products',
    status: 'connected',
    control: 'human',
    busy: true,
  })

  const pages = preview.normalizePages([
    { pageId: 'one', title: 'One' },
    { pageId: 'one', title: 'duplicate' },
    { pageId: 'two', kind: 'script-run' },
    null,
  ])
  assert.deepEqual(Array.from(pages, (page) => page.pageId), ['one', 'two'])
  assert.equal(preview.isScriptPage(pages[1]), true)
  assert.equal(preview.isScriptPage({ kind: 'interactive' }), false)

  const frame = preview.safeFrame({
    dataUrl: 'data:image/jpeg;base64,AA==',
    width: '320',
    height: 240,
    sequence: '7',
    ts: '42',
  })
  assert.deepEqual(JSON.parse(JSON.stringify(frame)), {
    dataUrl: 'data:image/jpeg;base64,AA==',
    width: 320,
    height: 240,
    sequence: 7,
    ts: 42,
  })
  assert.equal(preview.safeFrame({ dataUrl: 'data:image/svg+xml;base64,AA==', width: 10, height: 10 }), null)
  assert.equal(preview.safeFrame({ dataUrl: 'data:image/png;base64,AA==', width: 10001, height: 10 }), null)
})

test('preview client parses messages, maps contain coordinates, and encodes modifiers', () => {
  const { __test: preview } = loadClient()

  assert.deepEqual(JSON.parse(JSON.stringify(preview.parseMessage({ data: JSON.stringify({ type: 'frame', pageId: 'p1' }) }))), { type: 'frame', pageId: 'p1' })
  const inheritedMessageEvent = Object.create({
    get data() {
      return JSON.stringify({ type: 'status', pageId: 'p1', status: 'connected' })
    },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(preview.parseMessage(inheritedMessageEvent))), { type: 'status', pageId: 'p1', status: 'connected' })
  assert.deepEqual(JSON.parse(JSON.stringify(preview.parseMessage(JSON.stringify({ type: 'pages' })))), { type: 'pages' })
  assert.equal(preview.parseMessage({ data: '{bad json' }), null)
  assert.equal(preview.parseMessage({ data: JSON.stringify({ pageId: 'p1' }) }), null)

  const frame = { width: 100, height: 50 }
  const rect = { left: 10, top: 20, width: 200, height: 200 }
  assert.deepEqual(JSON.parse(JSON.stringify(preview.mapContainPoint(frame, rect, 110, 120))), { x: 50, y: 25 })
  assert.deepEqual(JSON.parse(JSON.stringify(preview.mapContainPoint(frame, rect, 110, 70))), { x: 50, y: 0 })
  assert.deepEqual(JSON.parse(JSON.stringify(preview.mapContainPoint(frame, { left: 10, top: 20, width: 200, height: 100 }, 209.9, 119.9))), { x: 99, y: 49 })
  assert.equal(preview.mapContainPoint(frame, rect, 110, 30), null)
  assert.equal(preview.mapContainPoint(frame, rect, 110, 170), null)

  assert.equal(preview.modifierMask({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true }), 15)
  assert.equal(preview.modifierMask({}), 0)
  assert.equal(preview.pageControlKey({ pageId: 'script', kind: 'script' }, ''), 'page.script')
  assert.equal(preview.pageControlKey({ pageId: 'mine', control: 'human' }, 'mine'), 'page.human')
  assert.equal(preview.pageControlKey({ pageId: 'other', control: 'human' }, 'mine'), 'page.otherHuman')
  assert.equal(preview.pageControlKey({ pageId: 'agent', control: 'agent' }, 'mine'), 'page.agent')

  const prefix = 'data:image/jpeg;base64,'
  assert.ok(preview.safeFrame({ dataUrl: `${prefix}${'A'.repeat(preview.MAX_FRAME_DATA_URL_LENGTH - prefix.length)}`, width: 1, height: 1 }))
  assert.equal(preview.safeFrame({ dataUrl: `${prefix}${'A'.repeat(preview.MAX_FRAME_DATA_URL_LENGTH - prefix.length + 1)}`, width: 1, height: 1 }), null)
})

test('preview channel handshakes, follows pages, streams frames, and scopes control to the selected page', () => {
  const { __test: preview } = loadClient()
  const sockets = []
  const snapshots = []
  const connection = {
    openWebSocket(path) {
      assert.equal(path, '/crawshrimp-browser/preview')
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
  }
  const channel = preview.createPreviewChannel({
    connection,
    sessionId: 'session-1',
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  })

  channel.start()
  const socket = sockets[0]
  assert.ok(socket)
  socket.open()
  assert.deepEqual(socket.sent[0], { type: 'hello', sessionId: 'session-1' })

  socket.message({
    type: 'pages',
    sessionId: 'session-1',
    pages: [
      { pageId: 'page-1', kind: 'interactive', title: 'Products', url: 'https://example.test/products' },
      { pageId: 'script-1', kind: 'script', title: 'Script run' },
    ],
  })
  assert.equal(channel.getSnapshot().selectedPageId, 'page-1')
  assert.deepEqual(socket.sent.at(-1), { type: 'subscribe', pageId: 'page-1' })

  socket.message({
    type: 'frame',
    pageId: 'page-1',
    dataUrl: 'data:image/jpeg;base64,AA==',
    width: 100,
    height: 50,
    sequence: 1,
  })
  assert.equal(channel.getSnapshot().frames['page-1'].sequence, 1)
  socket.message({
    type: 'frame',
    pageId: 'unknown',
    dataUrl: 'data:image/jpeg;base64,AA==',
    width: 100,
    height: 50,
    sequence: 2,
  })
  assert.equal(channel.getSnapshot().frames.unknown, undefined)

  assert.equal(channel.claim('script-1'), false)
  assert.equal(channel.sendInput('page-1', { kind: 'text', text: 'before claim' }), false)
  assert.equal(channel.claim('page-1'), true)
  const claim = socket.sent.at(-1)
  assert.equal(claim.type, 'claim')
  socket.message({
    type: 'pages',
    sessionId: 'session-1',
    pages: [{ pageId: 'page-1', kind: 'interactive', title: 'Products', control: 'agent' }],
  })
  assert.equal(channel.getSnapshot().pendingClaimPageId, 'page-1')
  socket.message({ type: 'result', requestId: claim.requestId, ok: true })
  assert.equal(channel.getSnapshot().claimedPageId, 'page-1')

  assert.equal(channel.sendInput('page-1', { kind: 'text', text: '中文' }), true)
  const input = socket.sent.at(-1)
  assert.equal(input.type, 'input')
  assert.deepEqual(input.event, { kind: 'text', text: '中文' })
  socket.message({ type: 'result', requestId: input.requestId, ok: true })
  assert.equal(channel.getSnapshot().pendingInputPageId, '')

  assert.equal(channel.releaseControl(), true)
  const release = socket.sent.at(-1)
  assert.equal(release.type, 'release')
  assert.deepEqual(Object.keys(release).sort(), ['pageId', 'requestId', 'type'])
  socket.message({ type: 'result', requestId: release.requestId, ok: true })
  assert.equal(channel.getSnapshot().claimedPageId, '')

  socket.message({
    type: 'pages',
    sessionId: 'session-1',
    pages: [
      { pageId: 'page-1', kind: 'interactive', title: 'Products', url: 'https://example.test/products' },
      { pageId: 'script-1', kind: 'script', title: 'Script run' },
    ],
  })
  socket.message({ type: 'pages', sessionId: 'other-session', pages: [] })
  assert.equal(channel.getSnapshot().pages.length, 2)
  assert.ok(snapshots.length >= 5)

  channel.close()
  assert.equal(channel.getSnapshot().connected, false)
})

test('preview channel rejects old frames, marks stale frames, revokes input leases, and cleans removed pages', () => {
  const { __test: preview } = loadClient()
  const sockets = []
  const connection = {
    openWebSocket() {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
  }
  const channel = preview.createPreviewChannel({ connection, sessionId: 'session-1' })
  channel.start()
  const socket = sockets[0]
  socket.open()
  const pages = (page = {}) => socket.message({
    type: 'pages',
    sessionId: 'session-1',
    pages: [{ pageId: 'page-1', kind: 'interactive', title: 'Products', control: 'agent', ...page }],
  })
  pages()
  socket.message({ type: 'frame', pageId: 'page-1', dataUrl: 'data:image/jpeg;base64,AA==', width: 100, height: 50, sequence: 3 })
  socket.message({ type: 'frame', pageId: 'page-1', dataUrl: 'data:image/jpeg;base64,Ag==', width: 100, height: 50, sequence: 2 })
  assert.equal(channel.getSnapshot().frames['page-1'].sequence, 3)

  socket.message({ type: 'status', pageId: 'page-1', status: 'disconnected' })
  assert.equal(channel.getSnapshot().frames['page-1'].stale, true)
  assert.equal(channel.getSnapshot().statuses['page-1'], 'disconnected')
  socket.message({ type: 'status', pageId: 'page-1', status: 'connected' })
  assert.equal(channel.getSnapshot().statuses['page-1'], 'idle')
  socket.message({ type: 'frame', pageId: 'page-1', dataUrl: 'data:image/jpeg;base64,Aw==', width: 100, height: 50, sequence: 4 })
  assert.equal(channel.getSnapshot().frames['page-1'].stale, false)
  assert.equal(channel.getSnapshot().statuses['page-1'], 'connected')

  assert.equal(channel.claim('page-1'), true)
  const claim = socket.sent.at(-1)
  socket.message({ type: 'result', requestId: claim.requestId, ok: true })
  assert.equal(channel.sendInput('page-1', { kind: 'text', text: 'pending' }), true)
  const input = socket.sent.at(-1)
  assert.equal(channel.getSnapshot().pendingInputPageId, 'page-1')
  pages({ control: 'agent' })
  assert.equal(channel.getSnapshot().claimedPageId, '')
  assert.equal(channel.getSnapshot().pendingInputPageId, '')
  socket.message({ type: 'result', requestId: input.requestId, ok: true })
  assert.equal(channel.getSnapshot().claimedPageId, '')

  pages({ control: 'human' })
  socket.message({ type: 'frame', pageId: 'page-1', dataUrl: 'data:image/jpeg;base64,BA==', width: 100, height: 50, sequence: 5 })
  socket.message({ type: 'status', pageId: 'page-1', status: 'connected' })
  assert.equal(channel.getSnapshot().frames['page-1'].sequence, 5)
  assert.equal(channel.getSnapshot().statuses['page-1'], 'connected')
  socket.message({ type: 'pages', sessionId: 'session-1', pages: [] })
  const snapshot = channel.getSnapshot()
  assert.equal(snapshot.pages.length, 0)
  assert.equal(snapshot.selectedPageId, '')
  assert.deepEqual(socket.sent.at(-1), { type: 'subscribe', pageId: '' })
  assert.equal(snapshot.frames['page-1'], undefined)
  assert.equal(snapshot.statuses['page-1'], undefined)
  assert.equal(snapshot.claimedPageId, '')
  channel.close()
})
