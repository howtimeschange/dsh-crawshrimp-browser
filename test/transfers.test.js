import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

import { BrowserTransferError, BrowserTransfers } from '../lib/capabilities/transfers.js'

const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)
const chromePath = chromeCandidates.find(candidate => existsSync(candidate))

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex')
const JSON_BYTES = Buffer.from('{"ok":true,"source":"fixture"}\n')
const CSV_BYTES = Buffer.from('sku,qty\nA,1\n')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

let server
let baseUrl
let slowConnections = 0
let leakedScopedCookie = false

before(async () => {
  server = createServer((request, response) => {
    if (request.url?.startsWith('/download-cookie')) {
      if (!request.headers.cookie?.includes('fixture_session=authorized')) {
        response.writeHead(401, { 'content-type': 'text/plain' })
        response.end('unauthorized')
        return
      }
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-disposition': 'attachment; filename="cookie-fixture.png"',
        'content-length': String(PNG.length),
      })
      response.end(PNG)
      return
    }
    if (request.url === '/download-large') {
      const bytes = Buffer.alloc(128, 0x41)
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) })
      response.end(bytes)
      return
    }
    if (request.url === '/download-slow') {
      slowConnections += 1
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      let count = 0
      const timer = setInterval(() => {
        count += 1
        response.write(Buffer.alloc(1024, 0x53))
        if (count === 100) {
          clearInterval(timer)
          response.end()
        }
      }, 20)
      request.on('close', () => clearInterval(timer))
      return
    }
    if (request.url === '/download-stalled') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="stalled.bin"',
      })
      response.write('stalled')
      return
    }
    if (request.url === '/redirect-private') {
      leakedScopedCookie ||= request.headers.cookie?.includes('scoped_fixture=private-only') === true
      response.writeHead(302, { location: '/private/download-cookie' })
      response.end()
      return
    }
    if (request.url?.startsWith('/private/download-cookie')) {
      if (!request.headers.cookie?.includes('scoped_fixture=private-only')) {
        response.writeHead(401, { 'content-type': 'text/plain' })
        response.end('missing scoped cookie')
        return
      }
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-disposition': 'attachment; filename="private-fixture.png"',
        'content-length': String(PNG.length),
      })
      response.end(PNG)
      return
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': ['fixture_session=authorized; Path=/', 'scoped_fixture=private-only; Path=/private'],
    })
    response.end(`<!doctype html>
      <title>Transfer fixture</title>
      <main>
        <input id="upload" type="file" multiple>
        <button id="choose-upload" type="button">Choose upload</button>
        <p id="uploaded"></p>
        <a id="cookie-download" href="/download-cookie" download>Cookie download</a>
        <button id="blob-download" type="button">Blob download</button>
        <button id="csv-blob-download" type="button">CSV blob download</button>
        <a id="stalled-download" href="/download-stalled" download>Stalled download</a>
        <button id="slow-download" type="button">Slow download</button>
      </main>
      <script>
        document.querySelector('#choose-upload').addEventListener('click', () => document.querySelector('#upload').click())
        document.querySelector('#upload').addEventListener('change', event => {
          document.querySelector('#uploaded').textContent = [...event.target.files].map(file => file.name).join(',')
        })
        document.querySelector('#blob-download').addEventListener('click', () => {
          const blob = new Blob([${JSON.stringify(JSON_BYTES.toString('utf8'))}], { type: 'application/json' })
          const link = document.createElement('a')
          link.href = URL.createObjectURL(blob)
          link.download = 'blob-fixture.json'
          link.click()
          setTimeout(() => URL.revokeObjectURL(link.href), 100)
        })
        document.querySelector('#csv-blob-download').addEventListener('click', () => {
          const blob = new Blob([${JSON.stringify(CSV_BYTES.toString('utf8'))}], { type: 'text/csv' })
          const link = document.createElement('a')
          link.href = URL.createObjectURL(blob)
          link.download = 'blob-fixture.csv'
          link.click()
          setTimeout(() => URL.revokeObjectURL(link.href), 100)
        })
        document.querySelector('#slow-download').addEventListener('click', () => {
          setTimeout(() => document.querySelector('#blob-download').click(), 500)
        })
      </script>`)
  })
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

async function fixture(t, extraConfig = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-browser-transfers-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const browser = await chromium.launch({ executablePath: chromePath, headless: true })
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()
  await page.goto(baseUrl)
  t.after(() => browser.close())
  const transfers = new BrowserTransfers({ workspaceDir: workspace, ...extraConfig })
  return { workspace, browser, context, page, transfers }
}

test('focused Chrome fixture uploads workspace files through a real file chooser', { skip: !chromePath }, async t => {
  const { workspace, page, transfers } = await fixture(t)
  await writeFile(join(workspace, 'upload.txt'), 'fixture upload')
  const result = await transfers.upload(page, { paths: ['upload.txt'], selector: '#upload' }, new AbortController().signal)
  assert.equal(result.count, 1)
  assert.equal(result.receipt.path, 'upload.txt')
  assert.equal(await page.locator('#uploaded').textContent(), 'upload.txt')
  const chooserResult = await transfers.upload(page, { paths: ['upload.txt'], chooserSelector: '#choose-upload' }, new AbortController().signal)
  assert.equal(chooserResult.receipt.path, 'upload.txt')
})

test('same-origin URL downloads carry the owned page cookie and publish verified atomic receipts', { skip: !chromePath }, async t => {
  const { workspace, page, transfers } = await fixture(t)
  const result = await transfers.download(page, {
    url: `${baseUrl}/download-cookie?token=secret&keep=1`,
    filename: 'verified.png',
    expectedMime: 'image/png',
    expectedSha256: sha256(PNG),
    magicHex: '89504e470d0a1a0a',
  }, new AbortController().signal)
  assert.match(result.receipt.path, /^artifacts\/browser-transfers\/\d+-[0-9a-f-]+-verified\.png$/)
  assert.equal(result.receipt.bytes, PNG.length)
  assert.equal(result.receipt.url.includes('secret'), false)
  assert.match(result.receipt.url, /token=%5BREDACTED%5D/)
  assert.deepEqual(await readFile(join(workspace, result.path)), PNG)
  assert.deepEqual((await readdir(join(workspace, 'artifacts/browser-transfers'))).filter(name => name.endsWith('.part')), [])
})

test('same-origin redirects recalculate path-scoped cookies on every hop', { skip: !chromePath }, async t => {
  leakedScopedCookie = false
  const { workspace, page, transfers } = await fixture(t)
  const result = await transfers.download(page, { url: `${baseUrl}/redirect-private`, filename: 'private.png', expectedMime: 'image/png' }, new AbortController().signal)
  assert.deepEqual(await readFile(join(workspace, result.path)), PNG)
  assert.equal(leakedScopedCookie, false)
})

test('click downloads cover a browser blob and a server download event', { skip: !chromePath }, async t => {
  const { workspace, page, transfers } = await fixture(t)
  const blob = await transfers.download(page, { selector: '#blob-download', filename: 'blob.json', expectedMime: 'application/json' }, new AbortController().signal)
  assert.equal(blob.receipt.magic, 'json')
  assert.deepEqual(await readFile(join(workspace, blob.path)), JSON_BYTES)
  const csvBlob = await transfers.download(page, { selector: '#csv-blob-download', filename: 'blob.csv', expectedMime: 'text/csv', magic: 'text' }, new AbortController().signal)
  assert.equal(csvBlob.receipt.mime, 'text/csv')
  assert.equal(csvBlob.receipt.magic, 'text')
  assert.deepEqual(await readFile(join(workspace, csvBlob.path)), CSV_BYTES)
  const serverDownload = await transfers.download(page, { selector: '#cookie-download', filename: 'click.png', expectedMime: 'image/png', magicHex: '89504e470d0a1a0a' }, new AbortController().signal)
  assert.deepEqual(await readFile(join(workspace, serverDownload.path)), PNG)
})

test('workspace paths, symlinks, size limits, hash failures, and cancellation fail closed', { skip: !chromePath }, async t => {
  const { workspace, page, transfers } = await fixture(t, { maxOutputBytes: 64 })
  await writeFile(join(workspace, 'safe.txt'), 'safe')
  const outside = await mkdtemp(join(tmpdir(), 'dsh-browser-transfers-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(join(outside, 'secret.txt'), join(workspace, 'escape.txt'))
  await assert.rejects(transfers.upload(page, { paths: ['../secret.txt'], selector: '#upload' }, new AbortController().signal), error => error.code === 'PATH_OUTSIDE_WORKSPACE')
  await assert.rejects(transfers.upload(page, { paths: ['escape.txt'], selector: '#upload' }, new AbortController().signal), error => error.code === 'SYMLINK_NOT_ALLOWED')
  await assert.rejects(transfers.download(page, { url: `${baseUrl}/download-large`, maxBytes: 32 }, new AbortController().signal), error => error.code === 'FILE_TOO_LARGE')
  await assert.rejects(transfers.download(page, { url: `${baseUrl}/download-cookie`, expectedSha256: '0'.repeat(64) }, new AbortController().signal), error => error.code === 'HASH_MISMATCH')
  const fixed = await transfers.download(page, { url: `${baseUrl}/download-cookie`, outputPath: 'fixed.png' }, new AbortController().signal)
  assert.deepEqual(await readFile(join(workspace, fixed.path)), PNG)
  await assert.rejects(transfers.download(page, { url: `${baseUrl}/download-cookie`, outputPath: 'fixed.png' }, new AbortController().signal), error => error.code === 'OUTPUT_EXISTS')
  assert.deepEqual(await readFile(join(workspace, 'fixed.png')), PNG)
  await assert.rejects(transfers.download(page, { url: `${baseUrl.replace('http://', 'http://user:pass@')}/download-cookie` }, new AbortController().signal), error => error.code === 'URL_INVALID')
  const controller = new AbortController()
  const pending = transfers.download(page, { url: `${baseUrl}/download-slow`, filename: 'cancel.bin' }, controller.signal)
  await new Promise(resolve => setTimeout(resolve, 80))
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError' || error.code === 'TRANSFER_CANCELLED')
  assert.equal(slowConnections > 0, true)
  const artifactRoot = join(workspace, 'artifacts', 'browser-transfers')
  if (existsSync(artifactRoot)) {
    const names = await readdir(artifactRoot)
    assert.equal(names.some(name => name.endsWith('.part')), false)
    assert.equal(names.some(name => name.endsWith('cancel.bin')), false)
  }
  await assert.rejects(transfers.verifyFile({ path: 'safe.txt', expectedSha256: '0'.repeat(64) }), error => error.code === 'HASH_MISMATCH')
  assert.equal((await stat(join(workspace, 'safe.txt'))).isFile(), true)
})

test('upload count and aggregate byte limits are enforced before chooser side effects', { skip: !chromePath }, async t => {
  const { workspace, page, transfers } = await fixture(t, { maxBytes: 64 * 1024 * 1024, maxUploadBytes: 64 * 1024 * 1024 })
  const paths = []
  for (let index = 0; index < 21; index += 1) {
    const name = `many-${index}.txt`
    await writeFile(join(workspace, name), 'x')
    paths.push(name)
  }
  await assert.rejects(transfers.upload(page, { paths, selector: '#upload' }, new AbortController().signal), error => error.code === 'UPLOAD_TOO_MANY_FILES')
  await writeFile(join(workspace, 'large-a.bin'), '')
  await writeFile(join(workspace, 'large-b.bin'), '')
  await truncate(join(workspace, 'large-a.bin'), 33 * 1024 * 1024)
  await truncate(join(workspace, 'large-b.bin'), 33 * 1024 * 1024)
  await assert.rejects(transfers.upload(page, { paths: ['large-a.bin', 'large-b.bin'], selector: '#upload' }, new AbortController().signal), error => error.code === 'UPLOAD_TOTAL_TOO_LARGE')
})

test('body timeout aborts a hanging download and leaves no published artifact', { skip: !chromePath }, async t => {
  const { workspace, page, transfers } = await fixture(t)
  await assert.rejects(transfers.download(page, { url: `${baseUrl}/download-slow`, filename: 'timeout.bin', timeoutMs: 50 }, undefined), error => error.code === 'DOWNLOAD_TIMEOUT')
  const artifactRoot = join(workspace, 'artifacts', 'browser-transfers')
  if (existsSync(artifactRoot)) assert.equal((await readdir(artifactRoot)).some(name => name.includes('timeout.bin')), false)
})

test('click attachment timeout cancels the exact download and leaves the page usable', { skip: !chromePath }, async t => {
  const { workspace, page, transfers } = await fixture(t)
  const started = Date.now()
  await assert.rejects(transfers.download(page, { selector: '#stalled-download', filename: 'stalled.bin', timeoutMs: 120 }, new AbortController().signal), error => error.code === 'DOWNLOAD_TIMEOUT')
  assert.ok(Date.now() - started < 1500)
  assert.equal(page.isClosed(), false)
  const artifactRoot = join(workspace, 'artifacts', 'browser-transfers')
  if (existsSync(artifactRoot)) assert.equal((await readdir(artifactRoot)).some(name => name.includes('stalled.bin') || name.endsWith('.part')), false)
  const followUp = await transfers.download(page, { selector: '#blob-download', filename: 'after-stalled.json', expectedMime: 'application/json' }, new AbortController().signal)
  assert.equal(followUp.receipt.magic, 'json')
})

test('aborting a click wait removes its listener while the delayed click finishes', { skip: !chromePath }, async t => {
  const { page, transfers } = await fixture(t)
  const controller = new AbortController()
  const pending = transfers.download(page, { selector: '#slow-download', filename: 'aborted.json' }, controller.signal)
  await new Promise(resolve => setTimeout(resolve, 50))
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError' || error.code === 'TRANSFER_CANCELLED')
  await new Promise(resolve => setTimeout(resolve, 600))
  const followUp = await transfers.download(page, { selector: '#blob-download', filename: 'follow-up.json', expectedMime: 'application/json' }, new AbortController().signal)
  assert.equal(followUp.receipt.magic, 'json')
})

test('manager-backed transfers reject an unregistered page', { skip: !chromePath }, async t => {
  const { page, browser, context } = await fixture(t)
  const manager = { sessions: new Set([{ closed: false, pages: new Map(), context }]) }
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-browser-transfers-owned-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const transfers = new BrowserTransfers({ workspaceDir: workspace, browserManager: manager })
  t.after(() => browser.close())
  await assert.rejects(transfers.download(page, { url: `${baseUrl}/download-cookie` }, new AbortController().signal), error => error.code === 'PAGE_NOT_OWNED')
})

test('transfer module validates without a browser using workspace receipts', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-browser-transfers-unit-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await writeFile(join(workspace, 'fixture.json'), JSON_BYTES)
  await writeFile(join(workspace, 'fixture.csv'), CSV_BYTES)
  const transfers = new BrowserTransfers({ workspaceDir: workspace })
  const result = await transfers.verifyFile({ path: 'fixture.json', expectedMime: 'application/json', expectedSha256: sha256(JSON_BYTES), magic: 'json' })
  assert.equal(result.receipt.magic, 'json')
  assert.equal(result.receipt.bytes, JSON_BYTES.length)
  const csv = await transfers.verifyFile({ path: 'fixture.csv', expectedMime: 'text/csv', magic: 'text', expectedSha256: sha256(CSV_BYTES) })
  assert.equal(csv.receipt.mime, 'text/csv')
  assert.equal(csv.receipt.magic, 'text')
  assert.equal(csv.receipt.bytes, CSV_BYTES.length)
})
