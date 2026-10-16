window.__ModuleLoader__.load({
  id: 'dsh-crawshrimp-browser',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const TAB_ID = 'crawshrimp-browser-preview'
    const TAB_KIND = 'crawshrimp-browser-preview'
    const LOCALE_NS = 'crawshrimpBrowserPreview'
    const PREVIEW_PATH = '/crawshrimp-browser/preview'
    const OPEN = 1
    const REQUEST_TIMEOUT_MS = 5000
    const PING_INTERVAL_MS = 10000
    const MAX_RECONNECT_MS = 5000
    const MAX_FRAME_DATA_URL_LENGTH = 8 * 1024 * 1024

    const zh = {
      'tab.title': '实时浏览器',
      'guide.title': '实时浏览器',
      'guide.description': '查看并交互操作 Agent 正在使用的网页',
      'page.list': '网页标签页',
      'page.empty': '当前会话没有可预览的网页',
      'page.untitled': '未命名页面',
      'page.script': '脚本运行页面 · 只读观看',
      'page.agent': 'Agent 控制中',
      'page.human': '你正在控制',
      'page.otherHuman': '其他窗口控制中',
      'page.closed': '页面已关闭',
      'status.connecting': '连接中',
      'status.connected': '已连接',
      'status.disconnected': '已断开',
      'status.error': '连接异常',
      'status.closed': '已关闭',
      'status.idle': '等待画面',
      observe: '观察',
      takeOver: '接管操作',
      restoreAgent: '恢复 Agent',
      reconnect: '重新连接',
      followLatest: '跟随最新页面',
      'followLatest.hint': '新页面出现时自动切换到它',
      'frame.alt': '网页实时画面',
      'frame.placeholder': '等待网页画面…',
      'frame.disconnected': '预览连接已断开',
      'frame.error': '预览暂时不可用',
      'frame.readOnly': '脚本页面仅支持实时观看',
      'control.claiming': '正在请求接管…',
      'control.release': '正在恢复 Agent…',
      'control.unavailable': '当前页面无法接管',
      'control.waiting': '等待 Agent 操作完成',
      'error.session': '当前会话不可用',
      'error.socket': '无法连接浏览器预览服务',
      'error.timeout': '操作超时，已释放浏览器输入状态',
      'error.wrongPage': '页面已切换，输入已释放',
      'error.notClaimed': '请先接管页面再操作',
      'input.label': '浏览器键盘输入',
      'retry': '重试',
    }

    const en = {
      'tab.title': 'Live Browser',
      'guide.title': 'Live Browser',
      'guide.description': 'Watch and interact with the page used by the Agent',
      'page.list': 'Web page tabs',
      'page.empty': 'No previewable web page in this Session',
      'page.untitled': 'Untitled page',
      'page.script': 'Script run page · read-only',
      'page.agent': 'Agent control',
      'page.human': 'You have control',
      'page.otherHuman': 'Controlled by another window',
      'page.closed': 'Page closed',
      'status.connecting': 'Connecting',
      'status.connected': 'Connected',
      'status.disconnected': 'Disconnected',
      'status.error': 'Connection error',
      'status.closed': 'Closed',
      'status.idle': 'Waiting for frame',
      observe: 'Observe',
      takeOver: 'Take over',
      restoreAgent: 'Return to Agent',
      reconnect: 'Reconnect',
      followLatest: 'Follow latest page',
      'followLatest.hint': 'Switch automatically when a new page appears',
      'frame.alt': 'Live web page',
      'frame.placeholder': 'Waiting for the web page…',
      'frame.disconnected': 'Preview connection is closed',
      'frame.error': 'Preview is temporarily unavailable',
      'frame.readOnly': 'Script pages can only be watched',
      'control.claiming': 'Requesting control…',
      'control.release': 'Returning control to Agent…',
      'control.unavailable': 'This page cannot be claimed',
      'control.waiting': 'Waiting for the Agent operation to finish',
      'error.session': 'This Session is unavailable',
      'error.socket': 'The browser preview service is unavailable',
      'error.timeout': 'The operation timed out; browser input was released',
      'error.wrongPage': 'The page changed; input was released',
      'error.notClaimed': 'Take over the page before interacting',
      'input.label': 'Browser keyboard input',
      retry: 'Retry',
    }

    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    function asText(value) {
      return typeof value === 'string' ? value : ''
    }

    function normalizePage(value) {
      if (!isRecord(value)) return null
      const pageId = asText(value.pageId || value.id).trim()
      if (!pageId || pageId.length > 256) return null
      const kind = asText(value.kind || 'page').trim().slice(0, 80) || 'page'
      const control = value.control === 'human' ? 'human' : 'agent'
      const status = asText(value.status || 'idle').trim().slice(0, 40) || 'idle'
      return {
        pageId,
        kind,
        runId: asText(value.runId).slice(0, 256),
        url: asText(value.url).slice(0, 4096),
        title: asText(value.title).slice(0, 512),
        status,
        control,
        busy: Boolean(value.busy),
      }
    }

    function normalizePages(value) {
      if (!Array.isArray(value)) return []
      const seen = new Set()
      const result = []
      for (const entry of value) {
        const page = normalizePage(entry)
        if (!page || seen.has(page.pageId)) continue
        seen.add(page.pageId)
        result.push(page)
        if (result.length >= 100) break
      }
      return result
    }

    function isScriptPage(page) {
      const kind = asText(page?.kind).toLowerCase()
      return kind === 'script' || kind === 'script-run' || kind.includes('script')
    }

    function pageControlKey(page, claimedPageId) {
      if (isScriptPage(page)) return 'page.script'
      if (page?.control === 'human') return page.pageId === claimedPageId ? 'page.human' : 'page.otherHuman'
      return 'page.agent'
    }

    function safeFrame(value) {
      if (!isRecord(value)) return null
      const dataUrl = asText(value.dataUrl)
      const width = Number(value.width)
      const height = Number(value.height)
      if (dataUrl.length > MAX_FRAME_DATA_URL_LENGTH) return null
      if (!/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(dataUrl)) return null
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 10000 || height > 10000) return null
      return {
        dataUrl,
        width: Math.round(width),
        height: Math.round(height),
        sequence: Number.isFinite(Number(value.sequence)) ? Number(value.sequence) : 0,
        ts: Number.isFinite(Number(value.ts)) ? Number(value.ts) : Date.now(),
      }
    }

    function parseMessage(value) {
      let data = value
      if (value !== null && typeof value === 'object') {
        try { data = value.data } catch { return null }
      }
      if (typeof data !== 'string') return null
      try {
        const parsed = JSON.parse(data)
        return isRecord(parsed) && typeof parsed.type === 'string' ? parsed : null
      } catch {
        return null
      }
    }

    function mapContainPoint(frame, rect, clientX, clientY) {
      const width = Number(frame?.width)
      const height = Number(frame?.height)
      const left = Number(rect?.left)
      const top = Number(rect?.top)
      const outerWidth = Number(rect?.width)
      const outerHeight = Number(rect?.height)
      if (![width, height, left, top, outerWidth, outerHeight, clientX, clientY].every(Number.isFinite)) return null
      if (width <= 0 || height <= 0 || outerWidth <= 0 || outerHeight <= 0) return null
      const scale = Math.min(outerWidth / width, outerHeight / height)
      const drawnWidth = width * scale
      const drawnHeight = height * scale
      const offsetX = (outerWidth - drawnWidth) / 2
      const offsetY = (outerHeight - drawnHeight) / 2
      const x = (clientX - left - offsetX) / scale
      const y = (clientY - top - offsetY) / scale
      if (x < 0 || y < 0 || x >= width || y >= height) return null
      return {
        x: Math.max(0, Math.min(Math.round(width) - 1, Math.round(x))),
        y: Math.max(0, Math.min(Math.round(height) - 1, Math.round(y))),
      }
    }

    function modifierMask(event) {
      let mask = 0
      if (event?.altKey) mask |= 1
      if (event?.ctrlKey) mask |= 2
      if (event?.metaKey) mask |= 4
      if (event?.shiftKey) mask |= 8
      return mask
    }

    function buttonName(button) {
      return button === 1 ? 'middle' : button === 2 ? 'right' : 'left'
    }

    function requestIdFactory() {
      let counter = 0
      return () => {
        counter += 1
        return `crb-${Date.now().toString(36)}-${counter.toString(36)}`
      }
    }

    function createPreviewChannel(options) {
      const connection = options?.connection
      const sessionId = asText(options?.sessionId).trim()
      const emit = typeof options?.onSnapshot === 'function' ? options.onSnapshot : () => {}
      const requestId = requestIdFactory()
      const state = {
        sessionId,
        pages: [],
        selectedPageId: '',
        subscribedPageId: '',
        frames: {},
        statuses: {},
        connected: false,
        socketError: '',
        claimedPageId: '',
        pendingClaimPageId: '',
        pendingReleasePageId: '',
        pendingInputPageId: '',
        followLatest: options?.followLatest !== false,
      }
      const pending = new Map()
      let socket = null
      let closed = false
      let pingTimer = null
      let reconnectTimer = null
      let reconnectAttempt = 0
      let generation = 0

      function snapshot() {
        return {
          sessionId: state.sessionId,
          pages: state.pages,
          selectedPageId: state.selectedPageId,
          frames: state.frames,
          statuses: state.statuses,
          connected: state.connected,
          socketError: state.socketError,
          claimedPageId: state.claimedPageId,
          pendingClaimPageId: state.pendingClaimPageId,
          pendingReleasePageId: state.pendingReleasePageId,
          pendingInputPageId: state.pendingInputPageId,
          followLatest: state.followLatest,
        }
      }

      function publish() {
        emit(snapshot())
      }

      function isOpen() {
        return socket !== null && socket.readyState === OPEN
      }

      function sendRaw(message) {
        if (!isOpen()) return false
        try {
          socket.send(JSON.stringify(message))
          return true
        } catch (error) {
          state.socketError = error instanceof Error ? error.message : String(error)
          publish()
          return false
        }
      }

      function pageById(pageId) {
        return state.pages.find((page) => page.pageId === pageId) || null
      }

      function releaseLocal(pageId) {
        if (!pageId || state.claimedPageId === pageId) state.claimedPageId = ''
        if (!pageId || state.pendingClaimPageId === pageId) state.pendingClaimPageId = ''
        if (!pageId || state.pendingReleasePageId === pageId) state.pendingReleasePageId = ''
        if (!pageId || state.pendingInputPageId === pageId) state.pendingInputPageId = ''
      }

      function clearPending(pageId, error) {
        const entries = [...pending.entries()]
        for (const [id, item] of entries) {
          if (pageId && item.pageId !== pageId) continue
          clearTimeout(item.timer)
          pending.delete(id)
          if (error && typeof item.onResult === 'function') item.onResult({ ok: false, error })
        }
        releaseLocal(pageId)
      }

      function cancelInput(pageId) {
        for (const [id, item] of [...pending.entries()]) {
          if (item.pageId !== pageId || item.type !== 'input') continue
          clearTimeout(item.timer)
          pending.delete(id)
        }
        if (state.pendingInputPageId === pageId) state.pendingInputPageId = ''
      }

      // A pages/status update is authoritative for the server-side lease. Do
      // not send a compensating input or automatically claim again after the
      // server has revoked it.
      function revokeClaim(pageId) {
        if (!pageId) return false
        const hadClaim = state.claimedPageId === pageId
        cancelInput(pageId)
        if (state.claimedPageId === pageId) state.claimedPageId = ''
        if (state.pendingReleasePageId === pageId) state.pendingReleasePageId = ''
        return hadClaim
      }

      function pruneRemovedPages() {
        const available = new Set(state.pages.map((page) => page.pageId))
        const removed = new Set([
          ...Object.keys(state.frames),
          ...Object.keys(state.statuses),
          ...[...pending.values()].map((item) => item.pageId),
          state.claimedPageId,
          state.pendingClaimPageId,
          state.pendingReleasePageId,
          state.pendingInputPageId,
          state.subscribedPageId,
        ])
        removed.delete('')
        const frames = { ...state.frames }
        const statuses = { ...state.statuses }
        for (const pageId of removed) {
          if (available.has(pageId)) continue
          delete frames[pageId]
          delete statuses[pageId]
          clearPending(pageId, 'page-removed')
        }
        state.frames = frames
        state.statuses = statuses
        if (state.subscribedPageId && !available.has(state.subscribedPageId)) state.subscribedPageId = ''
      }

      function reconcileClaimedPage() {
        const pageId = state.claimedPageId
        if (!pageId) return false
        const page = pageById(pageId)
        if (!page || page.control !== 'human' || page.busy) return revokeClaim(pageId)
        return false
      }

      function markFrameStale(pageId) {
        const frame = state.frames[pageId]
        if (!frame || frame.stale) return
        state.frames = { ...state.frames, [pageId]: { ...frame, stale: true } }
      }

      function sendRequest(type, pageId, extra, onResult) {
        if (!pageId || !pageById(pageId) || !isOpen()) return false
        const id = requestId()
        const timer = setTimeout(() => {
          const item = pending.get(id)
          if (!item) return
          pending.delete(id)
          item.onResult?.({ ok: false, error: 'timeout', timeout: true })
          if (item.type === 'input' || item.type === 'claim') {
            releaseControl(pageId, 'timeout')
            state.socketError = 'timeout'
            publish()
          }
        }, REQUEST_TIMEOUT_MS)
        pending.set(id, { id, type, pageId, timer, onResult })
        if (!sendRaw({ type, pageId, requestId: id, ...(extra || {}) })) {
          clearTimeout(timer)
          pending.delete(id)
          return false
        }
        return true
      }

      function subscribe(pageId) {
        const next = pageId && pageById(pageId) ? pageId : ''
        if (state.subscribedPageId === next && state.selectedPageId === next && isOpen()) return
        if (state.claimedPageId && state.claimedPageId !== next) releaseControl(state.claimedPageId, 'page-change')
        state.selectedPageId = next
        state.subscribedPageId = next
        if (isOpen()) sendRaw({ type: 'subscribe', pageId: next })
        publish()
      }

      function selectPage(pageId) {
        state.followLatest = false
        subscribe(pageId)
      }

      function setFollowLatest(value) {
        state.followLatest = Boolean(value)
        if (state.followLatest) {
          const latest = state.pages[0]?.pageId || ''
          if (latest !== state.selectedPageId) subscribe(latest)
        }
        publish()
      }

      function claim(pageId) {
        const page = pageById(pageId)
        if (!page || isScriptPage(page) || !isOpen() || state.selectedPageId !== pageId) return false
        if (state.claimedPageId === pageId || state.pendingClaimPageId === pageId) return true
        state.pendingClaimPageId = pageId
        state.socketError = ''
        publish()
        const sent = sendRequest('claim', pageId, {}, (result) => {
          if (result?.ok) {
            state.claimedPageId = pageId
            state.socketError = ''
          } else {
            releaseLocal(pageId)
            state.socketError = result?.error || 'claim-failed'
          }
          publish()
        })
        if (!sent) {
          releaseLocal(pageId)
          state.socketError = 'disconnected'
          publish()
        }
        return sent
      }

      function releaseControl(pageId = state.claimedPageId || state.pendingClaimPageId, _reason = '') {
        if (!pageId) return false
        const hadClaim = state.claimedPageId === pageId || state.pendingClaimPageId === pageId
        releaseLocal(pageId)
        if (!hadClaim || !isOpen() || !pageById(pageId)) {
          publish()
          return false
        }
        state.pendingReleasePageId = pageId
        publish()
        const sent = sendRequest('release', pageId, {}, (result) => {
          releaseLocal(pageId)
          if (!result?.ok && result?.error) state.socketError = result.error
          publish()
        })
        if (!sent) {
          releaseLocal(pageId)
          publish()
        }
        return sent
      }

      function sendInput(pageId, event) {
        const page = pageById(pageId)
        if (!page || state.selectedPageId !== pageId || state.claimedPageId !== pageId || !isOpen() || isScriptPage(page)) {
          releaseControl(pageId, 'wrong-page')
          state.socketError = 'not-claimed'
          publish()
          return false
        }
        state.pendingInputPageId = pageId
        const sent = sendRequest('input', pageId, { event }, (result) => {
          state.pendingInputPageId = ''
          if (!result?.ok) {
            releaseControl(pageId, result?.error || 'input-failed')
            state.socketError = result?.error || 'input-failed'
          }
          publish()
        })
        if (!sent) {
          releaseControl(pageId, 'disconnected')
          publish()
        }
        return sent
      }

      function releaseActive() {
        const pageId = state.claimedPageId || state.pendingClaimPageId
        if (!pageId) return
        sendInput(pageId, { kind: 'release' })
        releaseControl(pageId, 'focus-lost')
      }

      function handleResult(message) {
        const item = pending.get(asText(message.requestId))
        if (!item) return
        pending.delete(item.id)
        clearTimeout(item.timer)
        if (item.pageId !== state.selectedPageId && item.type !== 'release') {
          item.onResult?.({ ok: false, error: 'wrong-page' })
          releaseControl(item.pageId, 'wrong-page')
          return
        }
        item.onResult?.(message)
      }

      function handleMessage(event) {
        const message = parseMessage(event)
        if (!message) return
        if (message.type === 'pages') {
          if (message.sessionId && message.sessionId !== sessionId) {
            state.socketError = 'wrong-session'
            publish()
            return
          }
          state.pages = normalizePages(message.pages)
          pruneRemovedPages()
          reconcileClaimedPage()
          const current = state.selectedPageId
          const next = state.followLatest
            ? state.pages[0]?.pageId || ''
            : (state.pages.some((page) => page.pageId === current) ? current : state.pages[0]?.pageId || '')
          if (next !== current) subscribe(next)
          else if (isOpen() && state.subscribedPageId !== next) subscribe(next)
          publish()
          return
        }
        if (message.type === 'frame') {
          const pageId = asText(message.pageId)
          if (!pageById(pageId) || pageId !== state.selectedPageId) return
          const frame = safeFrame(message)
          if (!frame) return
          const previous = state.frames[pageId]
          if (previous && frame.sequence < previous.sequence) return
          state.frames = { ...state.frames, [pageId]: { ...frame, stale: false } }
          state.statuses = { ...state.statuses, [pageId]: 'connected' }
          publish()
          return
        }
        if (message.type === 'status') {
          const pageId = asText(message.pageId)
          if (!pageById(pageId)) return
          const status = asText(message.status).slice(0, 40) || 'idle'
          if (status === 'disconnected' || status === 'error') markFrameStale(pageId)
          if (status === 'disconnected' || status === 'closed') revokeClaim(pageId)
          const effectiveStatus = status === 'connected' && state.frames[pageId]?.stale ? 'idle' : status
          state.statuses = { ...state.statuses, [pageId]: effectiveStatus }
          if (message.status === 'closed') {
            const frames = { ...state.frames }
            delete frames[pageId]
            state.frames = frames
            clearPending(pageId, 'page-closed')
          }
          publish()
          return
        }
        if (message.type === 'result') {
          handleResult(message)
          return
        }
        if (message.type === 'error') {
          state.socketError = asText(message.message).slice(0, 512) || 'server-error'
          publish()
        }
      }

      function stopPing() {
        if (pingTimer !== null) clearInterval(pingTimer)
        pingTimer = null
      }

      function scheduleReconnect() {
        if (closed || reconnectTimer !== null) return
        const delay = Math.min(MAX_RECONNECT_MS, 400 * (2 ** Math.min(reconnectAttempt, 4)))
        reconnectAttempt += 1
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          connect()
        }, delay)
      }

      function detachSocket(current) {
        if (!current) return
        try { current.removeEventListener('open', current.__crbOpen) } catch {}
        try { current.removeEventListener('message', current.__crbMessage) } catch {}
        try { current.removeEventListener('error', current.__crbError) } catch {}
        try { current.removeEventListener('close', current.__crbClose) } catch {}
      }

      function connect() {
        if (closed || !sessionId || !connection?.openWebSocket) return
        const currentGeneration = ++generation
        let current
        try {
          current = connection.openWebSocket(PREVIEW_PATH)
        } catch (error) {
          state.connected = false
          state.socketError = error instanceof Error ? error.message : String(error)
          publish()
          scheduleReconnect()
          return
        }
        socket = current
        const onOpen = () => {
          if (closed || currentGeneration !== generation || socket !== current) return
          reconnectAttempt = 0
          state.connected = true
          state.socketError = ''
          sendRaw({ type: 'hello', sessionId })
          if (state.selectedPageId) {
            state.subscribedPageId = ''
            subscribe(state.selectedPageId)
          }
          stopPing()
          pingTimer = setInterval(() => sendRaw({ type: 'ping' }), PING_INTERVAL_MS)
          publish()
        }
        const onMessage = (event) => {
          if (currentGeneration !== generation || socket !== current) return
          handleMessage(event)
        }
        const onError = () => {
          if (currentGeneration !== generation || socket !== current) return
          state.socketError = 'socket-error'
          publish()
        }
        const onClose = () => {
          if (currentGeneration !== generation || socket !== current) return
          detachSocket(current)
          stopPing()
          socket = null
          state.connected = false
          clearPending('', 'disconnected')
          state.claimedPageId = ''
          state.pendingClaimPageId = ''
          state.pendingReleasePageId = ''
          state.pendingInputPageId = ''
          publish()
          scheduleReconnect()
        }
        current.__crbOpen = onOpen
        current.__crbMessage = onMessage
        current.__crbError = onError
        current.__crbClose = onClose
        current.addEventListener('open', onOpen)
        current.addEventListener('message', onMessage)
        current.addEventListener('error', onError)
        current.addEventListener('close', onClose)
        publish()
      }

      function reconnect() {
        if (reconnectTimer !== null) clearTimeout(reconnectTimer)
        reconnectTimer = null
        reconnectAttempt = 0
        if (socket) {
          const current = socket
          socket = null
          generation += 1
          detachSocket(current)
          try { current.close(1000, 'client reconnect') } catch {}
        }
        stopPing()
        clearPending('', 'reconnect')
        state.connected = false
        state.claimedPageId = ''
        state.pendingClaimPageId = ''
        state.pendingReleasePageId = ''
        state.pendingInputPageId = ''
        state.socketError = ''
        publish()
        connect()
      }

      function start() {
        closed = false
        state.socketError = ''
        publish()
        connect()
      }

      function close() {
        if (closed) return
        closed = true
        if (reconnectTimer !== null) clearTimeout(reconnectTimer)
        reconnectTimer = null
        releaseActive()
        stopPing()
        clearPending('', 'closed')
        const current = socket
        socket = null
        generation += 1
        if (current) {
          detachSocket(current)
          try { current.close(1000, 'client closed') } catch {}
        }
        state.connected = false
        state.claimedPageId = ''
        state.pendingClaimPageId = ''
        state.pendingReleasePageId = ''
        state.pendingInputPageId = ''
        publish()
      }

      return {
        start,
        close,
        reconnect,
        selectPage,
        setFollowLatest,
        claim,
        releaseControl,
        sendInput,
        releaseActive,
        getSnapshot: snapshot,
      }
    }

    function usePreviewChannel(options) {
      const [snapshot, setSnapshot] = React.useState(() => ({
        sessionId: asText(options?.sessionId),
        pages: [],
        selectedPageId: '',
        frames: {},
        statuses: {},
        connected: false,
        socketError: '',
        claimedPageId: '',
        pendingClaimPageId: '',
        pendingReleasePageId: '',
        pendingInputPageId: '',
        followLatest: options?.followLatest !== false,
      }))
      const channelRef = React.useRef(null)

      React.useEffect(() => {
        if (!options?.visible || !options?.sessionId || !options?.connection) {
          channelRef.current?.close()
          channelRef.current = null
          setSnapshot((current) => ({ ...current, connected: false, claimedPageId: '', pendingClaimPageId: '', pendingReleasePageId: '', pendingInputPageId: '' }))
          return undefined
        }
        const channel = createPreviewChannel({
          connection: options.connection,
          sessionId: options.sessionId,
          followLatest: options.followLatest,
          onSnapshot: setSnapshot,
        })
        channelRef.current = channel
        channel.start()
        return () => {
          channel.close()
          if (channelRef.current === channel) channelRef.current = null
        }
      }, [options?.connection, options?.sessionId, options?.visible])

      React.useEffect(() => {
        channelRef.current?.setFollowLatest(options?.followLatest)
      }, [options?.followLatest])

      return {
        ...snapshot,
        channel: channelRef.current,
      }
    }

    function statusText(t, status, connected) {
      if (status === 'closed') return t('status.closed')
      if (status === 'error') return t('status.error')
      if (status === 'disconnected' || !connected) return t('status.disconnected')
      if (status === 'connected') return t('status.connected')
      return t('status.idle')
    }

    function PreviewIcon() {
      return h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true },
        h('rect', { x: 3, y: 4, width: 18, height: 14, rx: 2 }),
        h('path', { d: 'M8 21h8M12 18v3M7 8h10M7 11h6' }))
    }

    function PreviewTitle({ useTabInfo, t }) {
      useTabInfo?.()
      return h('span', { className: 'crb-preview-title' }, h(PreviewIcon), t('tab.title'))
    }

    function PreviewBody(props) {
      const { sessionId, useSession, useTabInfo, connection, t } = props
      const tabInfo = useTabInfo?.()
      const visible = tabInfo?.tab?.visible !== false
      // Reading the standard session hook keeps the panel tied to the current
      // Session binding. The projection itself is not used as authorization.
      const sessionSnapshot = useSession ? useSession((value) => value) : undefined
      const sessionRemoved = Boolean(sessionSnapshot?.removed)
      const [followLatest, setFollowLatest] = React.useState(true)
      const preview = usePreviewChannel({ connection, sessionId, visible: visible && !sessionRemoved, followLatest })
      const [inputError, setInputError] = React.useState('')
      const imageRef = React.useRef(null)
      const inputRef = React.useRef(null)
      const pointerRef = React.useRef(null)
      const compositionRef = React.useRef(false)
      const compositionCommitRef = React.useRef('')
      const page = preview.pages.find((entry) => entry.pageId === preview.selectedPageId) || null
      const frame = page ? preview.frames[page.pageId] : null
      const pageStatus = page ? (preview.statuses[page.pageId] || page.status || 'idle') : 'idle'
      const script = isScriptPage(page)
      const claimed = Boolean(page && preview.claimedPageId === page.pageId && !script)
      const canInput = claimed && preview.connected && Boolean(frame)

      React.useEffect(() => {
        const release = () => {
          pointerRef.current = null
          preview.channel?.releaseActive()
          setInputError('')
        }
        const visibility = () => {
          if (document.visibilityState === 'hidden') release()
        }
        window.addEventListener('blur', release)
        document.addEventListener('visibilitychange', visibility)
        return () => {
          window.removeEventListener('blur', release)
          document.removeEventListener('visibilitychange', visibility)
          release()
        }
      }, [preview.channel])

      React.useEffect(() => {
        if (canInput) return undefined
        pointerRef.current = null
        inputRef.current?.blur?.()
        return undefined
      }, [canInput])

      function input(event) {
        if (!canInput || !page) {
          if (page && !script) setInputError(t('error.notClaimed'))
          return false
        }
        setInputError('')
        return preview.channel?.sendInput(page.pageId, event) !== false
      }

      function pointFor(event) {
        return mapContainPoint(frame, imageRef.current?.getBoundingClientRect?.(), event.clientX, event.clientY)
      }

      function onPointerDown(event) {
        if (!canInput || event.button > 2) return
        const point = pointFor(event)
        if (!point) return
        event.preventDefault()
        inputRef.current?.focus?.({ preventScroll: true })
        const held = { pointerId: event.pointerId, button: buttonName(event.button), clickCount: 1, lastPoint: point, target: event.currentTarget }
        pointerRef.current = held
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
        input({ kind: 'mouse', type: 'mousePressed', ...point, button: held.button, buttons: event.buttons & 7, clickCount: held.clickCount, modifiers: modifierMask(event) })
      }

      function onPointerMove(event) {
        const point = pointFor(event)
        if (!point || !canInput) return
        if (pointerRef.current) pointerRef.current.lastPoint = point
        input({ kind: 'mouse', type: 'mouseMoved', ...point, button: pointerRef.current?.button || 'none', buttons: event.buttons & 7, modifiers: modifierMask(event) })
      }

      function onPointerUp(event) {
        const held = pointerRef.current
        if (!held || held.pointerId !== event.pointerId) return
        const point = pointFor(event) || held.lastPoint
        pointerRef.current = null
        if (point) input({ kind: 'mouse', type: 'mouseReleased', ...point, button: held.button, buttons: event.buttons & 7, clickCount: held.clickCount, modifiers: modifierMask(event) })
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
      }

      function releasePointer() {
        const held = pointerRef.current
        pointerRef.current = null
        if (held) preview.channel?.sendInput(page?.pageId, { kind: 'release' })
      }

      function onWheel(event) {
        if (!canInput) return
        const point = pointFor(event)
        if (!point) return
        event.preventDefault()
        input({ kind: 'wheel', ...point, deltaX: Math.max(-10000, Math.min(10000, Number(event.deltaX) || 0)), deltaY: Math.max(-10000, Math.min(10000, Number(event.deltaY) || 0)), modifiers: modifierMask(event) })
      }

      function onKeyDown(event) {
        event.stopPropagation()
        if (!canInput || event.isComposing || compositionRef.current || event.keyCode === 229) return
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') return
        const command = (event.metaKey || event.ctrlKey) ? ({ a: 'selectAll', c: 'copy', x: 'cut' })[event.key.toLowerCase()] : undefined
        if (event.key.length > 1 || event.metaKey || event.ctrlKey) event.preventDefault()
        input({ kind: 'key', type: 'rawKeyDown', key: event.key, code: event.code, keyCode: event.keyCode || event.which || 0, modifiers: modifierMask(event), repeat: Boolean(event.repeat), ...(command ? { command } : {}) })
      }

      function onKeyUp(event) {
        event.stopPropagation()
        if (!canInput || event.isComposing || compositionRef.current) return
        event.preventDefault()
        input({ kind: 'key', type: 'keyUp', key: event.key, code: event.code, keyCode: event.keyCode || event.which || 0, modifiers: modifierMask(event) })
      }

      function sendText(value) {
        const text = typeof value === 'string' ? value : ''
        if (text) input({ kind: 'text', text })
      }

      function onInput(event) {
        event.stopPropagation()
        if (event.isComposing || compositionRef.current) return
        const value = event.currentTarget.value
        event.currentTarget.value = ''
        if (value && value !== compositionCommitRef.current) sendText(value)
        compositionCommitRef.current = ''
      }

      function onCompositionEnd(event) {
        event.stopPropagation()
        compositionRef.current = false
        compositionCommitRef.current = event.data || ''
        sendText(compositionCommitRef.current)
        event.currentTarget.value = ''
        setTimeout(() => { compositionCommitRef.current = '' }, 0)
      }

      function onPaste(event) {
        event.stopPropagation()
        event.preventDefault()
        sendText(event.clipboardData?.getData('text/plain') || '')
        event.currentTarget.value = ''
      }

      function onInputBlur(event) {
        pointerRef.current = null
        if (!canInput || !page) return
        // Moving focus between the hidden keyboard sink and a control in this
        // preview must not hand the page back while the user is still using it.
        // Always release held inputs; release the lease when focus explicitly
        // moves outside this panel. Window blur and hiding also release it.
        preview.channel?.sendInput(page.pageId, { kind: 'release' })
        const root = event.currentTarget.closest('.crb-preview-root')
        if (event.relatedTarget && !root?.contains(event.relatedTarget)) {
          preview.channel?.releaseControl(page.pageId)
        }
      }

      function onSelect(pageId) {
        setInputError('')
        setFollowLatest(false)
        preview.channel?.selectPage(pageId)
      }

      function onTabKeyDown(event, index) {
        const last = preview.pages.length - 1
        const next = event.key === 'ArrowRight' ? (index + 1) % (last + 1)
          : event.key === 'ArrowLeft' ? (index + last) % (last + 1)
            : event.key === 'Home' ? 0 : event.key === 'End' ? last : -1
        if (next < 0) return
        event.preventDefault()
        event.stopPropagation()
        onSelect(preview.pages[next].pageId)
        event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[next]?.focus()
      }

      function onFollow(value) {
        setFollowLatest(value)
        preview.channel?.setFollowLatest(value)
      }

      function onClaim() {
        if (page) preview.channel?.claim(page.pageId)
      }

      function onRelease() {
        if (page) preview.channel?.releaseControl(page.pageId)
      }

      const status = statusText(t, pageStatus, preview.connected)
      const errorText = inputError || (preview.socketError && preview.socketError !== 'timeout' && preview.socketError !== 'not-claimed' ? preview.socketError : '')
      const pageList = preview.pages.length === 0
        ? h('p', { className: 'crb-preview-empty-list' }, t('page.empty'))
        : preview.pages.map((entry, index) => h('button', {
          key: entry.pageId,
          type: 'button',
          role: 'tab',
          className: `crb-preview-page ${entry.pageId === preview.selectedPageId ? 'is-selected' : ''}`,
          onClick: () => onSelect(entry.pageId),
          onKeyDown: (event) => onTabKeyDown(event, index),
          'aria-selected': entry.pageId === preview.selectedPageId,
          'aria-controls': `crb-preview-panel-${sessionId}`,
          tabIndex: entry.pageId === preview.selectedPageId ? 0 : -1,
          title: `${entry.title || entry.pageId}\n${entry.url}\n${t(pageControlKey(entry, preview.claimedPageId))}`,
        },
        h('span', { className: `crb-preview-tab-indicator${isScriptPage(entry) ? ' is-script' : entry.control === 'human' ? ' is-human' : ''}`, 'aria-hidden': true }),
        h('span', { className: 'crb-preview-page-title' }, entry.title || entry.url || t('page.untitled')),
        h('span', { className: 'crb-preview-page-meta' }, t(pageControlKey(entry, preview.claimedPageId)))))

      return h('div', { className: 'crb-preview-root', 'data-session-id': sessionId || undefined },
        h('div', { className: 'crb-preview-layout' },
          h('nav', { className: 'crb-preview-page-list', role: 'tablist', 'aria-label': t('page.list'), 'aria-orientation': 'horizontal' }, pageList),
          h('section', { id: `crb-preview-panel-${sessionId}`, role: 'tabpanel', className: 'crb-preview-view', 'aria-label': t('frame.alt') },
            h('div', { className: `crb-preview-stage ${canInput ? 'is-interactive' : ''}`, tabIndex: -1, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: releasePointer, onLostPointerCapture: releasePointer, onWheel, onContextMenu: (event) => event.preventDefault() },
              frame
                ? h('img', { ref: imageRef, className: `crb-preview-frame${frame.stale ? ' is-stale' : ''}`, src: frame.dataUrl, alt: frame.stale ? t('frame.disconnected') : t('frame.alt'), draggable: false })
                : h('div', { className: 'crb-preview-placeholder', role: 'status' },
                  h('span', { className: 'crb-preview-placeholder-icon' }, preview.connected ? '◌' : '⚠'),
                  h('span', null, preview.connected ? t('frame.placeholder') : t('frame.disconnected'))),
              h('textarea', {
                ref: inputRef,
                className: 'crb-preview-input-sink',
                'aria-label': t('input.label'),
                tabIndex: canInput ? 0 : -1,
                autoComplete: 'off',
                autoCapitalize: 'off',
                spellCheck: false,
                onKeyDown,
                onKeyUp,
                onInput,
                onPaste,
                onCompositionStart: (event) => { event.stopPropagation(); compositionRef.current = true },
                onCompositionEnd,
                onBlur: onInputBlur,
              })),
            h('div', { className: 'crb-preview-footer' },
              h('span', { className: 'crb-preview-url', title: page?.url || '' }, page?.url || '—'),
              frame ? h('span', { className: 'crb-preview-dimensions' }, `${frame.width}×${frame.height}`) : null,
              frame?.stale ? h('span', { className: 'crb-preview-stale' }, t('frame.disconnected')) : null,
              script ? h('span', { className: 'crb-preview-readonly' }, t('frame.readOnly')) : null)
          )
        ),
        h('div', { className: 'crb-preview-actions' },
          h('label', { className: 'crb-preview-follow' },
            h('input', { type: 'checkbox', checked: followLatest, onChange: (event) => onFollow(event.target.checked) }),
            h('span', { title: t('followLatest.hint') }, t('followLatest'))),
          h('span', { className: 'crb-preview-action-spacer' }),
          h('span', { className: `crb-preview-status crb-status-${pageStatus}`, role: 'status', title: status }, h('i', { 'aria-hidden': true }), status),
          h('button', { type: 'button', className: 'crb-preview-button crb-preview-reconnect', onClick: () => preview.channel?.reconnect(), disabled: !sessionId, 'aria-label': t('reconnect'), title: t('reconnect') }, '↻'),
          h('button', { type: 'button', className: 'crb-preview-button', onClick: () => preview.channel?.releaseActive(), disabled: !claimed }, t('observe')),
          script
            ? h('span', { className: 'crb-preview-action-note' }, t('frame.readOnly'))
            : claimed
              ? h('button', { type: 'button', className: 'crb-preview-button crb-preview-button-primary', onClick: onRelease, disabled: Boolean(preview.pendingReleasePageId) }, preview.pendingReleasePageId ? t('control.release') : t('restoreAgent'))
              : h('button', { type: 'button', className: 'crb-preview-button crb-preview-button-primary', onClick: onClaim, disabled: !page || !preview.connected || Boolean(page.busy) || Boolean(preview.pendingClaimPageId) }, preview.pendingClaimPageId ? t('control.claiming') : t('takeOver'))),
        errorText ? h('p', { className: 'crb-preview-error', role: 'alert' }, errorText) : null
      )
    }

    const styleText = `
.crb-preview-root{--crb-border:var(--dsw-alias-border-module,rgba(127,127,127,.2));--crb-panel:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-module,rgba(127,127,127,.06)));--crb-subtle:var(--dsw-alias-label-secondary,#858585);--crb-primary:var(--dsw-alias-state-business-primary,#3478f6);box-sizing:border-box;display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;color:var(--dsw-alias-label-primary,#202020);font-size:13px;background:var(--dsw-alias-bg-base,#fff)}
.crb-preview-status{display:inline-flex;align-items:center;gap:5px;color:var(--crb-subtle);font-size:11px;white-space:nowrap}.crb-preview-status i{width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-label-tertiary,#aaa)}.crb-status-connected i{background:var(--dsw-alias-state-success-primary,#28a269)}.crb-status-error i{background:var(--dsw-alias-state-error-primary,#d04444)}
.crb-preview-layout{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}.crb-preview-page-list{display:flex;align-items:stretch;flex:none;gap:3px;min-height:38px;min-width:0;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;scrollbar-width:thin;border-bottom:1px solid var(--crb-border);background:var(--crb-panel);padding:5px 7px 0}.crb-preview-empty-list{color:var(--crb-subtle);font-size:12px;line-height:22px;margin:3px 5px 7px}.crb-preview-page{display:flex;align-items:center;flex:0 0 auto;gap:7px;min-width:120px;max-width:260px;border:1px solid transparent;border-bottom:2px solid transparent;border-radius:6px 6px 0 0;background:transparent;color:inherit;text-align:left;padding:8px 10px;cursor:pointer}.crb-preview-page:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}.crb-preview-page:focus-visible,.crb-preview-button:focus-visible,.crb-preview-follow input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--crb-primary));outline-offset:-2px}.crb-preview-page.is-selected{border-color:var(--crb-border);border-bottom-color:var(--crb-primary);background:var(--dsw-alias-bg-base,#fff)}.crb-preview-page-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-weight:500}.crb-preview-page-meta{flex:none;max-width:82px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--crb-subtle);font-size:10px}.crb-preview-tab-indicator{flex:none;width:7px;height:7px;border-radius:50%;background:var(--crb-primary)}.crb-preview-tab-indicator.is-human{background:var(--dsw-alias-state-success-primary,#28a269)}.crb-preview-tab-indicator.is-script{border-radius:2px;background:var(--dsw-alias-state-warning-primary,#a66b00)}.crb-preview-view{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;background:#111}.crb-preview-stage{position:relative;display:flex;align-items:center;justify-content:center;flex:1;min-width:0;min-height:160px;overflow:hidden;background:var(--dsw-alias-bg-inverse,#111);touch-action:none}.crb-preview-frame{display:block;max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain;user-select:none}.crb-preview-frame.is-stale{filter:saturate(.35);opacity:.72}.crb-preview-stage.is-interactive{cursor:default}.crb-preview-placeholder{display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary,#aaa);font-size:12px}.crb-preview-placeholder-icon{font-size:24px}.crb-preview-input-sink{position:absolute;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none}.crb-preview-footer{display:flex;align-items:center;gap:8px;min-height:30px;padding:5px 9px;color:var(--crb-subtle);font-size:11px;background:var(--crb-panel);border-top:1px solid var(--crb-border)}.crb-preview-url{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}.crb-preview-dimensions,.crb-preview-stale,.crb-preview-readonly{flex:none}.crb-preview-stale,.crb-preview-readonly{color:var(--dsw-alias-state-warning-primary,#a66b00)}
.crb-preview-actions{display:flex;align-items:center;gap:8px;min-height:42px;padding:7px 10px;border-top:1px solid var(--crb-border);background:var(--crb-panel)}.crb-preview-follow{display:inline-flex;align-items:center;gap:6px;color:var(--crb-subtle);font-size:12px;cursor:pointer}.crb-preview-follow input{accent-color:var(--crb-primary)}.crb-preview-action-spacer{flex:1}.crb-preview-button{border:1px solid var(--crb-border);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-control,var(--crb-panel));color:inherit;min-height:28px;padding:4px 9px;cursor:pointer;font:inherit}.crb-preview-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}.crb-preview-button:disabled{cursor:default;opacity:.55}.crb-preview-button-primary{border-color:color-mix(in srgb,var(--crb-primary),transparent 45%);color:var(--crb-primary)}.crb-preview-reconnect{min-width:28px;padding:3px;font-size:16px;line-height:18px}.crb-preview-action-note{color:var(--crb-subtle);font-size:11px}.crb-preview-error{flex:none;margin:0;padding:5px 10px;color:var(--dsw-alias-state-error-primary,#d04444);font-size:11px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#d04444),transparent 65%);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d04444),transparent 94%)}
@media(max-width:560px){.crb-preview-page{min-width:100px;max-width:200px}.crb-preview-page-meta{display:none}.crb-preview-actions{flex-wrap:wrap}.crb-preview-action-spacer{display:none}}
`

    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector('style[data-plugin-css="dsh-crawshrimp-browser-preview"]')
      if (existing) return () => {}
      const style = document.createElement('style')
      style.dataset.pluginCss = 'dsh-crawshrimp-browser-preview'
      style.dataset.plugin = 'dsh-crawshrimp-browser'
      style.textContent = styleText
      document.head.appendChild(style)
      return () => style.remove()
    }

    const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'connection']

    function apply(ctx) {
      const translate = ctx.locale.bind(LOCALE_NS)
      const definition = {
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'extension',
        title: () => translate('tab.title'),
        guide: [{
          id: 'open',
          order: 20,
          title: () => translate('guide.title'),
          description: () => translate('guide.description'),
          icon: PreviewIcon,
        }],
      }
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'crawshrimp-browser: locale')
      ctx.effect(() => ctx.sidebarRightTabs.register(definition), 'crawshrimp-browser: tab type')
      const Body = (props) => h(PreviewBody, { ...props, connection: ctx.connection })
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        locale: LOCALE_NS,
      }, Body)), 'crawshrimp-browser: tab body')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TAB_ID,
        locale: LOCALE_NS,
      }, PreviewTitle)), 'crawshrimp-browser: tab title')
      ctx.effect(() => installStyles(), 'crawshrimp-browser: styles')
    }

    return {
      inject,
      apply,
      __test: {
        MAX_FRAME_DATA_URL_LENGTH,
        normalizePage,
        normalizePages,
        isScriptPage,
        pageControlKey,
        safeFrame,
        parseMessage,
        mapContainPoint,
        modifierMask,
        createPreviewChannel,
      },
    }
  },
})
