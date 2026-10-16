export class ScriptsError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'CrawshrimpScriptsError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function errorMessage(error) {
  if (error instanceof ScriptsError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}
