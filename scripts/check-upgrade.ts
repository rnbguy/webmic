import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { readReleases } from './asset-graphs'
import { SAMPLE_RATE } from '../src/audio-format'

export async function checkUpgrade(browser: Browser) {
  const project = fileURLToPath(new URL('../', import.meta.url))
  const fixture = await mkdtemp(join(tmpdir(), 'webmic-upgrade-'))
  let activeSite = join(fixture, 'first')
  const missing: string[] = []
  const requested: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      requested.push(pathname)
      if (!pathname.startsWith('/webmic/')) return new Response('Not found', { status: 404 })
      const path = resolve(activeSite, pathname.endsWith('/') ? 'index.html' : pathname.slice('/webmic/'.length))
      if (!path.startsWith(activeSite + sep)) return new Response('Not found', { status: 404 })
      const file = Bun.file(path)
      if (!await file.exists()) {
        missing.push(pathname)
        return new Response('Not found', { status: 404 })
      }
      return new Response(file, { headers: { 'Cache-Control': path.endsWith('.html') ? 'no-store' : 'public, max-age=86400' } })
    }
  })
  const context = await browser.newContext()
  try {
    await mkdir(join(fixture, 'scripts'))
    for (const path of ['src', 'index.html', 'site.webmanifest', 'package.json', 'LICENSE', 'rust-toolchain.toml', 'tsconfig.json']) {
      await cp(join(project, path), join(fixture, path), { recursive: true })
    }
    for (const path of ['build.ts', 'generate-images.ts', 'asset-graphs.ts']) await cp(join(project, 'scripts', path), join(fixture, 'scripts', path))
    for (const path of ['node_modules', 'transport']) await symlink(join(project, path), join(fixture, path), 'junction')
    const source = await Bun.file(join(fixture, 'src/script.ts')).text()
    const style = await Bun.file(join(fixture, 'src/style.css')).text()
    const html = await Bun.file(join(fixture, 'index.html')).text()
    const releases = []
    for (const [version, color] of [['first', 'rgb(1, 2, 3)'], ['second', 'rgb(4, 5, 6)']]) {
      // Exercise real deferred worklet registration and glue/Wasm initialization without relying on a relay.
      await Bun.write(join(fixture, 'src/script.ts'), source + `
;{
  const probe = document.createElement('button')
  probe.id = 'cache-upgrade'
  probe.textContent = '${version}'
  probe.addEventListener('click', async () => {
    const context = new AudioContext({ sampleRate: ${SAMPLE_RATE} })
    try {
      await context.audioWorklet.addModule(new URL('audio-worklet.js', import.meta.url))
      const transport = await import(new URL(__TRANSPORT_PATH__, import.meta.url).href)
      await transport.default()
      probe.dataset.started = 'yes'
    } catch (error) { probe.dataset.error = String(error) }
    finally { await context.close() }
  })
  document.body.append(probe)
}\n`)
      await Bun.write(join(fixture, 'src/style.css'), style + `\n#cache-upgrade { color: ${color}; }\n`)
      await Bun.write(join(fixture, 'index.html'), html.replace('</head>', `<meta name="cache-fixture" content="${version}"></head>`))
      const build = Bun.spawn([process.execPath, 'scripts/build.ts'], {
        cwd: fixture, env: { ...process.env, WEBMIC_PREVIOUS_SITE: join(fixture, '_site') }, stdout: 'pipe', stderr: 'pipe'
      })
      const [exitCode, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()])
      assert.equal(exitCode, 0, stdout + stderr)
      await cp(join(fixture, '_site'), join(fixture, version), { recursive: true })
      releases.push((await readReleases(join(fixture, version)))[0])
    }
    assert.notEqual(releases[0].version, releases[1].version, 'UI edits create a new complete graph')
    assert.equal(releases[0].transport, releases[1].transport, 'UI-only builds reuse the transport URL')
    const errors: string[] = []
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
    const url = new URL('webmic/', server.url).href
    async function checkPage(page: Page, version: string, color: string) {
      await page.goto(url)
      await page.locator('#cache-upgrade').waitFor()
      assert.equal(await page.locator('meta[name=cache-fixture]').getAttribute('content'), version)
      assert.equal(await page.locator('#cache-upgrade').innerText(), version, 'Fresh HTML must load matching JavaScript')
      assert.equal(await page.locator('#cache-upgrade').evaluate(element => getComputedStyle(element).color), color, 'Fresh HTML must load matching CSS')
    }
    const oldPage = await context.newPage()
    await checkPage(oldPage, 'first', 'rgb(1, 2, 3)')
    assert.ok(!requested.some(path => /audio-worklet\.js|webmic_transport/.test(path)), 'The old page has not preloaded its deferred startup graph')
    activeSite = join(fixture, 'second')
    const freshPage = await context.newPage()
    await checkPage(freshPage, 'second', 'rgb(4, 5, 6)')
    for (const page of [oldPage, freshPage]) {
      await page.locator('#cache-upgrade').click()
      await page.waitForFunction(() => {
        const probe = document.querySelector<HTMLElement>('#cache-upgrade')!
        if (probe.dataset.error) throw new Error(probe.dataset.error)
        return probe.dataset.started === 'yes'
      })
      const manifest = await page.evaluate(async () => {
        const link = document.querySelector<HTMLLinkElement>('link[rel=manifest]')!
        const manifest = await (await fetch(link.href)).json()
        const icon = document.querySelector<HTMLLinkElement>('link[rel=icon]')!
        if (!(await fetch(icon.href)).ok) throw new Error('Retained icon is missing')
        return manifest
      })
      assert.equal(manifest.id, '/webmic/')
      assert.equal(manifest.start_url, '/webmic/')
      assert.equal(manifest.scope, '/webmic/')
    }
    assert.ok(requested.includes(`/webmic/dist/${releases[0].version}/audio-worklet.js`), 'The still-open old tab fetches its retained worklet only after deployment')
    assert.ok(requested.includes(`/webmic/transport/${releases[0].transport}/webmic_transport.js`))
    assert.ok(requested.includes(`/webmic/transport/${releases[0].transport}/webmic_transport_bg.wasm`))
    assert.deepEqual(errors, [])
    assert.deepEqual(missing, [], 'All current and retained release asset requests must resolve')
    console.info('Upgrade check passed: cached UI coherence, delayed old-tab startup, stable transport and app identity, and bounded artifact retention')
  } finally {
    await context.close()
    await server.stop(true)
    await rm(fixture, { recursive: true, force: true })
  }
}
