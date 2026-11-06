#!/usr/bin/env node
/**
 * Build a static release channel.
 *
 *   npm run channel            # dist/<name>-<version>.tgz + dist/channel.json
 *   npm run channel -- --prune 5
 *   npm run channel:serve      # serve dist/ on http://127.0.0.1:10600
 *
 * `channel.json` is what the plugin's update route reads when the package was
 * installed from a tarball URL: it maps version -> { url, sha256, size, engines }.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

function flag(name, fallback) {
  const index = argv.indexOf(name)
  if (index === -1) return fallback
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}

const dist = resolve(root, flag('--dist', 'dist'))
const pruneCount = Number(flag('--prune', '0'))

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(value).trim())
  if (match === null) return null
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ?? '' }
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return 0
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index] ? 1 : -1
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === '') return 1
  if (b.prerelease === '') return -1
  return a.prerelease > b.prerelease ? 1 : -1
}

function pickLatest(versions) {
  let best
  for (const version of versions) {
    if (parseVersion(version) === null) continue
    if (best === undefined || compareVersions(version, best) > 0) best = version
  }
  return best
}

mkdirSync(dist, { recursive: true })

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', dist], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
}))[0]

const tarball = join(dist, packed.filename)
const bytes = readFileSync(tarball)
const sha256 = createHash('sha256').update(bytes).digest('hex')

const channelPath = join(dist, 'channel.json')
const previous = existsSync(channelPath) ? JSON.parse(readFileSync(channelPath, 'utf8')) : { name: manifest.name, channel: 'stable', versions: {} }
const versions = { ...(previous.versions ?? {}) }
versions[manifest.version] = {
  url: relative(dist, tarball).split('\\').join('/'),
  sha256,
  size: statSync(tarball).size,
  engines: manifest.engines ?? {},
  publishedAt: new Date().toISOString(),
  notes: manifest.description,
}

let latest = pickLatest(Object.keys(versions))
if (pruneCount > 0) {
  const ordered = Object.keys(versions).sort((left, right) => compareVersions(right, left))
  for (const version of ordered.slice(pruneCount)) {
    const entry = versions[version]
    delete versions[version]
    if (typeof entry?.url === 'string') {
      const stale = join(dist, entry.url)
      if (existsSync(stale)) rmSync(stale)
    }
  }
  latest = pickLatest(Object.keys(versions))
}

const channel = {
  name: manifest.name,
  channel: 'stable',
  latest,
  versions,
  homepage: manifest.homepage,
  updatedAt: new Date().toISOString(),
}

writeFileSync(channelPath, `${JSON.stringify(channel, null, 2)}\n`, 'utf8')

console.log(`channel: ${manifest.name}@${manifest.version} (latest ${latest})`)
console.log(`  ${relative(root, tarball)}  ${bytes.length} B  sha256 ${sha256.slice(0, 12)}…`)
console.log(`  ${relative(root, channelPath)}  ${Object.keys(versions).length} version(s)`)
console.log(`  files: ${readdirSync(dist).join(', ')}`)
console.log('')
console.log('install from this directory (serve it with `npm run channel:serve`):')
console.log(`  dsh plugin --profile web add http://127.0.0.1:10600/${packed.filename}`)
