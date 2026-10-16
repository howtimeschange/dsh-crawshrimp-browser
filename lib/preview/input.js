/**
 * The preview client is deliberately allowed to send a small, typed input
 * vocabulary.  It must never be able to choose an arbitrary CDP method.
 */

const MAX_PENDING_INPUT = 64
const MAX_TEXT_LENGTH = 65536
const MAX_FIELD_LENGTH = 64
const MAX_WHEEL_DELTA = 10000

const MOUSE_BUTTONS = new Set(['none', 'left', 'middle', 'right'])
const MOUSE_TYPES = new Set(['mouseMoved', 'mousePressed', 'mouseReleased'])
const KEY_TYPES = new Set(['rawKeyDown', 'keyUp'])
const EDIT_COMMANDS = new Set(['selectAll', 'copy', 'cut'])

function invalid(message) {
  throw new Error(message)
}

function finiteNumber(value, message) {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(message)
  return value
}

function integerInRange(value, min, max, message) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(message)
  return value
}

function getViewport(viewport) {
  const value = typeof viewport === 'function' ? viewport() : viewport
  if (!value || typeof value !== 'object') invalid('无效的页面视口')
  const width = finiteNumber(Number(value.width), '无效的页面视口')
  const height = finiteNumber(Number(value.height), '无效的页面视口')
  if (width <= 0 || height <= 0) invalid('无效的页面视口')
  return { width, height }
}

function inputCommand(event, viewport) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) invalid('无效的浏览器输入')

  if (event.kind === 'release') {
    return null
  }

  const modifiers = event.modifiers === undefined ? 0 : Number(event.modifiers)
  integerInRange(modifiers, 0, 15, '无效的修饰键')

  if (event.kind === 'mouse' || event.kind === 'wheel') {
    const view = getViewport(viewport)
    const x = finiteNumber(event.x, '输入坐标超出页面')
    const y = finiteNumber(event.y, '输入坐标超出页面')
    if (x < 0 || y < 0 || x >= view.width || y >= view.height) invalid('输入坐标超出页面')

    const button = event.button === undefined || event.button === '' ? 'none' : event.button
    if (typeof button !== 'string' || !MOUSE_BUTTONS.has(button)) invalid('无效的鼠标按钮')
    const buttons = event.buttons === undefined ? 0 : Number(event.buttons)
    integerInRange(buttons, 0, 7, '无效的鼠标状态')
    const base = { x, y, modifiers, button, buttons }

    if (event.kind === 'wheel') {
      const deltaX = finiteNumber(event.deltaX, '无效的滚动距离')
      const deltaY = finiteNumber(event.deltaY, '无效的滚动距离')
      if (Math.abs(deltaX) > MAX_WHEEL_DELTA || Math.abs(deltaY) > MAX_WHEEL_DELTA) invalid('无效的滚动距离')
      return ['Input.dispatchMouseEvent', { ...base, type: 'mouseWheel', deltaX, deltaY }]
    }

    if (typeof event.type !== 'string' || !MOUSE_TYPES.has(event.type)) invalid('无效的鼠标事件')
    const clickCount = event.clickCount === undefined ? 0 : Number(event.clickCount)
    integerInRange(clickCount, 0, 3, '无效的点击次数')
    return ['Input.dispatchMouseEvent', { ...base, type: event.type, clickCount }]
  }

  if (event.kind === 'text') {
    if (typeof event.text !== 'string' || event.text.length === 0 || event.text.length > MAX_TEXT_LENGTH) {
      invalid('无效的输入文本')
    }
    return ['Input.insertText', { text: event.text }]
  }

  if (event.kind === 'key') {
    if (typeof event.type !== 'string' || !KEY_TYPES.has(event.type)) invalid('无效的键盘事件')
    if (typeof event.key !== 'string' || event.key.length === 0 || event.key.length > MAX_FIELD_LENGTH) invalid('无效的键盘事件')
    if (typeof event.code !== 'string' || event.code.length === 0 || event.code.length > MAX_FIELD_LENGTH) invalid('无效的键盘事件')
    const keyCode = event.keyCode === undefined ? 0 : Number(event.keyCode)
    integerInRange(keyCode, 0, 255, '无效的键码')
    if (event.repeat !== undefined && typeof event.repeat !== 'boolean') invalid('无效的键盘重复标记')
    const commands = event.command === undefined || event.command === '' ? [] : [event.command]
    if (commands.some((command) => typeof command !== 'string' || !EDIT_COMMANDS.has(command))) invalid('无效的编辑命令')
    const enter = event.type === 'rawKeyDown' && event.key === 'Enter'
    return ['Input.dispatchKeyEvent', {
      type: enter ? 'keyDown' : event.type,
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: keyCode,
      modifiers,
      autoRepeat: event.repeat === true,
      ...(enter ? { text: '\r', unmodifiedText: '\r' } : {}),
      ...(commands.length ? { commands } : {}),
    }]
  }

  invalid('不支持的浏览器输入')
}

function safeActive(isActive) {
  try {
    return typeof isActive === 'function' ? Boolean(isActive()) : true
  } catch {
    return false
  }
}

/**
 * Create one serial input bridge for one page.  `send` receives only the
 * method/params pair produced by inputCommand.  The bridge remembers keys
 * and buttons before sending: a command timeout cannot prove that Chrome did
 * not apply the command, so the next release must still compensate for it.
 */
function createBrowserInputSession(send, isActive, viewport) {
  if (typeof send !== 'function') throw new TypeError('send must be a function')

  let queue = Promise.resolve()
  let pending = 0
  let disposed = false
  const keys = new Map()
  const buttons = new Map()

  async function sendRelease() {
    const releases = [
      ...[...buttons.values()].map((params) => Promise.resolve().then(() => send('Input.dispatchMouseEvent', {
        ...params,
        type: 'mouseReleased',
        buttons: 0,
        modifiers: 0,
      }))),
      ...[...keys.values()].map((params) => Promise.resolve().then(() => send('Input.dispatchKeyEvent', {
        ...params,
        type: 'keyUp',
        modifiers: 0,
        commands: [],
      }))),
    ]
    await Promise.allSettled(releases)
    buttons.clear()
    keys.clear()
  }

  function inactiveResult() {
    return { ok: false, error: '浏览器画面已关闭，请重新打开' }
  }

  const session = {
    dispatch(event, activeOverride) {
      const activeForCommand = () => safeActive(isActive) && safeActive(activeOverride)
      let command
      try {
        command = inputCommand(event, viewport)
      } catch (error) {
        return Promise.resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      if (disposed || !activeForCommand()) return Promise.resolve(inactiveResult())
      if (pending >= MAX_PENDING_INPUT) return Promise.resolve({ ok: false, error: '浏览器输入繁忙，请稍后操作' })

      pending += 1
      const result = queue.then(async () => {
        if (disposed || !activeForCommand()) return inactiveResult()
        if (!command) {
          await sendRelease()
          return { ok: true }
        }

        const [method, params] = command
        if (params.type === 'mousePressed') buttons.set(params.button, params)
        if (params.type === 'rawKeyDown' || params.type === 'keyDown') keys.set(params.code, params)
        if (params.type === 'mouseMoved') {
          for (const [button, value] of buttons) buttons.set(button, { ...value, x: params.x, y: params.y })
        }
        try {
          await send(method, params)
          if (params.type === 'mouseReleased') buttons.delete(params.button)
          if (params.type === 'keyUp') keys.delete(params.code)
          return { ok: true }
        } catch (error) {
          return { ok: false, error: `浏览器输入未确认：${error instanceof Error ? error.message : String(error)}` }
        }
      }).finally(() => {
        pending -= 1
      })
      queue = result.catch(() => {})
      return result
    },

    async release() {
      const result = queue.then(() => sendRelease())
      queue = result.catch(() => {})
      await result
    },

    async dispose() {
      disposed = true
      const result = queue.then(() => sendRelease())
      queue = result.catch(() => {})
      await result
    },

    get pending() {
      return pending
    },
  }

  return session
}

export { inputCommand, createBrowserInputSession }
export default inputCommand
