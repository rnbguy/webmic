import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'

export async function generateImages(root: string, output: string) {
  await mkdir(output, { recursive: true })
  const { homepage } = await Bun.file(join(root, 'package.json')).json()
  const site = new URL(homepage)
  const style = await Bun.file(join(root, 'src/style.css')).text()
  const background = 'var(--canvas)'
  const accent = 'var(--accent)'
  const shadows = '<defs><filter id="island" x="-15%" y="-15%" width="130%" height="145%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="var(--shadow)" flood-opacity=".45"/></filter></defs>'
  const microphone = await Bun.file(join(root, 'node_modules/lucide-static/icons/mic.svg')).text()
  const speaker = await Bun.file(join(root, 'node_modules/lucide-static/icons/volume-2.svg')).text()
  const artwork = (icon: string, color = accent, surface = 'var(--surface)') => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${shadows}<rect width="512" height="512" rx="112" fill="${background}"/><rect x="16" y="16" width="480" height="480" rx="104" fill="${surface}" filter="url(#island)"/><g transform="translate(88 88) scale(14)" color="${color}">${icon}</g></svg>`
  const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">${shadows}<rect width="1200" height="630" fill="${background}"/><g font-family="Arial, sans-serif"><text x="80" y="212" fill="var(--text)" font-size="108" font-weight="700" letter-spacing="-6">webmic<tspan fill="${accent}">.</tspan></text><text x="84" y="300" fill="var(--text)" font-size="38">Your phone as a</text><text x="84" y="350" fill="var(--text)" font-size="38">wireless microphone.</text><text x="84" y="420" fill="var(--muted)" font-size="25">Pair devices with a QR code.</text><text x="84" y="548" fill="${accent}" font-size="24">${site.host}${site.pathname}</text><rect x="838" y="82" width="270" height="216" rx="36" fill="var(--microphone-surface)" filter="url(#island)"/><g transform="translate(925 114) scale(4)" color="var(--microphone)">${microphone}</g><text x="973" y="263" text-anchor="middle" fill="var(--microphone)" font-size="25" font-weight="600">Microphone</text><rect x="838" y="330" width="270" height="216" rx="36" fill="var(--speaker-surface)" filter="url(#island)"/><g transform="translate(925 362) scale(4)" color="var(--speaker)">${speaker}</g><text x="973" y="511" text-anchor="middle" fill="var(--speaker)" font-size="25" font-weight="600">Speaker</text></g></svg>`
  const browser = await chromium.launch({ headless: true, channel: 'chromium' })
  try {
    const page = await browser.newPage({ colorScheme: 'light', deviceScaleFactor: 1 })
    const render = async (svg: string, name: string, width: number, height = width) => {
      await page.setViewportSize({ width, height })
      await page.setContent(`<style>${style}html,body{margin:0;padding:0;width:${width}px;height:${height}px;min-height:0;overflow:hidden}body{display:block}body>svg{display:block;width:${width}px;height:${height}px}</style>${svg}`)
      await page.locator('body > svg').screenshot({ path: join(output, name), type: 'png', omitBackground: true })
    }
    for (const [role, icon] of [['microphone', microphone], ['speaker', speaker]]) {
      for (const size of [16, 32]) await render(artwork(icon, `var(--${role})`, `var(--${role}-surface)`), `${role}-${size}x${size}.png`, size)
    }
    for (const [name, size] of [['apple-touch-icon.png', 180], ['android-chrome-192x192.png', 192], ['android-chrome-512x512.png', 512]] as const) {
      await render(artwork(microphone), name, size)
    }
    await render(preview, 'preview.png', 1200, 630)
  } finally {
    await browser.close()
  }
}
