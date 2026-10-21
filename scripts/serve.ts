import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../_site/', import.meta.url))
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.PORT || 4173),
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname == '/') return Response.redirect(new URL('/webmic/', url))
    if (!url.pathname.startsWith('/webmic/')) return new Response('Not found', { status: 404 })
    let path: string
    try {
      path = resolve(root, `.${decodeURIComponent(url.pathname.slice('/webmic'.length))}`)
    } catch {
      // Malformed percent escapes are invalid request paths.
      return new Response('Invalid path', { status: 400 })
    }
    if (path != resolve(root) && !path.startsWith(resolve(root) + sep)) return new Response('Not found', { status: 404 })
    if (url.pathname.endsWith('/')) path = resolve(path, 'index.html')
    const file = Bun.file(path)
    return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 })
  }
})
console.info(`WebMic preview: ${server.url}webmic/`)
