import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, lstat, realpath, readFile, link, unlink, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

/**
 * File transfers intentionally live outside BrowserManager's tool plumbing.
 * The class accepts a plugin-owned Playwright Page and can therefore be used
 * by a future tool without giving that tool a way to discover arbitrary
 * browser targets.
 */

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 5
const PREFIX_BYTES = 8 * 1024
const MAX_UPLOAD_FILES = 20
const MAX_UPLOAD_TOTAL_BYTES = 64 * 1024 * 1024

const MAGIC_TYPES = Object.freeze({
  png: { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  jpeg: { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  jpg: { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  gif: { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  pdf: { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  zip: { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  gzip: { mime: 'application/gzip', bytes: [0x1f, 0x8b] },
  webp: { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], riff: [0x57, 0x45, 0x42, 0x50] },
  mp3: { mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] },
  mp4: { mime: 'video/mp4', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
})

const MIME_BY_EXTENSION = Object.freeze({
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
})

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function expandPath(value) {
  const valueText = text(value)
  if (!valueText) return ''
  if (valueText === '~') return homedir()
  if (valueText.startsWith('~/')) return join(homedir(), valueText.slice(2))
  return valueText
}

function inside(base, candidate) {
  const distance = relative(base, candidate)
  return distance === '' || (distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance))
}

function abortError(message = 'Browser transfer cancelled') {
  const error = new Error(message)
  error.name = 'AbortError'
  error.code = 'TRANSFER_CANCELLED'
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError()
}

function normalizeError(error, fallbackCode = 'TRANSFER_FAILED') {
  if (error?.name === 'AbortError' || error?.code === 'TRANSFER_CANCELLED') return error
  if (error instanceof BrowserTransferError) return error
  const wrapped = new BrowserTransferError(fallbackCode, error instanceof Error ? error.message : String(error))
  wrapped.cause = error
  return wrapped
}

function normalizeMime(value) {
  const candidate = text(value).toLowerCase()
  return candidate ? candidate.split(';', 1)[0].trim() : ''
}

function normalizeExpectedMime(value) {
  const values = Array.isArray(value) ? value : [value]
  return values.map(normalizeMime).filter(Boolean)
}

function expectedValue(args, names) {
  for (const name of names) {
    if (args && args[name] !== undefined && args[name] !== null && args[name] !== '') return args[name]
  }
  return undefined
}

function isPage(value) {
  return Boolean(value && typeof value.locator === 'function' && typeof value.url === 'function')
}

function parseExpectedMagic(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return { bytes: [...value], offset: 0, label: 'bytes' }
  if (Array.isArray(value) && value.every(item => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return { bytes: value, offset: 0, label: 'bytes' }
  }
  if (typeof value === 'object') {
    const source = value.bytes ?? value.hex
    const parsed = parseExpectedMagic(source)
    if (!parsed) throw new BrowserTransferError('MAGIC_INVALID', 'magic must contain bytes or a hexadecimal prefix')
    const offset = Number.isSafeInteger(value.offset) && value.offset >= 0 ? value.offset : parsed.offset
    return { ...parsed, offset, label: text(value.name) || parsed.label }
  }
  const name = text(value).toLowerCase()
  if (name === 'json' || name === 'text') return { classification: name, label: name, bytes: [] }
  if (MAGIC_TYPES[name]) return { ...MAGIC_TYPES[name], offset: MAGIC_TYPES[name].offset || 0, label: name }
  if (/^(?:0x)?[0-9a-f]+$/i.test(name) && name.length % 2 === 0) {
    const hex = name.replace(/^0x/, '')
    return { bytes: [...Buffer.from(hex, 'hex')], offset: 0, label: `0x${hex}` }
  }
  throw new BrowserTransferError('MAGIC_INVALID', 'magic must be a known type or an even-length hexadecimal prefix')
}

function magicFor(prefix) {
  const bytes = [...prefix]
  for (const [name, definition] of Object.entries(MAGIC_TYPES)) {
    const offset = definition.offset || 0
    const expected = definition.bytes
    if (bytes.slice(offset, offset + expected.length).every((byte, index) => byte === expected[index])) {
      if (definition.riff && !definition.riff.every((byte, index) => bytes[index + 8] === byte)) continue
      return { name, mime: definition.mime }
    }
  }
  const first = String.fromCharCode(...bytes.slice(0, 64))
  if (/^\s*[\[{]/.test(first)) return { name: 'json', mime: 'application/json' }
  if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(first)) return { name: 'html', mime: 'text/html' }
  if (bytes.length && bytes.every(byte => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127))) {
    return { name: 'text', mime: 'text/plain' }
  }
  return { name: 'unknown', mime: '' }
}

function expectedHash(value) {
  const candidate = text(value).toLowerCase().replace(/^sha256:/, '')
  if (!candidate) return ''
  if (!/^[0-9a-f]{64}$/.test(candidate)) throw new BrowserTransferError('HASH_INVALID', 'sha256 must be a 64-character hexadecimal digest')
  return candidate
}

function normalizeMax(value, fallback, label) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new BrowserTransferError('CONFIG_INVALID', `${label} must be a positive integer`)
  return number
}

function safeFilename(value, fallback = 'download.bin') {
  const candidate = basename(text(value)).replace(/[\u0000\r\n]/g, '').trim()
  return candidate && candidate !== '.' && candidate !== '..' ? candidate : fallback
}

function headerValue(headers, name) {
  if (!headers) return ''
  if (typeof headers.get === 'function') return headers.get(name) || ''
  return headers[name] || headers[name.toLowerCase()] || ''
}

function toNodeStream(stream) {
  if (!stream) throw new BrowserTransferError('DOWNLOAD_EMPTY', 'download response had no body')
  if (typeof stream[Symbol.asyncIterator] === 'function') return stream
  if (typeof Readable.fromWeb === 'function') return Readable.fromWeb(stream)
  throw new BrowserTransferError('DOWNLOAD_EMPTY', 'download response body is not streamable')
}

function pageEventWaiter(page, event, { timeout, signal } = {}) {
  // Playwright's waitForEvent promise cannot be cancelled.  Use an explicit
  // listener for real Pages so aborts and timeouts always detach it.  The
  // fallback keeps this helper usable with small Page doubles in unit tests.
  if (typeof page?.on !== 'function' || typeof page?.off !== 'function') {
    const promise = page.waitForEvent(event, { timeout })
    return { promise, cancel() {} }
  }
  let settled = false
  let timer
  let onAbort
  let handler
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
    handler = value => finish(undefined, value)
    page.on(event, handler)
    if (timeout > 0) timer = setTimeout(() => finish(new BrowserTransferError('TRANSFER_TIMEOUT', `${event} timed out`)), timeout)
    onAbort = () => finish(abortError())
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  function finish(error, value) {
    if (settled) return
    settled = true
    clearTimeout(timer)
    page.off(event, handler)
    signal?.removeEventListener('abort', onAbort)
    if (error) rejectPromise(error)
    else resolvePromise(value)
  }
  return { promise, cancel: () => finish(abortError('Browser transfer event wait cancelled')) }
}

function receiptUrl(value) {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/auth|credential|csrf|key|password|secret|session|signature|ticket|token/i.test(key)) {
        url.searchParams.set(key, '[REDACTED]')
      }
    }
    return url.toString()
  } catch {
    return ''
  }
}

function contentDispositionFilename(value) {
  const candidate = text(value)
  if (!candidate) return ''
  const encoded = candidate.match(/filename\*=UTF-8''([^;]+)/i)
  if (encoded) {
    try { return safeFilename(decodeURIComponent(encoded[1])) } catch {}
  }
  const quoted = candidate.match(/filename\s*=\s*"([^"]+)"/i) || candidate.match(/filename\s*=\s*([^;]+)/i)
  return quoted ? safeFilename(quoted[1]) : ''
}

function extensionMime(filename) {
  return MIME_BY_EXTENSION[extname(filename).toLowerCase()] || ''
}

export class BrowserTransferError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BrowserTransferError'
    this.code = code
  }
}

export class BrowserTransfers {
  constructor(options = {}, browserManager = undefined) {
    // Accept both new BrowserTransfers({ ... }) and the convenient
    // BrowserTransfers(config, browserManager) form used by plugin wiring.
    if (options && typeof options === 'object' && options.sessions instanceof Set && !options.workspaceDir) {
      browserManager = options
      options = {}
    }
    if (options?.config && !options.workspaceDir) options = { ...options.config, ...options }
    this.browserManager = options.browserManager || options.manager || browserManager
    this.workspaceDir = resolve(expandPath(options.workspaceDir) || join(homedir(), '.dsh-crawshrimp-browser'))
    this.artifactDirectory = text(options.artifactDirectory || options.artifactDir) || join('artifacts', 'browser-transfers')
    this.maxBytes = normalizeMax(options.maxBytes ?? options.maxDownloadBytes, DEFAULT_MAX_BYTES, 'maxBytes')
    this.maxUploadBytes = normalizeMax(options.maxUploadBytes, this.maxBytes, 'maxUploadBytes')
    this.timeoutMs = normalizeMax(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs')
    this.allowUnownedPage = options.allowUnownedPage === true
    this.ownedPage = typeof options.ownedPage === 'function' ? options.ownedPage : undefined
    this.disposed = false
  }

  async dispose() { this.disposed = true }

  async workspaceRoot() {
    if (this.disposed) throw new BrowserTransferError('DISPOSED', 'browser transfers is disposed')
    await mkdir(this.workspaceDir, { recursive: true })
    try {
      const root = await realpath(this.workspaceDir)
      const info = await lstat(root)
      if (!info.isDirectory()) throw new BrowserTransferError('WORKSPACE_INVALID', 'workspaceDir must be a directory')
      return root
    } catch (error) {
      if (error instanceof BrowserTransferError) throw error
      throw new BrowserTransferError('WORKSPACE_INVALID', `workspaceDir is not usable: ${error.message}`)
    }
  }

  async assertInputPath(pathname, label = 'path') {
    const root = await this.workspaceRoot()
    const supplied = text(pathname)
    if (!supplied || supplied.includes('\u0000')) throw new BrowserTransferError('PATH_INVALID', `${label} is required and must not contain NUL bytes`)
    const candidate = resolve(root, supplied)
    if (!inside(root, candidate)) throw new BrowserTransferError('PATH_OUTSIDE_WORKSPACE', `${label} must stay inside workspaceDir`)
    let info
    try { info = await lstat(candidate) } catch (error) { throw new BrowserTransferError('PATH_INVALID', `${label} is not readable: ${error.message}`) }
    if (info.isSymbolicLink()) throw new BrowserTransferError('SYMLINK_NOT_ALLOWED', `${label} must not be a symbolic link`)
    if (!info.isFile()) throw new BrowserTransferError('PATH_INVALID', `${label} must point to a regular file`)
    let resolvedPath
    try { resolvedPath = await realpath(candidate) } catch (error) { throw new BrowserTransferError('PATH_INVALID', `${label} cannot be resolved: ${error.message}`) }
    if (!inside(root, resolvedPath)) throw new BrowserTransferError('PATH_OUTSIDE_WORKSPACE', `${label} resolves outside workspaceDir`)
    return { root, path: resolvedPath, info }
  }

  async ensureOutputDirectory(root, directory) {
    const relativeDirectory = text(directory)
    if (!relativeDirectory || relativeDirectory.includes('\u0000')) throw new BrowserTransferError('PATH_INVALID', 'output directory is invalid')
    const candidate = resolve(root, relativeDirectory)
    if (!inside(root, candidate)) throw new BrowserTransferError('PATH_OUTSIDE_WORKSPACE', 'output path must stay inside workspaceDir')
    const segments = relative(root, candidate).split(sep).filter(Boolean)
    let current = root
    for (const segment of segments) {
      current = join(current, segment)
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink() || !info.isDirectory()) throw new BrowserTransferError('SYMLINK_NOT_ALLOWED', 'output directory must not contain symlinks')
      } catch (error) {
        if (error?.code === 'ENOENT') await mkdir(current)
        else throw error
      }
    }
    return candidate
  }

  async outputPath(args, suggestedFilename = 'download.bin') {
    const root = await this.workspaceRoot()
    const requested = text(expectedValue(args, ['outputPath', 'destination', 'targetPath']))
    if (requested) {
      const candidate = resolve(root, requested)
      if (!inside(root, candidate)) throw new BrowserTransferError('PATH_OUTSIDE_WORKSPACE', 'outputPath must stay inside workspaceDir')
      await this.ensureOutputDirectory(root, relative(root, dirname(candidate)) || '.')
      try {
        const info = await lstat(candidate)
        if (info.isSymbolicLink()) throw new BrowserTransferError('SYMLINK_NOT_ALLOWED', 'outputPath must not be a symbolic link')
        if (!info.isFile()) throw new BrowserTransferError('PATH_INVALID', 'outputPath must point to a regular file')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      return { root, path: candidate, relative: relative(root, candidate) }
    }
    const directory = await this.ensureOutputDirectory(root, this.artifactDirectory)
    const filename = safeFilename(suggestedFilename, 'download.bin')
    const path = join(directory, `${Date.now()}-${randomUUID()}-${filename}`)
    return { root, path, relative: relative(root, path) }
  }

  pageIsOwned(page) {
    if (!page) return false
    if (this.ownedPage) return Boolean(this.ownedPage(page))
    if (this.allowUnownedPage) return true
    const manager = this.browserManager
    if (!manager) return true
    for (const state of manager.sessions || []) {
      for (const record of state.pages?.values?.() || []) {
        if (record.page === page && !record.closed && !state.closed) return true
      }
    }
    return false
  }

  async resolvePage(args = {}, execution = undefined) {
    let page = args.page || args.pageObject
    if (!page && this.browserManager && execution?.agent) {
      const state = await this.browserManager.existingSessionFor(execution.agent, execution.signal)
      if (state) page = this.browserManager.pageFor(state, args.pageId)
    }
    if (!page || typeof page.locator !== 'function') throw new BrowserTransferError('PAGE_INVALID', 'a Playwright Page is required')
    if (!this.pageIsOwned(page)) throw new BrowserTransferError('PAGE_NOT_OWNED', 'transfers only accept a plugin-owned browser page')
    return page
  }

  async withAbort(signal, operation) {
    throwIfAborted(signal)
    if (!signal) return operation()
    let onAbort
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(abortError())
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try { return await Promise.race([Promise.resolve().then(operation), aborted]) }
    finally { signal.removeEventListener('abort', onAbort) }
  }

  async inspectFile(pathname, { expected = {}, actualMime = '', actualHash = '', actualBytes = undefined } = {}) {
    const info = await lstat(pathname)
    const bytes = actualBytes ?? info.size
    const maxBytes = normalizeMax(expected.maxBytes ?? expected.max_bytes, this.maxBytes, 'maxBytes')
    if (bytes > maxBytes) throw new BrowserTransferError('FILE_TOO_LARGE', `file exceeds maxBytes (${maxBytes})`)
    const expectedSize = expectedValue(expected, ['expectedSize', 'size', 'bytes'])
    if (expectedSize !== undefined && Number(bytes) !== Number(expectedSize)) throw new BrowserTransferError('SIZE_MISMATCH', `file size ${bytes} does not match expected size ${expectedSize}`)
    const minimum = expectedValue(expected, ['minBytes', 'minSize'])
    if (minimum !== undefined && bytes < Number(minimum)) throw new BrowserTransferError('SIZE_MISMATCH', `file size ${bytes} is below minimum ${minimum}`)
    const prefix = await readFile(pathname, { encoding: null, flag: 'r' }).then(buffer => buffer.subarray(0, PREFIX_BYTES))
    const magic = magicFor(prefix)
    const rawMagic = expectedValue(expected, ['expectedMagic', 'magic', 'magicHex'])
    const expectedMagic = parseExpectedMagic(rawMagic)
    if (expectedMagic) {
      const content = await readFile(pathname, { encoding: null, flag: 'r' }).then(buffer => buffer.subarray(0, expectedMagic.offset + expectedMagic.bytes.length))
      const matches = expectedMagic.classification
        ? magic.name === expectedMagic.classification
        : expectedMagic.bytes.every((byte, index) => content[expectedMagic.offset + index] === byte)
      if (!matches) throw new BrowserTransferError('MAGIC_MISMATCH', `file magic does not match ${expectedMagic.label}`)
    }
    const digest = actualHash || await hashFile(pathname)
    const wantedHash = expectedHash(expectedValue(expected, ['expectedSha256', 'sha256', 'hash']))
    if (wantedHash && digest !== wantedHash) throw new BrowserTransferError('HASH_MISMATCH', 'sha256 does not match expected hash')
    const extensionType = extensionMime(expected.filename || '')
    // Generic text magic cannot distinguish CSV from plain text.  Prefer an
    // explicit text extension for those payloads while retaining binary magic
    // (PNG/PDF/ZIP/etc.) as the stronger signal.
    const inferredMime = magic.name === 'text' && extensionType ? extensionType : magic.mime || extensionType
    const mime = normalizeMime(actualMime) || inferredMime
    const expectedMimes = normalizeExpectedMime(expectedValue(expected, ['expectedMime', 'mime', 'contentType']))
    if (expectedMimes.length && !expectedMimes.includes(mime) && !(mime === 'application/octet-stream' && expectedMimes.includes(inferredMime))) {
      throw new BrowserTransferError('MIME_MISMATCH', `file MIME ${mime || 'unknown'} does not match expected MIME ${expectedMimes.join(', ')}`)
    }
    return { bytes, sha256: digest, mime, magic: magic.name, expectedMimes }
  }

  async publish(stream, args = {}, metadata = {}, signal = undefined) {
    const maxBytes = normalizeMax(expectedValue(args, ['maxBytes', 'max_bytes']), this.maxBytes, 'maxBytes')
    const suggested = safeFilename(args.filename || metadata.filename || 'download.bin')
    const target = await this.outputPath(args, suggested)
    const temp = join(dirname(target.path), `.${basename(target.path)}.${randomUUID()}.part`)
    let handle
    let bytes = 0
    const hash = createHash('sha256')
    try {
      throwIfAborted(signal)
      handle = await open(temp, 'wx', 0o600)
      for await (const chunk of toNodeStream(stream)) {
        throwIfAborted(signal)
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > maxBytes) throw new BrowserTransferError('FILE_TOO_LARGE', `file exceeds maxBytes (${maxBytes})`)
        hash.update(buffer)
        await handle.write(buffer)
      }
      await handle.sync()
      await handle.close()
      handle = undefined
      const digest = hash.digest('hex')
      const verified = await this.inspectFile(temp, {
        expected: { ...args, filename: suggested },
        actualMime: metadata.mime,
        actualHash: digest,
        actualBytes: bytes,
      })
      throwIfAborted(signal)
      // `link` publishes the already-validated temp inode without replacing an
      // existing regular file.  A final symlink check alone would still leave
      // a TOCTOU window before publication.
      try {
        const existing = await lstat(target.path)
        if (existing.isSymbolicLink()) throw new BrowserTransferError('SYMLINK_NOT_ALLOWED', 'outputPath must not be a symbolic link')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      let linked = false
      try {
        await link(temp, target.path)
        linked = true
        throwIfAborted(signal)
        await unlink(temp)
        linked = false
      } catch (error) {
        if (linked) await unlink(target.path).catch(() => {})
        if (error?.code === 'EEXIST') throw new BrowserTransferError('OUTPUT_EXISTS', 'outputPath already exists')
        throw error
      }
      return {
        path: target.relative,
        bytes,
        sha256: verified.sha256,
        mime: verified.mime,
        magic: verified.magic,
        filename: suggested,
        url: metadata.url || undefined,
      }
    } catch (error) {
      throw normalizeError(error)
    } finally {
      await handle?.close().catch(() => {})
      await rm(temp, { force: true }).catch(() => {})
    }
  }

  async upload(args = {}, execution = undefined, signalOverride = undefined) {
    // The capability tool calls upload(page, args, signal); the object form
    // remains useful for direct callers and focused tests.
    let page
    let signal
    if (isPage(args)) {
      page = await this.resolvePage({ page: args })
      args = execution && typeof execution === 'object' && !('aborted' in execution) ? execution : {}
      signal = signalOverride || (execution && typeof execution?.aborted === 'boolean' ? execution : undefined)
    } else {
      page = await this.resolvePage(args, execution)
      signal = execution?.signal || args.signal
    }
    const pathValues = Array.isArray(args.paths) ? args.paths : [expectedValue(args, ['filePath', 'path', 'sourcePath'])]
    if (!pathValues.length || pathValues.some(pathname => !text(pathname))) throw new BrowserTransferError('PATH_INVALID', 'paths must contain at least one workspace-relative file')
    if (pathValues.length > MAX_UPLOAD_FILES) throw new BrowserTransferError('UPLOAD_TOO_MANY_FILES', `upload accepts at most ${MAX_UPLOAD_FILES} files`)
    const sources = []
    let totalBytes = 0
    for (const pathname of pathValues) {
      const source = await this.assertInputPath(pathname, 'filePath')
      if (source.info.size > this.maxUploadBytes) throw new BrowserTransferError('FILE_TOO_LARGE', `upload exceeds maxUploadBytes (${this.maxUploadBytes})`)
      totalBytes += source.info.size
      if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) throw new BrowserTransferError('UPLOAD_TOTAL_TOO_LARGE', `upload exceeds total limit (${MAX_UPLOAD_TOTAL_BYTES} bytes)`)
      const filename = safeFilename(args.filename || basename(source.path))
      const inspected = await this.inspectFile(source.path, {
        expected: { ...args, filename },
        actualMime: extensionMime(filename),
        actualBytes: source.info.size,
      })
      sources.push({ source, filename, inspected })
    }
    const inputSelector = text(args.selector || args.input)
    const chooserSelector = text(args.chooserSelector || args.target)
    if (!inputSelector && !chooserSelector) throw new BrowserTransferError('SELECTOR_REQUIRED', 'selector or chooserSelector is required for upload')
    await this.withAbort(signal, async () => {
      try {
        if (inputSelector && !chooserSelector) {
          await page.locator(inputSelector).setInputFiles(sources.map(item => item.source.path))
          return
        }
        const waiter = pageEventWaiter(page, 'filechooser', { timeout: Number(args.timeoutMs || this.timeoutMs), signal })
        try {
          const [chooser] = await Promise.all([waiter.promise, page.locator(chooserSelector).click()])
          await chooser.setFiles(sources.map(item => item.source.path))
        } finally {
          waiter.cancel()
        }
      } catch (error) {
        throw normalizeError(error, 'UPLOAD_FAILED')
      }
    })
    const receipts = sources.map(({ source, filename, inspected }) => ({
      path: relative(source.root, source.path), bytes: source.info.size, sha256: inspected.sha256, mime: inspected.mime, filename,
    }))
    return {
      receipt: receipts.length === 1 ? receipts[0] : undefined,
      receipts,
      files: receipts,
      count: receipts.length,
    }
  }

  async fetchSameOrigin(page, urlValue, signal, timeoutMs) {
    let current
    try { current = new URL(urlValue, page.url()) } catch { throw new BrowserTransferError('URL_INVALID', 'url must be a valid http(s) URL') }
    if (!['http:', 'https:'].includes(current.protocol)) throw new BrowserTransferError('URL_INVALID', 'url must use http:// or https://')
    if (current.username || current.password) throw new BrowserTransferError('URL_INVALID', 'download URL must not contain credentials')
    let pageUrl
    try { pageUrl = new URL(page.url()) } catch { throw new BrowserTransferError('PAGE_URL_INVALID', 'owned page must have an http(s) URL') }
    if (pageUrl.username || pageUrl.password) throw new BrowserTransferError('PAGE_URL_INVALID', 'owned page URL must not contain credentials')
    if (current.origin !== pageUrl.origin) throw new BrowserTransferError('CROSS_ORIGIN', 'downloads must stay on the page origin')
    const context = page.context?.()
    const controller = new AbortController()
    let timer
    let returnedBody = false
    let cleaned = false
    let timedOut = false
    const onTimeout = () => { timedOut = true; controller.abort() }
    const onAbort = () => { controller.abort() }
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(onTimeout, timeoutMs)
    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        throwIfAborted(signal)
        let cookies = []
        if (context?.cookies) cookies = await context.cookies(current.toString())
        const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
        const response = await fetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: cookieHeader ? { cookie: cookieHeader } : undefined,
        })
        const location = response.headers.get('location')
        if (response.status >= 300 && response.status < 400 && location) {
          const next = new URL(location, current)
          if (next.username || next.password) throw new BrowserTransferError('URL_INVALID', 'download redirect must not contain credentials')
          if (next.origin !== pageUrl.origin) throw new BrowserTransferError('CROSS_ORIGIN', 'download redirect left the page origin')
          current = next
          continue
        }
        if (!response.ok) throw new BrowserTransferError('DOWNLOAD_HTTP', `download returned HTTP ${response.status}`)
        const contentLength = Number(response.headers.get('content-length'))
        if (Number.isSafeInteger(contentLength) && contentLength > this.maxBytes) throw new BrowserTransferError('FILE_TOO_LARGE', `file exceeds maxBytes (${this.maxBytes})`)
        returnedBody = true
        return {
          stream: response.body,
          url: receiptUrl(current.toString()),
          mime: normalizeMime(response.headers.get('content-type')),
          filename: contentDispositionFilename(response.headers.get('content-disposition')) || safeFilename(basename(current.pathname), 'download.bin'),
          cleanup,
          timedOut: () => timedOut,
        }
      }
      throw new BrowserTransferError('DOWNLOAD_REDIRECTS', 'download exceeded redirect limit')
    } catch (error) {
      if (timedOut && !signal?.aborted) throw new BrowserTransferError('DOWNLOAD_TIMEOUT', 'download timed out')
      throw normalizeError(error, 'DOWNLOAD_FAILED')
    } finally {
      if (!returnedBody) cleanup()
    }
  }

  async download(args = {}, execution = undefined, signalOverride = undefined) {
    if (isPage(args)) {
      const page = await this.resolvePage({ page: args })
      const transferArgs = execution && typeof execution === 'object' && !('aborted' in execution) ? execution : {}
      const signal = signalOverride || (execution && typeof execution?.aborted === 'boolean' ? execution : undefined)
      return transferArgs.selector || transferArgs.click || transferArgs.trigger === 'click'
        ? this.downloadClick(page, transferArgs, signal)
        : this.downloadUrlFromPage(page, transferArgs, signal)
    }
    if (args.selector || args.click || args.trigger === 'click') return this.downloadClick(args, execution)
    const page = await this.resolvePage(args, execution)
    const signal = execution?.signal || args.signal
    return this.downloadUrlFromPage(page, args, signal)
  }

  async downloadUrlFromPage(page, args = {}, signal = undefined) {
    const urlValue = expectedValue(args, ['url', 'downloadUrl'])
    if (!text(urlValue)) throw new BrowserTransferError('URL_INVALID', 'url is required for URL download')
    const result = await this.withAbort(signal, () => this.fetchSameOrigin(page, expectedValue(args, ['url', 'downloadUrl']), signal, Number(args.timeoutMs || this.timeoutMs)))
    try {
      const receipt = await this.publish(result.stream, args, result, signal)
      return { ...receipt, receipt }
    } catch (error) {
      if (result.timedOut?.() && !signal?.aborted) throw new BrowserTransferError('DOWNLOAD_TIMEOUT', 'download timed out')
      throw error
    } finally {
      result.cleanup?.()
    }
  }

  async downloadClick(args = {}, execution = undefined, signalOverride = undefined) {
    let page
    if (isPage(args)) {
      page = await this.resolvePage({ page: args })
      args = execution && typeof execution === 'object' && !('aborted' in execution) ? execution : {}
      execution = signalOverride
    } else page = await this.resolvePage(args, execution)
    const signal = execution?.signal || (execution && typeof execution?.aborted === 'boolean' ? execution : undefined) || args.signal
    const selector = text(args.selector || args.target)
    if (!selector) throw new BrowserTransferError('SELECTOR_REQUIRED', 'selector is required for click download')
    throwIfAborted(signal)
    const timeoutMs = Number(args.timeoutMs || this.timeoutMs)
    const controller = new AbortController()
    let timer
    let timedOut = false
    let settled = false
    let download
    let stream
    let rejectCancellation
    const cancellation = new Promise((_, reject) => { rejectCancellation = reject })
    const cancelDownload = () => {
      try { stream?.destroy?.() } catch {}
      try { return Promise.resolve(download?.cancel?.()).catch(() => {}) } catch { return Promise.resolve() }
    }
    const cancelWith = (error) => {
      if (settled) return
      settled = true
      controller.abort()
      void cancelDownload()
      rejectCancellation(error)
    }
    const onAbort = () => cancelWith(abortError())
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      timedOut = true
      cancelWith(new BrowserTransferError('DOWNLOAD_TIMEOUT', 'download timed out'))
    }, timeoutMs)
    const operation = (async () => {
      const waiter = pageEventWaiter(page, 'download', { timeout: 0, signal: controller.signal })
      try {
        const [item] = await Promise.all([waiter.promise, page.locator(selector).click()])
        download = item
        const failure = await Promise.race([Promise.resolve(item.failure()), cancellation])
        if (failure) throw new BrowserTransferError('DOWNLOAD_FAILED', failure)
        stream = await Promise.race([Promise.resolve(item.createReadStream()), cancellation])
        if (!stream) throw new BrowserTransferError('DOWNLOAD_EMPTY', 'browser download had no readable stream')
        const suggestedFilename = await Promise.race([Promise.resolve(item.suggestedFilename()), cancellation])
        const receipt = await this.publish(stream, args, {
          filename: safeFilename(suggestedFilename, 'download.bin'),
          url: receiptUrl(page.url()),
          // Download events do not expose the response MIME. inspectFile will
          // infer it from magic bytes and the suggested filename.
        }, controller.signal)
        return { ...receipt, receipt }
      } finally {
        waiter.cancel()
      }
    })()
    operation.catch(() => {})
    try {
      const result = await Promise.race([operation, cancellation])
      settled = true
      return result
    } catch (error) {
      if (timedOut) throw new BrowserTransferError('DOWNLOAD_TIMEOUT', 'download timed out')
      throw normalizeError(error, 'DOWNLOAD_FAILED')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      controller.abort()
      if (!settled || timedOut || signal?.aborted) void cancelDownload()
    }
  }

  async clickDownload(args = {}, execution = undefined) { return this.downloadClick(args, execution) }
  async downloadUrl(args = {}, execution = undefined) { return this.download(args, execution) }

  async verifyFile(args = {}, signal = undefined) {
    if (!args || typeof args !== 'object') throw new BrowserTransferError('CHECK_INVALID', 'file verification requires an object')
    throwIfAborted(signal)
    const source = await this.assertInputPath(expectedValue(args, ['path', 'filePath', 'artifactPath']), 'path')
    const result = await this.inspectFile(source.path, { expected: { ...args, filename: basename(source.path) } })
    throwIfAborted(signal)
    const receipt = { path: relative(source.root, source.path), ...result }
    return { ...receipt, receipt }
  }

  async validateFile(args = {}) { return this.verifyFile(args) }
}

async function hashFile(pathname) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(pathname)) hash.update(chunk)
  return hash.digest('hex')
}

export { hashFile, magicFor, inside as pathInsideWorkspace }
