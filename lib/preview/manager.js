import { createBrowserInputSession } from './input.js'

const DEFAULT_FRAME_THROTTLE_MS = 150
const DEFAULT_FALLBACK_INTERVAL_MS = 800
const DEFAULT_STREAM_QUALITY = 75
const DEFAULT_FALLBACK_QUALITY = 55
const DEFAULT_MAX_WIDTH = 1920
const DEFAULT_MAX_HEIGHT = 1440
const DEFAULT_COMMAND_TIMEOUT_MS = 5000
const MAX_URL_LENGTH = 4096
const MAX_TITLE_LENGTH = 512

const PAGE_KINDS = new Set(['interactive', 'script'])
const CONNECTION_STATUSES = new Set(['idle', 'connecting', 'connected', 'error', 'disconnected', 'closed'])

function asId(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function optionalId(value, label) {
  if (value === undefined || value === null || value === '') return undefined
  return asId(value, label)
}

function boundedNumber(value, fallback, min, max) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function keyFor(sessionId, pageId) {
  return `${sessionId}\u0000${pageId}`
}

function thenable(value) {
  return value && typeof value.then === 'function'
}

function safePageUrl(page) {
  try {
    const url = typeof page?.url === 'function' ? page.url() : ''
    return typeof url === 'string' ? url.slice(0, MAX_URL_LENGTH) : ''
  } catch {
    return ''
  }
}

function safeViewport(page) {
  try {
    const value = typeof page?.viewportSize === 'function' ? page.viewportSize() : undefined
    if (value && Number.isFinite(Number(value.width)) && Number(value.width) > 0 && Number.isFinite(Number(value.height)) && Number(value.height) > 0) {
      return { width: Math.round(Number(value.width)), height: Math.round(Number(value.height)) }
    }
  } catch {}
  return { width: 0, height: 0 }
}

function removeListener(target, name, listener) {
  try {
    if (typeof target?.off === 'function') target.off(name, listener)
    else if (typeof target?.removeListener === 'function') target.removeListener(name, listener)
  } catch {}
}

/**
 * Owns one preview stream per plugin-owned Playwright page.  The manager does
 * not discover Chrome targets: callers must explicitly register a page that
 * already belongs to their DSH session.
 */
export class PreviewManager {
  constructor(config = {}) {
    this.config = config || {}
    this.frameThrottleMs = boundedNumber(
      this.config.frameThrottleMs ?? this.config.throttleMs,
      DEFAULT_FRAME_THROTTLE_MS,
      0,
      10000,
    )
    this.fallbackIntervalMs = boundedNumber(
      this.config.fallbackIntervalMs ?? this.config.fallbackScreenshotIntervalMs,
      DEFAULT_FALLBACK_INTERVAL_MS,
      10,
      60000,
    )
    this.streamQuality = boundedNumber(this.config.streamQuality, DEFAULT_STREAM_QUALITY, 1, 100)
    this.fallbackQuality = boundedNumber(this.config.fallbackQuality, DEFAULT_FALLBACK_QUALITY, 1, 100)
    this.maxWidth = boundedNumber(this.config.maxWidth, DEFAULT_MAX_WIDTH, 1, 8192)
    this.maxHeight = boundedNumber(this.config.maxHeight, DEFAULT_MAX_HEIGHT, 1, 8192)
    this.commandTimeoutMs = boundedNumber(this.config.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 100, 120000)

    this.records = new Map()
    this.changeListeners = new Set()
    this.disposed = false
  }

  registerPage({ sessionId, pageId, page, kind = 'interactive', runId } = {}) {
    if (this.disposed) throw new Error('browser preview is disposed')
    const sid = asId(sessionId, 'sessionId')
    const pid = asId(pageId, 'pageId')
    if (!page || typeof page !== 'object') throw new Error('page is required')
    const kindAlias = kind === 'page' ? 'interactive' : kind === 'script-run' ? 'script' : kind
    const normalizedKind = kindAlias === undefined ? 'interactive' : kindAlias
    if (!PAGE_KINDS.has(normalizedKind)) throw new Error('kind must be interactive or script')
    const normalizedRunId = optionalId(runId, 'runId')
    if (this.records.has(keyFor(sid, pid))) throw new Error(`preview page already registered: ${sid}/${pid}`)

    const record = {
      sessionId: sid,
      pageId: pid,
      page,
      kind: normalizedKind,
      ...(normalizedRunId ? { runId: normalizedRunId } : {}),
      url: safePageUrl(page),
      title: '',
      titleGeneration: 0,
      status: 'idle',
      controlOwner: undefined,
      controlGeneration: 0,
      busy: 0,
      closed: false,
      subscribers: new Set(),
      pageListeners: [],
      cdp: undefined,
      cdpListeners: [],
      input: undefined,
      viewport: safeViewport(page),
      mainFrameId: undefined,
      screencastStarted: false,
      fallbackTimer: undefined,
      captureInFlight: false,
      captureFailures: 0,
      frameTimer: undefined,
      pendingFrame: undefined,
      lastFrame: undefined,
      sequence: 0,
      lastFrameAt: 0,
      generation: 0,
      streamToken: undefined,
      startPromise: undefined,
      stopPromise: undefined,
      disconnectPromise: undefined,
      releasingPromise: undefined,
      unregisterPromise: undefined,
    }
    this.records.set(keyFor(sid, pid), record)
    this._attachPageListeners(record)
    this._refreshTitle(record)
    this._notifyChange(sid)

    let unregisterPromise
    return () => {
      if (!unregisterPromise) unregisterPromise = this._unregister(record, '页面已关闭')
      return unregisterPromise
    }
  }

  list(sessionId) {
    if (sessionId === undefined || sessionId === null || sessionId === '') {
      return []
    }
    const sid = String(sessionId).trim()
    if (!sid) return []
    const result = []
    for (const record of this.records.values()) {
      if (record.sessionId !== sid || record.closed) continue
      const metadata = {
        pageId: record.pageId,
        kind: record.kind,
        url: record.url || safePageUrl(record.page),
        title: record.title,
        status: record.status,
        control: this._controlState(record),
        busy: record.busy,
      }
      if (record.runId !== undefined) metadata.runId = record.runId
      result.push(metadata)
    }
    return result
  }

  onChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    this.changeListeners.add(listener)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.changeListeners.delete(listener)
    }
  }

  async subscribe(sessionId, pageId, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    const record = this._record(sessionId, pageId)
    if (record.closed) throw new Error('浏览器页面已关闭，请重新打开')
    const hadStream = Boolean(record.cdp || record.fallbackTimer || record.startPromise)
    record.subscribers.add(listener)
    let active = true
    try {
      await this._ensureStream(record)
      if (active && record.subscribers.has(listener)) {
        if (hadStream) this._deliverStatus(record, listener)
        if (record.lastFrame) this._deliver(listener, record.lastFrame)
      }
    } catch (error) {
      record.subscribers.delete(listener)
      throw error
    }

    return async () => {
      if (!active) return
      active = false
      record.subscribers.delete(listener)
      if (!record.subscribers.size && !record.closed) await this._stopStream(record)
    }
  }

  claimControl(sessionId, pageId, ownerId) {
    const record = this._record(sessionId, pageId)
    const owner = asId(ownerId, 'ownerId')
    if (record.kind === 'script') throw new Error('脚本页面不允许人工接管')
    if (record.releasingPromise) throw new Error('浏览器页面正在释放控制')
    if (record.disconnectPromise) throw new Error('浏览器画面正在断开')
    if (record.stopPromise) throw new Error('浏览器画面正在停止')
    if (record.busy > 0) throw new Error('浏览器页面正在由自动化控制')
    if (record.controlOwner && record.controlOwner !== owner) throw new Error('浏览器页面已被其他用户接管')
    if (record.controlOwner !== owner) record.controlGeneration += 1
    record.controlOwner = owner
    this._emitStatus(record, record.status, undefined)
    return { ok: true, ownerId: owner, pageId: record.pageId }
  }

  async releaseControl(ownerId, pageId) {
    const owner = asId(ownerId, 'ownerId')
    const records = []
    if (pageId !== undefined && pageId !== null && pageId !== '') {
      records.push(this._record(undefined, pageId, { pageOptional: true }))
    } else {
      for (const record of this.records.values()) if (record.controlOwner === owner) records.push(record)
    }
    let released = 0
    const pending = []
    for (const record of records) {
      if (record.controlOwner !== owner) continue
      record.controlGeneration += 1
      released += 1
      if (record.releasingPromise) {
        pending.push(record.releasingPromise)
        continue
      }
      const release = Promise.resolve().then(async () => {
        try {
          if (record.input) await record.input.release()
        } catch {}
        finally {
          if (record.releasingPromise === release) record.releasingPromise = undefined
          if (record.controlOwner === owner) record.controlOwner = undefined
          if (!record.closed) this._emitStatus(record, record.status, undefined)
        }
      })
      record.releasingPromise = release
      pending.push(release)
    }
    await Promise.allSettled(pending)
    return { ok: true, released }
  }

  async input(sessionId, pageId, ownerId, event) {
    const record = this._record(sessionId, pageId)
    const owner = asId(ownerId, 'ownerId')
    if (record.kind === 'script') throw new Error('脚本页面不允许人工输入')
    if (record.controlOwner !== owner) throw new Error('浏览器页面未由该用户接管')
    if (!record.input) return { ok: false, error: '浏览器画面未连接，请重新打开' }
    const generation = record.controlGeneration
    return record.input.dispatch(event, () => record.controlOwner === owner && record.controlGeneration === generation)
  }

  async withAutomation(sessionId, pageId, fn) {
    const record = this._record(sessionId, pageId)
    if (typeof fn !== 'function') throw new TypeError('fn must be a function')
    if (record.kind !== 'script' && record.controlOwner) throw new Error('浏览器页面已被用户接管')
    if (record.closed) throw new Error('浏览器页面已关闭，请重新打开')
    record.busy += 1
    this._emitStatus(record, record.status, 'automation-busy')
    try {
      return await fn(record.page)
    } finally {
      record.busy = Math.max(0, record.busy - 1)
      this._emitStatus(record, record.status, record.busy ? 'automation-busy' : undefined)
    }
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    const records = [...this.records.values()]
    await Promise.allSettled(records.map((record) => this._unregister(record, '预览管理器已关闭')))
    this.records.clear()
    this.changeListeners.clear()
  }

  _record(sessionId, pageId, { pageOptional = false } = {}) {
    const pid = asId(pageId, 'pageId')
    if (pageOptional) {
      for (const record of this.records.values()) if (record.pageId === pid) return record
      throw new Error(`Unknown preview page: ${pid}`)
    }
    const sid = asId(sessionId, 'sessionId')
    const record = this.records.get(keyFor(sid, pid))
    if (!record || record.closed) throw new Error(`Unknown preview page: ${sid}/${pid}`)
    return record
  }

  _controlState(record) {
    if (record.kind === 'script') return 'script'
    if (record.controlOwner) return 'human'
    if (record.busy > 0) return 'automation'
    return 'free'
  }

  _revokeControl(record, { notify = true } = {}) {
    record.controlGeneration += 1
    const hadOwner = Boolean(record.controlOwner)
    record.controlOwner = undefined
    if (hadOwner && !record.closed && notify) this._notifyChange(record.sessionId)
    return hadOwner
  }

  _attachPageListeners(record) {
    const page = record.page
    if (typeof page.on !== 'function') return
    const onClose = () => { void this._unregister(record, '页面已关闭') }
    const onNavigate = (frame) => {
      let main = true
      try {
        if (typeof frame?.parentFrame === 'function') main = frame.parentFrame() === null
        else if (frame?.parentFrame !== undefined) main = !frame.parentFrame
      } catch {}
      if (!main || record.closed) return
      const url = typeof frame?.url === 'function' ? frame.url() : frame?.url
      if (typeof url === 'string' && url) this._updateNavigation(record, url)
    }
    page.on('close', onClose)
    page.on('framenavigated', onNavigate)
    record.pageListeners.push(['close', onClose], ['framenavigated', onNavigate])
  }

  _detachPageListeners(record) {
    for (const [name, listener] of record.pageListeners) removeListener(record.page, name, listener)
    record.pageListeners = []
  }

  _refreshTitle(record) {
    if (record.closed || typeof record.page?.title !== 'function') return
    const generation = ++record.titleGeneration
    try {
      const result = record.page.title()
      if (thenable(result)) {
        result.then((title) => {
          if (!record.closed && generation === record.titleGeneration && typeof title === 'string') {
            record.title = title.slice(0, MAX_TITLE_LENGTH)
            this._notifyChange(record.sessionId)
          }
        }).catch(() => {})
      } else if (typeof result === 'string') {
        record.title = result.slice(0, MAX_TITLE_LENGTH)
      }
    } catch {}
  }

  _updateNavigation(record, url) {
    if (record.closed || typeof url !== 'string' || !url) return
    record.url = url.slice(0, MAX_URL_LENGTH)
    this._refreshTitle(record)
    this._emitStatus(record, record.status, undefined, { url: record.url })
  }

  _notifyChange(sessionId) {
    for (const listener of [...this.changeListeners]) {
      try {
        const result = listener(sessionId)
        if (thenable(result)) result.catch(() => {})
      } catch {}
    }
  }

  _deliver(listener, event) {
    try {
      const result = listener(event)
      if (thenable(result)) result.catch(() => {})
    } catch {}
  }

  _deliverStatus(record, listener) {
    const event = {
      type: 'status',
      pageId: record.pageId,
      status: record.status,
      busy: record.busy,
      url: record.url,
      title: record.title,
    }
    this._deliver(listener, event)
  }

  _emitStatus(record, status, message, extra = {}) {
    if (!CONNECTION_STATUSES.has(status)) status = 'error'
    record.status = status
    const event = {
      type: 'status',
      pageId: record.pageId,
      status,
      busy: record.busy,
      url: record.url,
      title: record.title,
      ...extra,
    }
    if (message !== undefined) event.message = message
    for (const listener of [...record.subscribers]) this._deliver(listener, event)
    this._notifyChange(record.sessionId)
  }

  async _ensureStream(record) {
    if (record.closed) throw new Error('浏览器页面已关闭，请重新打开')
    if (record.cdp || record.fallbackTimer) return
    if (record.startPromise) return record.startPromise
    const token = ++record.generation
    const start = this._startStream(record, token)
    record.startPromise = start
    try {
      await start
    } finally {
      if (record.startPromise === start) record.startPromise = undefined
    }
  }

  async _startStream(record, token) {
    if (record.closed || !record.subscribers.size) return
    this._emitStatus(record, 'connecting')

    let cdp
    let setupError
    try {
      const context = typeof record.page.context === 'function' ? record.page.context() : undefined
      if (!context || typeof context.newCDPSession !== 'function') throw new Error('当前浏览器不支持 CDP 预览')
      cdp = await context.newCDPSession(record.page)
      if (record.closed || record.generation !== token || !record.subscribers.size || this.disposed) {
        try { await cdp.detach?.() } catch {}
        return
      }
      record.cdp = cdp
      record.streamToken = token
      this._attachCdpListeners(record, cdp, token)
      await this._sendCdp(cdp, 'Page.enable')
      await this._sendCdp(cdp, 'Emulation.setFocusEmulationEnabled', { enabled: true })
      await this._readLayout(record, cdp)
      try {
        const tree = await this._sendCdp(cdp, 'Page.getFrameTree')
        record.mainFrameId = tree?.frameTree?.frame?.id
      } catch {}
      record.input = createBrowserInputSession(
        (method, params) => this._sendInput(record, cdp, method, params),
        () => this._streamCurrent(record, token, cdp) && !record.closed,
        () => record.viewport,
      )
      try {
        await this._sendCdp(cdp, 'Page.startScreencast', {
          format: 'jpeg',
          quality: this.streamQuality,
          maxWidth: this.maxWidth,
          maxHeight: this.maxHeight,
          everyNthFrame: 1,
        })
        record.screencastStarted = true
      } catch (error) {
        setupError = error
        record.screencastStarted = false
      }
    } catch (error) {
      setupError = error
      await this._discardCdp(record, cdp)
    }

    if (record.closed || !record.subscribers.size || record.generation !== token) {
      await this._stopStream(record, { fromStart: true })
      return
    }

    if (record.screencastStarted && record.cdp) {
      this._emitStatus(record, 'connected', setupError ? '已切换到实时画面' : undefined)
      return
    }

    if (setupError && record.cdp) {
      this._emitStatus(record, 'error', `实时画面不可用，已回退截图：${setupError.message || setupError}`)
    }
    this._startFallback(record, token)
    this._emitStatus(record, 'connected', setupError ? '截图回退已连接' : undefined)
    await this._captureFallback(record, token)
  }

  _attachCdpListeners(record, cdp, token) {
    if (typeof cdp.on !== 'function') return
    const onFrame = (params) => this._onScreencastFrame(record, cdp, token, params)
    const onNavigated = (params) => {
      const frame = params?.frame
      if (!frame || frame.parentId) return
      if (frame.id) record.mainFrameId = frame.id
      if (typeof frame.url === 'string' && frame.url) this._updateNavigation(record, frame.url)
    }
    const onWithinDocument = (params) => {
      if (record.mainFrameId && params?.frameId !== record.mainFrameId) return
      if (typeof params?.url === 'string' && params.url) this._updateNavigation(record, params.url)
    }
    const onClosed = () => { void this._handleCdpClosed(record, cdp, token) }
    cdp.on('Page.screencastFrame', onFrame)
    cdp.on('Page.frameNavigated', onNavigated)
    cdp.on('Page.navigatedWithinDocument', onWithinDocument)
    cdp.on('close', onClosed)
    cdp.on('disconnected', onClosed)
    record.cdpListeners.push(
      ['Page.screencastFrame', onFrame],
      ['Page.frameNavigated', onNavigated],
      ['Page.navigatedWithinDocument', onWithinDocument],
      ['close', onClosed],
      ['disconnected', onClosed],
    )
  }

  _detachCdpListeners(record, cdp) {
    for (const [name, listener] of record.cdpListeners) removeListener(cdp, name, listener)
    record.cdpListeners = []
  }

  _streamCurrent(record, token, cdp) {
    return !record.closed && record.generation === token && record.cdp === cdp && !this.disposed
  }

  async _handleCdpClosed(record, cdp, token) {
    if (!this._streamCurrent(record, token, cdp) || record.disconnectPromise) return
    // Install the barrier before notifying listeners.  A synchronous page-list
    // listener must not be able to claim the newly free lease while CDP input
    // compensation is still being drained.
    record.generation += 1
    const hadControl = this._revokeControl(record, { notify: false })
    const disconnect = Promise.resolve().then(async () => {
      // Keep the session attached while the input bridge sends its best-effort
      // compensation releases.  A closed CDP transport will reject them, but
      // an orderly close still lets Chrome clear any held state.
      if (record.input) await record.input.dispose().catch(() => {})
      if (record.closed || record.cdp !== cdp) return
      record.input = undefined
      record.screencastStarted = false
      this._detachCdpListeners(record, cdp)
      record.cdp = undefined
      record.streamToken = undefined
      record.generation += 1
      if (!record.subscribers.size) return
      this._emitStatus(record, 'disconnected', 'CDP 预览连接已断开')
      const fallbackToken = record.generation
      this._startFallback(record, fallbackToken)
      void this._captureFallback(record, fallbackToken)
    })
    record.disconnectPromise = disconnect
    if (hadControl && !record.closed) this._notifyChange(record.sessionId)
    try {
      await disconnect
    } finally {
      if (record.disconnectPromise === disconnect) record.disconnectPromise = undefined
    }
  }

  async _sendCdp(cdp, method, params = {}) {
    if (!cdp || typeof cdp.send !== 'function') throw new Error('CDP session is unavailable')
    let timer
    const request = Promise.resolve().then(() => cdp.send(method, params))
    try {
      return await Promise.race([
        request,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`CDP 命令超时: ${method}`)), this.commandTimeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async _sendInput(record, cdp, method, params) {
    const compensation = params?.type === 'mouseReleased' || params?.type === 'keyUp'
    if (!compensation && !this._streamCurrent(record, record.streamToken, cdp)) throw new Error('浏览器画面已关闭，请重新打开')
    if (compensation && record.cdp !== cdp) throw new Error('浏览器画面已关闭，请重新打开')
    await this._sendCdp(cdp, 'Emulation.setFocusEmulationEnabled', { enabled: true })
    return this._sendCdp(cdp, method, params)
  }

  async _readLayout(record, cdp) {
    try {
      const metrics = await this._sendCdp(cdp, 'Page.getLayoutMetrics')
      const visual = metrics?.cssVisualViewport || metrics?.visualViewport || {}
      const width = Number(visual.clientWidth)
      const height = Number(visual.clientHeight)
      if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
        record.viewport = { width: Math.round(width), height: Math.round(height) }
      }
    } catch {}
  }

  _startFallback(record, token) {
    if (record.fallbackTimer || record.closed || !record.subscribers.size) return
    record.fallbackTimer = setInterval(() => {
      void this._captureFallback(record, token)
    }, this.fallbackIntervalMs)
  }

  async _captureFallback(record, token) {
      if (record.closed || !record.subscribers.size || record.captureInFlight) return
    if (record.cdp && record.screencastStarted) return
    record.captureInFlight = true
    try {
      const image = await record.page.screenshot({ type: 'jpeg', quality: this.fallbackQuality, animations: 'disabled' })
      if (!this._streamCurrent(record, token, record.cdp) && record.cdp) return
      if (record.closed || !record.subscribers.size || !image) return
      const buffer = Buffer.isBuffer(image) ? image : Buffer.from(image)
      const viewport = safeViewport(record.page)
      if (viewport.width && viewport.height) record.viewport = viewport
      record.captureFailures = 0
      if (record.status === 'error' || record.status === 'disconnected' || record.status === 'connecting') this._emitStatus(record, 'connected')
      this._emitFrame(record, `data:image/jpeg;base64,${buffer.toString('base64')}`, record.viewport.width, record.viewport.height)
    } catch (error) {
      if (record.closed || !record.subscribers.size) return
      record.captureFailures += 1
      if (record.captureFailures >= 3) this._emitStatus(record, 'error', `画面暂未更新：${error?.message || '截图失败'}`)
    } finally {
      record.captureInFlight = false
    }
  }

  _onScreencastFrame(record, cdp, token, params = {}) {
    // ACK first, including frames arriving after the stream has been replaced.
    try {
      const result = cdp.send?.('Page.screencastFrameAck', { sessionId: params.sessionId })
      if (thenable(result)) result.catch(() => {})
    } catch {}
    if (!this._streamCurrent(record, token, cdp) || !record.subscribers.size) return
    if (typeof params.data !== 'string' || !params.data) return

    const metadata = params.metadata || {}
    const scale = Number(metadata.pageScaleFactor) > 0 ? Number(metadata.pageScaleFactor) : 1
    const deviceWidth = Number(metadata.deviceWidth)
    const deviceHeight = Number(metadata.deviceHeight)
    const offsetTop = Number(metadata.offsetTop) || 0
    const width = Number.isFinite(deviceWidth) && deviceWidth > 0
      ? Math.round(deviceWidth / scale)
      : record.viewport.width
    const height = Number.isFinite(deviceHeight) && deviceHeight > 0
      ? Math.round((deviceHeight - offsetTop) / scale)
      : record.viewport.height
    if (width > 0 && height > 0) record.viewport = { width, height }
    record.pendingFrame = {
      dataUrl: `data:image/jpeg;base64,${params.data}`,
      width: record.viewport.width || width || 0,
      height: record.viewport.height || height || 0,
    }
    if (record.frameTimer) return
    const elapsed = Date.now() - record.lastFrameAt
    const delay = Math.max(0, this.frameThrottleMs - elapsed)
    record.frameTimer = setTimeout(() => {
      record.frameTimer = undefined
      this._flushFrame(record, token, cdp)
    }, delay)
  }

  _flushFrame(record, token, cdp) {
    const frame = record.pendingFrame
    record.pendingFrame = undefined
    if (!frame || !this._streamCurrent(record, token, cdp) || !record.subscribers.size) return
    this._emitFrame(record, frame.dataUrl, frame.width, frame.height)
  }

  _emitFrame(record, dataUrl, width, height) {
    record.lastFrameAt = Date.now()
    const event = {
      type: 'frame',
      pageId: record.pageId,
      dataUrl,
      width: Number(width) || 0,
      height: Number(height) || 0,
      sequence: ++record.sequence,
      ts: record.lastFrameAt,
    }
    record.lastFrame = event
    for (const listener of [...record.subscribers]) this._deliver(listener, event)
  }

  _deliverLatest(record, listener) {
    if (record.lastFrame) this._deliver(listener, record.lastFrame)
  }

  async _discardCdp(record, cdp) {
    if (!cdp) return
    if (record.input) {
      await record.input.dispose().catch(() => {})
      record.input = undefined
    }
    this._detachCdpListeners(record, cdp)
    try { await cdp.detach?.() } catch {}
    if (record.cdp === cdp) record.cdp = undefined
    if (record.streamToken !== undefined) record.streamToken = undefined
  }

  async _stopStream(record, { fromStart = false } = {}) {
    if (record.disconnectPromise) await record.disconnectPromise.catch(() => {})
    if (!fromStart && record.startPromise) {
      await record.startPromise.catch(() => {})
      if (record.stopPromise) return record.stopPromise
    }
    if (record.stopPromise) return record.stopPromise
    // Install the stop barrier before notifying listeners.  This prevents a
    // synchronous page-list update from claiming a lease during teardown.
    const hadControl = this._revokeControl(record, { notify: false })
    record.generation += 1
    const stop = Promise.resolve().then(async () => {
      if (record.frameTimer) clearTimeout(record.frameTimer)
      record.frameTimer = undefined
      record.pendingFrame = undefined
      if (record.fallbackTimer) clearInterval(record.fallbackTimer)
      record.fallbackTimer = undefined

      const cdp = record.cdp
      const input = record.input
      if (input) await input.dispose().catch(() => {})
      record.input = undefined
      if (cdp && record.screencastStarted) await this._sendCdp(cdp, 'Page.stopScreencast').catch(() => {})
      record.screencastStarted = false
      if (cdp) this._detachCdpListeners(record, cdp)
      if (cdp) {
        try { await cdp.detach?.() } catch {}
      }
      if (record.cdp === cdp) record.cdp = undefined
      record.streamToken = undefined
      record.lastFrame = undefined
      if (!record.closed && !record.subscribers.size) this._emitStatus(record, 'idle')
    })
    record.stopPromise = stop
    if (hadControl && !record.closed) this._notifyChange(record.sessionId)
    try {
      await stop
    } finally {
      if (record.stopPromise === stop) record.stopPromise = undefined
    }
  }

  async _unregister(record, message) {
    if (record.unregisterPromise) return record.unregisterPromise
    if (record.closed) return
    record.closed = true
    const cleanup = Promise.resolve().then(async () => {
      this._emitStatus(record, 'closed', message)
      await this._stopStream(record)
      this._detachPageListeners(record)
      record.subscribers.clear()
      this.records.delete(keyFor(record.sessionId, record.pageId))
      this._notifyChange(record.sessionId)
    })
    record.unregisterPromise = cleanup
    await cleanup
  }
}

export default PreviewManager
