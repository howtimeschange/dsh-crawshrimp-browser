import { readFile, writeFile } from 'node:fs/promises'

const icon = await readFile(new URL('../icon.png', import.meta.url))
if (icon.length > 256 * 1024 || !icon.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
  throw new Error('The bundled icon must be a PNG no larger than DSH’s 256 KiB limit')
}
const clientPath = new URL('../lib/client.js', import.meta.url)
const source = await readFile(clientPath, 'utf8')
const marker = /\/\* crawshrimp-icon:start \*\/[^\n]*?\/\* crawshrimp-icon:end \*\//g
if ([...source.matchAll(marker)].length !== 1) throw new Error('Expected exactly one client icon marker')
const replacement = `/* crawshrimp-icon:start */ ${JSON.stringify(`data:image/png;base64,${icon.toString('base64')}`)} /* crawshrimp-icon:end */`
const updated = source.replace(marker, replacement)
if (process.argv.includes('--check')) {
  if (source !== updated) throw new Error('Client icon is stale; run npm run sync:icon')
} else if (source !== updated) {
  await writeFile(clientPath, updated)
}
