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
    return { KIND_RANK, EMPTY_STATUS, readStatus, buildSessionWorkspaceIndex, workspaceGroupKeyOf,
             relativeTimeKey, deriveActiveRows, rowToAcknowledgeInView, STORAGE_KEY, readPrefs,
             draftSnippetOf, collectDrafts, sameDrafts, DRAFT_KEY_PREFIX, currentSessionIdOf };`);
  return factory();
}

const pure = loadPure();
const {
  deriveActiveRows, rowToAcknowledgeInView, relativeTimeKey, buildSessionWorkspaceIndex,
  workspaceGroupKeyOf, KIND_RANK,
  draftSnippetOf, collectDrafts, sameDrafts, DRAFT_KEY_PREFIX, currentSessionIdOf,
} = pure;

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

test('KIND_RANK puts whoever waits on the user first, recency shortcuts and pins last', () => {
  assert.ok(KIND_RANK.waiting < KIND_RANK.running);
  assert.ok(KIND_RANK.running < KIND_RANK.drafted);
  assert.ok(KIND_RANK.drafted < KIND_RANK.failed);
  assert.ok(KIND_RANK.failed < KIND_RANK.done);
  /* A recency shortcut is navigation, not work; the resident pins stay the
     very last bucket. */
  assert.ok(KIND_RANK.done < KIND_RANK.recent);
  assert.ok(KIND_RANK.recent < KIND_RANK.pinned);
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

test('workspaceGroupKeyOf names the browser group a Session is listed under', () => {
  const items = [
    { workspaceId: 'w1', sessionIds: ['s1', 's2'] },
    { workspaceId: 'w2', sessionIds: ['s3'] },
  ];
  assert.equal(workspaceGroupKeyOf(items, 's3'), 'w2');
  /* A Session no Workspace accounts for lives in Ungrouped, key "". */
  assert.equal(workspaceGroupKeyOf(items, 'other'), '');
  assert.equal(workspaceGroupKeyOf(undefined, 's1'), '');
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
  /* Acknowledging clears the notice, not the Session: it drops out of the
     unread bucket and reappears as a recency shortcut. */
  assert.deepEqual(read.map((row) => row.kind), ['recent']);
  assert.equal(read[0].ackable, false);

  /* Next turn -> larger seq -> unread again, with no ack bookkeeping. */
  const nextTurn = deriveActiveRows({ ...base, list: listState([{ session: summary('s1'), projection: finished(88) }]), acked: { s1: 61 } });
  assert.deepEqual(nextTurn.map((row) => row.id), ['s1']);
  assert.equal(nextTurn[0].turnSeq, 88);

  /* A stale ack never resurrects the notice. */
  const staleAck = deriveActiveRows({ ...base, list: listState([{ session: summary('s1'), projection: finished(88) }]), acked: { s1: 200 } });
  assert.deepEqual(staleAck.map((row) => row.kind), ['recent']);
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

test('a live turn is not ackable, so opening a running row leaves its completion unread', () => {
  /* The click path writes an ack only when `ackable` is true. Clicking a
     generating Session opens it, writes nothing, and then the turn ends in the
     background: it must surface as "done", not vanish as pre-acknowledged. */
  const running = deriveActiveRows({
    list: listState([{ session: summary('s1'), projection: RUNNING_TURN(42) }]),
    statuses: statusMap([{ session: { id: 's1' }, status: { running: true } }]),
    workspaces: { items: [] },
    now: 5000,
  });
  assert.equal(running[0].kind, 'running');
  assert.equal(running[0].turnSeq, 42);
  assert.equal(running[0].ackable, false);

  const done = deriveActiveRows({
    list: listState([{ session: summary('s1'), projection: finished(42) }]),
    statuses: statusMap([{ session: { id: 's1' }, status: { running: false, completionUnread: true } }]),
    workspaces: { items: [] },
    acked: {},
    ackedReady: true,
    now: 5000,
  });
  assert.deepEqual(done.map((row) => row.kind), ['done']);
  assert.equal(done[0].ackable, true);
});

test('a waiting row is not ackable: its turn has not ended yet', () => {
  const rows = deriveActiveRows({
    list: listState([{ session: summary('s1'), projection: RUNNING_TURN(7) }]),
    statuses: statusMap([
      { session: { id: 's1' }, status: { running: true, pendingInteraction: { kind: 'approval' } } },
    ]),
    workspaces: { items: [] },
    now: 5000,
  });
  assert.equal(rows[0].kind, 'waiting');
  assert.equal(rows[0].ackable, false);
});

test('a row kept live by subagents is not ackable: the Session is still busy', () => {
  const rows = deriveActiveRows({
    list: listState([
      { session: summary('parent', { updatedAt: 4000 }), projection: finished(3) },
      { session: summary('child', { parentId: 'parent' }) },
    ]),
    statuses: statusMap([
      { session: { id: 'parent' }, status: { running: false, completionUnread: true } },
      { session: { id: 'child' }, status: { running: true } },
    ]),
    workspaces: { items: [] },
    now: 5000,
  });
  assert.equal(rows[0].kind, 'running');
  assert.equal(rows[0].waitingOnTasks, true);
  /* Its own turn ended when the child was dispatched, but the Session still has
     delegated work outstanding. A ✓ here would hide nothing and a premature ack
     would swallow the completion if the follow-up turn never starts. */
  assert.equal(rows[0].ackable, false);
});

test('a background job keeps a finished turn running until it settles', () => {
  const job = { id: 'job-1', owner: 's1', startedAt: 1 };
  const list = listState([{ session: summary('s1', { updatedAt: 4000 }), projection: { ...finished(3), jobs: [job] } }]);
  const input = { list, statuses: {}, workspaces: { items: [] }, acked: {}, now: 5000 };
  const running = deriveActiveRows(input);
  assert.deepEqual(running.map((row) => row.kind), ['running']);
  assert.equal(running[0].waitingOnTasks, true);
  assert.equal(running[0].jobs, 1);
  assert.equal(running[0].ackable, false);
  /* The whole point: a ✓ or an open must not write the finished turn's
     sequence while the job it started is still alive. */
  assert.equal(rowToAcknowledgeInView(running, 's1'), null);

  /* A turn acknowledged before the job surfaces is still a live row. */
  const acked = deriveActiveRows({ ...input, acked: { s1: 3 } });
  assert.deepEqual(acked.map((row) => row.kind), ['running']);

  /* Killing the job turns the row back into the done notice. */
  const settled = deriveActiveRows({
    list: listState([{ session: summary('s1', { updatedAt: 4000 }), projection: finished(3) }]),
    statuses: {},
    workspaces: { items: [] },
    acked: {},
    now: 5000,
  });
  assert.deepEqual(settled.map((row) => row.kind), ['done']);
  assert.equal(settled[0].ackable, true);
});

test('a job keeps a row live past the snooze window', () => {
  const list = listState([
    { session: summary('s1', { updatedAt: 1000 }), projection: { ...finished(3), jobs: [{ id: 'job-1', owner: 's1', startedAt: 1 }] } },
  ]);
  const rows = deriveActiveRows({
    list,
    statuses: {},
    workspaces: { items: [] },
    snooze: { s1: 60_000 },
    now: 5000,
  });
  assert.deepEqual(rows.map((row) => row.kind), ['running']);
});

test('a job in an inherited prefix belongs to the source Session, not the fork', () => {
  const list = listState([
    { session: summary('source', { updatedAt: 3000 }), projection: { ...finished(3), jobs: [{ id: 'job-s', owner: 'source', startedAt: 1 }] } },
    { session: summary('fork', { updatedAt: 4000 }), projection: { ...finished(3), jobs: [{ id: 'job-s', owner: 'source', startedAt: 1 }] } },
  ]);
  const rows = deriveActiveRows({ list, statuses: {}, workspaces: { items: [] }, acked: {}, now: 5000 });
  assert.deepEqual(rows.map((row) => [row.id, row.kind, row.jobs]), [
    ['source', 'running', 1],
    ['fork', 'done', 0],
  ]);
});

test('a child kept live by its background job keeps the parent running', () => {
  const list = listState([
    { session: summary('parent', { updatedAt: 4000 }), projection: finished(3) },
    { session: summary('child', { parentId: 'parent' }), projection: { ...finished(7), jobs: [{ id: 'job-c', owner: 'child', startedAt: 1 }] } },
  ]);
  const rows = deriveActiveRows({
    list,
    statuses: statusMap([
      { session: { id: 'parent' }, status: { running: false, completionUnread: true } },
      { session: { id: 'child' }, status: { running: false } },
    ]),
    workspaces: { items: [] },
    now: 5000,
  });
  assert.deepEqual(rows.map((row) => row.id), ['parent']);
  assert.equal(rows[0].kind, 'running');
  assert.equal(rows[0].waitingOnTasks, true);
  assert.equal(rows[0].subagents, 1);
  assert.equal(rows[0].jobs, 0);
});

test('a job without an owner is trusted for its own row', () => {
  const list = listState([
    { session: summary('s1', { updatedAt: 4000 }), projection: { ...finished(3), jobs: [{ id: 'job-1', owner: null, startedAt: 1 }] } },
  ]);
  const rows = deriveActiveRows({ list, statuses: {}, workspaces: { items: [] }, now: 5000 });
  assert.equal(rows[0].kind, 'running');
  assert.equal(rows[0].jobs, 1);
});

test('finished rows and the no-projection fallback are ackable', () => {
  const list = listState([
    { session: summary('done'), projection: finished(3) },
    { session: summary('failed'), projection: finished(4, 'failed', 'boom') },
  ]);
  const finishedRows = deriveActiveRows({ list, statuses: {}, workspaces: { items: [] }, now: 5000 });
  assert.deepEqual(finishedRows.map((row) => [row.kind, row.ackable]), [['failed', true], ['done', true]]);

  /* Without a projection the row exists only because the Host's own status
     says "completion unread": it is finished by construction and the client
     acknowledges it locally. */
  const fallback = deriveActiveRows({
    list: listState([{ session: summary('legacy', { updatedAt: 4000 }) }]),
    statuses: statusMap([{ session: { id: 'legacy' }, status: { completionUnread: true } }]),
    workspaces: { items: [] },
    now: 5000,
  });
  assert.equal(fallback[0].kind, 'done');
  assert.equal(fallback[0].turnSeq, -1);
  assert.equal(fallback[0].ackable, true);
});

test('the finished turn of the Session on screen is picked for automatic acknowledgement', () => {
  const rows = [
    { id: 'open', kind: 'done', turnSeq: 9, ackable: true },
    { id: 'other', kind: 'done', turnSeq: 8, ackable: true },
    { id: 'live', kind: 'running', turnSeq: 10, ackable: false },
    { id: 'draft', kind: 'drafted', turnSeq: -1, ackable: false },
  ];
  assert.equal(rowToAcknowledgeInView(rows, 'open')?.turnSeq, 9);
  assert.equal(rowToAcknowledgeInView(rows, 'other')?.turnSeq, 8);
  /* A running turn is never auto-acknowledged: it has not ended yet. */
  assert.equal(rowToAcknowledgeInView(rows, 'live'), null);
  assert.equal(rowToAcknowledgeInView(rows, 'draft'), null);
  assert.equal(rowToAcknowledgeInView(rows, null), null);
  assert.equal(rowToAcknowledgeInView(undefined, 'open'), null);
});

test('a draft left on an abandoned turn is not ackable either', () => {
  const rows = deriveActiveRows({
    list: listState([{ session: summary('s1', { updatedAt: 1000 }), projection: RUNNING_TURN(4) }]),
    statuses: {},
    workspaces: { items: [] },
    drafts: { s1: 'still typing' },
    now: 10 * 60 * 1000,
  });
  assert.equal(rows[0].kind, 'drafted');
  assert.equal(rows[0].ackable, false);
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

test('a parent waiting on a running subagent is live, not finished', () => {
  /* The turn ends as soon as the background child is accepted: the projection
     says "done" while the delegated work is still running. */
  const list = listState([
    { session: summary('parent', { updatedAt: 4000 }), projection: finished(3) },
    { session: summary('child', { parentId: 'parent', updatedAt: 4000 }) },
  ]);
  const running = statusMap([
    { session: { id: 'parent' }, status: { running: false, completionUnread: true } },
    { session: { id: 'child' }, status: { running: true } },
  ]);
  const rows = deriveActiveRows({ list, statuses: running, workspaces: { items: [] }, now: 5000 });
  assert.deepEqual(rows.map((row) => row.kind), ['running']);
  assert.equal(rows[0].waitingOnTasks, true);
  assert.equal(rows[0].subagents, 1);

  /* An already reviewed turn does not hide a Session that is still working. */
  const reviewed = deriveActiveRows({
    list, statuses: running, workspaces: { items: [] }, acked: { parent: 3 }, ackedReady: true, now: 5000,
  });
  assert.deepEqual(reviewed.map((row) => row.kind), ['running']);

  /* Once the child settles the finished turn is a notice again. */
  const settled = deriveActiveRows({
    list,
    statuses: statusMap([
      { session: { id: 'parent' }, status: { running: false, completionUnread: true } },
      { session: { id: 'child' }, status: { running: false } },
    ]),
    workspaces: { items: [] },
    now: 5000,
  });
  assert.deepEqual(settled.map((row) => row.kind), ['done']);
  assert.equal(settled[0].waitingOnTasks, false);
});

test('a nested subagent keeps every ancestor live', () => {
  const rows = deriveActiveRows({
    list: listState([
      { session: summary('root', { updatedAt: 4000 }), projection: finished(3) },
      { session: summary('child', { parentId: 'root' }) },
      { session: summary('grandchild', { parentId: 'child' }) },
    ]),
    statuses: statusMap([
      { session: { id: 'root' }, status: { running: false, completionUnread: true } },
      { session: { id: 'child' }, status: { running: false } },
      { session: { id: 'grandchild' }, status: { running: true } },
    ]),
    workspaces: { items: [] },
    now: 5000,
  });
  assert.deepEqual(rows.map((row) => row.id), ['root']);
  assert.equal(rows[0].kind, 'running');
  assert.equal(rows[0].waitingOnTasks, true);
});

test('a live subagent outranks the stale-turn bound and the snooze window', () => {
  /* The parent turn is old enough to read as abandoned, but the child proves
     the Session is alive; running rows are never hidden by snooze either. */
  const rows = deriveActiveRows({
    list: listState([
      { session: summary('parent', { updatedAt: 1_000_000 }), projection: RUNNING_TURN(9) },
      { session: summary('child', { parentId: 'parent' }) },
    ]),
    statuses: statusMap([
      { session: { id: 'parent' }, status: { running: false } },
      { session: { id: 'child' }, status: { running: true } },
    ]),
    workspaces: { items: [] },
    snooze: { parent: 10_000_000 },
    now: 1_000_000 + 10 * 60_000,
  });
  assert.deepEqual(rows.map((row) => row.kind), ['running']);
});

test('a running child with no status yet falls back to its list row', () => {
  const rows = deriveActiveRows({
    list: listState([
      { session: summary('parent', { updatedAt: 4000 }), projection: finished(3) },
      { session: summary('child', { parentId: 'parent', running: true }) },
    ]),
    statuses: statusMap([
      { session: { id: 'parent' }, status: { running: false, completionUnread: true } },
    ]),
    workspaces: { items: [] },
    now: 5000,
  });
  assert.deepEqual(rows.map((row) => row.kind), ['running']);
  assert.equal(rows[0].subagents, 1);
});

test('a running subagent outranks the previous turn failure', () => {
  /* The Session is demonstrably busy: the child will settle and wake it, so
     the failed turn is not the state it is in right now. A turn that fails
     once nothing is left running reports `failed` again. */
  const rows = deriveActiveRows({
    list: listState([
      { session: summary('parent', { updatedAt: 4000 }), projection: finished(3, 'failed', 'boom') },
      { session: summary('child', { parentId: 'parent' }) },
    ]),
    statuses: statusMap([
      { session: { id: 'parent' }, status: { running: false, completionUnread: true } },
      { session: { id: 'child' }, status: { running: true } },
    ]),
    workspaces: { items: [] },
    now: 5000,
  });
  assert.deepEqual(rows.map((row) => row.kind), ['running']);
  assert.equal(rows[0].waitingOnTasks, true);
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
  /* Acknowledging locally hides the notice; the Session stays as a recency
     shortcut, which makes no unread claim. */
  assert.deepEqual(acknowledged.map((row) => row.kind), ['recent']);

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
  /* No status and no run: the Session is not live, but it is still a recently
     active one. */
  assert.deepEqual(fromStatus.map((row) => row.kind), ['recent']);

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
  assert.deepEqual(deriveActiveRows({ ...input, now: 1_000_000 + 10 * 60_000 }).map((row) => row.kind), ['recent'], 'an abandoned turn is not an active Session');
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

  /* The unread notice waits for the ack map; the Session itself may still
     surface as a recency shortcut, which makes no unread claim. */
  assert.deepEqual(deriveActiveRows({ ...input, ackedReady: false }).map((row) => row.kind), ['recent']);
  assert.equal(deriveActiveRows({ ...input, ackedReady: true }).length, 1);
  assert.deepEqual(deriveActiveRows({ ...input, ackedReady: false, acked: { done: 7 } }).map((row) => row.kind), ['recent']);
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
  assert.deepEqual(rows.map((row) => [row.id, row.kind]), [['ask', 'waiting'], ['run', 'running'], ['done', 'recent']]);
})
/* ---- Unsent drafts (composer localStorage) ---- */

/** A tiny Storage double: the composer's keys plus unrelated noise. */
function fakeStorage(entries) {
  const keys = Object.keys(entries);
  return {
    length: keys.length,
    key: (index) => keys[index] ?? null,
    getItem: (key) => (key in entries ? entries[key] : null),
  };
}

test('draftSnippetOf collapses whitespace, truncates and ignores empty drafts', () => {
  assert.equal(draftSnippetOf({ text: '  你好\n\n世界  ', references: [] }), '你好 世界');
  assert.equal(draftSnippetOf({ text: '', references: [] }), null);
  assert.equal(draftSnippetOf(undefined), null);
  /* A references-only draft is still unsent work. */
  assert.equal(draftSnippetOf({ text: '', references: ['src/a.ts'] }), '@src/a.ts');
  const long = draftSnippetOf({ text: 'x'.repeat(200), references: [] });
  assert.equal(long.length, 49);
  assert.ok(long.endsWith('…'));
})

test('collectDrafts reads only the composer namespace and memoizes raw values', () => {
  const storage = fakeStorage({
    [`${DRAFT_KEY_PREFIX}session-a`]: JSON.stringify({ draft: { text: 'one', references: [] } }),
    [`${DRAFT_KEY_PREFIX}session-b`]: JSON.stringify({ draft: { text: '   ', references: [] } }),
    'dsh-active-sessions:v1': '{"collapsed":true}',
  });
  const { drafts, memo } = collectDrafts(storage);
  assert.deepEqual(drafts, { 'session-a': 'one' });
  assert.equal(memo.size, 2);

  /* Unchanged keys are taken from the memo instead of being parsed again. */
  const stale = new Map([...memo].map(([key, value]) => [key, { raw: value.raw, snippet: 'cached' }]));
  const again = collectDrafts(storage, DRAFT_KEY_PREFIX, stale);
  assert.equal(again.drafts['session-a'], 'cached');
})

test('sameDrafts compares snippets, not object identity', () => {
  assert.equal(sameDrafts({ a: 'x' }, { a: 'x' }), true);
  assert.equal(sameDrafts({ a: 'x' }, { a: 'y' }), false);
  assert.equal(sameDrafts({ a: 'x' }, { a: 'x', b: 'y' }), false);
  assert.equal(sameDrafts({}, {}), true);
})

test('a Session with an unsent draft is listed as drafted, above the review buckets', () => {
  const list = listState([
    { session: summary('drafting', { updatedAt: 3000 }) },
    { session: summary('finished'), projection: finished(9) },
  ]);
  const rows = deriveActiveRows({
    list,
    statuses: {},
    workspaces: { items: [] },
    drafts: { drafting: '我还想补充一句' },
    now: 5000,
  });
  assert.deepEqual(rows.map((row) => [row.id, row.kind]), [
    ['drafting', 'drafted'],
    ['finished', 'done'],
  ]);
  assert.equal(rows[0].draft, '我还想补充一句');
})

test('waiting and running outrank a draft in the same Session', () => {
  const list = listState([{ session: summary('s1') }, { session: summary('s2') }]);
  const rows = deriveActiveRows({
    list,
    statuses: statusMap([
      { session: { id: 's1' }, status: { pendingInteraction: { key: 'k', kind: 'question', sessionId: 's1' } } },
      { session: { id: 's2' }, status: { running: true } },
    ]),
    workspaces: { items: [] },
    drafts: { s1: 'draft one', s2: 'draft two' },
    now: 5000,
  });
  assert.deepEqual(rows.map((row) => [row.id, row.kind]), [['s1', 'waiting'], ['s2', 'running']]);
})

test('the open Session is not echoed back to the user', () => {
  const list = listState([{ session: summary('open') }, { session: summary('other') }]);
  const input = {
    list,
    statuses: {},
    workspaces: { items: [] },
    drafts: { open: 'typing now', other: 'left behind' },
    now: 5000,
  };
  assert.deepEqual(deriveActiveRows(input).map((row) => row.id), ['open', 'other']);
  assert.deepEqual(deriveActiveRows({ ...input, openSessionId: 'open' }).map((row) => row.id), ['other']);
})

test('a draft survives an abandoned turn, an ack never hides it, snooze does', () => {
  const list = listState([{ session: summary('s1', { updatedAt: 1000 }) }]);
  const base = {
    list,
    statuses: {},
    workspaces: { items: [] },
    now: 10 * 60 * 1000,
  };
  /* `turn/start` with no `turn/end` and no activity for minutes: the turn is
     neither running nor finished, but the draft is still the user's. */
  assert.deepEqual(deriveActiveRows({ ...base, drafts: { s1: 'x' }, list: listState([{ session: summary('s1', { updatedAt: 1000 }), projection: RUNNING_TURN(4) }]) })
    .map((row) => row.kind), ['drafted']);
  /* An ack of an older turn does not clear unfinished work. */
  assert.deepEqual(deriveActiveRows({ ...base, drafts: { s1: 'x' }, acked: { s1: 4 } }).map((row) => row.kind), ['drafted']);
  assert.deepEqual(deriveActiveRows({ ...base, drafts: { s1: 'x' }, snooze: { s1: base.now + 1000 } }), []);
})

test('the Session retained by the main view is the one on screen', () => {
  /* Same derivation the workspace list uses for its row highlight
     (`retainedBy.mainView > 0`), so a draft in the Session the user is
     looking at is not echoed back as a list row. */
  const state = {
    ids: ['s1', 's2'],
    byId: {
      s1: { id: 's1', retainedBy: { sidebar: 1 } },
      s2: { id: 's2', retainedBy: { mainView: 2, sidebar: 1 } },
    },
  };
  assert.equal(currentSessionIdOf(state), 's2');
  assert.equal(currentSessionIdOf({ ids: ['s1'], byId: { s1: { id: 's1' } } }), null);
  assert.equal(currentSessionIdOf(undefined), null);
  assert.equal(currentSessionIdOf({ ids: ['gone'], byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }), null);
  /* A malformed summary must not throw while the list is still loading. */
  assert.equal(currentSessionIdOf({ ids: ['s1', 's2'], byId: { s1: null, s2: { id: 's2', retainedBy: { mainView: 1 } } } }), 's2');
})

/* -------------------------------------------------------------------------- *
 * Resident pins: the Sessions pinned in any Workspace stay listed here.
 * -------------------------------------------------------------------------- */

test('a pinned Session with no active state stays listed, in pin order', () => {
  const rows = deriveActiveRows({
    list: listState([
      { session: summary('done-one', { updatedAt: 3000 }), projection: finished(5) },
      { session: summary('idle-pin', { updatedAt: 1000 }) },
      { session: summary('other-pin', { updatedAt: 2000 }) },
    ]),
    statuses: {},
    workspaces: {
      items: [
        { workspaceId: 'w1', title: 'alpha', sessionIds: ['done-one'] },
        { workspaceId: 'w2', title: 'beta', sessionIds: ['idle-pin', 'other-pin'] },
      ],
      pinnedSessionIds: ['other-pin', 'idle-pin'],
    },
    acked: {},
    ackedReady: true,
    now: 10_000,
  });
  assert.deepEqual(rows.map((row) => row.id), ['done-one', 'other-pin', 'idle-pin']);
  assert.equal(rows[1].kind, 'pinned');
  assert.equal(rows[1].pinned, true);
  assert.equal(rows[1].ackable, false);
  assert.equal(rows[1].workspaceTitle, 'beta');
})

test('a pinned Session is listed once, in its active bucket', () => {
  const rows = deriveActiveRows({
    list: listState([{ session: summary('pin'), projection: RUNNING_TURN(3) }]),
    statuses: statusMap([{ session: { id: 'pin' }, status: { running: true } }]),
    workspaces: { items: [], pinnedSessionIds: ['pin'] },
    now: 5000,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'running');
  assert.equal(rows[0].pinned, true);
})

test('a pinned Session falls back to the resident row once its turn is read', () => {
  const input = {
    list: listState([{ session: summary('pin', { updatedAt: 2000 }), projection: finished(9) }]),
    statuses: statusMap([{ session: { id: 'pin' }, status: { running: false, completionUnread: true } }]),
    workspaces: { items: [], pinnedSessionIds: ['pin'] },
    ackedReady: true,
  };
  const unread = deriveActiveRows({ ...input, acked: {}, now: 10_000 });
  assert.deepEqual(unread.map((row) => [row.kind, row.pinned]), [['done', true]]);
  const read = deriveActiveRows({ ...input, acked: { pin: 9 }, now: 10_000 });
  assert.deepEqual(read.map((row) => [row.kind, row.pinned, row.ackable]), [['pinned', true, false]]);
})

test('an unreadable ack map keeps a pinned Session resident instead of dropping it', () => {
  const rows = deriveActiveRows({
    list: listState([{ session: summary('pin'), projection: finished(12) }]),
    statuses: {},
    workspaces: { items: [], pinnedSessionIds: ['pin'] },
    ackedReady: false,
    now: 10_000,
  });
  assert.deepEqual(rows.map((row) => [row.kind, row.pinned]), [['pinned', true]]);
  assert.equal(rows[0].turnSeq, 12);
})

test('snooze does not hide a pinned Session', () => {
  const rows = deriveActiveRows({
    list: listState([
      { session: summary('pin'), projection: finished(4) },
      { session: summary('plain'), projection: finished(4) },
    ]),
    statuses: {},
    workspaces: { items: [], pinnedSessionIds: ['pin'] },
    acked: {},
    ackedReady: true,
    snooze: { pin: 20_000, plain: 20_000 },
    now: 10_000,
  });
  assert.deepEqual(rows.map((row) => row.id), ['pin']);
  assert.equal(rows[0].kind, 'done');
})

test('resident rows skip every unlistable Session, but never the open one', () => {
  const rows = deriveActiveRows({
    list: listState([
      { session: summary('open') },
      { session: summary('archived') },
      { session: summary('child', { parentId: 'parent' }) },
      { session: summary('sub', { origin: 'subagent' }) },
      { session: summary('blank', { blank: true }) },
      { session: summary('kept') },
    ]),
    statuses: {},
    workspaces: {
      items: [],
      archivedSessionIds: ['archived'],
      pinnedSessionIds: ['open', 'archived', 'child', 'sub', 'blank', 'missing', 'kept'],
    },
    openSessionId: 'open',
    now: 5000,
  });
  /* The open Session stays listed too: the resident row doubles as the
     ordering anchor and as the way back when the user switches away. */
  assert.deepEqual(rows.map((row) => row.id), ['open', 'kept']);
  assert.deepEqual(rows.map((row) => row.kind), ['pinned', 'pinned']);
})

test('a pinned Session that is still running shows its live row while open', () => {
  const rows = deriveActiveRows({
    list: listState([{ session: summary('pin'), projection: RUNNING_TURN(8) }]),
    statuses: statusMap([{ session: { id: 'pin' }, status: { running: true } }]),
    workspaces: { items: [], pinnedSessionIds: ['pin'] },
    openSessionId: 'pin',
    now: 5000,
  });
  assert.deepEqual(rows.map((row) => [row.id, row.kind]), [['pin', 'running']]);
})

/* ---------------- Recently active shortcuts ---------------- */

test('the three most recently active Sessions trail the active buckets, before the pins', () => {
  const rows = deriveActiveRows({
    list: listState([
      { session: summary('run', { updatedAt: 900 }) },
      { session: summary('old', { updatedAt: 100 }) },
      { session: summary('mid', { updatedAt: 500 }) },
      { session: summary('new', { updatedAt: 800 }) },
      { session: summary('older', { updatedAt: 50 }) },
    ]),
    statuses: statusMap([{ session: { id: 'run' }, status: { running: true } }]),
    workspaces: { items: [], pinnedSessionIds: ['old'] },
    now: 5000,
  });
  assert.deepEqual(rows.map((row) => [row.id, row.kind]), [
    ['run', 'running'],
    ['new', 'recent'],
    ['mid', 'recent'],
    ['older', 'recent'],
    ['old', 'pinned'],
  ]);
})

test('recency shortcuts skip archived, blank, sub-agent and snoozed Sessions', () => {
  const rows = deriveActiveRows({
    list: listState([
      { session: summary('a', { updatedAt: 900 }) },
      { session: summary('arch', { updatedAt: 800 }) },
      { session: summary('blank', { updatedAt: 700, blank: true }) },
      { session: summary('child', { updatedAt: 600, parentId: 'a' }) },
      { session: summary('sub', { updatedAt: 500, origin: 'subagent' }) },
      { session: summary('snoozed', { updatedAt: 400 }) },
    ]),
    statuses: {},
    workspaces: { items: [], archivedSessionIds: ['arch'] },
    snooze: { snoozed: 6000 },
    now: 5000,
  });
  assert.deepEqual(rows.map((row) => [row.id, row.kind]), [['a', 'recent']]);
})

test('the recency shortcut is capped at three and never repeats a listed Session', () => {
  const rows = deriveActiveRows({
    list: listState(['a', 'b', 'c', 'd', 'e'].map((id, index) => ({
      session: summary(id, { updatedAt: 100 + index }),
    }))),
    statuses: {},
    workspaces: { items: [] },
    now: 5000,
  });
  assert.deepEqual(rows.map((row) => row.id), ['e', 'd', 'c']);
})

test('a recency shortcut is navigation, not a notice: no ack and no open-Session echo', () => {
  const rows = deriveActiveRows({
    list: listState([
      { session: summary('open', { updatedAt: 900 }) },
      { session: summary('a', { updatedAt: 800 }) },
    ]),
    statuses: {},
    workspaces: { items: [] },
    openSessionId: 'open',
    now: 5000,
  });
  assert.deepEqual(rows.map((row) => [row.id, row.kind, row.ackable]), [['a', 'recent', false]]);
})
