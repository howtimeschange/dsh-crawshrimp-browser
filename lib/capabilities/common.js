import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, realpath, stat, open, link, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, join, relative, isAbsolute, sep, basename } from 'node:path'

export class CapabilityError extends Error {
  constructor(code, message) { super(message); this.name = 'CapabilityError'; this.code = code }
}

export function boundedInt(value, min, max, fallback) {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new CapabilityError('INVALID_LIMIT', `expected integer between ${min} and ${max}`)
  return n
}

const secretKey = /authorization|cookie|password|passwd|secret|token|api[-_]?key|csrf|xsrf|signature|session|ticket|credential/i
export function redact(value, depth = 0) {
  if (depth > 24) return '[DEPTH_LIMIT]'
  if (typeof value === 'string') {
    // Responses and evaluate results can contain JSON encoded as text. Redact
    // its fields before treating it as free text (including nested JSON text).
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { return JSON.stringify(redact(JSON.parse(value), depth + 1)) } catch {}
    }
    return value.replace(/([?&](?:[^=&]*(?:token|key|secret|password|signature|ticket|session|auth)[^=&]*)=)[^&#\s]*/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, '$1 [REDACTED]')
      .replace(/((?:[\w-]*(?:session|sid|token|secret|auth|csrf|xsrf|api[-_]?key|password|signature|ticket)[\w-]*)\s*=\s*)[^;\s,]+/gi, '$1[REDACTED]')
      .replace(/(["'][\w-]*(?:token|secret|password|authorization|cookie|session|api[-_]?key|csrf|xsrf|signature|ticket)[\w-]*["']\s*:\s*["'])[^"']*(["'])/gi, '$1[REDACTED]$2')
      .replace(/((?:password|secret|token|api[-_]?key|csrf|xsrf|authorization|cookie|signature)\s*[=:]\s*)[^\s,;"'<>]+/gi, '$1[REDACTED]')
  }
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? '[REDACTED]' : redact(item, depth + 1)]))
  return value
}

export function boundedJson(value, maxBytes = 2 * 1024 * 1024) {
  let text
  try { text = JSON.stringify(value) } catch { throw new CapabilityError('NON_JSON_RESULT', 'result must be JSON serializable') }
  if (text === undefined || Buffer.byteLength(text) > maxBytes) throw new CapabilityError('OUTPUT_TOO_LARGE', `JSON result exceeds ${maxBytes} bytes`)
  return JSON.parse(text)
}

export function workspacePath(config) {
  const text = config.workspaceDir || '~/.dsh-crawshrimp-browser'
  return resolve(text === '~' ? homedir() : text.startsWith('~/') ? join(homedir(), text.slice(2)) : text)
}
function inside(base, file) { const d = relative(base, file); return d === '' || (d !== '..' && !d.startsWith(`..${sep}`) && !isAbsolute(d)) }
export async function workspaceDirectory(config, parts) {
  await mkdir(workspacePath(config), { recursive: true })
  const base = await realpath(workspacePath(config))
  let dir = base
  for (const part of parts) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(part)) throw new CapabilityError('PATH_INVALID', 'invalid workspace directory')
    const candidate = join(dir, part)
    await mkdir(candidate, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    dir = await realpath(candidate)
    if (!inside(base, dir) || !(await stat(dir)).isDirectory()) throw new CapabilityError('PATH_ESCAPE', 'directory escapes workspace')
  }
  return dir
}
export async function workspaceFile(config, path, { maxBytes = 64 * 1024 * 1024 } = {}) {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\') || isAbsolute(path) || path.split('/').includes('..')) throw new CapabilityError('PATH_ESCAPE', 'path must be workspace relative')
  const base = await realpath(workspacePath(config))
  const file = await realpath(resolve(base, path))
  if (!inside(base, file)) throw new CapabilityError('PATH_ESCAPE', 'path resolves outside workspace')
  const info = await stat(file)
  if (!info.isFile() || info.size > maxBytes) throw new CapabilityError('FILE_INVALID', 'expected a regular file within size limit')
  return { file, path: relative(base, file), bytes: info.size }
}

export async function writeArtifact(config, namespace, bytes, { filename = 'evidence.json', signal } = {}) {
  signal?.throwIfAborted()
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (data.length > 64 * 1024 * 1024) throw new CapabilityError('OUTPUT_TOO_LARGE', 'artifact exceeds 64 MiB')
  const root = workspacePath(config)
  await mkdir(root, { recursive: true })
  const base = await realpath(root)
  let dir = base
  for (const part of ['artifacts', namespace]) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(part)) throw new CapabilityError('PATH_INVALID', 'invalid artifact namespace')
    const candidate = join(dir, part)
    await mkdir(candidate, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    dir = await realpath(candidate)
    if (!inside(base, dir) || !(await stat(dir)).isDirectory()) throw new CapabilityError('PATH_ESCAPE', 'artifact directory escapes workspace')
  }
  const safeName = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'artifact.json'
  const target = join(dir, `${Date.now()}-${randomUUID()}-${safeName}`)
  const temp = join(dir, `.${randomUUID()}.tmp`)
  let handle, linked = false
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(data, { signal }); await handle.close(); handle = undefined
    signal?.throwIfAborted()
    await link(temp, target); linked = true
    signal?.throwIfAborted()
    return { path: relative(base, target), bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }
  } catch (error) {
    if (linked) await unlink(target).catch(() => {})
    throw error
  } finally { await handle?.close().catch(() => {}); await unlink(temp).catch(() => {}) }
}
