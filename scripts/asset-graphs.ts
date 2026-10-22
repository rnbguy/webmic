import { cp, mkdtemp, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

export type Release = { version: string, transport: string | null }
const digestPattern = /^[a-f0-9]{16}$/
export const retainedReleases = 3

export async function hashAssets(directory: string, prefix = '', excludeTransport = false) {
  const hash = createHash('sha256').update(prefix)
  const paths = await Array.fromAsync(new Bun.Glob('**/*').scan(directory))
  for (const path of paths.sort()) {
    if (excludeTransport && path.startsWith('iroh/')) continue
    const bytes = await Bun.file(join(directory, path)).bytes()
    hash.update(JSON.stringify([path, bytes.length])).update(bytes)
  }
  return hash.digest('hex').slice(0, 16)
}

export async function readReleases(site: string): Promise<Release[]> {
  const manifest = Bun.file(join(site, 'releases.json'))
  if (await manifest.exists()) {
    const data: unknown = await manifest.json()
    if (!Array.isArray(data) || !data.length || data.length > retainedReleases || !data.every(release =>
      release && typeof release.version === 'string' && digestPattern.test(release.version) &&
      (release.transport === null || (typeof release.transport === 'string' && digestPattern.test(release.transport))))) {
      throw new Error(`Invalid release manifest in ${site}`)
    }
    if (new Set(data.map(release => release.version)).size !== data.length) throw new Error('Duplicate release identity')
    return data
  }
  const index = Bun.file(join(site, 'index.html'))
  if (!await index.exists()) return []
  // The first retained deployment predates releases.json and carries its own iroh directory.
  const version = (await index.text()).match(/\bdist\/([a-f0-9]{16})\/bundle\.js/)?.[1]
  if (!version) throw new Error(`Cannot identify the previous release in ${site}`)
  return [{ version, transport: null }]
}

async function requireFiles(directory: string, files: string[]) {
  for (const file of files) {
    if (!await Bun.file(join(directory, file)).exists()) throw new Error(`Incomplete asset graph: ${join(directory, file)}`)
  }
}

export async function publishAssets(options: {
  dist: string, output: string, previous: string, html: string, version: string, transport: string
}) {
  const { dist, output, previous, html, version, transport } = options
  if (!digestPattern.test(version) || !digestPattern.test(transport)) throw new Error('Invalid asset digest')
  const releases: Release[] = [{ version, transport }, ...(await readReleases(previous))
    .filter(release => release.version !== version).slice(0, retainedReleases - 1)]
  const staging = await mkdtemp(join(dirname(output), '.site-'))
  try {
    for (const release of releases) {
      const source = release.version === version ? dist : join(previous, 'dist', release.version)
      await requireFiles(source, ['bundle.js', 'bundle.css', 'audio-worklet.js', 'site.webmanifest'])
      await cp(source, join(staging, 'dist', release.version), {
        recursive: true,
        filter: path => release.version !== version || path !== join(dist, 'iroh')
      })
      const transportSource = release.version === version ? join(dist, 'iroh')
        : release.transport ? join(previous, 'transport', release.transport) : join(source, 'iroh')
      await requireFiles(transportSource, ['webmic_transport.js', 'webmic_transport_bg.wasm'])
      if (release.transport) {
        const target = join(staging, 'transport', release.transport)
        if (!await Bun.file(join(target, 'webmic_transport.js')).exists()) await cp(transportSource, target, { recursive: true })
      }
    }
    await Bun.write(join(staging, 'index.html'), html.replaceAll('dist/', `dist/${version}/`))
    await Bun.write(join(staging, 'releases.json'), JSON.stringify(releases, null, 2) + '\n')
    await Bun.write(join(staging, '.nojekyll'), '')
    await rm(output, { recursive: true, force: true })
    await rename(staging, output)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return releases
}
