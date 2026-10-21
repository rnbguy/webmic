import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

export async function generateImages(root: string, output: string) {
  await mkdir(output, { recursive: true })
  const { homepage } = await Bun.file(join(root, 'package.json')).json()
  const site = new URL(homepage)
  const style = await Bun.file(join(root, 'src/style.css')).text()
  const background = 'var(--surface)'
  const accent = 'var(--accent)'
  const shadows = '<defs><filter id="raised" x="-35%" y="-35%" width="170%" height="170%" color-interpolation-filters="sRGB"><feDropShadow dx="12" dy="12" stdDeviation="12" flood-color="var(--shadow)"/><feDropShadow dx="-12" dy="-12" stdDeviation="12" flood-color="var(--highlight)"/></filter></defs>'
  const microphone = await Bun.file(join(root, 'node_modules/lucide-static/icons/mic.svg')).text()
  const speaker = await Bun.file(join(root, 'node_modules/lucide-static/icons/volume-2.svg')).text()
  const artwork = (icon: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${shadows}<rect width="512" height="512" fill="${background}"/><circle cx="256" cy="256" r="178" fill="${background}" filter="url(#raised)"/><g transform="translate(136 136) scale(10)" color="${accent}">${icon}</g></svg>`
  const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">${shadows}<rect width="1200" height="630" fill="${background}"/><circle cx="948" cy="315" r="164" fill="${background}" filter="url(#raised)"/><g transform="translate(876 243) scale(6)" color="${accent}">${microphone}</g><g font-family="Arial, sans-serif"><text x="88" y="235" fill="var(--text)" font-size="104" font-weight="700" letter-spacing="-7">webmic<tspan fill="${accent}">.</tspan></text><text x="94" y="310" fill="var(--text)" font-size="30">Your phone as a wireless microphone.</text><text x="94" y="365" fill="var(--muted)" font-size="24">Pair with a QR code. Speak through another device.</text><text x="94" y="532" fill="${accent}" font-size="24">${site.host}${site.pathname}</text></g></svg>`
  const browser = await chromium.launch({ headless: true, channel: 'chromium' })
  try {
    const page = await browser.newPage({ colorScheme: 'light', deviceScaleFactor: 1 })
    const render = async (svg: string, name: string, width: number, height = width) => {
      await page.setViewportSize({ width, height })
      await page.setContent(`<style>${style}body{margin:0}body>svg{display:block;width:${width}px;height:${height}px}</style>${svg}`)
      await page.locator('body > svg').screenshot({ path: join(output, name), type: 'png', omitBackground: true })
    }
    for (const [role, icon] of [['microphone', microphone], ['speaker', speaker]]) {
      for (const size of [16, 32]) await render(artwork(icon), `${role}-${size}x${size}.png`, size)
    }
    for (const [name, size] of [['apple-touch-icon.png', 180], ['android-chrome-192x192.png', 192], ['android-chrome-512x512.png', 512]] as const) {
      await render(artwork(microphone), name, size)
    }
    await render(preview, 'preview.png', 1200, 630)
  } finally {
    await browser.close()
  }
}
