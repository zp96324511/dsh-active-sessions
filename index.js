/**
 * dsh-active-sessions — Host half.
 *
 * The Client half can see "is this Session running / waiting on me" from the
 * Session UI status, but it cannot see *why a turn ended* for a Session the
 * user never opened: `lastAgentError` and `promptError` live on a Session
 * snapshot that only exists while the Session is retained. So the two durable
 * facts behind the "正在活跃" group are produced here:
 *
 * 1. `activeSessions` Session projection — per Session, the sequence number of
 *    the last turn (`turn/start.seq`), whether that turn is running, ended
 *    cleanly or failed, and the failure message. Values reach the Client for
 *    every listed Session, retained or not.
 * 2. `active_sessions` storage domain + `remote.activeSessions` — the
 *    acknowledgement records: `sessionId -> { turnSeq, at }`, written when the
 *    user opens a row or marks it read.
 *
 * Why a turn *sequence* and not a timestamp: "the user has seen the stop"
 * never reaches the Host as an event, so the Client cannot report when the
 * conversation was last viewed. `turnSeq` sidesteps it — an ack means "I have
 * seen the turn that started at seq N", and a later turn gets a larger seq and
 * is unread again by construction. No clocks, no expiry, no cross-tab drift.
 *
 * The acknowledgement records are user behaviour and live in their own storage
 * domain; the projection stays a pure function of the Session log and is
 * therefore rebuildable at any time.
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { createUpdater, createUpdateRoutes, LOADED_VERSION } from './update.js'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'dsh-active-sessions'

/** Version this module was loaded from; the update channel compares it with disk. */
export { LOADED_VERSION }

/** Services this plugin reaches at apply time. The Remote service is created, not injected. */
export const inject = ['sessionProjections', 'storageDomain']

/**
 * Background warm-up of the durable projection cache (see {@link startWarmup}).
 *
 * A row is only ever written for a Session something actually looked at, so a
 * store with thousands of finished Sessions keeps serving "no cached value"
 * for this key until the user opens each one. The sweep folds those logs once,
 * in the background, and the cache keeps the result.
 */
export const Config = z.object({
  /** Warm the projection cache for stored Sessions in the background. */
  warm: z.boolean().default(true),
  /** Quiet period after apply before the sweep starts, so startup I/O goes first. */
  warmDelayMs: z.number().default(8000),
  /** Sessions folded per tick before the sweep rests. */
  warmBatch: z.number().default(6),
  /** Rest between ticks; keeps a long sweep off the event loop's critical path. */
  warmPauseMs: z.number().default(150),
  /** Skip stored logs larger than this (bytes, compressed): a cold read holds the whole log. */
  warmMaxBytes: z.number().default(4 * 1024 * 1024),
  /**
   * Update channel served at `/plugins/dsh-active-sessions/*`.
   *
   * The channel is derived from how the package was installed: a release tarball
   * points at the `channel.json` next to `releases/latest/download/`, a registry
   * install asks the registry, and `file:`/`link:`/git installs refuse to upgrade
   * in place until `manifestUrl` or `github` names a channel explicitly.
   */
  update: z.object({
    /** Explicit channel.json URL; wins over everything else. */
    manifestUrl: z.string().default(''),
    /** `owner/repo` shorthand for a GitHub release channel. */
    github: z.string().default(''),
    /** Registry base URL for registry installs; empty means npm's configured one. */
    registry: z.string().default(''),
    /** How long a channel read stays cached before the next check. */
    checkIntervalMs: z.number().default(6 * 60 * 60 * 1000),
    /** Channel read timeout. */
    timeoutMs: z.number().default(8000),
    /** How long an installer run may take before it is abandoned. */
    upgradeTimeoutMs: z.number().default(15 * 60 * 1000),
    /** How a restart is carried out: `respawn` (default), `exit`, or `none` to disable. */
    restart: z.object({
      mode: z.string().default('respawn'),
      port: z.number().default(0),
    }),
  }),
})

/** Prototype marker the Typert Gateway reads for remotely callable methods. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Projection key; the Client half reads it as `values.activeSessions`. */
const PROJECTION_KEY = 'activeSessions'

/** Bumped whenever the wire view changes shape. */
const STATE_VERSION = 1

/**
 * Reserved key in the `acks` table recording that the one-time baseline has
 * run. It is not a Session id, so it never collides; `snapshotAcks` filters it
 * out of the wire map.
 */
const BASELINE_KEY = '#baseline'

/**
 * Initial projection state. Frozen and shared: `init()` returns this exact
 * reference, so a Session that never ran a turn costs no allocation and no
 * downstream work.
 */
const EMPTY_STATE = Object.freeze({
  lastTurnSeq: -1,
  lastTurn: 'idle',
  lastError: null,
  endedAt: null,
})

/** Wire/state schema, shared by `stateSchema` and `viewSchema` (zod instances are accepted as-is). */
const ACTIVE_SESSIONS_SCHEMA = zod.object({
  lastTurnSeq: zod.number().int().min(-1),
  lastTurn: zod.enum(['idle', 'running', 'done', 'failed']),
  lastError: zod.string().nullable(),
  endedAt: zod.number().nullable(),
})

/**
 * Acknowledgement records: one table, `sessionId -> { turnSeq, at }`.
 * `layout: 'single'` keeps the whole map in one record set (a few hundred
 * tiny rows), which is what `list()` hands to the Client in one call.
 */
const ACK_DOMAIN = defineDomain({
  name: 'active_sessions',
  version: 1,
  layout: 'single',
  tables: {
    acks: domainTable(zod.object({
      turnSeq: zod.number().int().min(-1),
      at: zod.number().int(),
    })),
  },
})

/* #region pure */
/** Logging must never break the feature (a throwing apply makes the host unbootable). */
function warn(ctx, message) {
  try {
    (ctx.logger?.warn ?? console.warn)('[dsh-active-sessions]', message)
  } catch { /* ignore */ }
}

/**
 * Extract the failure message of a `turn/end` reason.
 *
 * `TurnEndReason` is a merge-extensible sum type whose variants are objects
 * carrying `kind`; only `error` is a failure (`aborted`/`interrupted` are
 * cancellations and count as a finished turn). `error.error` is always a
 * structured `LlmFailure` — the raw LLM error facts, or a flattened
 * `{ message, code }`.
 *
 * @param reason - `turn/end` `reason` payload.
 * @returns the message, or null when the turn did not fail.
 */
function turnFailureMessage(reason) {
  if (reason === null || typeof reason !== 'object') return null
  if (reason.kind !== 'error') return null
  const failure = reason.error
  if (typeof failure === 'string' && failure !== '') return failure
  const message = typeof failure?.message === 'string' ? failure.message : ''
  if (message !== '') return message
  const code = typeof failure?.code === 'string' ? failure.code : ''
  return code !== '' ? code : 'turn failed'
}

/**
 * Fold one Session log event into the projection state.
 *
 * Contract: synchronous, and *the same state reference* for every event this
 * projection does not care about — a new object on an unrelated event would
 * invalidate every downstream consumer of the projection.
 *
 * @param state - previous state.
 * @param event - `{ type, seq, time, data }` Session log event.
 * @returns next state.
 */
function reduceActiveSessions(state, event) {
  if (event === null || typeof event !== 'object') return state
  if (event.type === 'turn/start') {
    const seq = Number(event.seq)
    if (!Number.isFinite(seq)) return state
    /* A new turn starts unread by construction: its seq is larger than any ack. */
    return { lastTurnSeq: seq, lastTurn: 'running', lastError: null, endedAt: null }
  }
  if (event.type === 'turn/end') {
    const failure = turnFailureMessage(event.data?.reason)
    const endedAt = Number(event.time)
    return {
      lastTurnSeq: state.lastTurnSeq,
      lastTurn: failure === null ? 'done' : 'failed',
      lastError: failure,
      endedAt: Number.isFinite(endedAt) ? endedAt : state.endedAt,
    }
  }
  return state
}

/**
 * Wire view cache. `wire.view` results are compared by identity (`Object.is`),
 * so one state reference must keep yielding one view reference — otherwise
 * every consumer re-renders on every projection read.
 */
const viewCache = new WeakMap()

/** @param state - projection state. @returns its stable wire view. */
function viewOfActiveSessions(state) {
  const cached = viewCache.get(state)
  if (cached !== undefined) return cached
  const view = {
    lastTurnSeq: state.lastTurnSeq,
    lastTurn: state.lastTurn,
    lastError: state.lastError,
    endedAt: state.endedAt,
  }
  viewCache.set(state, view)
  return view
}
/**
 * Decide which stored Sessions the one-time baseline has to mark as reviewed.
 *
 * The group answers "what finished and I have not looked at yet". That question
 * only makes sense from the moment the plugin starts existing: without a
 * baseline, the first Client to open the page after an install sees every
 * Session that ever finished as unread. So the first sweep acknowledges
 * whatever the cache already knows about, and later turns stay unread because
 * their sequence numbers are larger.
 *
 * Pure on purpose: the caller owns storage, this only pairs ids with sequences.
 *
 * @param stored - `sessionPersistence.list()` snapshots (`{ header }` each).
 * @param readView - `(header) => wire view | undefined`, from the projection cache.
 * @param isAcked - `(sessionId) => boolean` for records that already exist.
 * @param cutOff - epoch ms when the sweep began; anything newer stays unread.
 * @returns `[{ sessionId, turnSeq }]`, only for turns that had already ended.
 */
function planBaseline(stored, readView, isAcked, cutOff) {
  const plan = []
  for (const snapshot of Array.isArray(stored) ? stored : []) {
    const header = snapshot?.header
    if (header === undefined || header === null || header.id === undefined) continue
    const sessionId = String(header.id)
    if (isAcked(sessionId)) continue
    const view = readView(header)
    if (view === undefined || view === null) continue
    /* An open turn must stay unread, and a turn that ends after the baseline
       began would otherwise be marked reviewed before anyone could see it. */
    if (view.lastTurn !== 'done' && view.lastTurn !== 'failed') continue
    if (Number.isFinite(cutOff) && Number(view.endedAt ?? 0) >= cutOff) continue
    const turnSeq = Number(view.lastTurnSeq ?? -1)
    if (!Number.isFinite(turnSeq) || turnSeq < 0) continue
    plan.push({ sessionId, turnSeq })
  }
  return plan
}

/* #endregion pure */

/** The projection definition registered for every Session. */
const ACTIVE_SESSIONS_PROJECTION = {
  key: PROJECTION_KEY,
  stateVersion: STATE_VERSION,
  stateSchema: ACTIVE_SESSIONS_SCHEMA,
  init: () => EMPTY_STATE,
  apply: reduceActiveSessions,
  wire: {
    viewSchema: ACTIVE_SESSIONS_SCHEMA,
    view: viewOfActiveSessions,
  },
}

/**
 * Client-callable Host service. The Client half mounts the matching descriptor
 * contribution itself, so the namespace only exists once its `apply` ran.
 */
class ActiveSessionsRemote extends TypertRemoteService {
  /**
   * @param ctx - plugin context.
   * @param ops - acknowledgement implementation shared with the storage domain.
   */
  constructor(ctx, ops) {
    super(ctx, 'activeSessions')
    this.ops = ops
  }

  /** Remote `list`: every acknowledgement record. */
  async remoteList() {
    return this.ops.list()
  }

  /** Remote `ack`: acknowledge one Session up to one turn sequence. */
  async remoteAck(sessionId, turnSeq) {
    return this.ops.ack(String(sessionId), Number(turnSeq))
  }

  /** Remote `ackMany`: acknowledge several Sessions at once. */
  async remoteAckMany(entries) {
    return this.ops.ackMany(entries)
  }
}

/* Plain-JS equivalent of the decorator form: the versioned prototype descriptor
 * the Gateway's source-mode discovery reads. Export names are what the Client
 * calls (`remote.activeSessions.batch` etc. are NOT these — see the Client
 * half's descriptor contribution). */
Object.defineProperty(ActiveSessionsRemote.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: 'remoteList', exportName: 'list', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'remoteAck', exportName: 'ack', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'remoteAckMany', exportName: 'ackMany', invocation: Object.freeze({ kind: 'direct' }) }),
    ]),
  }),
})

/**
 * Fold the log of every stored Session that has no durable `activeSessions`
 * row yet, so the row is there before anything asks for it.
 *
 * What this buys: a cold row is served from the checkpoint table with zero I/O,
 * and a *missing* row is simply omitted — the list still renders, and the fold
 * happens later, when the Session is materialized. The saving is the fold
 * itself (measured at ~1.3 ms on the largest log on this machine) plus the
 * replay tail the registry would otherwise redo, not the log read: whoever
 * needs a cold value has to bring the log anyway. So the sweep is deliberately
 * polite — it starts after a quiet period, folds a handful of Sessions per
 * tick, yields between ticks, skips Sessions a live owner is writing, and
 * abandons the whole thing on dispose.
 *
 * @param ctx - host context.
 * @param config - parsed plugin config.
 * @param hooks - `{ baseline(stored, final): Promise<number> }`, the one-time
 *   "everything that already finished counts as reviewed" migration.
 * @returns `{ stop() }`.
 */
function startWarmup(ctx, config, hooks = {}) {
  const warm = config?.warm !== false
  const batch = Math.max(1, Math.trunc(Number(config?.warmBatch ?? 6)) || 6)
  const pauseMs = Math.max(0, Number(config?.warmPauseMs ?? 150) || 0)
  const maxBytes = Math.max(0, Number(config?.warmMaxBytes ?? 4 * 1024 * 1024) || 0)
  const delayMs = Math.max(0, Number(config?.warmDelayMs ?? 8000) || 0)

  const controller = new AbortController()
  let stopped = false
  let timer = null
  let resume = null

  /** @param ms - delay in milliseconds. @returns a promise that `stop()` settles early. */
  function wait(ms) {
    return new Promise((resolve) => {
      resume = resolve
      timer = setTimeout(() => {
        timer = null
        resume = null
        resolve()
      }, ms)
    })
  }

  /** @returns whether the sweep should keep going. */
  function active() {
    return !stopped
  }

  async function sweep() {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) {
      warn(ctx, 'projection sweep skipped: session persistence is not mounted')
      return
    }
    const live = ctx.get('sessions')
    let stored = []
    try {
      stored = await persistence.list({ signal: controller.signal })
    } catch (error) {
      if (active()) warn(ctx, `projection sweep could not list stored sessions: ${String(error)}`)
      return
    }
    const startedAt = Date.now()
    let baselined = 0
    /* Pass 1 runs before any folding: a store that was already warm is
     * baselined immediately instead of after a minute of log reads. */
    if (typeof hooks.baseline === 'function') {
      try {
        baselined += Number(await hooks.baseline(stored, false, startedAt)) || 0
      } catch (error) {
        warn(ctx, `projection baseline failed: ${String(error)}`)
      }
    }
    const cache = warm ? ctx.get('sessionProjectionCache') : undefined
    if (warm && cache === undefined) {
      warn(ctx, 'projection warm-up skipped: the projection cache is not mounted')
    }
    let warmed = 0
    let skipped = 0
    let failed = 0
    for (let index = 0; cache !== undefined && index < stored.length; index += 1) {
      if (!active()) return
      if (index > 0 && index % batch === 0) await wait(pauseMs)
      if (!active()) return
      const snapshot = stored[index]
      const header = snapshot?.header
      if (header === undefined || snapshot.formatStatus === 'migration-required') {
        skipped += 1
        continue
      }
      if (Number.isFinite(snapshot.sizeBytes) && snapshot.sizeBytes > maxBytes) {
        skipped += 1
        continue
      }
      /* A live Session checkpoints itself at turn/end; reading its log here
       * would race the single writer for no durable gain. */
      if (live?.get?.(header.id) !== undefined) {
        skipped += 1
        continue
      }
      if (cache.cachedSnapshot(header, [PROJECTION_KEY]) !== undefined) {
        skipped += 1
        continue
      }
      let handle = null
      try {
        handle = await persistence.open(header.id, 'read', { signal: controller.signal })
        const read = await handle.read(0, undefined, { signal: controller.signal })
        if (!active()) return
        cache.coldSnapshot(handle.header, handle.inheritedEventCount, read.events)
        warmed += 1
      } catch (error) {
        failed += 1
        if (!active()) return
      } finally {
        if (handle !== null) {
          try {
            await handle.close()
          } catch (error) {
            /* A closed handle is the only failure mode here. */
          }
        }
      }
    }
    if (!active()) return
    /* Pass 2 catches this run's folds, then closes the migration so Sessions
     * that finish from now on stay unread. */
    if (typeof hooks.baseline === 'function') {
      try {
        baselined += Number(await hooks.baseline(stored, true, startedAt)) || 0
      } catch (error) {
        warn(ctx, `projection baseline failed: ${String(error)}`)
      }
    }
    if (!active()) return
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    ctx.logger?.info?.(
      `projection warm-up: ${warmed} folded, ${skipped} skipped, ${failed} failed, ${baselined} baselined in ${seconds}s`,
    )
  }

  timer = setTimeout(() => {
    timer = null
    sweep().catch((error) => {
      warn(ctx, `projection warm-up stopped early: ${String(error)}`)
    })
  }, delayMs)

  return {
    stop() {
      stopped = true
      controller.abort()
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      const settle = resume
      resume = null
      if (settle !== null) settle()
    },
  }
}

/**
 * Host plugin body.
 *
 * @param ctx - plugin context carrying the two injected services.
 * @param config - parsed plugin config.
 * @returns cleanup for the projection registration, the warm-up sweep and the storage domain.
 */
export async function apply(ctx, config = {}) {
  /* ---------------- acknowledgement records ---------------- */

  /** sessionId -> { turnSeq, at }. Loaded from storage, always the read path. */
  const acks = new Map()
  /** Storage domain, or null when it is unavailable (in-memory degradation). */
  let domain = null

  try {
    domain = await ctx.storageDomain.open(ACK_DOMAIN)
    for (const [sessionId, record] of domain.table('acks').entries()) {
      acks.set(String(sessionId), { turnSeq: record.turnSeq, at: record.at })
    }
  } catch (error) {
    warn(ctx, `ack storage unavailable, acks stay in memory: ${String(error)}`)
    domain = null
  }

  /* All writes go through one promise chain: read-modify-write of a single
   * record stays race-free without relying on domain-level compare-and-set. */
  let writeChain = Promise.resolve()

  /**
   * Queue one write task.
   * @param task - async work.
   * @returns the task's own result (a rejection does not poison the chain).
   */
  function enqueue(task) {
    const run = writeChain.then(task)
    writeChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** @returns every acknowledgement as an array (wire-shaped, no map keys). */
  function snapshotAcks() {
    const out = []
    for (const [sessionId, record] of acks) {
      /* The baseline marker is bookkeeping, not a Session the Client knows. */
      if (sessionId === BASELINE_KEY) continue
      out.push({ sessionId, turnSeq: record.turnSeq, at: record.at })
    }
    return out
  }

  /**
   * Advance one Session's ack. Monotonic: an out-of-order or stale ack is a
   * no-op, so two tabs racing can never move the mark backwards.
   *
   * @param sessionId - Session to acknowledge.
   * @param turnSeq - sequence number the user has seen.
   */
  async function storeAck(sessionId, turnSeq) {
    if (!Number.isFinite(turnSeq) || turnSeq < 0) return
    const current = acks.get(sessionId)
    if (current !== undefined && current.turnSeq >= turnSeq) return
    const record = { turnSeq, at: Date.now() }
    if (domain !== null) await domain.table('acks').put(sessionId, record)
    acks.set(sessionId, record)
  }

  /**
   * One-time migration: everything that finished before this plugin started
   * watching is "already reviewed", otherwise a fresh Client would list every
   * Session that ever completed as unread.
   *
   * @param stored - `sessionPersistence.list()` snapshots.
   * @param final - write the marker (only after the pass that can see folds).
   * @param cutOff - when the sweep began; later turns are left unread.
   * @returns how many Sessions were marked.
   */
  async function baseline(stored, final, cutOff) {
    if (acks.has(BASELINE_KEY)) return 0
    const cache = ctx.get('sessionProjectionCache')
    if (cache === undefined) return 0
    const plan = planBaseline(
      stored,
      (header) => cache.cachedSnapshot(header, [PROJECTION_KEY])?.values?.[PROJECTION_KEY],
      (sessionId) => acks.has(sessionId),
      cutOff,
    )
    for (const entry of plan) await storeAck(entry.sessionId, entry.turnSeq)
    if (final === true) {
      const record = { turnSeq: -1, at: Date.now() }
      if (domain !== null) await domain.table('acks').put(BASELINE_KEY, record)
      acks.set(BASELINE_KEY, record)
      if (plan.length > 0) {
        ctx.logger?.info?.(`projection baseline: ${plan.length} earlier sessions marked reviewed`)
      }
    }
    return plan.length
  }

  const ops = {
    /** @returns `{ acks: [{ sessionId, turnSeq, at }] }`. */
    list() {
      return { acks: snapshotAcks() }
    },
    /**
     * @param sessionId - Session to acknowledge.
     * @param turnSeq - sequence number the user has seen.
     * @returns the resulting full map.
     */
    ack(sessionId, turnSeq) {
      return enqueue(async () => {
        await storeAck(sessionId, turnSeq)
        return { acks: snapshotAcks() }
      })
    },
    /**
     * @param entries - `[{ sessionId, turnSeq }]`.
     * @returns the resulting full map.
     */
    ackMany(entries) {
      return enqueue(async () => {
        for (const entry of Array.isArray(entries) ? entries : []) {
          if (entry === null || typeof entry !== 'object') continue
          const sessionId = String(entry.sessionId ?? '')
          if (sessionId === '') continue
          await storeAck(sessionId, Number(entry.turnSeq))
        }
        return { acks: snapshotAcks() }
      })
    },
  }

  /* ---------------- projection + remote ---------------- */

  ctx.effect(() => ctx.sessionProjections.register(ACTIVE_SESSIONS_PROJECTION))

  const service = new ActiveSessionsRemote(ctx, ops)

  /* ---------------- update channel ---------------- */

  /* `webServer` gets its own fiber: a headless host never provides it, and a
   * broken update channel must not take the whole group down with it. */
  let updater = null
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    if (webServer === undefined) return
    const disposers = []
    try {
      updater = createUpdater({ ctx, config, logger: (message) => warn(ctx, message) })
      const handle = createUpdateRoutes(updater)
      const prefix = `/plugins/${name}`
      const handler = (req, res) => {
        let pathname = '/'
        try {
          /* The route matcher hands over the full request path; the table below
           * is relative to the prefix, so strip it before dispatch. */
          pathname = new URL(req.url ?? '/', 'http://localhost').pathname
          if (pathname.startsWith(prefix)) pathname = pathname.slice(prefix.length) || '/'
        } catch {
          pathname = '/'
        }
        handle(req, res, pathname).catch((error) => {
          warn(ctx, `update route failed: ${String(error)}`)
          try {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: String(error) }))
          } catch {
            /* the socket may already be gone */
          }
        })
      }
      disposers.push(webServer.register({ kind: 'prefix', path: prefix, handler }))
      scoped.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* best effort on unload */
          }
        }
        try {
          updater?.dispose()
        } catch {
          /* best effort on unload */
        }
        updater = null
      })
    } catch (error) {
      warn(ctx, `update channel unavailable: ${String(error)}`)
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* best effort */
        }
      }
    }
  })


  /* The sweep runs even with `warm: false`: the baseline is a migration, not
   * an optimisation, and skipping it would resurrect every finished Session. */
  const warmup = startWarmup(ctx, config, { baseline })

  return () => {
    if (warmup !== null) warmup.stop()
    /* `void` keeps the service reachable until this cleanup runs; the Gateway
     * owns the actual unregistration of the fiber-registered service. */
    void service
    try {
      updater?.dispose()
    } catch {
      /* best effort on unload */
    }
    if (domain !== null) void domain.close().catch(() => { /* best effort on unload */ })
  }
}
