import assert from 'node:assert/strict'
import type { Browser } from 'playwright'

export async function checkRecovery(browser: Browser, url: string) {
  for (const [width, height, fontSize] of [[1100, 760, '100%'], [320, 568, '100%'], [844, 390, '100%'], [320, 568, '200%']] as const) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, reducedMotion: 'reduce' })
    const preparing = Promise.withResolvers<void>()
    try {
      // Keep media/relay availability outside this deterministic layout scenario.
      await context.addInitScript(() => { AudioContext.prototype.resume = () => Promise.resolve() })
      await context.route('**/webmic_transport.js', async route => {
        await preparing.promise
        await route.fulfill({
          contentType: 'application/javascript',
          body: `export default async function () {}
          export class AudioEndpoint {
            static async create() { return new AudioEndpoint() }
            address() { return JSON.stringify({id:'a'.repeat(64),addrs:[{Relay:'https://relay.invalid/'}]}) }
            accept() { return new Promise((resolve,reject) => { this.reject = reject }) }
            close() { this.reject?.(new Error('Fixture endpoint closed')) }
          }`
        })
      })
      const page = await context.newPage()
      await page.goto(url)
      await page.evaluate(size => { document.documentElement.style.fontSize = size }, fontSize)
      await page.getByRole('button', { name: 'Start speaker', exact: true }).click()
      await page.getByRole('heading', { name: 'Preparing QR code...', exact: true }).waitFor()
      if (width === 1100) {
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        await page.waitForFunction(() => document.querySelector('.qr-loading svg')!.getAnimations().some(animation => animation.playState === 'running'))
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.waitForFunction(() => document.querySelector('.qr-loading svg')!.getAnimations().length === 0)
        await page.keyboard.press('Escape')
        await page.getByRole('button', { name: 'Start speaker', exact: true }).waitFor()
        await page.getByRole('button', { name: 'Start speaker', exact: true }).click()
        await page.getByRole('heading', { name: 'Preparing QR code...', exact: true }).waitFor()
      }
      preparing.resolve()
      await page.locator('#pairing-link').waitFor()
      if (width === 1100) {
        const inline = await page.getByAltText('Private pairing QR code for this speaker', { exact: true }).evaluate(image => {
          const box = image.getBoundingClientRect()
          const panel = image.closest('.setup-content')!.getBoundingClientRect()
          return { width: box.width, height: box.height, contained: box.top >= panel.top && box.bottom <= panel.bottom && box.left >= panel.left && box.right <= panel.right }
        })
        assert.ok(inline.width >= 128 && inline.height >= 128 && inline.contained, `Ordinary desktop pairing must expose a complete inline QR: ${JSON.stringify(inline)}`)
      }
      await page.getByRole('button', { name: 'Show pairing QR code', exact: true }).click()
      await page.getByRole('button', { name: 'Collapse pairing QR code', exact: true }).waitFor()
      const bounds = await page.getByAltText('Private pairing QR code for this speaker', { exact: true }).evaluate(image => {
        const box = image.getBoundingClientRect()
        const slot = image.closest('.workspace')!.getBoundingClientRect()
        return { width: box.width, height: box.height, contained: box.top >= slot.top - 1 && box.bottom <= slot.bottom + 1 && box.left >= slot.left - 1 && box.right <= slot.right + 1, viewport: box.top >= 0 && box.bottom <= innerHeight + 1 && box.left >= 0 && box.right <= innerWidth + 1 }
      })
      assert.ok(bounds.width >= 128 && bounds.height >= 128 && bounds.contained && bounds.viewport, `${width}x${height}: the complete QR must stay in the workspace: ${JSON.stringify(bounds)}`)
      const action = await page.locator('#session-toggle').boundingBox()
      const collapse = await page.locator('#collapse-pairing').boundingBox()
      assert.ok(action && collapse && action.y + action.height <= height && collapse.y >= 0 && collapse.y + collapse.height <= height, 'Expanded QR keeps session and collapse actions visible')
      await page.getByRole('button', { name: 'Help', exact: true }).click()
      await page.getByRole('button', { name: 'Close help', exact: true }).click()
      await page.getByRole('button', { name: 'Collapse pairing QR code', exact: true }).click()
      await page.getByRole('button', { name: 'Show pairing QR code', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Show pairing QR code', exact: true }).click()
      await page.getByRole('button', { name: 'Collapse pairing QR code', exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Show pairing QR code', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Stop speaker', exact: true }).click()
      assert.equal(await page.evaluate(() => scrollY), 0)
    } finally {
      preparing.resolve()
      await context.close()
    }
  }

  const reloadContext = await browser.newContext()
  try {
    await reloadContext.addInitScript(() => { AudioContext.prototype.resume = () => Promise.resolve() })
    await reloadContext.route('**/webmic_transport.js', route => route.abort())
    const page = await reloadContext.newPage()
    await page.goto(url)
    await page.getByRole('button', { name: 'Start speaker', exact: true }).click()
    await page.getByRole('button', { name: 'Reload app', exact: true }).waitFor()
    await reloadContext.unroute('**/webmic_transport.js')
    await page.getByRole('button', { name: 'Reload app', exact: true }).click()
    await page.getByRole('button', { name: 'Start speaker', exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-state') == 'idle')
    assert.equal(await page.locator('main').getAttribute('data-state'), 'idle', 'Reload creates a fresh usable controller after a failed deferred import')
  } finally {
    await reloadContext.close()
  }

  const context = await browser.newContext({ viewport: { width: 320, height: 568 }, reducedMotion: 'reduce' })
  try {
    await context.addInitScript(() => {
      window.AudioContext = new Proxy(AudioContext, { construct() { throw new DOMException('Audio output unavailable', 'NotSupportedError') } })
    })
    const page = await context.newPage()
    await page.goto(url)
    await page.getByRole('button', { name: 'Start speaker', exact: true }).waitFor()
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    for (const family of ['', 'monospace', 'DejaVu Sans', 'serif']) {
      await page.evaluate(family => { document.documentElement.style.fontFamily = family }, family)
      await page.getByRole('radio', { name: 'Speaker', exact: true }).click({ trial: true })
      const roles = await page.locator('.role-option label').evaluateAll(labels => labels.map(label => {
        const text = Array.from(label.childNodes).find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
        if (!text) throw new Error('Role label has no text')
        const range = new Range()
        range.selectNodeContents(text)
        const lines = Array.from(range.getClientRects()).filter(line => line.width > 0)
        const bounds = label.getBoundingClientRect()
        return {
          readable: lines.length === 1 && lines[0].left >= bounds.left && lines[0].right <= bounds.right,
          iconLeft: label.querySelector('.icon')!.getBoundingClientRect().left,
          textLeft: range.getBoundingClientRect().left
        }
      }))
      assert.ok(roles.every(role => role.readable), `${family || 'System'}: enlarged role names must remain complete readable words: ${JSON.stringify(roles)}`)
      assert.ok(Math.abs(roles[0].iconLeft - roles[1].iconLeft) < 1 && Math.abs(roles[0].textLeft - roles[1].textLeft) < 1, 'Stacked roles must share icon and text columns')
    }
    await page.evaluate(() => { document.documentElement.style.fontFamily = '' })
    await page.getByRole('button', { name: 'Start speaker', exact: true }).click()
    const error = page.locator('#session-error')
    await page.getByRole('alert').waitFor()
    await page.getByRole('button', { name: 'Retry speaker', exact: true }).click({ trial: true })
    const readability = await error.evaluate(element => {
      let scroller = element.parentElement!
      while (scroller.parentElement && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
      const bounds = element.getBoundingClientRect()
      const slot = scroller.getBoundingClientRect()
      return { width: bounds.width, visible: Math.min(bounds.bottom, slot.bottom) - Math.max(bounds.top, slot.top), height: bounds.height, scroll: scrollY }
    })
    assert.ok(readability.width >= 160 && readability.visible >= readability.height - 1, `Enlarged speaker error must be fully readable before scrolling: ${JSON.stringify(readability)}`)
    assert.equal(readability.scroll, 0)
    await page.locator('#volume').scrollIntoViewIfNeeded()
    const action = await page.locator('#session-toggle').boundingBox()
    assert.ok(action && action.y >= 0 && action.y + action.height <= 569, 'Reaching volume must not displace the session action')
  } finally {
    await context.close()
  }

  console.info('Recovery checks passed: same-plane QR expansion, enlarged role alignment/errors and reachable session/volume controls')
}
