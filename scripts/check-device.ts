import assert from 'node:assert/strict'
import { devices, type Browser } from 'playwright'

export async function checkDeviceDefaults(browser: Browser, url: string) {
  for (const [name, device, expected] of [
    ['desktop', {}, 'Speaker'],
    ['Android', devices['Pixel 5'], 'Microphone'],
    ['iPhone', devices['iPhone 13'], 'Microphone']
  ] as const) {
    // Firefox does not support isMobile emulation; retain mobile UA, viewport, and touch.
    const context = await browser.newContext({ ...device, ...(browser.browserType().name() === 'firefox' ? { isMobile: false } : {}), reducedMotion: 'reduce' })
    try {
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(url)
      await page.waitForFunction(() => !!document.querySelector('#session-toggle')?.getAttribute('aria-label'))
      const speaker = page.getByLabel('Speaker', { exact: true })
      const microphone = page.getByLabel('Microphone', { exact: true })
      assert.equal(await page.getByLabel(expected, { exact: true }).isChecked(), true, `${name}: default role`)
      assert.match(await page.locator('link[rel=icon]').first().getAttribute('href') || '', new RegExp(expected.toLowerCase()), `${name}: default favicon`)
      const speakerBox = await page.locator('label[for=speaker]').boundingBox()
      const microphoneBox = await page.locator('label[for=microphone]').boundingBox()
      assert.ok(speakerBox && microphoneBox && speakerBox.x + speakerBox.width <= microphoneBox.x + 1, `${name}: Speaker is left of Microphone`)
      await (expected == 'Speaker' ? microphone : speaker).check()
      assert.equal(await (expected == 'Speaker' ? microphone : speaker).isChecked(), true, `${name}: manual role override`)
      await page.getByLabel(expected, { exact: true }).check()
      assert.equal(await page.getByLabel(expected, { exact: true }).isChecked(), true, `${name}: manual role restore`)

      if (name == 'desktop') {
        const address = btoa(JSON.stringify({ id: 'not-contacted-in-device-test' })).replace(/=+$/, '')
        const pairingURL = new URL(url)
        pairingURL.hash = new URLSearchParams({ speaker: address, key: 'a'.repeat(64) }).toString()
        await page.goto(pairingURL.href)
        await page.waitForFunction(() => !location.hash)
        assert.equal(await microphone.isChecked(), true, 'Pairing link overrides desktop default')
        assert.equal(new URL(page.url()).hash, '', 'Pairing secret is removed from URL')
        assert.equal(await page.locator('#invitation').inputValue(), '', 'Pairing secret is removed from input')
        assert.match(await page.locator('link[rel=icon]').first().getAttribute('href') || '', /microphone/, 'Pairing updates the role favicon')
        await speaker.check()
        assert.equal(await speaker.isChecked(), true, 'Manual role selection remains available after pairing')
      }
      assert.deepEqual(errors, [], `${name}: no browser runtime errors`)
    } finally {
      await context.close()
    }
  }
  console.info('Device checks passed: desktop/Android/iPhone defaults, role order, manual overrides, pairing precedence and secret removal, role favicons')
}
