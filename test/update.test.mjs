import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'dsh-active-sessions-update-'))
process.env.DSH_HOME = home

const update = await import('../update.js')

const { classifySpec, compareVersions, createUpdater, createUpdateRoutes, findProfile, isNewer, resolveChannel, resolveDshHome, satisfiesRange } = update

const PROFILE_DIR = join(home, 'profiles', 'web')
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

/** A version strictly newer than the one this checkout builds (fixtures only). */
const NEWER_VERSION = (() => {
  const [major, minor] = PACKAGE_VERSION.split('.').map((part) => Number.parseInt(part, 10))
  return `${major}.${minor + 1}.0`
})()

function writeProfile(spec = 'https://github.com/zp96324511/dsh-active-sessions/releases/download/v0.2.0/dsh-active-sessions.tgz') {
  mkdirSync(PROFILE_DIR, { recursive: true })
  writeFileSync(join(PROFILE_DIR, 'package.json'), `${JSON.stringify({ name: 'web', dependencies: { 'dsh-active-sessions': spec } }, null, 2)}\n`)
  return PROFILE_DIR
}

function writeInstalled(version) {
  const dir = join(PROFILE_DIR, 'node_modules', 'dsh-active-sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'dsh-active-sessions', version }, null, 2)}\n`)
}

function channelDocument(version, extra = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() {
      return {
        name: 'dsh-active-sessions',
        channel: 'stable',
        latest: version,
        versions: {
          [version]: {
            url: `https://example.test/dsh-active-sessions-${version}.tgz`,
            sha256: 'a'.repeat(64),
            size: 42,
            engines: { dsh: '>=0.2.0-rc.2' },
            publishedAt: '2026-11-06T00:00:00.000Z',
            notes: 'test',
            ...extra,
          },
        },
      }
    },
  }
}

function fakeFetch(document) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    if (typeof document === 'function') return document(url, init)
    return document
  }
  impl.calls = calls
  return impl
}

function fakeSpawn({ exitCode = 0, output = 'installed', autoClose = true } = {}) {
  const calls = []
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => { child.killed = true }
    calls.push({ command, args, options, child })
    if (autoClose) {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(output))
        child.emit('close', exitCode)
      })
    }
    return child
  }
  spawnImpl.calls = calls
  return spawnImpl
}

function fakeContext(extras = {}) {
  return { get: (name) => extras[name], ...extras }
}

function makeUpdater({ config = {}, document, spawn, ctx = fakeContext() } = {}) {
  const fetchImpl = fakeFetch(document ?? channelDocument('0.2.0'))
  const spawnImpl = spawn ?? fakeSpawn()
  const messages = []
  const updater = createUpdater({
    ctx,
    config: { update: { ...config } },
    logger: (message) => messages.push(message),
    spawn: spawnImpl,
    fetch: fetchImpl,
  })
  return { updater, fetchImpl, spawnImpl, messages }
}

test('classifySpec names every install shape', () => {
  assert.deepEqual(classifySpec('https://example.test/pkg-1.0.0.tgz'), { kind: 'tarball', url: 'https://example.test/pkg-1.0.0.tgz' })
  assert.equal(classifySpec('https://example.test/x.tar.gz').kind, 'tarball')
  assert.equal(classifySpec('github:owner/repo').kind, 'git')
  assert.equal(classifySpec('https://github.com/owner/repo').kind, 'git')
  assert.deepEqual(classifySpec('file:../pkg'), { kind: 'file', path: '../pkg' })
  assert.deepEqual(classifySpec('link:../pkg'), { kind: 'link', path: '../pkg' })
  assert.deepEqual(classifySpec('@scope/pkg@^1.2.0'), { kind: 'registry', name: '@scope/pkg', range: '^1.2.0' })
  assert.deepEqual(classifySpec('pkg'), { kind: 'registry', name: 'pkg', range: '*' })
})

test('resolveChannel always points at latest/download for a tagged GitHub asset', () => {
  const channel = resolveChannel({
    profile: { url: 'https://github.com/owner/repo/releases/download/v0.2.0/pkg.tgz' },
  })
  assert.equal(channel.kind, 'manifest')
  assert.equal(channel.manifestUrl, 'https://github.com/owner/repo/releases/latest/download/channel.json')

  const sibling = resolveChannel({ profile: { url: 'https://example.test/dist/pkg-0.2.0.tgz' } })
  assert.equal(sibling.manifestUrl, 'https://example.test/dist/channel.json')

  const local = resolveChannel({ profile: { url: 'file:../../projects/pkg' } })
  assert.equal(local.kind, 'local')

  const explicit = resolveChannel({
    config: { update: { manifestUrl: 'https://example.test/custom.json' } },
    profile: { url: 'file:../pkg' },
  })
  assert.equal(explicit.kind, 'manifest')
  assert.equal(explicit.origin, 'config')

  const github = resolveChannel({ config: { update: { github: 'owner/repo' } }, profile: {} })
  assert.equal(github.kind, 'github')

  const registry = resolveChannel({ config: { update: { registry: 'https://registry.test/' } }, profile: { url: 'pkg@1.0.0' } })
  assert.equal(registry.kind, 'registry')
})

test('version helpers compare release and prerelease orderings', () => {
  assert.equal(compareVersions('0.2.0', '0.2.0-rc.2'), 1)
  assert.equal(compareVersions('0.2.1', '0.2.0'), 1)
  assert.equal(isNewer('0.3.0', '0.2.0'), true)
  assert.equal(isNewer('0.1.9', '0.2.0'), false)
  assert.equal(satisfiesRange('>=0.2.0-rc.2', '0.2.1-rc.2'), true)
  assert.equal(satisfiesRange('^0.2.0', '0.2.9'), true)
  assert.equal(satisfiesRange('^0.2.0', '0.3.0'), false)
  assert.equal(satisfiesRange('~0.2.1', '1.0.0'), false)
  assert.equal(satisfiesRange('*', '9.9.9'), true)
})

/** Set DSH_HOME for one assertion, then put the previous value back. */
function withDshHome(value, run) {
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = value
    return run()
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
}

test('resolveDshHome expands a ~/ prefix from DSH_HOME', () => {
  withDshHome('~/x', () => {
    const resolved = resolveDshHome()
    assert.equal(resolved, join(homedir(), 'x'))
    assert.equal(resolved.includes('~'), false)
  })
})

test('resolveDshHome expands a Windows ~\\ prefix from DSH_HOME', () => {
  withDshHome('~\\x', () => {
    const resolved = resolveDshHome()
    assert.equal(resolved, join(homedir(), 'x'))
    assert.equal(resolved.includes('~'), false)
  })
})

test('resolveDshHome falls back to ~/.dsh when DSH_HOME is blank', () => {
  withDshHome('   ', () => {
    assert.equal(resolveDshHome(), join(homedir(), '.dsh'))
  })
})

test('findProfile ignores a trailing separator in DSH_HOME', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-active-sessions-home-'))
  const profileDir = join(root, 'profiles', 'web')
  try {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{}\n')
    // A backslash is only a separator on Windows; POSIX treats it as a filename byte.
    const separators = process.platform === 'win32' ? ['\\', '/'] : [sep]
    for (const trailing of separators) {
      withDshHome(`${root}${trailing}`, () => {
        assert.equal(resolveDshHome(), root)
        const profile = findProfile({}, 'web')
        assert.ok(profile, `profile must be found with a trailing ${JSON.stringify(trailing)}`)
        assert.equal(profile.dir, profileDir)
        assert.doesNotMatch(profile.dir, /[\\/]{2}/)
      })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check translates a channel document into an upgrade decision', async () => {
  writeProfile()
  writeInstalled(PACKAGE_VERSION)
  const { updater, fetchImpl } = makeUpdater({ document: channelDocument(NEWER_VERSION) })

  const info = await updater.check()
  assert.equal(info.ok, true)
  assert.equal(info.current, PACKAGE_VERSION)
  assert.equal(info.latest, NEWER_VERSION)
  assert.equal(info.hasUpdate, true)
  assert.equal(info.canUpgrade, true)
  assert.equal(info.compatible, true)
  assert.equal(info.channel.kind, 'manifest')
  assert.equal(info.installSpec, `https://example.test/dsh-active-sessions-${NEWER_VERSION}.tgz`)
  // No hmr service is mounted in this fake context, so a reload needs a restart.
  assert.equal(info.restartRequired, true)
  assert.equal(fetchImpl.calls.length, 1)
})

test('check reports up-to-date and caches the answer', async () => {
  writeProfile()
  writeInstalled('0.2.0')
  const { updater, fetchImpl } = makeUpdater({ document: channelDocument('0.2.0') })

  const first = await updater.check()
  assert.equal(first.hasUpdate, false)
  assert.equal(first.canUpgrade, false)

  await updater.check()
  assert.equal(fetchImpl.calls.length, 1, 'the second read must come from the cache')

  await updater.check({ force: true })
  assert.equal(fetchImpl.calls.length, 2)
})

test('a channel error is reported instead of looking up to date', async () => {
  writeProfile()
  const failing = async () => ({ ok: false, status: 404, statusText: 'Not Found', async json() { return {} } })
  const { updater } = makeUpdater({ document: failing })

  const info = await updater.check({ force: true })
  assert.equal(info.ok, false)
  assert.equal(info.hasUpdate, false)
  assert.match(String(info.error), /channel could not be read/)
  assert.match(String(info.error), /404/)
})

test('a local checkout refuses in-place upgrades with a hint', async () => {
  writeProfile('file:../../projects/dsh-active-sessions')
  const { updater } = makeUpdater({ document: channelDocument(NEWER_VERSION) })

  const info = await updater.check({ force: true })
  assert.equal(info.ok, false)
  assert.equal(info.channel.kind, 'local')
  assert.match(String(info.error), /update\.manifestUrl/)
  await assert.rejects(updater.upgrade({}), /local directory/)
})

test('upgrade shells out to dsh plugin add and records the job', async () => {
  writeProfile()
  writeInstalled('0.2.0')
  const spawnImpl = fakeSpawn({ exitCode: 0, output: 'added 1 package' })
  const { updater } = makeUpdater({ document: channelDocument(NEWER_VERSION), spawn: spawnImpl })

  // The installer rewrites the profile dependency, so the next read must match.
  const run = updater.upgrade({})
  await new Promise((resolve) => setImmediate(resolve))
  writeInstalled(NEWER_VERSION)
  const result = await run

  assert.equal(result.ok, true)
  assert.equal(spawnImpl.calls.length, 1)
  const [call] = spawnImpl.calls
  assert.equal(call.command, process.execPath)
  assert.deepEqual(call.args.slice(-4), ['--profile', 'web', 'add', `https://example.test/dsh-active-sessions-${NEWER_VERSION}.tgz`])
  assert.equal(call.options.cwd, PROFILE_DIR)
  assert.equal(call.options.env.DSH_HOME, home)
  assert.equal(result.restartRequired, true)

  const job = updater.jobView()
  assert.equal(job.state, 'done')
  assert.equal(job.target, NEWER_VERSION)
  assert.match(job.lines.join('\n'), /added 1 package/)
})

test('a second upgrade while one is running is rejected', async () => {
  writeProfile()
  writeInstalled('0.2.0')
  const spawnImpl = fakeSpawn({ autoClose: false })
  const { updater } = makeUpdater({ document: channelDocument(NEWER_VERSION), spawn: spawnImpl })

  const first = updater.upgrade({})
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(updater.upgrade({}), /already running/)

  spawnImpl.calls[0].child.emit('close', 0)
  await first
})

test('an installer that exits non-zero fails the job', async () => {
  writeProfile()
  writeInstalled('0.2.0')
  const spawnImpl = fakeSpawn({ exitCode: 3, output: 'boom' })
  const { updater } = makeUpdater({ document: channelDocument(NEWER_VERSION), spawn: spawnImpl })

  await assert.rejects(updater.upgrade({}), /exited with code 3/)
  assert.equal(updater.jobView().state, 'failed')
  assert.equal(updater.jobView().exitCode, 3)
})

test('upgrade refuses when there is nothing newer, without spawning', async () => {
  writeProfile()
  writeInstalled('0.2.0')
  const spawnImpl = fakeSpawn()
  const { updater } = makeUpdater({ document: channelDocument('0.2.0'), spawn: spawnImpl })

  await assert.rejects(updater.upgrade({}), /no newer version/)
  assert.equal(spawnImpl.calls.length, 0)
})

test('routes answer ping, version, update and 404', async () => {
  writeProfile()
  writeInstalled('0.2.0')
  const { updater } = makeUpdater({ document: channelDocument(NEWER_VERSION) })
  const handle = createUpdateRoutes(updater)

  async function call(method, url, body) {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      url,
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    }
    const res = {
      status: 0,
      headers: {},
      payload: '',
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(text) {
        this.payload = text ?? ''
      },
    }
    const matched = await handle(req, res, url.split('?')[0])
    return { matched, status: res.status, body: res.payload === '' ? {} : JSON.parse(res.payload) }
  }

  const ping = await call('GET', '/ping')
  assert.equal(ping.status, 200)
  assert.equal(ping.body.ok, true)
  assert.equal(ping.body.version, PACKAGE_VERSION)

  const version = await call('GET', '/version')
  assert.equal(version.body.package, 'dsh-active-sessions')

  const updateAnswer = await call('GET', '/update?force=1')
  assert.equal(updateAnswer.body.hasUpdate, true)

  const upgrade = await call('POST', '/update/upgrade', { version: NEWER_VERSION })
  assert.equal(upgrade.status, 202)
  assert.equal(upgrade.body.ok, true)

  const job = await call('GET', '/update/job')
  assert.equal(job.body.state, 'done')

  const missing = await call('GET', '/nope')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.ok, false)

  /* The plugin deliberately never restarts the host; the old endpoint must be gone. */
  const restart = await call('POST', '/update/restart')
  assert.equal(restart.status, 404)
  assert.equal(restart.body.ok, false)
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})
