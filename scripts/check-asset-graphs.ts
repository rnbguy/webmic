import assert from 'node:assert/strict'
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hashAssets, publishAssets, readReleases, retainedReleases } from './asset-graphs'
import { validateArchiveEntries } from './extract-pages'

async function checkAssetGraphs() {
  const fixture = await mkdtemp(join(tmpdir(), 'webmic-assets-'))
  const dist = join(fixture, 'dist')
  const output = join(fixture, 'site')
  const previous = join(fixture, 'downloaded-pages')
  const html = '<script type="module" src="dist/bundle.js"></script>'
  const manifest = JSON.stringify({ id: '/webmic/', start_url: '/webmic/', scope: '/webmic/' })
  try {
    for (const [path, content] of Object.entries({
      'bundle.js': 'export const release = 0', 'bundle.css': 'body {}', 'audio-worklet.js': 'export {}',
      'site.webmanifest': manifest, 'res/icon.png': 'fixture icon',
      'iroh/webmic_transport.js': 'export default () => new URL("webmic_transport_bg.wasm", import.meta.url)',
      'iroh/webmic_transport_bg.wasm': new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
    })) await Bun.write(join(dist, path), content)

    // The initial artifact has the b9540da-era layout and no release manifest.
    const legacy = await hashAssets(dist, html)
    await cp(dist, join(previous, 'dist', legacy), { recursive: true })
    await Bun.write(join(previous, 'index.html'), html.replaceAll('dist/', `dist/${legacy}/`))
    assert.deepEqual(await readReleases(previous), [{ version: legacy, transport: null }])

    const history: { version: string, transport: string | null }[] = [{ version: legacy, transport: null }]
    let unchangedTransport = ''
    for (let release = 1; release <= 5; release++) {
      await Bun.write(join(dist, 'bundle.js'), `export const release = ${release}`)
      if (release === 3) await Bun.write(join(dist, 'iroh/webmic_transport.js'), 'export const revision = 3')
      if (release === 4) await Bun.write(join(dist, 'iroh/webmic_transport_bg.wasm'), new Uint8Array([0, 97, 115, 109, 4]))
      const transport = await hashAssets(join(dist, 'iroh'))
      if (release === 1) unchangedTransport = transport
      if (release === 2) assert.equal(transport, unchangedTransport, 'UI-only updates retain the same transport URL')
      if (release === 3 || release === 4) assert.notEqual(transport, history[0].transport, 'Either glue or Wasm changes the shared transport URL')
      const version = await hashAssets(dist, html + transport, true)
      assert.notEqual(version, history[0].version)
      history.unshift({ version, transport })
      const retained = history.slice(0, retainedReleases)
      await publishAssets({ dist, output, previous, html, version, transport })
      assert.deepEqual(await readReleases(output), retained)
      assert.deepEqual((await readdir(join(output, 'dist'))).sort(), retained.map(item => item.version).sort())
      assert.deepEqual((await readdir(join(output, 'transport'))).sort(), [...new Set(retained.map(item => item.transport).filter(Boolean))].sort())
      assert.equal(await Bun.file(join(output, 'index.html')).text(), html.replaceAll('dist/', `dist/${version}/`))
      for (const item of retained) {
        const graph = join(output, 'dist', item.version)
        const transportGraph = item.transport ? join(output, 'transport', item.transport) : join(graph, 'iroh')
        for (const path of ['bundle.js', 'bundle.css', 'audio-worklet.js', 'res/icon.png']) assert.ok(await Bun.file(join(graph, path)).exists())
        assert.equal(await Bun.file(join(graph, 'site.webmanifest')).text(), manifest, 'Installed app identity stays stable')
        assert.ok(await Bun.file(join(transportGraph, 'webmic_transport.js')).exists())
        assert.ok(await Bun.file(join(transportGraph, 'webmic_transport_bg.wasm')).exists())
        if (item.transport) assert.equal(await hashAssets(transportGraph), item.transport, 'Glue and Wasm form one immutable graph')
      }
      // A fresh runner receives only the downloaded artifact, not the previous workspace.
      await rm(previous, { recursive: true, force: true })
      await cp(output, previous, { recursive: true })
      if (release === 5) {
        const before = await Bun.file(join(output, 'releases.json')).text()
        await publishAssets({ dist, output, previous, html, version, transport })
        assert.equal(await Bun.file(join(output, 'releases.json')).text(), before, 'Rebuilding unchanged assets must not consume a retention slot')
      }
    }
    await rm(join(previous, 'transport', history[1].transport!, 'webmic_transport_bg.wasm'))
    await assert.rejects(publishAssets({
      dist, output, previous, html, version: history[0].version, transport: history[0].transport!
    }), /Incomplete asset graph/)
    assert.deepEqual(await readReleases(output), history.slice(0, retainedReleases), 'An incomplete previous artifact must not replace the working site')

    validateArchiveEntries('./\n./index.html\n', 'drwxr-xr-x root/root 0 date ./\n-rw-r--r-- root/root 1 date ./index.html\n')
    for (const path of ['/etc/passwd', '../escape', './dist/../../escape', './line\\nbreak']) {
      assert.throws(() => validateArchiveEntries(`${path}\n`, '-rw-r--r-- entry\n'), /Unsafe path/)
    }
    for (const type of ['l', 'h', 'b', 'p']) assert.throws(() => validateArchiveEntries('./entry\n', `${type} entry\n`), /regular files/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
}

await checkAssetGraphs()
console.info('Asset checks passed: independent transport hashes, bounded retained graphs, stable app identity and safe archives')
