import assert from 'node:assert/strict'
import { chromium, type Browser } from 'playwright'

export async function checkBrowser(browser: Browser, url: string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', reducedMotion: 'reduce' })
  try {
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(url)
    await page.locator('#session-toggle').waitFor()
    await page.waitForFunction(() => document.querySelector('main')?.hasAttribute('x-data') && !!document.querySelector('#session-toggle')?.getAttribute('aria-label'))
    assert.equal(await page.getByRole('link', { name: /Source code/ }).getAttribute('href'), 'https://github.com/rnbguy/webmic')
    assert.equal(await page.locator('a[href*="twitter.com"], a[href*="producthunt.com"]').count(), 0)
    await page.locator('#invitation').fill('https://untrusted.example/#speaker=e30&key=bad')
    await page.getByRole('button', { name: 'Pair', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.match(await page.locator('#session-error').innerText(), /Invalid pairing/)
    assert.equal(await page.locator('#invitation').getAttribute('aria-invalid'), 'true')
    await page.getByLabel('Speaker', { exact: true }).check()
    assert.equal(await page.getByRole('alert').isVisible(), false, 'Changing role clears an obsolete pairing error')
    await page.locator('#help-toggle').click()
    await page.locator('#help-panel').waitFor()
    assert.equal(await page.locator('#help-toggle').getAttribute('aria-expanded'), 'true')
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('#help-panel').isVisible(), false)
    assert.equal(await page.locator('#help-toggle').evaluate(element => document.activeElement === element), true)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
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
        const selectors = ['.status-detail', '.field-note', '.feedback-note', '.app-footer', '.role-hint', '.soft-button', '.session-toggle', '.role-option input:checked + label']
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
    }
    await page.getByLabel('Microphone', { exact: true }).check()
    const address = btoa(JSON.stringify({ id: 'not-contacted-in-permission-test' })).replace(/=+$/, '')
    await page.locator('#invitation').fill(`${url}#speaker=${address}&key=${'a'.repeat(64)}`)
    await page.getByRole('button', { name: 'Pair', exact: true }).click()
    assert.equal(await page.locator('#invitation').inputValue(), '')
    await context.clearPermissions()
    await page.locator('#session-toggle').click()
    await page.waitForFunction(() => document.querySelector('#session-error')?.textContent?.includes('site settings'))
    assert.equal(await page.locator('#session-toggle').getAttribute('aria-label'), 'Retry microphone')
    assert.match(await page.locator('#session-error').innerText(), /Microphone access was denied/)
    await context.setOffline(true)
    await page.locator('#session-toggle').click()
    assert.match(await page.locator('#session-error').innerText(), /offline/)
    await context.setOffline(false)
    assert.deepEqual(errors, [], 'No browser runtime errors')
    console.info('Browser checks passed: system themes, 320/390/768/1280px layout, touch targets, text contrast, pairing validation, help focus, permission denial, offline retry')
  } finally {
    await context.close()
  }
}

if (import.meta.main) {
  const url = process.env.WEBMIC_TEST_URL || 'http://127.0.0.1:4173/webmic/'
  const server = process.env.WEBMIC_TEST_URL ? null : Bun.spawn([process.execPath, 'scripts/serve.ts'], { stdout: 'inherit', stderr: 'inherit' })
  let browser: Browser | undefined
  try {
    let ready = false
    for (let attempt = 0; attempt < 50; attempt++) {
      if (server && server.exitCode !== null) throw new Error('Preview server exited before browser checks')
      try { ready = (await fetch(url)).ok } catch { /* The preview process may still be starting. */ }
      if (ready) break
      await Bun.sleep(100)
    }
    assert.equal(ready, true, 'Preview must be reachable')
    browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream'] })
    await checkBrowser(browser, url)
  } finally {
    await browser?.close()
    server?.kill()
    if (server) await server.exited
  }
}
