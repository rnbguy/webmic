import assert from 'node:assert/strict'
import type { Browser, Page } from 'playwright'

async function checkPinnedAction(page: Page, label: string) {
  await page.waitForFunction(() => {
    const box = document.querySelector('#session-toggle')!.getBoundingClientRect()
    return box.height >= 48 && box.top >= 0 && box.bottom <= innerHeight + 1
  })
  const layout = await page.evaluate(() => {
    const button = document.querySelector<HTMLElement>('#session-toggle')!
    const box = button.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return {
      documentOverflow: document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1,
      reachable: box.top >= 0 && box.bottom <= innerHeight + 1 && box.left >= 0 && box.right <= innerWidth + 1 && !!hit && button.contains(hit),
      height: box.height,
      scroll: scrollY,
      box: box.toJSON(),
      viewport: { width: innerWidth, height: innerHeight },
    }
  })
  assert.equal(layout.documentOverflow, false, `${label}: document must not scroll`)
  assert.equal(layout.reachable, true, `${label}: session action must remain visible and unobstructed: ${JSON.stringify(layout)}`)
  assert.ok(layout.height >= 48, `${label}: session action needs a touch-sized target`)
  assert.equal(layout.scroll, 0, `${label}: document stays anchored`)
}

export async function checkLayout(browser: Browser, url: string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', reducedMotion: 'reduce' })
  try {
    const page = await context.newPage()
    await page.goto(url)
    for (const [preference, scheme] of [['dark', 'dark'], ['light', 'light'], ['no-preference', 'light']] as const) {
      await page.emulateMedia({ colorScheme: preference })
      await page.waitForFunction(scheme => getComputedStyle(document.documentElement).colorScheme === scheme, scheme)
      assert.equal(await page.evaluate(() => {
        const meta = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name=theme-color]')).find(meta => matchMedia(meta.getAttribute('media') || 'all').matches)!
        const paint = document.createElement('canvas').getContext('2d')!
        paint.fillStyle = meta.content
        const declared = paint.fillStyle
        paint.fillStyle = getComputedStyle(document.documentElement).backgroundColor
        return declared === paint.fillStyle
      }), true, 'Browser chrome matches the system-selected page background')
      await page.getByLabel('Speaker', { exact: true }).focus()
      for (const [key, role, mode] of [['ArrowRight', 'Microphone', 'microphone'], ['ArrowLeft', 'Speaker', 'speaker']]) {
        await page.keyboard.press(key)
        await page.waitForFunction(mode => document.querySelector('main')?.getAttribute('data-mode') === mode, mode)
        assert.equal(await page.getByLabel(role, { exact: true }).isChecked(), true, 'Keyboard selection and session role agree')
        const focus = await page.evaluate(() => {
          const label = document.querySelector<HTMLElement>('.role-option input:checked + label')!
          const style = getComputedStyle(label)
          let surface: HTMLElement | null = Number.parseFloat(style.outlineOffset) < 0 ? label : label.parentElement
          while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement
          const luminance = (color: string) => {
            const [red, green, blue] = color.match(/[\d.]+/g)!.slice(0, 3).map(value => {
              const channel = Number(value) / 255
              return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
            })
            return red * .2126 + green * .7152 + blue * .0722
          }
          const foreground = luminance(style.outlineColor)
          const background = luminance(getComputedStyle(surface || document.body).backgroundColor)
          return { visible: style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0, contrast: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) }
        })
        assert.equal(focus.visible, true, `${scheme} ${role}: keyboard focus must be visible`)
        assert.ok(focus.contrast >= 3, `${scheme} ${role}: focus contrast ${focus.contrast.toFixed(2)}`)
      }
    }
    await page.locator('#volume').waitFor({ state: 'visible' })
    await page.locator('#volume').focus()
    for (const [key, value] of [['Home', '0%'], ['ArrowRight', '1%'], ['End', '100%'], ['ArrowLeft', '99%']]) {
      await page.keyboard.press(key)
      await page.waitForFunction(value => document.querySelector('output[for="volume"]')?.textContent === value, value)
    }
    for (const [width, height] of [[320, 568], [390, 844], [844, 390], [768, 600], [1280, 720], [390, 360]]) {
      await page.setViewportSize({ width, height })
      for (const role of ['Speaker', 'Microphone']) {
        await page.getByLabel(role, { exact: true }).check()
        await checkPinnedAction(page, `${width}x${height} ${role}`)
        await page.locator('#help-toggle').click()
        await page.locator('#help-panel').waitFor()
        await page.waitForFunction(() => document.activeElement === document.querySelector('#help-panel'))
        await checkPinnedAction(page, `${width}x${height} ${role} help`)
        const close = page.getByRole('button', { name: 'Close help', exact: true })
        assert.equal(await close.isVisible(), true)
        await page.locator('#session-toggle').focus()
        await page.keyboard.press('Escape')
        await page.locator('#help-panel').waitFor({ state: 'hidden' })
        assert.equal(await page.locator('#help-toggle').evaluate(element => document.activeElement === element), true)
      }
    }
    await page.setViewportSize({ width: 320, height: 568 })
    await page.getByLabel('Microphone', { exact: true }).check()
    await page.locator('#invitation').fill('https://untrusted.example/#speaker=e30&key=bad')
    await page.getByRole('button', { name: 'Pair', exact: true }).click()
    await page.getByRole('alert').waitFor()
    await checkPinnedAction(page, 'Pairing validation error')
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    await checkPinnedAction(page, 'Enlarged text')
    await page.getByRole('button', { name: 'Pair', exact: true }).scrollIntoViewIfNeeded()
    await checkPinnedAction(page, 'Enlarged text after reaching pairing action')
    console.info('Layout checks passed: viewport-bound mobile/desktop/landscape, persistent actions, help recovery, enlarged text, system appearance and bright fallback')
  } finally {
    await context.close()
  }
}
