#!/usr/bin/env node
/**
 * Manifest guard for dsh-active-sessions.
 *
 * Runs before every pack/release: the release workflow publishes whatever
 * `npm pack` produces, so anything missing from `files` ships broken and only
 * fails after a user installs it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

function fail(message) {
  problems.push(message)
}

function read(relative) {
  const path = join(root, relative)
  if (!existsSync(path)) {
    fail(`missing file: ${relative}`)
    return undefined
  }
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    fail(`cannot read ${relative}: ${String(error)}`)
    return undefined
  }
}

const manifest = JSON.parse(read('package.json') ?? '{}')
const required = ['index.js', 'client.js', 'update.js', 'respawn.cjs', 'cordis.patch.yml', 'CHANGELOG.md', 'README.md', 'README.zh.md']

for (const file of required) {
  if (!existsSync(join(root, file))) fail(`missing file: ${file}`)
  if (Array.isArray(manifest.files) === false || manifest.files.includes(file) === false) {
    fail(`files[] does not list ${file}; it will not be published`)
  }
}

for (const [name, target] of Object.entries(manifest.exports ?? {})) {
  if (typeof target !== 'string') continue
  if (target.includes('*')) continue
  if (!existsSync(join(root, target))) fail(`exports["${name}"] points at a missing file: ${target}`)
}

if (manifest.type !== 'module') fail('package.json must set "type": "module"')
if (manifest.license !== 'MIT') fail('package.json must declare the MIT license')
if (manifest.engines?.dsh === undefined) fail('package.json must declare engines.dsh')
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail('package.json must point dsh.bundle.patch at ./cordis.patch.yml')
if (manifest.dsh?.client?.platform !== 'web') fail('package.json must declare dsh.client.platform = "web"')
if (manifest.exports?.['./update'] !== './update.js') fail('package.json must export ./update (the channel imports it)')

const patch = read('cordis.patch.yml')
if (patch !== undefined && patch.includes(manifest.name) === false) {
  fail('cordis.patch.yml does not mention the package name')
}

const changelog = read('CHANGELOG.md')
if (changelog !== undefined) {
  const heading = /^##\s+\[?v?([0-9]+\.[0-9]+\.[0-9]+)/m.exec(changelog)
  if (heading === null) fail('CHANGELOG.md has no "## <version>" heading')
  else if (heading[1] !== manifest.version) fail(`CHANGELOG.md top version is ${heading[1]} but package.json is ${manifest.version}`)
}

const locales = {}
for (const language of ['zh', 'en']) {
  const text = read(`locale/${language}.json`)
  if (text === undefined) continue
  try {
    locales[language] = JSON.parse(text)
  } catch (error) {
    fail(`locale/${language}.json is not valid JSON: ${String(error)}`)
  }
}

if (locales.zh !== undefined && locales.en !== undefined) {
  const zh = new Set(Object.keys(locales.zh))
  const en = new Set(Object.keys(locales.en))
  for (const key of zh) if (en.has(key) === false) fail(`locale/en.json is missing "${key}"`)
  for (const key of en) if (zh.has(key) === false) fail(`locale/zh.json is missing "${key}"`)
}

if (problems.length > 0) {
  console.error(`manifest check failed with ${problems.length} problem(s):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`manifest ok: ${manifest.name}@${manifest.version}, ${required.length} published entries, ${Object.keys(locales.zh ?? {}).length} locale keys`)
