import assert from 'node:assert/strict'
import type { Browser } from 'playwright'

export async function checkMobile(browser: Browser, url: string) {
  for (const [width, height] of [[320, 568], [390, 844], [390, 360]]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, reducedMotion: 'reduce' })
    try {
      const page = await context.newPage()
      await page.goto(url)
      await page.getByRole('button', { name: 'Start speaker', exact: true }).waitFor()
      for (const role of ['Speaker', 'Microphone']) {
        await page.getByLabel(role, { exact: true }).check()
        const primary = page.locator('#session-toggle')
        const box = await primary.boundingBox()
        assert.ok(box && box.height >= 64 && box.y >= 0 && box.y + box.height <= height + 1, `${width}x${height} ${role}: large primary action stays visible`)
        await page.locator('#help-toggle').tap({ position: { x: 8, y: 8 } })
        await page.locator('#help-panel').waitFor()
        const controls = await page.locator('button:visible, a.soft-button:visible, .role-option label').evaluateAll(elements => elements.map(element => {
          const box = element.getBoundingClientRect()
          return { name: element.getAttribute('aria-label') || element.textContent, width: box.width, height: box.height }
        }))
        for (const control of controls) assert.ok(control.width >= 56 && control.height >= 56, `${width}x${height} ${control.name}: mobile target ${control.width}x${control.height}`)
        await page.getByRole('button', { name: 'Close help', exact: true }).tap({ position: { x: 8, y: 8 } })
        await page.locator('#help-panel').waitFor({ state: 'hidden' })
      }
      await page.locator('#invitation').fill('https://untrusted.example/#speaker=e30&key=bad')
      await page.getByRole('button', { name: 'Pair', exact: true }).tap()
      await page.getByRole('alert').waitFor()
      assert.equal(await page.locator('#invitation').getAttribute('aria-invalid'), 'true', 'Large pairing control still submits validation')
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1), false, 'Mobile controls do not introduce document scrolling')
    } finally {
      await context.close()
    }
  }
  console.info('Mobile checks passed: larger touch targets, visible primary actions, edge taps, Help, and pairing validation on regular and short screens')
}
