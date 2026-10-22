import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

export function validateArchiveEntries(names: string, details: string) {
  const paths = names.trimEnd().split('\n')
  if (!paths.length || paths.some(path => !/^(\.\/)?[A-Za-z0-9_./-]+$/.test(path) ||
    path.startsWith('/') || path.split('/').includes('..'))) {
    throw new Error('Unsafe path in previous Pages archive')
  }
  const entries = details.trimEnd().split('\n')
  if (entries.length !== paths.length || entries.some(entry => !['-', 'd'].includes(entry[0] || ''))) {
    throw new Error('Previous Pages archive must contain only regular files and directories')
  }
}

export async function extractPages(archive: string, destination: string) {
  function tar(args: string[]) {
    const result = Bun.spawnSync(['tar', ...args], { stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode) throw new Error(`Cannot read previous Pages artifact: ${result.stderr.toString()}`)
    return result.stdout.toString()
  }
  validateArchiveEntries(
    tar(['--list', '--quoting-style=escape', '--file', archive]),
    tar(['--list', '--verbose', '--quoting-style=escape', '--file', archive])
  )
  await mkdir(destination, { recursive: true })
  tar(['--extract', '--file', archive, '--directory', destination, '--no-same-owner', '--no-same-permissions'])
}

if (import.meta.main) {
  const [archive, destination] = process.argv.slice(2)
  if (!archive || !destination) throw new Error('Usage: bun scripts/extract-pages.ts <artifact.tar> <previous-site>')
  await extractPages(resolve(archive), resolve(destination))
}
