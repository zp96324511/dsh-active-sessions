// Unit tests for the host's background warm-up sweep.
//
// `startWarmup` is not part of the pure region the other suites evaluate, so it
// is extracted by brace matching and driven with fake services. The point is
// the *decisions* — which Sessions get folded, which are skipped, and that
// `stop()` really stops — not the storage plumbing underneath.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

/**
 * Cut one top-level function declaration out of a source text.
 *
 * The parameter list is skipped paren by paren first: defaults like
 * `hooks = {}` would otherwise be mistaken for the body's opening brace.
 *
 * @param name - function name.
 * @returns the function source, including its `function` keyword.
 */
function extract(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} not found in index.js`)
  let parens = 0
  let body = -1
  for (let index = source.indexOf('(', start); index < source.length; index += 1) {
    const char = source[index]
    if (char === '(') parens += 1
    else if (char === ')') {
      parens -= 1
      if (parens === 0) {
        body = source.indexOf('{', index)
        break
      }
    }
  }
  assert.ok(body > start, `${name} has no body`)
  let depth = 0
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`unbalanced braces around ${name}`)
}

/** Build `startWarmup` with a stub `warn` (the real one logs through `ctx.logger`). */
function build() {
  /* `PROJECTION_KEY` is module scope in index.js; the extractor only takes the
   * function, so its one module-level dependency is restated here. */
  const body = `const PROJECTION_KEY = 'activeSessions'\n${extract('startWarmup')}\nreturn startWarmup`
  const warnings = []
  const factory = new Function('warn', body)
  return { startWarmup: factory((ctx, message) => warnings.push(message)), warnings }
}

/**
 * Fake host context.
 * @param stored - persistence snapshots to list.
 * @param options - `{ cached }` session ids that already have a row.
 */
function fakeContext(stored, options = {}) {
  const folded = []
  const cached = new Set(options.cached ?? [])
  const live = new Set(options.live ?? [])
  const lines = []
  const opened = []
  /* One instance per service: `ctx.get` must be stable, exactly like Cordis. */
  const cache = {
    cachedSnapshot: (header) => (cached.has(header.id) ? { asOfSeq: 1, values: {} } : undefined),
    coldSnapshot: (meta, cut, events) => {
      folded.push({ id: meta.id, cut, events: events.length })
      return { asOfSeq: 1, values: {} }
    },
  }
  const persistence = {
    list: async () => stored,
    open: async (id, access) => {
      opened.push({ id, access })
      return {
        id,
        header: { id },
        inheritedEventCount: 0,
        read: async () => ({ eventState: 'detached', events: [{ seq: 0 }, { seq: 1 }] }),
        close: async () => {},
      }
    },
  }
  const sessions = { get: (id) => (live.has(id) ? { id } : undefined) }
  const services = {
    sessionProjectionCache: cache,
    sessionPersistence: persistence,
    sessions,
  }
  const ctx = {
    logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    get: (name) => services[name],
  }
  return { ctx, folded, lines, opened, cached, persistence, cache }
}

/** @param predicate - resolved when true. @returns a promise. */
function until(predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('condition not reached'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

test('folds only the Sessions that need it and reports the tally', async () => {
  const stored = [
    { header: { id: 'warm' } },
    { header: { id: 'cached' } },
    { header: { id: 'live' } },
    { header: { id: 'big' }, sizeBytes: 5000 },
    { header: { id: 'old' }, formatStatus: 'migration-required' },
  ]
  const { startWarmup } = build()
  const fake = fakeContext(stored, { cached: ['cached'], live: ['live'] })
  const sweep = startWarmup(fake.ctx, { warmDelayMs: 0, warmBatch: 2, warmPauseMs: 0, warmMaxBytes: 1000 })

  await until(() => fake.lines.some((line) => line.startsWith('projection warm-up:')))
  sweep.stop()

  assert.deepEqual(fake.folded.map((entry) => entry.id), ['warm'])
  assert.equal(fake.folded[0].cut, 0)
  assert.equal(fake.folded[0].events, 2)
  assert.deepEqual(fake.opened, [{ id: 'warm', access: 'read' }])
  const summary = fake.lines.find((line) => line.startsWith('projection warm-up:'))
  assert.match(summary, /1 folded, 4 skipped, 0 failed/)
})

test('a failing Session is counted, not fatal', async () => {
  const { startWarmup } = build()
  const stored = [{ header: { id: 'boom' } }, { header: { id: 'warm' } }]
  const fake = fakeContext(stored)
  const realOpen = fake.persistence.open
  fake.persistence.open = async (id, access) => {
    if (id === 'boom') throw new Error('corrupt tail')
    return realOpen(id, access)
  }
  const sweep = startWarmup(fake.ctx, { warmDelayMs: 0, warmBatch: 8, warmPauseMs: 0, warmMaxBytes: 1000 })

  await until(() => fake.lines.some((line) => line.startsWith('projection warm-up:')))
  sweep.stop()

  assert.deepEqual(fake.folded.map((entry) => entry.id), ['warm'])
  assert.match(fake.lines.find((line) => line.startsWith('projection warm-up:')), /1 failed/)
})

test('stop() halts the sweep before any Session is folded', async () => {
  const stored = Array.from({ length: 20 }, (_, index) => ({ header: { id: `s${index}` } }))
  const { startWarmup } = build()
  const fake = fakeContext(stored)
  const sweep = startWarmup(fake.ctx, { warmDelayMs: 0, warmBatch: 1, warmPauseMs: 0, warmMaxBytes: 1000 })
  sweep.stop()

  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(fake.folded, [])
  assert.equal(fake.lines.some((line) => line.startsWith('projection warm-up:')), false)
})

test('a missing persistence is reported, not thrown', async () => {
  const { startWarmup, warnings } = build()
  const ctx = { logger: { info: () => {} }, get: () => undefined }
  const sweep = startWarmup(ctx, { warmDelayMs: 0, warmBatch: 1, warmPauseMs: 0, warmMaxBytes: 1000 })

  await until(() => warnings.length > 0)
  sweep.stop()

  assert.match(warnings[0], /sweep skipped/)
})

test('the baseline runs before folding and once more after it', async () => {
  const stored = [{ header: { id: 'a' } }, { header: { id: 'b' } }]
  const { startWarmup } = build()
  const fake = fakeContext(stored)
  const passes = []
  const sweep = startWarmup(fake.ctx, { warmDelayMs: 0, warmBatch: 10, warmPauseMs: 0 }, {
    baseline: async (listed, final) => {
      passes.push({ ids: listed.map((item) => item.header.id), final })
      return 0
    },
  })

  await until(() => fake.lines.some((line) => line.startsWith('projection warm-up:')))
  sweep.stop()

  assert.deepEqual(passes, [
    { ids: ['a', 'b'], final: false },
    { ids: ['a', 'b'], final: true },
  ])
  assert.match(fake.lines.at(-1), /2 folded.*0 baselined/s)
})

test('warm: false still baselines but folds nothing', async () => {
  const stored = [{ header: { id: 'a' } }]
  const { startWarmup } = build()
  const fake = fakeContext(stored)
  const passes = []
  const sweep = startWarmup(fake.ctx, { warm: false, warmDelayMs: 0, warmBatch: 10, warmPauseMs: 0 }, {
    baseline: async (listed, final) => {
      passes.push(final)
      /* Pass 1 sees no cached rows; pass 2 marks the one that exists. */
      return final ? 1 : 0
    },
  })

  await until(() => fake.lines.some((line) => line.startsWith('projection warm-up:')))
  sweep.stop()

  assert.deepEqual(fake.folded, [])
  assert.deepEqual(passes, [false, true])
  assert.match(fake.lines.at(-1), /0 folded.*1 baselined/s)
})
