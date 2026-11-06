// Host-half unit tests: the projection reducer and its wire-view cache are
// plain functions, so they are extracted from index.js and evaluated directly
// (index.js itself imports platform packages that only resolve inside a booted
// host).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8')
const start = source.indexOf('/* #region pure */')
const end = source.indexOf('/* #endregion pure */')
assert.ok(start >= 0 && end > start, 'index.js must keep its pure region markers')

const region = source.slice(start, end)
const { turnFailureMessage, reduceActiveSessions, viewOfActiveSessions, planBaseline } =
  new Function(`${region}\nreturn { turnFailureMessage, reduceActiveSessions, viewOfActiveSessions, planBaseline }`)()

const IDLE = Object.freeze({ lastTurnSeq: -1, lastTurn: 'idle', lastError: null, endedAt: null })
const turnStart = (seq) => ({ type: 'turn/start', seq, time: 1000 * seq, data: { turn: seq } })
const turnEnd = (seq, reason, time = 1000 * seq + 5) => ({ type: 'turn/end', seq, time, data: { turn: seq, reason } })

test('turn/start records the event sequence and reports running', () => {
  const next = reduceActiveSessions(IDLE, turnStart(61))
  assert.deepEqual(next, { lastTurnSeq: 61, lastTurn: 'running', lastError: null, endedAt: null })
})

test('turn/end with a completed reason reports done', () => {
  const running = reduceActiveSessions(IDLE, turnStart(61))
  const next = reduceActiveSessions(running, turnEnd(61, { kind: 'completed' }))
  assert.equal(next.lastTurn, 'done')
  assert.equal(next.lastError, null)
  assert.equal(next.endedAt, 1000 * 61 + 5)
  assert.equal(next.lastTurnSeq, 61, 'the turn sequence survives turn/end')
})

test('only an error reason counts as a failure', () => {
  for (const kind of ['completed', 'aborted', 'blocked', 'max-tokens', 'interrupted', 'forked']) {
    assert.equal(turnFailureMessage({ kind }), null, `${kind} is not a failure`)
  }
  assert.equal(turnFailureMessage({ kind: 'error', error: { message: 'rate limited' } }), 'rate limited')
  assert.equal(turnFailureMessage({ kind: 'error', error: { code: 'E_RATE' } }), 'E_RATE')
  assert.equal(turnFailureMessage({ kind: 'error', error: 'socket closed' }), 'socket closed')
  assert.equal(turnFailureMessage({ kind: 'error' }), 'turn failed')
  assert.equal(turnFailureMessage(null), null)
  assert.equal(turnFailureMessage(undefined), null)
})

test('an error turn becomes failed and keeps the message', () => {
  const running = reduceActiveSessions(IDLE, turnStart(88))
  const next = reduceActiveSessions(running, turnEnd(88, { kind: 'error', error: { message: 'boom' } }))
  assert.equal(next.lastTurn, 'failed')
  assert.equal(next.lastError, 'boom')
})

test('unrelated events return the very same state reference', () => {
  const state = reduceActiveSessions(IDLE, turnStart(61))
  for (const type of ['step/start', 'assistant/message', 'tool/call', 'tool/result', 'user/message']) {
    assert.equal(reduceActiveSessions(state, { type, seq: 62, time: 1, data: {} }), state, type)
  }
  assert.equal(reduceActiveSessions(state, null), state)
})

test('a turn/start without a usable sequence leaves the state untouched', () => {
  const state = reduceActiveSessions(IDLE, turnStart(61))
  assert.equal(reduceActiveSessions(state, { type: 'turn/start', data: {} }), state)
})

test('one state reference always yields one view reference', () => {
  const state = reduceActiveSessions(IDLE, turnStart(61))
  assert.equal(viewOfActiveSessions(state), viewOfActiveSessions(state))
  const done = reduceActiveSessions(state, turnEnd(61, { kind: 'completed' }))
  assert.notEqual(viewOfActiveSessions(done), viewOfActiveSessions(state))
  assert.deepEqual(viewOfActiveSessions(done), {
    lastTurnSeq: 61,
    lastTurn: 'done',
    lastError: null,
    endedAt: 1000 * 61 + 5,
  })
})

/* ---------------- baseline planning ---------------- */

const storedOf = (...ids) => ids.map((id) => ({ header: { id } }))
const viewOf = (seq) => (seq === null ? undefined : { lastTurnSeq: seq, lastTurn: 'done' })

test('the baseline marks every earlier Session that finished a turn', () => {
  const plan = planBaseline(storedOf('a', 'b', 'c'), (header) => viewOf({ a: 10, b: 20, c: null }[header.id]), () => false)
  assert.deepEqual(plan, [
    { sessionId: 'a', turnSeq: 10 },
    { sessionId: 'b', turnSeq: 20 },
  ])
})

test('the baseline leaves acknowledged and turn-less Sessions alone', () => {
  const plan = planBaseline(
    storedOf('acked', 'already', 'fresh'),
    (header) => (header.id === 'fresh' ? viewOf(3) : viewOf(99)),
    (sessionId) => sessionId !== 'fresh',
  )
  assert.deepEqual(plan, [{ sessionId: 'fresh', turnSeq: 3 }])
})

test('the baseline survives malformed store listings', () => {
  assert.deepEqual(planBaseline(undefined, () => viewOf(1), () => false), [])
  assert.deepEqual(planBaseline([null, {}, { header: null }, { header: {} }], () => viewOf(1), () => false), [])
})

test('an open turn is never baselined, a failed one is', () => {
  const plan = planBaseline(storedOf('run', 'fail'), (header) => ({
    lastTurnSeq: header.id === 'run' ? 7 : 8,
    lastTurn: header.id === 'run' ? 'running' : 'failed',
  }), () => false)
  assert.deepEqual(plan, [{ sessionId: 'fail', turnSeq: 8 }])
})

test('a turn that ended after the sweep began stays unread', () => {
  const cutOff = 5_000_000
  const plan = planBaseline(
    storedOf('old', 'fresh'),
    (header) => ({
      lastTurnSeq: 4,
      lastTurn: 'done',
      endedAt: header.id === 'old' ? cutOff - 60_000 : cutOff + 1,
    }),
    () => false,
    cutOff,
  )
  assert.deepEqual(plan, [{ sessionId: 'old', turnSeq: 4 }])
})