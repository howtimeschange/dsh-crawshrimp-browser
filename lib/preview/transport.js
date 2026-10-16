import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'

export const PREVIEW_PATH = '/crawshrimp-browser/preview'

function stringId(value, label) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u001f]/u.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

function envelope(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid preview message')
  const fields = {
    hello: ['type', 'sessionId'], ping: ['type'], subscribe: ['type', 'pageId'],
    claim: ['type', 'pageId', 'requestId'], release: ['type', 'pageId', 'requestId'],
    input: ['type', 'pageId', 'requestId', 'event'],
  }[message.type]
  if (!fields || Object.keys(message).some(key => !fields.includes(key))) throw new Error('Unsupported preview message')
  if (['claim', 'release', 'input'].includes(message.type)) stringId(message.requestId, 'request id')
  return message
}

/** Same-host channel: DSH owns Host/Origin checks and signed browser admission. */
export function installPreviewTransport(ctx, preview, options = {}) {
  if (!ctx.connection?.admit || !ctx.webServer?.registerUpgrade) throw new Error('DSH authenticated connection and Web server are required for preview')
  const maxClients = options.maxClients ?? 16
  const idleTimeoutMs = options.idleTimeoutMs ?? 45000
  const server = new WebSocketServer({ noServer: true, maxPayload: 72 * 1024, perMessageDeflate: false })
  const clients = new Set()
  let disposed = false

  function admit(request, socket, head) {
    if (disposed || clients.size >= maxClients) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return
    }
    let admission
    try { admission = ctx.connection.admit(request) } catch { admission = { rejection: 403 } }
    if (admission.rejection || admission.peer?.principal?.kind !== 'owner') {
      const status = admission.rejection === 401 ? 401 : 403
      socket.end(`HTTP/1.1 ${status} Unauthorized\r\nConnection: close\r\n\r\n`); return
    }
    server.handleUpgrade(request, socket, head, ws => connected(ws, admission.peer))
  }

  function connected(socket, peer) {
    const ownerId = randomUUID()
    let sessionId, selected, unsubscribe, lastSeen = Date.now(), closed = false, revision = 0
    let pending = 0, queue = Promise.resolve(), cleanupPromise
    const send = value => {
      if (closed || socket.readyState !== 1) return
      // A slow viewer must never stall Chrome's screencast ACK or retain frames.
      if (value.type === 'frame' && socket.bufferedAmount > 512 * 1024) return
      socket.send(JSON.stringify(value))
    }
    const pages = () => sessionId ? preview.list(sessionId).reverse() : []
    const sendPages = () => {
      if (!sessionId || closed) return
      const list = pages()
      send({ type: 'pages', sessionId, pages: list })
      if (selected && !list.some(page => page.pageId === selected)) {
        const release = unsubscribe; unsubscribe = undefined; selected = undefined; revision += 1
        void Promise.resolve(release?.()).catch(() => {})
        void preview.releaseControl(ownerId).catch(() => {})
      }
    }
    const offChange = preview.onChange(changedSessionId => { if (changedSessionId === sessionId) sendPages() })
    const helloTimeout = setTimeout(() => { if (!sessionId) socket.close(1008, 'Session handshake required') }, 5000)
    const heartbeat = setInterval(() => { if (Date.now() - lastSeen > idleTimeoutMs) socket.terminate() }, Math.min(5000, idleTimeoutMs))
    helloTimeout.unref?.(); heartbeat.unref?.()
    const cleanup = () => {
      if (cleanupPromise) return cleanupPromise
      closed = true; revision += 1
      clearTimeout(helloTimeout); clearInterval(heartbeat); offChange()
      peer.signal?.removeEventListener('abort', peerEnded)
      cleanupPromise = (async () => {
        await Promise.allSettled([Promise.resolve(unsubscribe?.()), preview.releaseControl(ownerId)])
        // Join admitted operations before removing the socket; queued operations
        // see closed and cannot dispatch additional browser input.
        await queue.catch(() => {})
        clients.delete(client)
      })()
      return cleanupPromise
    }
    const peerEnded = () => socket.terminate()
    const client = { socket, cleanup }
    clients.add(client)
    peer.signal?.addEventListener('abort', peerEnded, { once: true })
    if (peer.signal?.aborted) peerEnded()
    socket.on('close', () => { void cleanup() })
    socket.on('error', () => { socket.terminate(); void cleanup() })
    socket.on('message', (bytes, binary) => {
      if (closed) return
      lastSeen = Date.now()
      if (binary || pending >= 64) { socket.close(1008, 'Invalid or excessive preview input'); return }
      pending += 1
      queue = queue.then(async () => {
        if (closed) return
        let message
        try {
          message = envelope(JSON.parse(bytes.toString('utf8')))
          if (message.type === 'hello') {
            if (sessionId) throw new Error('Preview session cannot change')
            sessionId = stringId(message.sessionId, 'session id'); clearTimeout(helloTimeout); sendPages(); return
          }
          if (!sessionId) throw new Error('Session handshake required')
          if (message.type === 'ping') { send({ type: 'pong' }); return }
          if (message.type === 'subscribe') {
            const pageId = message.pageId === '' ? undefined : stringId(message.pageId, 'page id')
            if (pageId && !pages().some(page => page.pageId === pageId)) throw new Error('Page does not belong to this session')
            const generation = ++revision
            await preview.releaseControl(ownerId)
            await unsubscribe?.(); unsubscribe = undefined; selected = pageId
            if (pageId && !closed) {
              const stop = await preview.subscribe(sessionId, pageId, event => {
                if (!closed && revision === generation && selected === pageId) send(event)
              })
              if (closed || revision !== generation) await stop()
              else unsubscribe = stop
            }
            sendPages(); return
          }
          const pageId = stringId(message.pageId, 'page id')
          if (pageId !== selected || !pages().some(page => page.pageId === pageId)) throw new Error('Select an owned page before interacting')
          if (message.type === 'claim') await preview.claimControl(sessionId, pageId, ownerId)
          else if (message.type === 'release') await preview.releaseControl(ownerId, pageId)
          else if (message.type === 'input') {
            const result = await preview.input(sessionId, pageId, ownerId, message.event)
            if (result?.ok === false) throw new Error(result.error || 'Browser input was not confirmed')
          }
          if (closed) { await preview.releaseControl(ownerId); return }
          send({ type: 'result', requestId: message.requestId, ok: true }); sendPages()
        } catch (error) {
          const text = error instanceof Error ? error.message.slice(0, 300) : 'Preview operation failed'
          if (message?.type === 'input') await preview.releaseControl(ownerId).catch(() => {})
          if (message?.requestId) send({ type: 'result', requestId: message.requestId, ok: false, error: text })
          else send({ type: 'error', message: text })
        }
      }).catch(() => { socket.close(1011, 'Preview connection failed') }).finally(() => { pending -= 1 })
    })
  }

  const removeRoute = ctx.webServer.registerUpgrade({ path: PREVIEW_PATH, handler: admit })
  return async () => {
    if (disposed) return
    disposed = true; removeRoute()
    const active = [...clients]
    for (const client of active) client.socket.terminate()
    await Promise.allSettled(active.map(client => client.cleanup()))
    await new Promise(resolve => server.close(resolve))
  }
}
