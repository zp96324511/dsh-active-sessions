/**
 * Update channel for dsh-active-sessions.
 *
 * Mirrors the shape of dsh-context-control's update channel, trimmed to what this
 * plugin needs: a release tarball next to a `channel.json` manifest, an npm
 * registry entry, or an explicit `update.manifestUrl` / `update.github`.
 *
 * Nothing here touches the running host. Upgrades install into the active profile
 * and stop there: the process that started the host owns its command line (extra
 * flags, ports, `--public-url`, environment), so a relaunch reconstructed from
 * `process.argv` would silently drop whatever the launcher added. The Client only
 * reports "installed, restart the host to apply".
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = 'dsh-active-sessions'

const HERE = dirname(fileURLToPath(import.meta.url))

export const LOADED_VERSION = readOwnManifest().version

function readOwnManifest() {
  return readJson(join(HERE, 'package.json')) ?? { version: '0.0.0' }
}

const LOG_LIMIT = 48 * 1024
const CHECK_TTL_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000
const UPGRADE_TIMEOUT_MS = 15 * 60 * 1000
const JOB_TTL_MS = 24 * 60 * 60 * 1000

/* ------------------------------------------------------------------ versions */

export function parseVersion(value) {
  const text = String(value ?? '').trim().replace(/^v/i, '')
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?/i.exec(text)
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumber = /^\d+$/.test(a)
    const bNumber = /^\d+$/.test(b)
    if (aNumber && bNumber) {
      const delta = Number(a) - Number(b)
      if (delta !== 0) return delta > 0 ? 1 : -1
      continue
    }
    if (aNumber) return -1
    if (bNumber) return 1
    if (a !== b) return a > b ? 1 : -1
  }
  return 0
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return 0
  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1
  return comparePrerelease(a.prerelease, b.prerelease)
}

export function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0
}

export function pickHighest(versions) {
  let best
  for (const version of versions) {
    if (parseVersion(version) === null) continue
    if (best === undefined || compareVersions(version, best) > 0) best = version
  }
  return best
}

/**
 * Loose range check. Deliberately small: channels only ever publish a plain
 * `engines.dsh` range, and a wrong answer here would only mislabel a build as
 * incompatible, never block the install itself.
 */
export function satisfiesRange(range, version, { loosePrerelease = true } = {}) {
  const text = String(range ?? '').trim()
  if (text === '' || text === '*' || text === 'x') return true
  const actual = loosePrerelease ? String(version ?? '').split('-')[0] : String(version ?? '')
  if (parseVersion(actual) === null) return true
  return text.split('||').some((branch) => {
    const comparators = branch.trim().split(/\s+/).filter((part) => part !== '')
    if (comparators.length === 0) return true
    return comparators.every((comparator) => matchesComparator(comparator, actual))
  })
}

function expandComparatorVersion(value) {
  const cleaned = String(value).trim()
  if (cleaned === '' || cleaned === '*' || cleaned === 'x') return null
  return parseVersion(cleaned) === null ? null : cleaned.replace(/^v/i, '')
}

function matchesComparator(comparator, version) {
  const operator = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator)
  if (operator === null) return true
  const symbol = operator[1] ?? ''
  const target = expandComparatorVersion(operator[2])
  if (target === null) return true
  const delta = compareVersions(version, target)
  if (symbol === '>=') return delta >= 0
  if (symbol === '<=') return delta <= 0
  if (symbol === '>') return delta > 0
  if (symbol === '<') return delta < 0
  if (symbol === '^') {
    const wanted = parseVersion(target)
    const actual = parseVersion(version)
    if (wanted === null || actual === null) return true
    if (delta < 0) return false
    if (wanted.major > 0) return actual.major === wanted.major
    if (wanted.minor > 0) return actual.major === 0 && actual.minor === wanted.minor
    return actual.major === 0 && actual.minor === 0 && actual.patch === wanted.patch
  }
  if (symbol === '~') {
    const wanted = parseVersion(target)
    const actual = parseVersion(version)
    if (wanted === null || actual === null) return true
    if (delta < 0) return false
    return actual.major === wanted.major && actual.minor === wanted.minor
  }
  return delta === 0
}

/* --------------------------------------------------------------------- io */

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function fetchJson(url, { timeout = FETCH_TIMEOUT_MS, headers = {}, fetch: fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': PACKAGE_NAME, ...headers },
    })
    if (!response.ok) {
      // A 404 on a channel URL usually means "published before the asset existed"
      // or "the host is still running an older build"; callers turn this into text.
      throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim())
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------- environment */

export function resolveDshHome() {
  const override = process.env.DSH_HOME
  if (typeof override === 'string' && override.trim() !== '') return resolve(override)
  return join(homedir(), '.dsh')
}

export function resolveProfileName(argv = process.argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile' || arg === '-p') {
      const next = argv[index + 1]
      if (typeof next === 'string' && next !== '') return next
    }
    if (typeof arg === 'string' && arg.startsWith('--profile=')) return arg.slice('--profile='.length)
  }
  const fromEnv = process.env.DSH_PROFILE
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return 'web'
}

export function findProfile(ctx, name = resolveProfileName()) {
  const home = resolveDshHome()
  const dir = join(home, 'profiles', name)
  if (!existsSync(join(dir, 'package.json'))) return undefined
  return { name, dir, url: readProfileDependency(dir, PACKAGE_NAME) }
}

export function readProfileDependency(profileDir, name = PACKAGE_NAME) {
  const manifest = readJson(join(profileDir, 'package.json'))
  const value = manifest?.dependencies?.[name]
  return typeof value === 'string' ? value : undefined
}

export function resolveLauncher() {
  const cli = process.argv[1]
  if (typeof cli === 'string' && cli !== '' && existsSync(cli)) return { command: process.execPath, leading: [cli] }
  return { command: 'dsh', leading: [] }
}

export function resolveRuntimeVersion(launcher = resolveLauncher()) {
  const start = launcher.leading[0]
  if (typeof start !== 'string') return undefined
  let dir = dirname(resolve(start))
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = readJson(join(dir, 'package.json'))
    if (manifest?.name === '@deepseek-ai/dsh') return manifest.version
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export function resolveRegistry(fallback = 'https://registry.npmjs.org/') {
  const fromEnv = process.env.NPM_CONFIG_REGISTRY
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.endsWith('/') ? fromEnv : `${fromEnv}/`
  }
  return fallback
}

/* ----------------------------------------------------------------- channels */

export function classifySpec(spec) {
  const text = String(spec ?? '').trim()
  if (text === '') return { kind: 'unknown' }
  if (/^(link|portal):/i.test(text)) return { kind: 'link', path: text.replace(/^(link|portal):/i, '') }
  if (/^file:/i.test(text)) return { kind: 'file', path: text.replace(/^file:/i, '') }
  if (/^https?:\/\//i.test(text)) {
    if (/\.(tgz|tar\.gz)(?:[?#].*)?$/i.test(text)) return { kind: 'tarball', url: text }
    return { kind: 'git', url: text }
  }
  if (/^(git\+|git:|github:|gitlab:|bitbucket:)/i.test(text) || /\.git(?:#.*)?$/.test(text)) {
    return { kind: 'git', url: text }
  }
  const at = text.lastIndexOf('@')
  if (at > 0) return { kind: 'registry', name: text.slice(0, at), range: text.slice(at + 1) || '*' }
  return { kind: 'registry', name: text, range: '*' }
}

export function resolveChannel({ config, profile, argv } = {}) {
  const update = config?.update ?? {}
  const manifestUrl = typeof update.manifestUrl === 'string' ? update.manifestUrl.trim() : ''
  if (manifestUrl !== '') return { kind: 'manifest', manifestUrl, origin: 'config' }

  const github = typeof update.github === 'string' ? update.github.trim() : ''
  if (/^[\w.-]+\/[\w.-]+$/.test(github)) return { kind: 'github', repo: github, origin: 'config' }

  const spec = profile?.url
  const classified = classifySpec(spec)
  if (classified.kind === 'tarball') {
    const url = classified.url.split(/[?#]/)[0]
    const release = /^(https?:\/\/github\.com\/[^/]+\/[^/]+)\/releases\/(?:latest\/)?download\//i.exec(url)
    if (release !== null) {
      // A channel.json sitting next to a tagged asset is frozen at that tag, so the
      // sibling of `releases/latest/download/` is always the one that keeps moving.
      return { kind: 'manifest', manifestUrl: `${release[1]}/releases/latest/download/channel.json`, origin: 'spec' }
    }
    try {
      return { kind: 'manifest', manifestUrl: new URL('channel.json', url).href, origin: 'spec' }
    } catch {
      return { kind: 'unknown', origin: 'spec', error: `cannot derive a channel from ${url}` }
    }
  }
  if (classified.kind === 'link' || classified.kind === 'file') {
    return { kind: 'local', path: classified.path, origin: 'spec' }
  }
  if (classified.kind === 'git') return { kind: 'git', url: spec, origin: 'spec' }
  if (classified.kind === 'registry') {
    return { kind: 'registry', registry: typeof update.registry === 'string' ? update.registry : resolveRegistry(), origin: 'spec' }
  }
  return { kind: 'local', path: spec, origin: 'spec' }
}

const LOCAL_HINT = 'this installation is a local directory (file:/link:), so there is no version to compare against. Set update.manifestUrl or update.github to enable in-place upgrades.'

export async function queryChannel(channel, { timeout = FETCH_TIMEOUT_MS, fetch: fetchImpl } = {}) {
  if (channel.kind === 'local') return { ok: false, error: LOCAL_HINT }
  if (channel.kind === 'git') {
    return { ok: false, error: 'this installation tracks a git source, so there is no version to compare against. Set update.manifestUrl or update.github to enable in-place upgrades.' }
  }
  if (channel.kind === 'registry') {
    const encoded = channel.registry.endsWith('/') ? channel.registry : `${channel.registry}/`
    const documentUrl = `${encoded}${PACKAGE_NAME.replace(/^@/, '%40').replace('/', '%2f')}/latest`
    const document = await fetchJson(documentUrl, { timeout, fetch: fetchImpl })
    const version = typeof document?.version === 'string' ? document.version : undefined
    if (version === undefined) return { ok: false, error: 'the registry answered without a version' }
    return {
      ok: true,
      latest: version,
      url: documentUrl,
      engines: document.engines ?? {},
      installSpec: `${PACKAGE_NAME}@${version}`,
      notes: document.description,
    }
  }
  if (channel.kind === 'github') {
    const documentUrl = `https://api.github.com/repos/${channel.repo}/releases/latest`
    const release = await fetchJson(documentUrl, {
      timeout,
      headers: { 'x-github-api-version': '2022-11-28' },
      fetch: fetchImpl,
    })
    const tag = typeof release?.tag_name === 'string' ? release.tag_name : ''
    if (tag === '') return { ok: false, error: 'the latest release has no tag' }
    const version = tag.replace(/^v/i, '')
    return {
      ok: true,
      latest: version,
      url: documentUrl,
      engines: {},
      installSpec: `https://github.com/${channel.repo}/releases/download/${tag}/${PACKAGE_NAME}.tgz`,
      notes: typeof release.body === 'string' ? release.body.slice(0, 2000) : undefined,
    }
  }
  if (channel.kind === 'manifest') {
    const document = await fetchJson(channel.manifestUrl, { timeout, fetch: fetchImpl })
    const latest = typeof document?.latest === 'string' ? document.latest : undefined
    if (latest === undefined) return { ok: false, error: 'channel.json has no "latest" entry' }
    const entry = document.versions?.[latest]
    if (entry === undefined || entry === null || typeof entry !== 'object') {
      return { ok: false, error: `channel.json has no entry for version ${latest}` }
    }
    let url
    try {
      url = new URL(String(entry.url ?? ''), channel.manifestUrl).href
    } catch {
      return { ok: false, error: `channel.json has an unusable url for version ${latest}` }
    }
    return {
      ok: true,
      latest,
      url: channel.manifestUrl,
      engines: entry.engines ?? {},
      sha256: typeof entry.sha256 === 'string' ? entry.sha256 : undefined,
      size: typeof entry.size === 'number' ? entry.size : undefined,
      publishedAt: typeof entry.publishedAt === 'string' ? entry.publishedAt : undefined,
      notes: typeof entry.notes === 'string' ? entry.notes : undefined,
      installSpec: url,
    }
  }
  return { ok: false, error: `unsupported channel kind: ${String(channel.kind)}` }
}

export function installSpecFor(channel, version, info = {}) {
  if (channel.kind === 'registry') return `${PACKAGE_NAME}@${version}`
  if (channel.kind === 'manifest' || channel.kind === 'github') return info.installSpec
  return undefined
}

/* ----------------------------------------------------------------- updater */

export function createUpdater({ ctx, config = {}, logger = () => {}, spawn: spawnProcess = spawn, fetch: fetchImpl } = {}) {
  const state = { check: undefined, job: loadJobRecord(), running: false, disposed: false }
  const updateConfig = config?.update ?? {}

  function version() {
    return readOwnManifest().version
  }

  function installedVersion() {
    const profile = findProfile(ctx)
    if (profile === undefined) return undefined
    const manifest = readJson(join(profile.dir, 'node_modules', ...PACKAGE_NAME.split('/'), 'package.json'))
    return typeof manifest?.version === 'string' ? manifest.version : undefined
  }

  function stale() {
    const onDisk = installedVersion()
    return onDisk !== undefined && onDisk !== LOADED_VERSION
  }

  function hmr() {
    try {
      return ctx?.get?.('hmr') !== undefined
    } catch {
      return false
    }
  }

  function channel() {
    return resolveChannel({ config, profile: findProfile(ctx) })
  }

  function launcher() {
    return updateConfig.launcher ?? resolveLauncher()
  }

  function runtimeVersion() {
    return updateConfig.runtimeVersion ?? resolveRuntimeVersion(launcher())
  }

  async function check({ force = false } = {}) {
    const now = Date.now()
    const ttl = Number(updateConfig.checkIntervalMs ?? CHECK_TTL_MS)
    if (!force && state.check !== undefined && now - state.check.checkedAt < ttl) return state.check

    const profile = findProfile(ctx)
    const resolved = channel()
    const runtime = runtimeVersion()
    const base = {
      ok: true,
      current: version(),
      loaded: LOADED_VERSION,
      stale: stale(),
      hmr: hmr(),
      profile: profile?.name,
      installedSpec: profile?.url,
      runtime,
      channel: { kind: resolved.kind, origin: resolved.origin },
      upgrading: state.running,
      checkedAt: now,
    }

    let result
    try {
      const info = await queryChannel(resolved, { timeout: updateConfig.timeoutMs ?? FETCH_TIMEOUT_MS, fetch: fetchImpl })
      if (info.ok !== true) {
        result = { ...base, ok: false, hasUpdate: false, canUpgrade: false, error: info.error ?? 'the channel could not be read' }
      } else {
        const current = version()
        const hasUpdate = isNewer(info.latest, current)
        /* An unknown runtime version (a launcher we could not read) must not be
         * turned into "incompatible": the install itself is the authority. */
        const compatible = info.engines?.dsh === undefined || runtime === undefined || satisfiesRange(info.engines.dsh, runtime)
        result = {
          ...base,
          latest: info.latest,
          hasUpdate,
          canUpgrade: hasUpdate && compatible,
          compatible,
          engines: info.engines ?? {},
          publishedAt: info.publishedAt,
          notes: info.notes,
          channelUrl: info.url,
          sha256: info.sha256,
          size: info.size,
          installSpec: installSpecFor(resolved, info.latest, info),
          error: hasUpdate && !compatible ? `this build needs ${PACKAGE_NAME} compatible with ${String(info.engines?.dsh)}` : undefined,
        }
      }
    } catch (error) {
      result = { ...base, ok: false, hasUpdate: false, canUpgrade: false, error: `the channel could not be read: ${String(error?.message ?? error)}` }
    }

    result.restartRequired = result.stale === true || result.hmr !== true
    state.check = result
    return result
  }

  function jobRecordPath() {
    return join(resolveDshHome(), 'storages', `${PACKAGE_NAME}-update.json`)
  }

  function saveJobRecord() {
    const path = jobRecordPath()
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(state.job, null, 2)}\n`, 'utf8')
    } catch (error) {
      logger(`update job record could not be written: ${String(error)}`)
    }
  }

  function loadJobRecord() {
    const record = readJson(join(resolveDshHome(), 'storages', `${PACKAGE_NAME}-update.json`))
    if (record === null || typeof record !== 'object') return { state: 'idle', lines: [] }
    const startedAt = Number(record.startedAt ?? 0)
    if (startedAt > 0 && Date.now() - startedAt > JOB_TTL_MS) return { state: 'idle', lines: [] }
    if (record.state === 'running') {
      // The record only says "running" while this process is alive; a reload in the
      // middle of an install leaves it behind, so report the interruption instead.
      return { ...record, state: 'failed', finishedAt: Date.now(), error: 'the install was interrupted by a reload' }
    }
    return record
  }

  function append(line) {
    const text = String(line ?? '').replace(/\s+$/u, '')
    if (text === '') return
    state.job.lines = [...(state.job.lines ?? []), text]
    const joined = state.job.lines.join('\n')
    if (joined.length > LOG_LIMIT) state.job.lines = [joined.slice(joined.length - LOG_LIMIT)]
  }

  function jobView() {
    const job = state.job ?? { state: 'idle', lines: [] }
    return {
      state: job.state ?? 'idle',
      target: job.target,
      spec: job.spec,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      exitCode: job.exitCode,
      restartRequired: job.restartRequired === true,
      error: job.error,
      lines: (job.lines ?? []).slice(-200),
    }
  }

  async function upgrade({ version: target } = {}) {
    if (state.running) throw new Error('an upgrade is already running')

    const resolved = channel()
    if (resolved.kind === 'local' || resolved.kind === 'git') {
      throw new Error(LOCAL_HINT)
    }

    // The cached check may predate the release the user just published, so a
    // forced re-read is the difference between "no update" and a silent no-op.
    const fresh = await check({ force: true })
    if (fresh.ok !== true) throw new Error(fresh.error ?? 'the channel could not be read')
    if (fresh.hasUpdate !== true && target === undefined) throw new Error('there is no newer version to install')
    if (fresh.compatible === false) throw new Error(fresh.error ?? 'this build is not compatible with the running host')

    const wanted = target ?? fresh.latest
    const spec = installSpecFor(resolved, wanted, fresh)
    if (typeof spec !== 'string' || spec === '') throw new Error('the channel has no installable artifact')

    const profile = findProfile(ctx)
    if (profile === undefined) throw new Error('the active profile could not be located')

    state.running = true
    state.job = {
      state: 'running',
      target: wanted,
      spec,
      startedAt: Date.now(),
      restartRequired: false,
      lines: [`installing ${spec} into profile ${profile.name}`],
    }
    saveJobRecord()

    const command = launcher()
    const args = [...command.leading, 'plugin', '--profile', profile.name, 'add', spec]
    const env = { ...process.env, DSH_HOME: resolveDshHome() }

    return await new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      let child
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          child?.kill?.()
        } catch {}
        state.running = false
        state.job = { ...state.job, state: 'failed', finishedAt: Date.now(), error: `the install did not finish within ${Math.round((updateConfig.upgradeTimeoutMs ?? UPGRADE_TIMEOUT_MS) / 1000)}s` }
        saveJobRecord()
        rejectPromise(new Error(state.job.error))
      }, Number(updateConfig.upgradeTimeoutMs ?? UPGRADE_TIMEOUT_MS))

      try {
        child = spawnProcess(command.command, args, {
          cwd: profile.dir,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        settled = true
        clearTimeout(timer)
        state.running = false
        state.job = { ...state.job, state: 'failed', finishedAt: Date.now(), error: String(error?.message ?? error) }
        saveJobRecord()
        rejectPromise(new Error(state.job.error))
        return
      }

      const onData = (chunk) => {
        append(chunk.toString())
        saveJobRecord()
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)

      const finish = (exitCode, failure) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        state.running = false
        const onDisk = installedVersion()
        const staleNow = onDisk !== undefined && onDisk !== LOADED_VERSION
        state.job = {
          ...state.job,
          state: failure === undefined ? 'done' : 'failed',
          finishedAt: Date.now(),
          exitCode,
          restartRequired: staleNow || hmr() !== true,
          error: failure,
        }
        saveJobRecord()
        state.check = undefined
        if (failure === undefined) resolvePromise({ ok: true, job: jobView(), installed: onDisk, restartRequired: state.job.restartRequired })
        else rejectPromise(new Error(failure))
      }

      child.on('error', (error) => finish(undefined, String(error?.message ?? error)))
      child.on('close', (code) => {
        if (code === 0) finish(0, undefined)
        else finish(code, `the installer exited with code ${String(code)}`)
      })
    })
  }

  function dispose() {
    state.disposed = true
  }

  return {
    version,
    installedVersion,
    stale,
    channel,
    check,
    upgrade,
    dispose,
    jobView,
    loadedVersion: LOADED_VERSION,
  }
}

/* ------------------------------------------------------------------ routes */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function reply(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

async function readBody(req, limit = 8192) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

export function createUpdateRoutes(updater, { prefix = `/plugins/${PACKAGE_NAME}` } = {}) {
  return async function handle(req, res, pathname) {
    const route = String(pathname ?? '/')
    if (route === '/' || route === '') {
      reply(res, 200, { ok: true, package: PACKAGE_NAME, prefix })
      return true
    }
    if (route === '/ping') {
      reply(res, 200, { ok: true, version: updater.version(), loaded: updater.loadedVersion })
      return true
    }
    if (route === '/version') {
      reply(res, 200, { ok: true, version: updater.version(), loaded: updater.loadedVersion, package: PACKAGE_NAME })
      return true
    }
    if (route === '/update/job') {
      reply(res, 200, { ok: true, ...updater.jobView() })
      return true
    }
    if (route === '/update' && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://x')
      const force = url.searchParams.get('force') === '1'
      try {
        reply(res, 200, await updater.check({ force }))
      } catch (error) {
        reply(res, 200, { ok: false, error: String(error?.message ?? error) })
      }
      return true
    }
    if (route === '/update/upgrade' && req.method === 'POST') {
      let body = {}
      try {
        body = await readBody(req)
      } catch (error) {
        reply(res, 400, { ok: false, error: String(error?.message ?? error) })
        return true
      }
      try {
        const job = await updater.upgrade({ version: typeof body.version === 'string' ? body.version : undefined })
        reply(res, 202, { ok: true, ...job })
      } catch (error) {
        reply(res, 409, { ok: false, error: String(error?.message ?? error) })
      }
      return true
    }
    reply(res, 404, { ok: false, error: `no route ${req.method} ${route}` })
    return false
  }
}
