#!/usr/bin/env node
/**
 * Serve `dist/` as a plain static channel, for testing the update flow without
 * publishing a release:
 *
 *   npm run channel
 *   npm run channel:serve            # http://127.0.0.1:10600
 *   dsh plugin --profile web add http://127.0.0.1:10600/dsh-active-sessions-0.2.0.tgz
 *
 * The channel is derived from the tarball URL: the plugin reads `channel.json`
 * from the same directory.
 */
'use strict'

const { createReadStream, existsSync, statSync } = require('node:fs')
const { createServer } = require('node:http')
const { dirname, join, normalize, resolve } = require('node:path')

const root = resolve(dirname(__dirname), process.argv.includes('--dist')
  ? process.argv[process.argv.indexOf('--dist') + 1] ?? 'dist'
  : 'dist')
const port = Number(process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1] ?? 10600
  : 10600)

const TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.tgz': 'application/octet-stream',
  '.gz': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8',
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const name = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const target = normalize(join(root, name === '' ? 'channel.json' : name))
  if (!target.startsWith(root)) {
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('forbidden')
    return
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end(`not found: ${name}`)
    return
  }
  const extension = target.slice(target.lastIndexOf('.'))
  const size = statSync(target).size
  res.writeHead(200, {
    'content-type': TYPES[extension] ?? 'application/octet-stream',
    'content-length': size,
  })
  createReadStream(target).pipe(res)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`channel served from ${root}`)
  console.log(`  http://127.0.0.1:${port}/channel.json`)
})
