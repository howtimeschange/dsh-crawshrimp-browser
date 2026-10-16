import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { parse } from 'yaml'
import { ScriptsError } from './errors.js'

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u
const MANIFEST_KEYS = new Set(['id', 'name', 'version', 'description', 'author', 'entry_url', 'tasks', 'skip_auth', 'trigger'])
const TASK_KEYS = new Set(['id', 'name', 'description', 'script', 'entry_url', 'params', 'skip_auth', 'trigger'])
const PARAM_KEYS = new Set(['id', 'type', 'label', 'default', 'required', 'min', 'max', 'options'])
const OPTION_KEYS = new Set(['value', 'label'])
const TRIGGER_KEYS = new Set(['type'])
const SUPPORTED_PARAM_TYPES = new Set(['text', 'textarea', 'number', 'select', 'radio', 'checkbox', 'date'])
const BACKEND_ONLY_PARAM_TYPES = new Set([
  'line_list', 'directory', 'week', 'month', 'date_range', 'week_range', 'month_range',
  'file_excel', 'file_images', 'file_zip', 'file_pdf', 'model_chain',
])
export const PORTABLE_GLOBALS = Object.freeze([
  'window.__PARAMS__',
  'window.__CRAWSHRIMP_PARAMS__',
  'window.__CRAWSHRIMP_PAGE__',
  'window.__CRAWSHRIMP_PHASE__',
  'window.__CRAWSHRIMP_SHARED__',
])

function assertRecord(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ScriptsError('MANIFEST_INVALID', message)
  return value
}

function assertString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new ScriptsError('MANIFEST_INVALID', `${label} must be a non-empty string`)
  return value.trim()
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') throw new ScriptsError('MANIFEST_INVALID', `${label} must be a boolean`)
  return value
}

function assertFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ScriptsError('MANIFEST_INVALID', `${label} must be a finite number`)
  return value
}

function assertSlug(value, label) {
  const text = assertString(value, label)
  if (!SLUG_PATTERN.test(text)) throw new ScriptsError('MANIFEST_INVALID', `${label} must match ${SLUG_PATTERN}`)
  return text
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) {
    throw new ScriptsError(
      'UNSUPPORTED_MANIFEST_FIELD',
      `${label} contains unsupported field(s): ${unknown.join(', ')}; migration: remove backend-only fields or use a portable page script with native DSH approval`,
    )
  }
}

function assertHttpUrl(value, label) {
  const text = assertString(value, label)
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new ScriptsError('MANIFEST_INVALID', `${label} must be an absolute http(s) URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ScriptsError('MANIFEST_INVALID', `${label} must use http or https`)
  }
  return parsed.toString()
}

function assertDate(value, label) {
  const text = assertString(value, label)
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) throw new ScriptsError('MANIFEST_INVALID', `${label} must use YYYY-MM-DD`)
  const parsed = new Date(`${text}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new ScriptsError('MANIFEST_INVALID', `${label} must be a valid calendar date`)
  }
  return text
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function unsupportedParamType(type, label) {
  if (BACKEND_ONLY_PARAM_TYPES.has(type)) {
    throw new ScriptsError(
      'UNSUPPORTED_PARAM_TYPE',
      `${label} uses backend-only parameter type "${type}"; migration: replace file/model/desktop inputs with a JSON value or a separate portable task, then pass it through crawshrimp_browser_script_run`,
    )
  }
  throw new ScriptsError('UNSUPPORTED_PARAM_TYPE', `${label} uses unsupported parameter type "${type}"; supported types: ${[...SUPPORTED_PARAM_TYPES].join(', ')}`)
}

function assertOptions(value, label) {
  if (!Array.isArray(value) || !value.length) throw new ScriptsError('MANIFEST_INVALID', `${label} must be a non-empty array`)
  const seen = new Set()
  return value.map((rawOption, index) => {
    assertRecord(rawOption, `${label}[${index}] must be an object`)
    rejectUnknownKeys(rawOption, OPTION_KEYS, `${label}[${index}]`)
    const optionValue = assertString(rawOption.value, `${label}[${index}].value`)
    const optionLabel = assertString(rawOption.label, `${label}[${index}].label`)
    if (seen.has(optionValue)) throw new ScriptsError('MANIFEST_INVALID', `${label} contains duplicate option value: ${optionValue}`)
    seen.add(optionValue)
    return Object.freeze({ value: optionValue, label: optionLabel })
  })
}

function validateParamValue(definition, value, label) {
  const type = definition.type
  if (type === 'text' || type === 'textarea') {
    if (typeof value !== 'string') throw new ScriptsError('PARAMS_INVALID', `${label} must be a string`)
    if (definition.required && !value.trim()) throw new ScriptsError('PARAMS_REQUIRED', `${label} is required`)
    return value
  }
  if (type === 'date') {
    if (typeof value !== 'string') throw new ScriptsError('PARAMS_INVALID', `${label} must be a YYYY-MM-DD string`)
    const normalized = assertDate(value, label)
    if (definition.required && !normalized) throw new ScriptsError('PARAMS_REQUIRED', `${label} is required`)
    return normalized
  }
  if (type === 'number') {
    const number = assertFiniteNumber(value, label)
    if (definition.min !== undefined && number < definition.min) throw new ScriptsError('PARAMS_OUT_OF_RANGE', `${label} must be at least ${definition.min}`)
    if (definition.max !== undefined && number > definition.max) throw new ScriptsError('PARAMS_OUT_OF_RANGE', `${label} must be at most ${definition.max}`)
    return number
  }
  if (type === 'select' || type === 'radio') {
    if (typeof value !== 'string') throw new ScriptsError('PARAMS_INVALID', `${label} must be one option value`)
    if (!definition.options.some((option) => option.value === value)) throw new ScriptsError('PARAMS_INVALID', `${label} must match one declared option value`)
    return value
  }
  if (type === 'checkbox') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new ScriptsError('PARAMS_INVALID', `${label} must be an array of option values`)
    const allowed = new Set(definition.options.map((option) => option.value))
    if (value.some((item) => !allowed.has(item))) throw new ScriptsError('PARAMS_INVALID', `${label} contains an undeclared option value`)
    if (definition.required && value.length === 0) throw new ScriptsError('PARAMS_REQUIRED', `${label} is required`)
    return [...value]
  }
  throw new ScriptsError('UNSUPPORTED_PARAM_TYPE', `${label} uses unsupported parameter type "${type}"`)
}

function parseParam(rawParam, index) {
  const label = `manifest.tasks[].params[${index}]`
  const param = assertRecord(rawParam, `${label} must be an object`)
  rejectUnknownKeys(param, PARAM_KEYS, label)
  const id = assertSlug(param.id, `${label}.id`)
  const type = assertString(param.type, `${label}.type`)
  if (!SUPPORTED_PARAM_TYPES.has(type)) unsupportedParamType(type, `${label}.type`)
  const fieldLabel = assertString(param.label, `${label}.label`)
  const required = param.required === undefined ? false : assertBoolean(param.required, `${label}.required`)
  const definition = { id, type, label: fieldLabel, required }
  if (Object.hasOwn(param, 'min')) {
    if (type !== 'number') throw new ScriptsError('UNSUPPORTED_MANIFEST_FIELD', `${label}.min is only supported for number parameters; migration: remove it or convert the field to number`)
    definition.min = assertFiniteNumber(param.min, `${label}.min`)
  }
  if (Object.hasOwn(param, 'max')) {
    if (type !== 'number') throw new ScriptsError('UNSUPPORTED_MANIFEST_FIELD', `${label}.max is only supported for number parameters; migration: remove it or convert the field to number`)
    definition.max = assertFiniteNumber(param.max, `${label}.max`)
  }
  if (definition.min !== undefined && definition.max !== undefined && definition.min > definition.max) {
    throw new ScriptsError('MANIFEST_INVALID', `${label}.min must not be greater than max`)
  }
  if (Object.hasOwn(param, 'options')) {
    if (!['select', 'radio', 'checkbox'].includes(type)) throw new ScriptsError('UNSUPPORTED_MANIFEST_FIELD', `${label}.options is only supported for select, radio, and checkbox parameters`)
    definition.options = assertOptions(param.options, `${label}.options`)
  } else if (['select', 'radio', 'checkbox'].includes(type)) {
    throw new ScriptsError('MANIFEST_INVALID', `${label}.options is required for ${type} parameters`)
  }
  if (Object.hasOwn(param, 'default')) {
    definition.default = cloneJson(param.default)
    validateParamValue(definition, definition.default, `${label}.default`)
  }
  return Object.freeze(definition)
}

function parseTrigger(value, label, fallback = { type: 'manual' }) {
  if (value === undefined) return Object.freeze({ ...fallback })
  const trigger = assertRecord(value, `${label} must be an object`)
  rejectUnknownKeys(trigger, TRIGGER_KEYS, label)
  const type = assertString(trigger.type, `${label}.type`)
  if (type !== 'manual') {
    throw new ScriptsError(
      'UNSUPPORTED_TRIGGER',
      `${label}.type "${type}" is unsupported; migration: use trigger.type: manual and invoke this DSH tool explicitly; interval/cron scheduling belongs to a host scheduler`,
    )
  }
  return Object.freeze({ type: 'manual' })
}

function relativePath(rawPath, label) {
  const text = assertString(rawPath, label).replaceAll('\\', '/')
  const parsed = normalize(text)
  if (isAbsolute(text) || parsed === '..' || parsed.startsWith(`..${normalize('/')}`) || text.split('/').includes('..')) {
    throw new ScriptsError('PATH_ESCAPE', `${label} must stay inside its adapter directory`)
  }
  if (text.includes('\0')) throw new ScriptsError('PATH_INVALID', `${label} contains a NUL byte`)
  return text
}

function isInside(base, candidate) {
  const distance = relative(base, candidate)
  return distance === '' || (distance !== '..' && !distance.startsWith(`..${normalize('/')}`) && !isAbsolute(distance))
}

async function realFileInside(base, rawPath, label) {
  const relativeName = relativePath(rawPath, label)
  let candidate
  try {
    candidate = await realpath(join(base, relativeName))
    const info = await stat(candidate)
    if (!info.isFile()) throw new Error('not a file')
  } catch (error) {
    if (error instanceof ScriptsError) throw error
    throw new ScriptsError('PATH_INVALID', `${label} does not point to a readable file: ${relativeName}`)
  }
  if (!isInside(base, candidate)) throw new ScriptsError('PATH_ESCAPE', `${label} resolves outside its adapter directory`)
  return candidate
}

async function realDirectory(pathname, label) {
  let candidate
  try {
    candidate = await realpath(pathname)
    const info = await stat(candidate)
    if (!info.isDirectory()) throw new Error('not a directory')
  } catch (error) {
    if (error instanceof ScriptsError) throw error
    throw new ScriptsError('ROOT_UNAVAILABLE', `${label} is not an existing directory: ${pathname}`)
  }
  return candidate
}

function validateTaskScriptContract(source, relativeName) {
  const compact = source.replace(/\s+/gu, ' ')
  const asyncIife = /\(\s*async\s*(?:(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|function(?:\s+[A-Za-z_$][\w$]*)?\s*\()/u.test(compact)
  const iifeCall = /\}\s*\)\s*\(\s*\)\s*;?\s*$/u.test(compact)
  if (!asyncIife || !iifeCall) {
    throw new ScriptsError('SCRIPT_CONTRACT_INVALID', `${relativeName} must be an async IIFE`)
  }
}

export async function loadAdapter(adapterDirectory, rootDirectory, limits = {}) {
  const adapterDir = await realDirectory(adapterDirectory, 'adapter directory')
  if (!isInside(rootDirectory, adapterDir)) throw new ScriptsError('PATH_ESCAPE', `adapter directory resolves outside configured root: ${adapterDirectory}`)
  const manifestPath = await realFileInside(adapterDir, 'manifest.yaml', 'manifest.yaml')
  let manifest
  try {
    manifest = parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    if (error instanceof ScriptsError) throw error
    throw new ScriptsError('MANIFEST_INVALID', `cannot parse ${manifestPath}: ${error.message}`)
  }
  assertRecord(manifest, `manifest.yaml must contain an object: ${adapterDir}`)
  rejectUnknownKeys(manifest, MANIFEST_KEYS, 'manifest.yaml')
  const id = assertSlug(manifest.id, 'manifest.id')
  const name = assertString(manifest.name, 'manifest.name')
  const version = manifest.version === undefined ? '1.0.0' : assertString(manifest.version, 'manifest.version')
  const entryUrl = assertHttpUrl(manifest.entry_url, 'manifest.entry_url')
  if (!Array.isArray(manifest.tasks) || !manifest.tasks.length) throw new ScriptsError('MANIFEST_INVALID', 'manifest.tasks must contain at least one task')
  const adapterSkipAuth = manifest.skip_auth === undefined ? false : assertBoolean(manifest.skip_auth, 'manifest.skip_auth')
  const adapterTrigger = parseTrigger(manifest.trigger, 'manifest.trigger')

  const seenTaskIds = new Set()
  const tasks = []
  for (const [index, rawTask] of manifest.tasks.entries()) {
    const task = assertRecord(rawTask, `manifest.tasks[${index}] must be an object`)
    rejectUnknownKeys(task, TASK_KEYS, `manifest.tasks[${index}]`)
    const taskId = assertSlug(task.id, `manifest.tasks[${index}].id`)
    if (seenTaskIds.has(taskId)) throw new ScriptsError('DUPLICATE_TASK', `duplicate task id: ${taskId}`)
    seenTaskIds.add(taskId)
    const taskName = assertString(task.name, `manifest.tasks[${index}].name`)
    const scriptName = relativePath(task.script, `manifest.tasks[${index}].script`)
    if (!scriptName.toLowerCase().endsWith('.js')) throw new ScriptsError('SCRIPT_INVALID', `${taskId} script must use the .js suffix`)
    const scriptPath = await realFileInside(adapterDir, scriptName, `${taskId} script`)
    const source = await readFile(scriptPath, 'utf8')
    const maxScriptBytes = limits.maxScriptBytes ?? Number.POSITIVE_INFINITY
    if (Buffer.byteLength(source, 'utf8') > maxScriptBytes) throw new ScriptsError('SCRIPT_TOO_LARGE', `${scriptName} exceeds maxScriptBytes (${maxScriptBytes})`)
    validateTaskScriptContract(source, scriptName)
    const taskEntryUrl = task.entry_url === undefined
      ? entryUrl
      : assertHttpUrl(task.entry_url, `manifest.tasks[${index}].entry_url`)
    const paramsDeclared = Object.hasOwn(task, 'params')
    if (paramsDeclared && !Array.isArray(task.params)) throw new ScriptsError('MANIFEST_INVALID', `manifest.tasks[${index}].params must be an array`)
    const params = paramsDeclared ? task.params.map((param, paramIndex) => parseParam(param, paramIndex)) : []
    const paramIds = new Set()
    for (const param of params) {
      if (paramIds.has(param.id)) throw new ScriptsError('DUPLICATE_PARAM', `duplicate parameter id: ${param.id}`)
      paramIds.add(param.id)
    }
    const skipAuth = task.skip_auth === undefined ? adapterSkipAuth : assertBoolean(task.skip_auth, `manifest.tasks[${index}].skip_auth`)
    const trigger = parseTrigger(task.trigger, `manifest.tasks[${index}].trigger`, adapterTrigger)
    tasks.push(Object.freeze({
      id: taskId,
      name: taskName,
      description: typeof task.description === 'string' ? task.description : '',
      script: scriptName,
      scriptPath,
      source,
      entryUrl: taskEntryUrl,
      params,
      paramsDeclared,
      skipAuth,
      trigger,
    }))
  }
  return Object.freeze({
    id,
    name,
    version,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    author: typeof manifest.author === 'string' ? manifest.author : '',
    entryUrl,
    skipAuth: adapterSkipAuth,
    trigger: adapterTrigger,
    adapterDir,
    tasks,
  })
}

async function adapterDirectories(rootDirectory) {
  const manifestAtRoot = join(rootDirectory, 'manifest.yaml')
  try {
    await stat(manifestAtRoot)
    return [rootDirectory]
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new ScriptsError('ROOT_UNAVAILABLE', `cannot inspect adapter root ${rootDirectory}: ${error.message}`)
  }
  let entries
  try {
    entries = await readdir(rootDirectory, { withFileTypes: true })
  } catch (error) {
    throw new ScriptsError('ROOT_UNAVAILABLE', `cannot scan adapter root ${rootDirectory}: ${error.message}`)
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(rootDirectory, entry.name)
    try {
      await stat(join(candidate, 'manifest.yaml'))
      candidates.push(candidate)
    } catch (error) {
      // Adapter roots may also contain README/assets or other unrelated
      // directories. They are ignored unless they actually declare a
      // manifest; errors other than a missing manifest remain actionable.
      if (error?.code !== 'ENOENT') throw new ScriptsError('ROOT_UNAVAILABLE', `cannot inspect adapter directory ${candidate}: ${error.message}`)
    }
  }
  return candidates
}

export async function discoverAdapters(configuredRoots, limits = {}) {
  const roots = Array.isArray(configuredRoots) ? configuredRoots : []
  const adapters = new Map()
  for (const rawRoot of roots) {
    const root = await realDirectory(resolve(String(rawRoot)), 'adapter root')
    for (const candidate of await adapterDirectories(root)) {
      const adapter = await loadAdapter(candidate, root, limits)
      if (adapters.has(adapter.id)) throw new ScriptsError('DUPLICATE_ADAPTER', `duplicate adapter id: ${adapter.id}`)
      adapters.set(adapter.id, adapter)
    }
  }
  return [...adapters.values()].sort((left, right) => left.id.localeCompare(right.id))
}

export function publicAdapter(adapter) {
  return {
    id: adapter.id,
    name: adapter.name,
    version: adapter.version,
    description: adapter.description,
    author: adapter.author,
    entry_url: adapter.entryUrl,
    skip_auth: adapter.skipAuth,
    trigger: adapter.trigger,
    tasks: adapter.tasks.map((task) => publicTask(adapter, task)),
  }
}

export function publicParam(param) {
  return {
    id: param.id,
    type: param.type,
    label: param.label,
    required: param.required,
    ...(Object.hasOwn(param, 'default') ? { default: cloneJson(param.default) } : {}),
    ...(param.min !== undefined ? { min: param.min } : {}),
    ...(param.max !== undefined ? { max: param.max } : {}),
    ...(param.options ? { options: param.options.map((option) => ({ ...option })) } : {}),
  }
}

export function validateTaskParams(task, params) {
  if (!task.paramsDeclared) return cloneJson(params)
  const result = {}
  const definitions = new Map(task.params.map((param) => [param.id, param]))
  for (const key of Object.keys(params)) {
    if (!definitions.has(key)) throw new ScriptsError('PARAMS_UNKNOWN', `params contains undeclared field: ${key}`)
  }
  for (const definition of task.params) {
    const label = `params.${definition.id}`
    if (Object.hasOwn(params, definition.id)) {
      result[definition.id] = validateParamValue(definition, params[definition.id], label)
    } else if (Object.hasOwn(definition, 'default')) {
      result[definition.id] = cloneJson(definition.default)
    } else if (definition.required) {
      throw new ScriptsError('PARAMS_REQUIRED', `${label} is required`)
    }
  }
  return result
}

export function publicTask(adapter, task) {
  return {
    adapter_id: adapter.id,
    adapter_name: adapter.name,
    id: task.id,
    name: task.name,
    description: task.description,
    script: task.script,
    entry_url: task.entryUrl,
    params_declared: task.paramsDeclared,
    params: task.params.map(publicParam),
    skip_auth: task.skipAuth,
    trigger: task.trigger,
  }
}
