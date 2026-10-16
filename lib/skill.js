import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

/** Load the same-package skill, independent of the current workspace. */
export function loadBundledSkill() {
  const path = fileURLToPath(new URL('../skills/crawshrimp-browser/SKILL.md', import.meta.url))
  const raw = readFileSync(path, 'utf8')
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (!header) throw new Error('Bundled browser skill has no frontmatter')
  const metadata = parse(header[1])
  if (metadata?.name !== 'crawshrimp-browser' || typeof metadata.description !== 'string' || !metadata.description.trim()) {
    throw new Error('Bundled browser skill metadata is invalid')
  }
  return {
    name: metadata.name,
    description: metadata.description,
    content: raw.slice(header[0].length).trim(),
    source: 'bundled',
    path,
    resourceBase: { kind: 'directory', path: dirname(path) },
    invocation: { modelInvocable: true, userInvocable: true },
  }
}
