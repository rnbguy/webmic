import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser } from 'playwright'

export async function checkUpgrade(browser: Browser) {
  const project = fileURLToPath(new URL('../', import.meta.url))
  const fixture = await mkdtemp(join(tmpdir(), 'webmic-upgrade-'))
  let activeSite = join(fixture, 'first')
  const missing: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
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
    for (const path of ['build.ts', 'generate-images.ts']) await cp(join(project, 'scripts', path), join(fixture, 'scripts', path))
    for (const path of ['node_modules', 'transport']) await symlink(join(project, path), join(fixture, path), 'junction')
    const source = await Bun.file(join(fixture, 'src/script.ts')).text()
    const style = await Bun.file(join(fixture, 'src/style.css')).text()
    const html = await Bun.file(join(fixture, 'index.html')).text()
    for (const [version, color] of [['first', 'rgb(1, 2, 3)'], ['second', 'rgb(4, 5, 6)']]) {
      await Bun.write(join(fixture, 'src/script.ts'), source + `\n;{ const probe = document.createElement('p'); probe.id = 'cache-upgrade'; probe.textContent = '${version}'; document.body.append(probe) }\n`)
      await Bun.write(join(fixture, 'src/style.css'), style + `\n#cache-upgrade { color: ${color}; }\n`)
      await Bun.write(join(fixture, 'index.html'), html.replace('</head>', `<meta name="cache-fixture" content="${version}"></head>`))
      const build = Bun.spawn([process.execPath, 'scripts/build.ts'], { cwd: fixture, stdout: 'pipe', stderr: 'pipe' })
      const [exitCode, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()])
      assert.equal(exitCode, 0, stdout + stderr)
      await cp(join(fixture, '_site'), join(fixture, version), { recursive: true })
    }
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const url = new URL('webmic/', server.url).href
    for (const [version, color] of [['first', 'rgb(1, 2, 3)'], ['second', 'rgb(4, 5, 6)']]) {
      activeSite = join(fixture, version)
      await page.goto(url)
      await page.locator('#cache-upgrade').waitFor()
      assert.equal(await page.locator('meta[name=cache-fixture]').getAttribute('content'), version)
      assert.equal(await page.locator('#cache-upgrade').innerText(), version, 'Fresh HTML must not reuse the previous deployment JavaScript')
      assert.equal(await page.locator('#cache-upgrade').evaluate(element => getComputedStyle(element).color), color, 'Fresh HTML must not reuse the previous deployment stylesheet')
      await page.goto('about:blank')
    }
    assert.deepEqual(errors, [])
    assert.deepEqual(missing, [], 'All release asset requests must resolve')
    console.info('Upgrade check passed: new HTML loads matching JavaScript and CSS with the previous deployment cached')
  } finally {
    await context.close()
    await server.stop(true)
    await rm(fixture, { recursive: true, force: true })
  }
}
