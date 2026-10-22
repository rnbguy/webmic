import assert from 'node:assert/strict'
import { chromium, firefox, webkit, type Browser } from 'playwright'
import { checkUpgrade } from './check-upgrade'
import { checkDeviceDefaults } from './check-device'
import { checkLayout } from './check-layout'
import { checkMobile } from './check-mobile'
import { checkRecovery } from './check-recovery'

export async function checkBrowser(browser: Browser, url: string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', reducedMotion: 'reduce' })
  const errors: string[] = []
  try {
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(url)
    await page.locator('#session-toggle').waitFor()
    await page.waitForFunction(() => document.querySelector('main')?.hasAttribute('x-data') && !!document.querySelector('#session-toggle')?.getAttribute('aria-label'))
    let externalScriptRequested = false
    await page.route('https://csp-probe.invalid/**', async route => {
      externalScriptRequested = true
      await route.fulfill({ contentType: 'text/javascript', body: 'document.documentElement.dataset.cspProbe = \"executed\"' })
    })
    const scriptLoaded = await page.evaluate(() => {
      const { promise, resolve } = Promise.withResolvers<boolean>()
      const script = document.createElement('script')
      script.src = 'https://csp-probe.invalid/blocked.js'
      script.onload = () => { script.remove(); resolve(true) }
      script.onerror = () => { script.remove(); resolve(false) }
      document.head.append(script)
      return promise
    })
    assert.equal(scriptLoaded, false, 'Meta CSP must block third-party script execution')
    assert.equal(externalScriptRequested, false, 'Blocked scripts must not reach the network')
    const evalProbe = new URL('csp-eval-probe.js', url).href
    await page.route(evalProbe, route => route.fulfill({
      contentType: 'text/javascript',
      body: 'try { new Function("return 1")(); window.cspEvalBlocked = false } catch (error) { window.cspEvalBlocked = error instanceof EvalError }'
    }))
    await page.evaluate(async url => { await import(url) }, evalProbe)
    assert.equal(await page.evaluate(() => (window as any).cspEvalBlocked), true, 'Trusted scripts still cannot use unsafe JavaScript evaluation')
    assert.equal(await page.getByRole('link', { name: /Source code/ }).getAttribute('href'), 'https://github.com/rnbguy/webmic')
    assert.equal(await page.locator('a[href*="twitter.com"], a[href*="producthunt.com"]').count(), 0)
    const artwork = await page.evaluate(async () => {
      const preview = new URL(document.querySelector<HTMLMetaElement>('meta[property="og:image"]')!.content)
      const imageURL = new URL(preview.pathname, location.origin)
      const image = await createImageBitmap(await (await fetch(imageURL)).blob())
      const manifestURL = new URL(document.querySelector<HTMLLinkElement>('link[rel=manifest]')!.href)
      const manifest = await (await fetch(manifestURL)).json()
      const icons: number[] = []
      for (const icon of manifest.icons) {
        const bitmap = await createImageBitmap(await (await fetch(new URL(icon.src, manifestURL))).blob())
        icons.push(bitmap.width)
        bitmap.close()
      }
      const result = { preview: [image.width, image.height], icons, start: new URL(manifest.start_url, manifestURL).pathname, scope: new URL(manifest.scope, manifestURL).pathname }
      image.close()
      return result
    })
    assert.deepEqual(artwork.preview, [1200, 630])
    assert.deepEqual(artwork.icons, [192, 512])
    assert.equal(artwork.start, new URL(url).pathname, 'Installed app must open the application, not its versioned asset directory')
    assert.equal(artwork.scope, new URL(url).pathname)
    await page.getByLabel('Microphone', { exact: true }).check()
    await page.reload()
    await page.waitForFunction(() => !!document.querySelector('#session-toggle')?.getAttribute('aria-label'))
    const restoredRole = await page.locator('main').getAttribute('data-mode')
    assert.equal(await page.locator(`#${restoredRole}`).isChecked(), true, 'Reload must repair native restored radio properties to match the controller')
    await page.getByLabel('Microphone', { exact: true }).check()
    assert.equal(await page.locator('#session-toggle').getAttribute('aria-label'), 'Pair with speaker')
    await page.locator('#session-toggle').press('Enter')
    await page.waitForFunction(() => document.activeElement?.id === 'invitation')
    await page.locator('#help-toggle').press('Space')
    await page.locator('#help-panel').waitFor()
    await page.getByRole('button', { name: 'Pair with speaker', exact: true }).click()
    await page.locator('#help-panel').waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.activeElement?.id === 'invitation')
    await page.locator('#invitation').fill('https://untrusted.example/#speaker=e30&key=bad')
    await page.getByRole('button', { name: 'Pair', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.match(await page.locator('#session-error').innerText(), /Invalid pairing/)
    assert.equal(await page.locator('#invitation').getAttribute('aria-invalid'), 'true')
    await page.getByLabel('Speaker', { exact: true }).check()
    await page.getByRole('alert').waitFor({ state: 'hidden' })
    await page.locator('#help-toggle').click()
    await page.locator('#help-panel').waitFor()
    assert.equal(await page.locator('#help-toggle').getAttribute('aria-expanded'), 'true')
    await page.waitForFunction(() => document.activeElement?.id === 'help-panel')
    await page.keyboard.press('Escape')
    await page.locator('#help-panel').waitFor({ state: 'hidden' })
    assert.equal(await page.locator('#help-toggle').evaluate(element => document.activeElement === element), true)
    await page.keyboard.press('Tab')
    assert.equal(await page.locator('.source-link').evaluate(element => document.activeElement === element), true)
    await page.keyboard.press('Shift+Tab')
    assert.equal(await page.locator('#help-toggle').evaluate(element => document.activeElement === element), true)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await page.getByLabel('Microphone', { exact: true }).check()
      await page.locator('#invitation').fill('https://untrusted.example/#speaker=e30&key=bad')
      await page.getByRole('button', { name: 'Pair', exact: true }).click()
      await page.getByRole('alert').waitFor()
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 })
        await page.evaluate(() => document.fonts.ready)
        const layout = await page.evaluate(() => {
          const viewport = document.documentElement.clientWidth
          const clipped = Array.from(document.querySelectorAll<HTMLElement>('button, input:not([type=radio]), label, h1, h2, .status-detail')).filter(element => {
            const box = element.getBoundingClientRect()
            return box.width > 0 && box.height > 0 && (box.left < -1 || box.right > viewport + 1)
          }).map(element => element.id || element.textContent)
          const undersized = Array.from(document.querySelectorAll<HTMLElement>('button, input:not([type=radio]), .role-option label')).filter(element => {
            const box = element.getBoundingClientRect()
            return box.width > 0 && box.height > 0 && (box.height < 48 || box.width < 48)
          }).map(element => element.id || element.textContent)
          return { overflow: document.documentElement.scrollWidth > viewport, clipped, undersized, colorScheme: getComputedStyle(document.documentElement).colorScheme }
        })
        assert.equal(layout.overflow, false, `${scheme} ${width}: horizontal overflow`)
        assert.deepEqual(layout.clipped, [], `${scheme} ${width}: clipped content`)
        assert.deepEqual(layout.undersized, [], `${scheme} ${width}: touch targets`)
        assert.ok(layout.colorScheme.includes(scheme), `${scheme}: native controls follow system theme`)
      }
      const contrast = await page.evaluate(() => {
        const luminance = (color: string) => {
          const values = color.match(/[\d.]+/g)!.slice(0, 3).map(value => {
            const channel = Number(value) / 255
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
          })
          return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
        }
        const selectors = ['.status-detail', '.field-note', '.feedback-note', '.role-hint', '.soft-button', '.session-toggle', '.role-option input:checked + label', '.error-panel > .icon', '#session-error']
        return selectors.map(selector => {
          const element = document.querySelector<HTMLElement>(selector)!
          let ancestor: HTMLElement | null = element
          while (ancestor && getComputedStyle(ancestor).backgroundColor === 'rgba(0, 0, 0, 0)') ancestor = ancestor.parentElement
          const foreground = luminance(getComputedStyle(element).color)
          const background = luminance(getComputedStyle(ancestor || document.body).backgroundColor)
          return { selector, ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) }
        })
      })
      for (const entry of contrast) assert.ok(entry.ratio >= 4.5, `${scheme} ${entry.selector}: contrast ${entry.ratio.toFixed(2)}`)
      await page.getByLabel('Speaker', { exact: true }).check()
    }
    await page.getByLabel('Microphone', { exact: true }).check()
    const address = btoa(JSON.stringify({ id: 'not-contacted-in-permission-test' })).replace(/=+$/, '')
    await page.locator('#invitation').fill(`${url}#speaker=${address}&key=${'a'.repeat(64)}`)
    await page.getByRole('button', { name: 'Pair', exact: true }).click()
    assert.equal(await page.locator('#invitation').inputValue(), '')
    assert.equal(await page.getByLabel('Microphone', { exact: true }).isChecked(), true)
    assert.equal(await page.getByLabel('Speaker', { exact: true }).isChecked(), false)
    // Firefox has no Playwright microphone permission mapping; its launch preference denies capture.
    if (browser.browserType().name() !== 'firefox') await context.grantPermissions([], { origin: new URL(url).origin })
    await page.locator('#session-toggle').click()
    await page.waitForFunction(() => document.querySelector('#session-toggle')?.getAttribute('aria-label') === 'Retry microphone')
    assert.match(await page.locator('#session-error').innerText(), /Microphone access was denied/)
    await context.setOffline(true)
    await page.locator('#network-warning').waitFor()
    assert.match(await page.locator('#network-warning').innerText(), /reports offline/)
    await page.locator('#session-toggle').click()
    await page.waitForFunction(() => document.querySelector('#session-toggle')?.getAttribute('aria-label') === 'Retry microphone')
    assert.match(await page.locator('#session-error').innerText(), /Microphone access was denied/, 'Offline hints must not replace real capture failures')
    await context.setOffline(false)
    await page.locator('#network-warning').waitFor({ state: 'hidden' })
    assert.deepEqual(errors, [], 'No browser runtime errors under the CSP build')
    console.info('Browser checks passed: CSP bootstrap/enforcement, system themes, 320/390/768/1280px layout, touch targets, text contrast, pairing actions/validation, Help focus, permission denial and advisory offline retry')
  } catch (error) {
    const page = context.pages()[0]
    console.error('Browser check failed', {
      status: await page?.locator('#session-status').innerText().catch(() => 'unavailable') ?? 'unavailable',
      message: await page?.locator('#session-error').innerText().catch(() => 'unavailable') ?? 'unavailable',
      browserErrors: errors
    })
    throw error
  } finally {
    await context.close()
  }
}

if (import.meta.main) {
  const url = process.env.WEBMIC_TEST_URL || 'http://127.0.0.1:4173/webmic/'
  const server = process.env.WEBMIC_TEST_URL ? null : Bun.spawn([process.execPath, 'scripts/serve.ts'], { stdout: 'inherit', stderr: 'inherit' })
  try {
    let ready = false
    for (let attempt = 0; attempt < 50; attempt++) {
      if (server && server.exitCode !== null) throw new Error('Preview server exited before browser checks')
      try { ready = (await fetch(url)).ok } catch { /* The preview process may still be starting. */ }
      if (ready) break
      await Bun.sleep(100)
    }
    assert.equal(ready, true, 'Preview must be reachable')
    for (const browserType of [chromium, firefox, webkit]) {
      console.info(`Running ${browserType.name()} browser checks`)
      const browser = await browserType.launch({
        headless: true,
        // Headless shell reports NotSupportedError for microphone capture; use full Chromium.
        ...(browserType === chromium ? { channel: 'chromium', args: ['--use-fake-device-for-media-stream'] } : {}),
        // Fake devices keep denial independent of host hardware; Firefox denies via a browser preference.
        ...(browserType === firefox ? { firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'permissions.default.microphone': 2 } } : {})
      })
      try {
        await checkBrowser(browser, url)
        await checkDeviceDefaults(browser, url)
        await checkLayout(browser, url)
        await checkMobile(browser, url)
        await checkRecovery(browser, url)
        // Cache behavior is engine-specific; each fixture builds both deployments using the native build cache.
        if (!process.env.WEBMIC_TEST_URL) await checkUpgrade(browser)
      } finally {
        await browser.close()
      }
    }
  } finally {
    server?.kill()
    if (server) await server.exited
  }
}
