import { cp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { generateImages } from './generate-images'
import { hashAssets, publishAssets } from './asset-graphs'

const root = fileURLToPath(new URL('../', import.meta.url))

function run(command: string[], cwd = root) {
  const result = Bun.spawnSync(command, { cwd, stdout: 'inherit', stderr: 'inherit' })
  if (result.exitCode) throw new Error(`${command[0]} failed with exit code ${result.exitCode}`)
}

run(['cargo', 'build', '--release', '--locked', '--target', 'wasm32-unknown-unknown'], `${root}transport`)
await rm(`${root}dist`, { recursive: true, force: true })
run(['wasm-bindgen', '--target', 'web', '--out-name', 'webmic_transport', '--out-dir', `${root}dist/iroh`, `${root}transport/target/wasm32-unknown-unknown/release/webmic_transport.wasm`])
const transport = await hashAssets(`${root}dist/iroh`)

for (const [entrypoint, naming] of [['src/script.ts', 'bundle.[ext]'], ['src/audio-worklet.ts', 'audio-worklet.[ext]']]) {
  const result = await Bun.build({
    entrypoints: [`${root}${entrypoint}`], outdir: `${root}dist`, target: 'browser', format: 'esm', naming, minify: true,
    define: { __TRANSPORT_PATH__: JSON.stringify(`../../transport/${transport}/webmic_transport.js`) }
  })
  if (!result.success) throw new AggregateError(result.logs, `Could not compile ${entrypoint}`)
}
await generateImages(root, `${root}dist/res`)
const { homepage } = await Bun.file(`${root}package.json`).json()
const site = new URL(homepage)
const manifest = await Bun.file(`${root}site.webmanifest`).json()
manifest.id = manifest.start_url = manifest.scope = site.pathname
await Bun.write(`${root}dist/site.webmanifest`, JSON.stringify(manifest, null, 2) + '\n')
await cp(`${root}LICENSE`, `${root}dist/LICENSE.txt`)
await cp(`${root}node_modules/lucide-static/LICENSE`, `${root}dist/lucide-LICENSE.txt`)
await cp(`${root}node_modules/simple-icons/LICENSE.md`, `${root}dist/simple-icons-LICENSE.txt`)
let html = (await Bun.file(`${root}index.html`).text()).replaceAll('__SITE_URL__', site.href)
for (const match of html.matchAll(/<!-- icon:([a-z0-9-]+) -->/g)) {
  const library = match[1] == 'github' ? 'simple-icons' : 'lucide-static'
  html = html.replaceAll(match[0], await Bun.file(`${root}node_modules/${library}/icons/${match[1]}.svg`).text())
}
const version = await hashAssets(`${root}dist`, html + transport, true)
await publishAssets({
  dist: `${root}dist`, output: `${root}_site`, previous: process.env.WEBMIC_PREVIOUS_SITE || `${root}_site`,
  html, version, transport
})
console.info(`Static site built in _site/ (UI ${version}, transport ${transport}; current + two prior releases)`)
