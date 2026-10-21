import { cp, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

function run(command: string[], cwd = root) {
  const result = Bun.spawnSync(command, { cwd, stdout: 'inherit', stderr: 'inherit' })
  if (result.exitCode) throw new Error(`${command[0]} failed with exit code ${result.exitCode}`)
}

run(['cargo', 'build', '--release', '--locked', '--target', 'wasm32-unknown-unknown'], `${root}transport`)
run(['wasm-bindgen', '--target', 'web', '--out-name', 'webmic_transport', '--out-dir', `${root}dist/iroh`, `${root}transport/target/wasm32-unknown-unknown/release/webmic_transport.wasm`])

for (const [entrypoint, naming] of [['src/script.ts', 'bundle.[ext]'], ['src/audio-worklet.ts', 'audio-worklet.[ext]']]) {
  const result = await Bun.build({
    entrypoints: [`${root}${entrypoint}`], outdir: `${root}dist`, target: 'browser', format: 'esm', naming, minify: true
  })
  if (!result.success) throw new AggregateError(result.logs, `Could not compile ${entrypoint}`)
}

await rm(`${root}_site`, { recursive: true, force: true })
await mkdir(`${root}_site`, { recursive: true })
for (const path of ['index.html', 'site.webmanifest', 'favicon.ico', 'res', 'dist']) {
  await cp(`${root}${path}`, `${root}_site/${path}`, { recursive: true })
}
await Bun.write(`${root}_site/.nojekyll`, '')
console.info('Static site built in _site/')
