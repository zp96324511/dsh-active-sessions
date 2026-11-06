/**
 * Unit tests for the pure derivation in client.js.
 *
 * client.js is a browser bundle (it calls window.__ModuleLoader__.load), so the
 * functions under test are extracted from the `#region pure` block and
 * evaluated standalone — no bundler, no DOM, no DSH runtime needed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_SOURCE = readFileSync(join(HERE, '..', 'client.js'), 'utf8');

/**
 * Evaluate the pure region of client.js and return its exports.
 * @returns the region's declarations.
 */
function loadPure() {
  const start = CLIENT_SOURCE.indexOf('/* #region pure */');
  const end = CLIENT_SOURCE.indexOf('/* #endregion pure */');
  assert.ok(start >= 0 && end > start, 'client.js must keep its #region pure markers');
  const body = CLIENT_SOURCE.slice(start, end);
  const factory = new Function(`${body}
    return { KIND_RANK, EMPTY_STATUS, readStatus, buildSessionWorkspaceIndex, relativeTimeKey,
             deriveActiveRows, STORAGE_KEY, readPrefs };`);
  return factory();
}

const pure = loadPure();
const { deriveActiveRows, relativeTimeKey, buildSessionWorkspaceIndex, KIND_RANK } = pure;

/** One SessionSummary-shaped row. */
function summary(id, overrides = {}) {
  return {
    id,
    displayTitle: id,
    running: false,
    blank: false,
    retainedBy: {},
    updatedAt: 1000,
    ...overrides,
  };
}

/**
 * Build a SessionListState-shaped snapshot.
 * @param entries - `{ session, projection?, status? }[]`.
 */
function listState(entries) {
  const ids = [];
  const byId = {};
  const projectionsBySession = {};
  for (const entry of entries) {
    ids.push(entry.session.id);
    byId[entry.session.id] = entry.session;
    projectionsBySession[entry.session.id] = entry.projection === undefined
      ? { values: {}, state: 'idle', error: null }
      : { values: { activeSessions: entry.projection }, state: 'ready', error: null };
  }
  return { ids, byId, projectionsBySession, phase: 'ready' };
}

/** Build a SessionStatus snapshot. */
function statusMap(entries) {
  const map = new Map();
  for (const entry of entries) map.set(entry.session.id, { running: undefined, pendingInteraction: undefined, completionUnread: false, ...entry.status });
  return map;
}

/** A finished turn as the projection reports it. */
function finished(turnSeq, lastTurn = 'done', lastError = null) {
  return { lastTurnSeq: turnSeq, lastTurn, lastError, endedAt: 2000 };
}

const RUNNING_TURN = (turnSeq) => ({ lastTurnSeq: turnSeq, lastTurn: 'running', lastError: null, endedAt: null });

test('KIND_RANK puts whoever waits on the user first', () => {
  assert.ok(KIND_RANK.waiting < KIND_RANK.running);
  assert.ok(KIND_RANK.running < KIND_RANK.failed);
  assert.ok(KIND_RANK.failed < KIND_RANK.done);
});

test('relativeTimeKey buckets by minute, hour and day', () => {
  const now = 10 * 86400000;
  assert.deepEqual(relativeTimeKey(now, now - 1000), { unit: 'now', count: 0 });
  assert.deepEqual(relativeTimeKey(now, now - 3 * 60000), { unit: 'minute', count: 3 });
  assert.deepEqual(relativeTimeKey(now, now - 3 * 3600000), { unit: 'hour', count: 3 });
  assert.deepEqual(relativeTimeKey(now, now - 3 * 86400000), { unit: 'day', count: 3 });
  /* A clock that runs backwards must not produce a negative age. */
  assert.deepEqual(relativeTimeKey(now, now + 5000), { unit: 'now', count: 0 });
});

test('buildSessionWorkspaceIndex maps every listed session to its workspace', () => {
  const index = buildSessionWorkspaceIndex([
    { workspaceId: 'w1', title: 'alpha', sessionIds: ['s1', 's2'] },
    { workspaceId: 'w2', title: 'beta', sessionIds: ['s3'] },
  ]);
  assert.equal(index.get('s1').title, 'alpha');
  assert.equal(index.get('s3').title, 'beta');
  assert.equal(index.get('missing'), undefined);
  assert.equal(buildSessionWorkspaceIndex(undefined).size, 0);
});

test('excludes blank, subagent, child and archived sessions', () => {
  const rows = deriveActiveRows({
    list: listState([
      { session: summary('blank-one', { blank: true }) },
      { session: summary('subagent-one', { origin: 'subagent' }) },
      { session: summary('child-one', { parentId: 'parent' }) },
      { session: summary('archived-one') },
      { session: summary('kept') },
    ]),
    statuses: statusMap([
      { session: { id: 'blank-one' }, status: { running: true } },
      { session: { id: 'subagent-one' }, status: { running: true } },
      { session: { id: 'child-one' }, status: { running: true } },
      { session: { id: 'archived-one' }, status: { running: true } },
      { session: { id: 'kept' }, status: { running: true } },
    ]),
    workspaces: { items: [], archivedSessionIds: ['archived-one'] },
    now: 5000,
  });
  assert.deepEqual(rows.map((row) => row.id), ['kept']);
});

test('orders waiting → running → failed → done, newest first inside a bucket', () => {
  const rows = deriveActiveRows({
    list: listState([
      { session: summary('done-old', { updatedAt: 1000 }), projection: finished(3) },
      { session: summary('done-new', { updatedAt: 2000 }), projection: finished(4) },
      { session: summary('failed', { updatedAt: 3000 }), projection: finished(5, 'failed', 'boom') },
      { session: summary('running', { updatedAt: 4000 }), projection: RUNNING_TURN(6) },
      { session: summary('waiting', { updatedAt: 10 }), projection: RUNNING_TURN(7) },
    ]),
    statuses: statusMap([
      { session: { id: 'running' }, status: { running: true } },
      { session: { id: 'waiting' }, status: { running: true, pendingInteraction: { kind: 'approval' } } },
    ]),
    workspaces: { items: [] },
    now: 10_000,
  });
  assert.deepEqual(rows.map((row) => row.id), ['waiting', 'running', 'failed', 'done-new', 'done-old']);
  assert.deepEqual(rows.map((row) => row.kind), ['waiting', 'running', 'failed', 'done', 'done']);
  assert.equal(rows[2].lastError, 'boom');
});

test('waiting wins over running for the same session', () => {
  const rows = deriveActiveRows({
    list: listState([{ session: summary('s1') }]),
    statuses: statusMap([{ session: { id: 's1' }, status: { running: true, pendingInteraction: { kind: 'question' } } }]),
    workspaces: { items: [] },
    now: 5000,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'waiting');
  assert.equal(rows[0].pendingKind, 'question');
});

test('ack by turn: seen sequence hides the row, a newer turn brings it back', () => {
  const base = {
    statuses: statusMap([{ session: { id: 's1' } }]),
    workspaces: { items: [] },
    now: 10_000,
  };

  const unread = deriveActiveRows({ ...base, list: listState([{ session: summary('s1'), projection: finished(61) }]), acked: {} });
  assert.deepEqual(unread.map((row) => row.id), ['s1']);

  const read = deriveActiveRows({ ...base, list: listState([{ session: summary('s1'), projection: finished(61) }]), acked: { s1: 61 } });
  assert.deepEqual(read, []);

  /* Next turn -> larger seq -> unread again, with no ack bookkeeping. */
  const nextTurn = deriveActiveRows({ ...base, list: listState([{ session: summary('s1'), projection: finished(88) }]), acked: { s1: 61 } });
  assert.deepEqual(nextTurn.map((row) => row.id), ['s1']);
  assert.equal(nextTurn[0].turnSeq, 88);

  /* A stale ack never resurrects the notice. */
  const staleAck = deriveActiveRows({ ...base, list: listState([{ session: summary('s1'), projection: finished(88) }]), acked: { s1: 200 } });
  assert.deepEqual(staleAck.map((row) => row.id), []);
});

test('acking does not hide a running turn', () => {
  const rows = deriveActiveRows({
    list: listState([{ session: summary('s1'), projection: RUNNING_TURN(42) }]),
    statuses: statusMap([{ session: { id: 's1' }, status: { running: true } }]),
    workspaces: { items: [] },
    acked: { s1: 42 },
    now: 5000,
  });
  assert.deepEqual(rows.map((row) => row.id), ['s1']);
  assert.equal(rows[0].kind, 'running');
});

test('snooze hides finished rows only', () => {
  const now = 10_000;
  const list = listState([
    { session: summary('done', { updatedAt: 1000 }), projection: finished(3) },
    { session: summary('waiting'), projection: RUNNING_TURN(4) },
  ]);
  const statuses = statusMap([{ session: { id: 'waiting' }, status: { running: true, pendingInteraction: { kind: 'approval' } } }]);
  const rows = deriveActiveRows({
    list,
    statuses,
    workspaces: { items: [] },
    snooze: { done: now + 60_000, waiting: now + 60_000 },
    now,
  });
  assert.deepEqual(rows.map((row) => row.id), ['waiting']);

  /* Once the window lapses the finished row returns. */
  const later = deriveActiveRows({ list, statuses, workspaces: { items: [] }, snooze: { done: now + 60_000 }, now: now + 120_000 });
  assert.deepEqual(later.map((row) => row.id), ['waiting', 'done']);
});

test('counts running direct subagents on the parent row', () => {
  const rows = deriveActiveRows({
    list: listState([
      { session: summary('parent') },
      { session: summary('child-a', { parentId: 'parent' }) },
      { session: summary('child-b', { parentId: 'parent' }) },
      { session: summary('child-done', { parentId: 'parent' }) },
    ]),
    statuses: statusMap([
      { session: { id: 'parent' }, status: { running: true } },
      { session: { id: 'child-a' }, status: { running: true } },
      { session: { id: 'child-b' }, status: { running: true } },
      { session: { id: 'child-done' }, status: { running: false } },
    ]),
    workspaces: { items: [] },
    now: 5000,
  });
  assert.deepEqual(rows.map((row) => row.id), ['parent']);
  assert.equal(rows[0].subagents, 2);
});

test('falls back to completionUnread when the host projection is absent', () => {
  const rows = deriveActiveRows({
    list: listState([{ session: summary('s1', { updatedAt: 4000 }) }]),
    statuses: statusMap([{ session: { id: 's1' }, status: { completionUnread: true } }]),
    workspaces: { items: [] },
    now: 5000,
  });
  assert.equal(rows[0].kind, 'done');
  /* No projection -> the sequence is unknown, so the caller must ack locally. */
  assert.equal(rows[0].turnSeq, -1);

  const acknowledged = deriveActiveRows({
    list: listState([{ session: summary('s1', { updatedAt: 4000 }) }]),
    statuses: statusMap([{ session: { id: 's1' }, status: { completionUnread: true } }]),
    workspaces: { items: [] },
    hidden: { s1: 4000 },
    now: 5000,
  });
  assert.deepEqual(acknowledged, []);

  /* A newer update (the compute proxy for "another turn ran") shows up again. */
  const newer = deriveActiveRows({
    list: listState([{ session: summary('s1', { updatedAt: 6000 }) }]),
    statuses: statusMap([{ session: { id: 's1' }, status: { completionUnread: true } }]),
    workspaces: { items: [] },
    hidden: { s1: 4000 },
    now: 7000,
  });
  assert.equal(newer.length, 1);
});

test('treats an undefined running flag as "no baseline", not as false', () => {
  const fromStatus = deriveActiveRows({
    list: listState([{ session: summary('s1', { running: false }) }]),
    statuses: statusMap([{ session: { id: 's1' }, status: { running: undefined } }]),
    workspaces: { items: [] },
    now: 5000,
  });
  assert.deepEqual(fromStatus, []);

  const fromRow = deriveActiveRows({
    list: listState([{ session: summary('s1', { running: true }) }]),
    statuses: statusMap([{ session: { id: 's1' }, status: { running: undefined } }]),
    workspaces: { items: [] },
    now: 5000,
  });
  assert.equal(fromRow[0].kind, 'running');
});

test('carries the workspace title onto the row', () => {
  const rows = deriveActiveRows({
    list: listState([{ session: summary('s1') }]),
    statuses: statusMap([{ session: { id: 's1' }, status: { running: true } }]),
    workspaces: { items: [{ workspaceId: 'w1', title: 'alpha', sessionIds: ['s1'] }] },
    now: 5000,
  });
  assert.equal(rows[0].workspaceTitle, 'alpha');
  assert.equal(rows[0].title, 's1');
});

test('tolerates an empty or missing snapshot', () => {
  assert.deepEqual(deriveActiveRows({}), []);
  assert.deepEqual(deriveActiveRows({ list: listState([]), workspaces: { items: [] }, now: 1 }), []);
});

/* ---------------- robustness: stale turns and unknown acks ---------------- */

test('a turn left open by a dead host is not reported as running forever', () => {
  const list = listState([{ session: summary('stale', { updatedAt: 1_000_000 }), projection: RUNNING_TURN(9) }]);
  const input = { list, statuses: {}, workspaces: { items: [] } };

  const recent = deriveActiveRows({ ...input, now: 1_000_000 + 30_000 });
  assert.deepEqual(recent.map((row) => row.kind), ['running'], 'recent activity still reads as a running turn');
  assert.deepEqual(deriveActiveRows({ ...input, now: 1_000_000 + 10 * 60_000 }), [], 'an abandoned turn is not an active Session');
})

test('a live status keeps a long turn visible past the stale window', () => {
  const list = listState([{ session: summary('long', { updatedAt: 1_000 }), projection: RUNNING_TURN(4) }]);
  const rows = deriveActiveRows({
    list,
    statuses: statusMap([{ session: { id: 'long' }, status: { running: true } }]),
    workspaces: { items: [] },
    now: 10_000_000,
  });
  assert.equal(rows.length, 1, 'the live status outranks the stale bound');
  assert.equal(rows[0].kind, 'running');
})

test('finished rows stay hidden until the ack map has been read', () => {
  const list = listState([{ session: summary('done'), projection: finished(7) }]);
  const input = { list, statuses: {}, workspaces: { items: [] }, now: 5000 };

  assert.deepEqual(deriveActiveRows({ ...input, ackedReady: false }), []);
  assert.equal(deriveActiveRows({ ...input, ackedReady: true }).length, 1);
  assert.deepEqual(deriveActiveRows({ ...input, ackedReady: false, acked: { done: 7 } }), []);
})

test('an unreadable ack map still shows waiting and running rows', () => {
  const list = listState([
    { session: summary('ask') },
    { session: summary('run') },
    { session: summary('done'), projection: finished(7) },
  ]);
  const rows = deriveActiveRows({
    list,
    statuses: statusMap([
      { session: { id: 'ask' }, status: { pendingInteraction: { key: 'k', kind: 'approval', sessionId: 'ask' } } },
      { session: { id: 'run' }, status: { running: true } },
    ]),
    workspaces: { items: [] },
    ackedReady: false,
    now: 5000,
  });
  assert.deepEqual(rows.map((row) => [row.id, row.kind]), [['ask', 'waiting'], ['run', 'running']]);
})