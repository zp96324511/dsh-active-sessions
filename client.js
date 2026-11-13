/**
 * dsh-active-sessions — Client half.
 *
 * A fixed block at the top of the workspace sidebar: one row per Session that
 * needs the user — waiting on an answer, still generating, a turn that failed,
 * or a turn that finished unread — aggregated across every workspace, newest
 * first inside each bucket, click to jump straight there.
 *
 * Why it is built this way (see README "实现备注" for the verified facts):
 * - The sidebar's workspace region is a single, fully occupied hole
 *   (`sidebar.workspaces` -> WorkspaceBrowser) with no group-level extension
 *   point, and the browser component is not exported. So the block is mounted
 *   from `shell.overlay` (root scope, where the Session hooks are available)
 *   and portalled into the DOM between the section header and the scrolling
 *   list — outside the scroll container, hence "does not scroll away".
 * - "Read" is decided by turn sequence, not by time: opening a row writes
 *   `acked[sessionId] = lastTurnSeq` to the Host; a later turn has a larger
 *   seq and is unread again. Nothing about clocks or tabs to synchronise.
 * - Any structural surprise (a changed sidebar DOM) degrades to a standalone
 *   main panel instead of disappearing.
 */
window.__ModuleLoader__.load({
  id: 'dsh-active-sessions',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;
    const zod = require('zod');

    const PREFIX = '[dsh-active-sessions]';

    function log(...args) {
      try {
        console.warn(PREFIX, ...args);
      } catch { /* logging must never break the UI */ }
    }

    /* ------------------------------------------------------------------ *
     * Remote descriptor contribution
     *
     * The Gateway only creates a `remote.<namespace>` service from mounted
     * contributions, and this plugin owns its namespace — so the Client half
     * mounts its own descriptors. Names/exports mirror the Host's
     * ActiveSessionsRemote: list() / ack(sessionId, turnSeq) /
     * ackMany([{ sessionId, turnSeq }]), all direct invocations.
     * ------------------------------------------------------------------ */
    const ACK_ENTRY_JSON = {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        turnSeq: { type: 'number' },
        at: { type: 'number' },
      },
      required: ['sessionId', 'turnSeq', 'at'],
      additionalProperties: false,
    };

    const ackEntryZod = () => zod.object({
      sessionId: zod.string(),
      turnSeq: zod.number(),
      at: zod.number(),
    });

    const ackResultJson = {
      type: 'object',
      properties: { acks: { type: 'array', items: ACK_ENTRY_JSON } },
      required: ['acks'],
      additionalProperties: false,
    };

    /**
     * Build one strict codec pair for a parameter or a result.
     * @param symbol - stable type symbol for the wire.
     * @param create - factory returning a zod schema.
     * @param jsonSchema - JSON Schema mirror of the same shape.
     */
    const codecPair = (symbol, create, jsonSchema) => ({
      codec: { mode: 'strict', typeSymbol: symbol, create, jsonSchema },
      strictCodec: { mode: 'strict', typeSymbol: symbol, create, jsonSchema },
    });

    /**
     * Build one JSON-wire parameter descriptor.
     * @param name - parameter name.
     * @param description - model/reader facing description.
     * @param symbol - stable type symbol suffix.
     * @param create - zod factory.
     * @param jsonSchema - JSON Schema mirror.
     */
    const jsonParam = (name, description, symbol, create, jsonSchema) => ({
      name,
      description,
      source: 'json',
      wire: name,
      ...codecPair(`dsh-active-sessions#${symbol}`, create, jsonSchema),
    });

    /** Result descriptor for the three ack methods: the full map after the write. */
    const ackResult = (symbol) => ({
      mode: 'strict',
      typeSymbol: `dsh-active-sessions#activeSessions/${symbol}:result`,
      create: () => zod.object({ acks: zod.array(ackEntryZod()) }),
      description: 'every acknowledgement record after the write: sessionId, turnSeq, at.',
      jsonSchema: ackResultJson,
    });

    const CONTRIBUTION = {
      package: 'dsh-active-sessions',
      descriptors: [
        {
          id: 'dsh-active-sessions#activeSessions/list',
          namespace: 'activeSessions',
          method: 'list',
          service: 'activeSessions',
          description: 'Read every session acknowledgement (the turn sequence the user has already seen).',
          invocation: { kind: 'direct' },
          parameters: [],
          result: ackResult('list'),
        },
        {
          id: 'dsh-active-sessions#activeSessions/ack',
          namespace: 'activeSessions',
          method: 'ack',
          service: 'activeSessions',
          description: 'Acknowledge one session up to one turn sequence (monotonic: a stale ack is a no-op).',
          invocation: { kind: 'direct' },
          parameters: [
            jsonParam('sessionId', 'session whose mark advances', 'sessionId', () => zod.string(), { type: 'string' }),
            jsonParam('turnSeq', 'turn sequence the user has seen', 'turnSeq', () => zod.number(), { type: 'number' }),
          ],
          result: ackResult('ack'),
        },
        {
          id: 'dsh-active-sessions#activeSessions/ackMany',
          namespace: 'activeSessions',
          method: 'ackMany',
          service: 'activeSessions',
          description: 'Acknowledge several sessions in one round trip.',
          invocation: { kind: 'direct' },
          parameters: [
            jsonParam('entries', 'pairs of session and turn sequence', 'entries', () => zod.array(zod.object({
              sessionId: zod.string(),
              turnSeq: zod.number(),
            })), {
              type: 'array',
              items: {
                type: 'object',
                properties: { sessionId: { type: 'string' }, turnSeq: { type: 'number' } },
                required: ['sessionId', 'turnSeq'],
                additionalProperties: false,
              },
            }),
          ],
          result: ackResult('ackMany'),
        },
      ],
    };

    /* ------------------------------------------------------------------ *
     * Copy (mirrors locale/*.json; embedded so a missing locale service
     * still yields readable text)
     * ------------------------------------------------------------------ */
    const DICT = {
      zh: {
        title: '活跃会话',
        expand: '展开',
        collapse: '收起',
        waitingApproval: '等待审批',
        waitingQuestion: '等待回答',
        waitingPlan: '计划待审',
        waitingUnknown: '等待你处理',
        running: '正在生成…',
        waitingTasks: '等待子任务',
        pinned: '已置顶',
    recent: '最近活跃',
        failedUnread: '轮次失败 · 未查看',
        doneUnread: '已完成 · 未查看',
        drafted: '草稿未发送',
        draftPrefix: '草稿：',
        open: '打开会话',
        ack: '标记已读',
        snooze: '忽略 1 小时',
        ackAll: '全部已读',
        snoozeAll: '忽略全部 1 小时',
        subagents: '含 {count} 个运行中子任务',
        empty: '暂无活跃会话',
        justNow: '刚刚',
        minutesAgo: '{count} 分钟前',
        hoursAgo: '{count} 小时前',
        daysAgo: '{count} 天前',
        panelFallback: '侧栏结构不兼容，已启用独立面板',
        dataUnavailable: '会话数据来源暂不可用',
        groupLabel: '活跃会话',
        update: '插件更新',
        checking: '正在检查更新…',
        checkUpdate: '检查更新',
        updateFailed: '检查更新失败',
        updateUnavailable: '无法读取更新渠道',
        upToDate: '已是最新版本',
        updateAvailable: '有新版本',
        restartRequired: '已安装，重启宿主后生效',
        restartHint: '插件不会替你重启宿主：请用你平时启动它的方式（终端、脚本或服务管理器）重启 dsh Web Host，原有的启动参数保持不变。',
        updating: '正在安装…',
        updated: '安装完成',
        upgrade: '升级到',
      },
      en: {
        title: 'Active sessions',
        expand: 'Expand',
        collapse: 'Collapse',
        waitingApproval: 'Waiting for approval',
        waitingQuestion: 'Waiting for an answer',
        waitingPlan: 'Plan awaiting review',
        waitingUnknown: 'Waiting for you',
        running: 'Generating…',
        waitingTasks: 'Waiting for background work',
        pinned: 'Pinned',
    recent: 'Recently active',
        failedUnread: 'Turn failed · unread',
        doneUnread: 'Done · unread',
        drafted: 'Draft not sent',
        draftPrefix: 'Draft: ',
        open: 'Open session',
        ack: 'Mark as read',
        snooze: 'Snooze 1 hour',
        ackAll: 'Mark all as read',
        snoozeAll: 'Snooze all 1 hour',
        subagents: '{count} running subagent(s)',
        empty: 'No active sessions',
        justNow: 'just now',
        minutesAgo: '{count}m ago',
        hoursAgo: '{count}h ago',
        daysAgo: '{count}d ago',
        panelFallback: 'The sidebar layout is incompatible; the standalone panel is in use',
        dataUnavailable: 'Session data is unavailable right now',
        groupLabel: 'Active sessions',
        update: 'Plugin update',
        checking: 'Checking for updates…',
        checkUpdate: 'Check for updates',
        updateFailed: 'The update check failed',
        updateUnavailable: 'The update channel could not be read',
        upToDate: 'Up to date',
        updateAvailable: 'New version available',
        restartRequired: 'Installed — restart the host to apply',
        restartHint: 'The plugin never restarts the host: restart dsh Web Host the way you normally start it (terminal, script or service manager), keeping your usual arguments.',
        updating: 'Installing…',
        updated: 'Installed',
        upgrade: 'Upgrade to',
      },
    };

    /* #region pure */
    /* ---- Pure derivation (framework-free; covered by test/derive.test.mjs) ---- */

    /** Bucket order: who needs the user first; recent shortcuts and resident
        pins trail the active states. */
    const KIND_RANK = Object.freeze({ waiting: 0, running: 1, drafted: 2, failed: 3, done: 4, recent: 5, pinned: 6 });

    /** How many recently active Sessions trail the group as shortcuts. */
    const RECENT_LIMIT = 3;

    /** Status value used when a Session has no status entry yet. */
    const EMPTY_STATUS = Object.freeze({ running: undefined, pendingInteraction: undefined, completionUnread: false });

    /**
     * Read one Session's UI status out of the status snapshot.
     * @param statuses - ReadonlyMap or plain record.
     * @param id - session id.
     * @returns the status, or a frozen empty status.
     */
    function readStatus(statuses, id) {
      if (statuses === undefined || statuses === null) return EMPTY_STATUS;
      const value = typeof statuses.get === 'function' ? statuses.get(id) : statuses[id];
      return value === undefined || value === null ? EMPTY_STATUS : value;
    }

    /**
     * Build sessionId -> workspace from the workspace snapshot, once per
     * workspace-list change. The list has no reverse index of its own.
     * @param items - WorkspaceSnapshot.items.
     * @returns Map<sessionId, workspace>.
     */
    function buildSessionWorkspaceIndex(items) {
      const index = new Map();
      for (const item of Array.isArray(items) ? items : []) {
        const ids = Array.isArray(item?.sessionIds) ? item.sessionIds : [];
        for (const id of ids) {
          if (!index.has(id)) index.set(id, item);
        }
      }
      return index;
    }

    /**
     * Group key the workspace browser lists a Session under: its Workspace id,
     * or the empty string for the Ungrouped bucket (the browser's
     * `data-row-key="workspace:<key>"` convention).
     * @param items - WorkspaceSnapshot.items.
     * @param sessionId - Session to look up.
     * @returns the group key.
     */
    function workspaceGroupKeyOf(items, sessionId) {
      for (const item of Array.isArray(items) ? items : []) {
        if (Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId)) {
          return String(item.workspaceId);
        }
      }
      return '';
    }

    /**
     * Bucket a duration into a unit the copy layer can localize.
     * @param now - current epoch ms.
     * @param then - epoch ms of the event.
     * @returns `{ unit: 'now' | 'minute' | 'hour' | 'day', count: number }`.
     */
    function relativeTimeKey(now, then) {
      const delta = Number(now) - Number(then);
      if (!Number.isFinite(delta) || delta < 60000) return { unit: 'now', count: 0 };
      const minutes = Math.floor(delta / 60000);
      if (minutes < 60) return { unit: 'minute', count: minutes };
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return { unit: 'hour', count: hours };
      return { unit: 'day', count: Math.floor(hours / 24) };
    }

    /**
     * How long an open turn may look "still running" in the log without the
     * Client seeing any activity. A Host that died mid-turn leaves
     * `lastTurn: 'running'` in a stored log forever; without this bound such a
     * Session would sit in the group as "正在生成" for weeks.
     */
    const STALE_TURN_MS = 120000;

    /**
     * The composer keeps every Session's unsent text in localStorage under
     * `dsh.conversation.<sessionId>` (`{ draft: { text, references }, view, … }`,
     * `dsh-client-ui-conversation` `CONVERSATION_STORE_KEY`). The draft is thus
     * already on disk in this browser — no Host round-trip and no storage of
     * our own is needed to find it.
     */
    const DRAFT_KEY_PREFIX = 'dsh.conversation.';

    /** Longest excerpt of a draft shown as a row subtitle. */
    const DRAFT_SNIPPET_MAX = 48;

    /**
     * Flatten a stored draft into one line of readable text.
     * @param value - a stored draft (`{ text, references }`, or a bare string).
     * @returns the collapsed excerpt, or `null` when there is nothing unsent.
     */
    function draftSnippetOf(value) {
      const text = typeof value === 'string' ? value : typeof value?.text === 'string' ? value.text : '';
      const references = Array.isArray(value?.references) ? value.references : [];
      const collapsed = text.replace(/\s+/gu, ' ').trim();
      if (collapsed === '') {
        /* A draft can be references only: an `@file` picked from the picker
           with nothing typed after it. */
        if (references.length === 0) return null;
        return `@${String(references[0] ?? '')}`;
      }
      return collapsed.length <= DRAFT_SNIPPET_MAX ? collapsed : `${collapsed.slice(0, DRAFT_SNIPPET_MAX)}…`;
    }

    /**
     * Collect the unsent drafts this browser holds.
     * @param storage - Storage-like object (`window.localStorage`).
     * @param prefix - key prefix owned by the composer.
     * @param previous - memo of the last scan (`Map<key, { raw, snippet }>`).
     * @returns `{ drafts, memo }`: `drafts` maps sessionId -> snippet.
     */
    function collectDrafts(storage, prefix = DRAFT_KEY_PREFIX, previous = new Map()) {
      const drafts = {};
      const memo = new Map();
      if (storage === null || storage === undefined || typeof storage.length !== 'number') {
        return { drafts, memo };
      }
      for (let index = 0; index < storage.length; index += 1) {
        let key = null;
        try {
          key = typeof storage.key === 'function' ? storage.key(index) : null;
        } catch {
          continue;
        }
        if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
        let raw = null;
        try {
          raw = storage.getItem(key);
        } catch {
          continue;
        }
        if (typeof raw !== 'string') continue;
        const cached = previous.get(key);
        let snippet;
        if (cached !== undefined && cached.raw === raw) {
          snippet = cached.snippet;
        } else {
          try {
            snippet = draftSnippetOf(JSON.parse(raw)?.draft);
          } catch {
            snippet = null;
          }
        }
        memo.set(key, { raw, snippet });
        if (snippet !== null) drafts[key.slice(prefix.length)] = snippet;
      }
      return { drafts, memo };
    }

    /**
     * @param left - one draft map.
     * @param right - another draft map.
     * @returns true when both hold the same sessionIds and snippets.
     */
    function sameDrafts(left, right) {
      const leftKeys = Object.keys(left ?? {});
      if (leftKeys.length !== Object.keys(right ?? {}).length) return false;
      for (const key of leftKeys) {
        if (left[key] !== right?.[key]) return false;
      }
      return true;
    }

    /**
     * Derive the visible rows of the "活跃会话" group.
     *
     * One Session appears at most once, in its highest-precedence bucket:
     * waiting > running > drafted > failed-unread > done-unread. Finished
     * buckets are filtered by the turn-sequence ack (and by the local snooze
     * window); waiting/running are never hidden — they are live states, not
     * notices. A draft is not a notice either, but it is the user's own
     * unfinished work, so it ranks above the two "come back and review" buckets.
     *
     * "Running" includes a Session whose own turn has ended but which still
     * has work underneath it: a running subagent, or a background job the turn
     * left behind (a dev server started with `run_in_background` and not killed
     * yet). Dispatching a background child ends the parent turn immediately and
     * a job outlives the turn that registered it, so the projection alone would
     * report the Session as finished while the work it started is still going
     * on.
     *
     * Every row also carries `ackable`: whether the row is a finished turn that
     * may be written as reviewed. Only rows shown as done/failed qualify. A row
     * still shown as running — including one kept live only by its subagents or
     * a background job — is not ackable: the Session is still busy, and
     * acknowledging it would put a ✓ on a row that cannot disappear. Opening it
     * only navigates.
     *
     * Pinned Sessions are resident: the Host's pin set (`pinnedSessionIds`,
     * registry-global in DSH) is listed after every active bucket, so a pinned
     * Session is reachable from this group without a notice being raised for
     * it. A pinned Session that already has an active row keeps that row (and
     * is marked `pinned`); once that row is acknowledged or would be snoozed,
     * it falls back to the `pinned` bucket instead of disappearing. `pinned`
     * rows are never ackable and are never hidden by the local snooze. The
     * resident row exists even for the Session currently on screen: it orders
     * the list and is the shortcut back to it from any other Session.
     *
     * @param input - `{ list, statuses, workspaces, acked, ackedReady, drafts,
     *   openSessionId, hidden, snooze, now }`.
     * @returns rows sorted by bucket, then newest first in every bucket.
     */
    function deriveActiveRows(input) {
      const list = input?.list;
      const ids = Array.isArray(list?.ids) ? list.ids : [];
      const byId = list?.byId ?? {};
      const projections = list?.projectionsBySession ?? {};
      const workspaces = input?.workspaces;
      const statuses = input?.statuses;
      const acked = input?.acked ?? {};
      const drafts = input?.drafts ?? {};
      const hidden = input?.hidden ?? {};
      const snooze = input?.snooze ?? {};
      const now = Number(input?.now) || 0;
      /* The Session on screen is already in front of the user: listing its own
         draft would just echo what the composer shows. The caller passes null
         while a global panel covers the Conversation — then nothing is on
         screen, and the Session has to be listed like any other. */
      const openSessionId = typeof input?.openSessionId === 'string' ? input.openSessionId : null;
      /* Until the Host answers with its ack map, "unread" is unknowable. Showing
         the optimistic default would list every finished Session in the store. */
      const ackedReady = input?.ackedReady !== false;

      const archived = new Set(Array.isArray(workspaces?.archivedSessionIds) ? workspaces.archivedSessionIds : []);
      const workspaceOf = buildSessionWorkspaceIndex(workspaces?.items);

      /* DSH pins Sessions registry-wide (not per Workspace) and leads its
         Workspace groups with them. This group has a different job — it is a
         work queue — so the resident bucket comes last instead: every pinned
         Session stays reachable without pushing a row that needs the user
         down. Order inside the bucket is recency, newest first, like every
         other bucket. */
      const pinnedSessionIds = Array.isArray(workspaces?.pinnedSessionIds) ? workspaces.pinnedSessionIds : [];
      const pinned = new Set();
      for (const pinnedId of pinnedSessionIds) {
        if (typeof pinnedId !== 'string') continue;
        pinned.add(pinnedId);
      }

      /* Subagents belong to their parent Session: the child never becomes a row
         of its own, it shows up as ⚙ N on the parent and keeps the parent live
         while it runs. The child rows live in `byId` (the Host lists them), so
         the parent chain is walked over the whole catalog, not just `ids`. */
      const parentOf = new Map();
      for (const id of Object.keys(byId)) {
        const parentId = byId[id]?.parentId;
        if (parentId === undefined || parentId === null) continue;
        parentOf.set(id, parentId);
      }

      /* A job event from a forked Session's inherited prefix names the source
         Session as its owner: the fork is not the process doing that work. A
         job without an owner is kept — the log is the owning Session's own. */
      const jobsOf = (id) => {
        const view = projections[id]?.values?.activeSessions;
        const jobs = Array.isArray(view?.jobs) ? view.jobs : [];
        let count = 0;
        for (const job of jobs) {
          if (job === null || typeof job !== 'object') continue;
          if (job.owner !== undefined && job.owner !== null && job.owner !== id) continue;
          count += 1;
        }
        return count;
      };

      /* A child counts as running under the same rule as a row: the status
         store wins, "no status yet" falls back to the list row's flag, and a
         background job keeps it live after its turn ended. */
      const isLive = (id) => {
        const status = readStatus(statuses, id);
        if (status.running === true) return true;
        if (status.running === undefined && byId[id]?.running === true) return true;
        return jobsOf(id) > 0;
      };

      const subagentsRunning = new Map();
      const descendantsRunning = new Map();
      for (const id of parentOf.keys()) {
        if (!isLive(id)) continue;
        const parentId = parentOf.get(id);
        subagentsRunning.set(parentId, (subagentsRunning.get(parentId) ?? 0) + 1);
        /* A running grandchild keeps its own parent busy too, so mark every
           ancestor, not just the direct parent. The chain is finite and a
           malformed cycle is cut by `seen`. */
        const seen = new Set([id]);
        let ancestor = parentId;
        while (ancestor !== undefined && ancestor !== null && !seen.has(ancestor)) {
          seen.add(ancestor);
          descendantsRunning.set(ancestor, (descendantsRunning.get(ancestor) ?? 0) + 1);
          ancestor = parentOf.get(ancestor);
        }
      }

      const rows = [];
      for (const id of ids) {
        const row = byId[id];
        if (row === undefined || row === null) continue;
        if (row.blank === true) continue;
        if (row.parentId !== undefined && row.parentId !== null) continue;
        if (row.origin === 'subagent') continue;
        if (archived.has(id)) continue;

        const status = readStatus(statuses, id);
        const view = projections[id]?.values?.activeSessions;
        const ackSeq = Number(acked[id] ?? -1);
        const lastTurnSeq = Number(view?.lastTurnSeq ?? -1);
        /* `running === undefined` means "no baseline yet": fall back to the list
           row's own flag rather than reading it as false. */
        const running = status.running === true || (status.running === undefined && row.running === true);
        const jobs = view === undefined ? 0 : jobsOf(id);
        const isPinned = pinned.has(id);

        let kind = null;
        let pendingKind;
        let waitingOnTasks = false;
        /* A turn the Host abandoned mid-flight is neither running nor finished;
           it is listed nowhere rather than invented as a result — but a draft
           the user left in that Session is still their own pending work. */
        let abandonedTurn = false;
        if (status.pendingInteraction !== undefined && status.pendingInteraction !== null) {
          kind = 'waiting';
          pendingKind = status.pendingInteraction.kind;
        } else if (running) {
          kind = 'running';
        } else if (jobs > 0 || (descendantsRunning.get(id) ?? 0) > 0) {
          /* The turn that dispatched a background subagent — or registered a
             background job — ended as soon as that work was accepted, but the
             work itself is still running: the Session is busy, not a finished
             turn to come back to. */
          kind = 'running';
          waitingOnTasks = true;
        } else if (view !== undefined && view.lastTurn === 'running') {
          if (now - Number(row.updatedAt ?? 0) < STALE_TURN_MS) kind = 'running';
          else abandonedTurn = true;
        }
        const draftSnippet = kind === null && id !== openSessionId ? drafts[id] : undefined;
        if (kind === null && typeof draftSnippet === 'string' && draftSnippet !== '') kind = 'drafted';
        if (kind === null && !abandonedTurn) {
          const unreadByTurn = view !== undefined ? lastTurnSeq > ackSeq : status.completionUnread === true;
          /* No projection (Host half missing) -> the only ack we can honour is
             the local one, keyed by the row's updatedAt. */
          const ackedLocally = view === undefined
            && hidden[id] !== undefined
            && Number(row.updatedAt) <= Number(hidden[id]);
          if ((status.completionUnread === true || unreadByTurn) && !ackedLocally) {
            kind = view !== undefined && view.lastTurn === 'failed' ? 'failed' : 'done';
          }
        }
        if (kind === null) {
          /* A pinned Session is resident: with no active state to report it is
             still listed, so this group doubles as the shortcut list for the
             Sessions the user pinned in any Workspace. */
          if (!isPinned) continue;
          kind = 'pinned';
        }

        if (kind === 'failed' || kind === 'done') {
          /* Without the Host's ack map a finished Session cannot be placed on
             the read side of the line; a pinned one falls back to its resident
             row instead of disappearing. */
          if (!ackedReady && view !== undefined) {
            if (!isPinned) continue;
            kind = 'pinned';
          } else if (view !== undefined && lastTurnSeq >= 0 && lastTurnSeq <= ackSeq) {
            if (!isPinned) continue;
            kind = 'pinned';
          }
        }
        /* Both review notices and drafts honour the local snooze; waiting and
           running never do — they are live states — and neither does a pinned
           row, which is resident by definition. */
        if (!isPinned && kind !== 'waiting' && kind !== 'running' && Number(snooze[id] ?? 0) > now) continue;

        rows.push({
          id,
          kind,
          title: String(row.displayTitle ?? row.id),
          updatedAt: Number(row.updatedAt ?? 0),
          workspaceTitle: workspaceOf.get(id)?.title,
          subagents: subagentsRunning.get(id) ?? 0,
          jobs,
          waitingOnTasks,
          pendingKind,
          draft: kind === 'drafted' ? draftSnippet : null,
          lastError: typeof view?.lastError === 'string' ? view.lastError : null,
          /* Sequence to write when this row is acknowledged (open / mark read).
             For a live turn it names the turn still in flight: callers must
             check `ackable` before using it. */
          turnSeq: view !== undefined ? lastTurnSeq : -1,
          /* Only a row displayed as finished is acknowledgeable. That rule is
             stricter than "its own turn ended": a Session waiting on its
             background subagents or a background job is still busy, even
             though the turn that started that work already ended. */
          ackable: kind === 'done' || kind === 'failed',
          pinned: isPinned,
        });
      }

      /* A pinned Session whose summary is in `byId` but not in the ID list
         (the two snapshots can update in different frames) is still resident.
         Same visibility rules as any other row: no sub-sessions, no blank
         Sessions, no archives. */
      const listed = new Set(rows.map((row) => row.id));
      for (const pinnedId of pinned) {
        if (listed.has(pinnedId)) continue;
        const row = byId[pinnedId];
        if (row === undefined || row === null) continue;
        if (row.blank === true) continue;
        if (row.parentId !== undefined && row.parentId !== null) continue;
        if (row.origin === 'subagent') continue;
        if (archived.has(pinnedId)) continue;
        const view = projections[pinnedId]?.values?.activeSessions;
        const lastTurnSeq = Number(view?.lastTurnSeq ?? -1);
        rows.push({
          id: pinnedId,
          kind: 'pinned',
          title: String(row.displayTitle ?? row.id),
          updatedAt: Number(row.updatedAt ?? 0),
          workspaceTitle: workspaceOf.get(pinnedId)?.title,
          subagents: 0,
          jobs: 0,
          waitingOnTasks: false,
          pendingKind: undefined,
          draft: null,
          lastError: null,
          turnSeq: view !== undefined && Number.isFinite(lastTurnSeq) ? lastTurnSeq : -1,
          ackable: false,
          pinned: true,
        });
        listed.add(pinnedId);
      }

      /* The recency shortcut: the few Sessions that were active most recently
         and are not listed above already. A Session with an active state is
         already higher up (and is not repeated); an acknowledged finish or an
         idle conversation from this morning lands here, so the group also
         remembers where the user was working. The Session on
         screen is skipped: it is already the main view, and a shortcut back to
         it would only echo it. Capped so this never grows into a second
         sidebar; a newer Session pushes the oldest one out. */
      const recentCandidates = [];
      for (const id of ids) {
        if (listed.has(id) || id === openSessionId) continue;
        const row = byId[id];
        if (row === undefined || row === null) continue;
        if (row.blank === true) continue;
        if (row.parentId !== undefined && row.parentId !== null) continue;
        if (row.origin === 'subagent') continue;
        if (archived.has(id)) continue;
        if (Number(snooze[id] ?? 0) > now) continue;
        recentCandidates.push(row);
      }
      recentCandidates.sort((left, right) => (Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
        || String(left.id).localeCompare(String(right.id)));
      for (const row of recentCandidates.slice(0, RECENT_LIMIT)) {
        rows.push({
          id: row.id,
          kind: 'recent',
          title: String(row.displayTitle ?? row.id),
          updatedAt: Number(row.updatedAt ?? 0),
          workspaceTitle: workspaceOf.get(row.id)?.title,
          subagents: 0,
          jobs: 0,
          waitingOnTasks: false,
          pendingKind: undefined,
          draft: null,
          lastError: null,
          turnSeq: -1,
          ackable: false,
          pinned: false,
        });
      }

      rows.sort((left, right) => {
        const byKind = KIND_RANK[left.kind] - KIND_RANK[right.kind];
        if (byKind !== 0) return byKind;
        /* Every bucket is newest first, the resident bucket included: a pin
           that was active a minute ago sits above one untouched for a week. */
        return right.updatedAt - left.updatedAt;
      });
      return rows;
    }

    /**
     * Pick the finished turn of the Session on screen that should be
     * acknowledged automatically.
     *
     * The user is looking at that conversation, so a completion there must not
     * raise a "come back and review" row against them. Only a visible tab
     * counts as looking (the caller checks `document.visibilityState`), and only
     * an ended turn can be acknowledged; a live row is skipped.
     *
     * @param rows - derived rows.
     * @param openSessionId - the Session in the main view, or null.
     * @returns the row to acknowledge, or null.
     */
    function rowToAcknowledgeInView(rows, openSessionId) {
      if (typeof openSessionId !== 'string' || openSessionId === '') return null;
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row === null || typeof row !== 'object') continue;
        if (row.id !== openSessionId) continue;
        if (row.ackable !== true) continue;
        if (row.kind === 'failed' || row.kind === 'done') return row;
      }
      return null;
    }

    /**
     * The Session the main view currently retains. The workspace list derives its
     * row highlight from exactly this (`retainedBy.mainView > 0`), so it is the
     * host's own notion of "the Session on screen" and it works even when that
     * row is not rendered (collapsed workspace, narrow sidebar).
     *
     * @param list - Session list state (`{ ids, byId }`), possibly undefined.
     * @returns the retained Session id, or null.
     */
    function currentSessionIdOf(list) {
      const byId = list?.byId;
      if (byId === null || typeof byId !== 'object') return null;
      const ids = Array.isArray(list?.ids) ? list.ids : Object.keys(byId);
      for (const id of ids) {
        const summary = byId[id];
        if (summary !== null && typeof summary === 'object' && (summary.retainedBy?.mainView ?? 0) > 0) return id;
      }
      return null;
    }

    /**
     * Whether a global main panel is covering the Conversation.
     *
     * Plugins, Scheduled tasks and every other keyed `main` entry replace the
     * Conversation inside the same frame. DSH keeps the Session retained by the
     * main view while that happens (`retainedBy.mainView` is not released), so
     * the retention counter alone still calls it "on screen" when nobody can
     * see it. `activePanelId` is the layout's own answer: null displays the
     * current Conversation, a panel id means a panel took its place.
     *
     * @param info - layout `panelInfo` snapshot (`{ activePanelId }`), possibly
     *   undefined while the layout service is not mounted yet.
     * @returns true when a global panel occupies the main view.
     */
    function mainPanelActiveOf(info) {
      if (info === null || typeof info !== 'object') return false;
      const activePanelId = info.activePanelId;
      return activePanelId !== null && activePanelId !== undefined;
    }

    /** Local UI preferences: only what the Host has no opinion about. */
    const STORAGE_KEY = 'dsh-active-sessions:v1';

    /** Read the local preference blob, tolerating anything stored under the key. */
    function readPrefs() {
      const fallback = { snooze: {}, hidden: {}, collapsed: false, heightPx: 320 };
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) return fallback;
        const parsed = JSON.parse(raw);
        return {
          snooze: parsed?.snooze !== null && typeof parsed?.snooze === 'object' ? parsed.snooze : {},
          hidden: parsed?.hidden !== null && typeof parsed?.hidden === 'object' ? parsed.hidden : {},
          collapsed: parsed?.collapsed === true,
          heightPx: Number.isFinite(parsed?.heightPx) ? Number(parsed.heightPx) : 320,
        };
      } catch {
        return fallback;
      }
    }

    /** Persist the local preference blob; failures (private mode) are not fatal. */
    function writePrefs(prefs) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
      } catch { /* storage unavailable */ }
    }
    /* #endregion pure */

    /* ------------------------------------------------------------------ *
     * Sidebar DOM anchoring
     *
     * Verified structure (DSH 0.2.1-rc.2, WorkspaceBrowser):
     *   div.<root>                      flex column
     *     div.<sectionHeader>           36px, "工作区/会话" + search
     *     div.<listArea>                flex 1, flex column
     *       div.<treeBody>              flex 1, min-height 0, relative
     *         div.<list>                overflow-y: auto  <- the scroll container
     *         span.<fade>
     *
     * The host node is inserted into <listArea> *before* <treeBody>: above the
     * scroll container, so it never scrolls away, and it takes part in the
     * column's flex layout so the list shrinks instead of being covered.
     * No hashed class name is referenced — only `[data-row-key]` rows, the
     * `[role="tree"]` list and the computed `overflow-y` of the scroller.
     * ------------------------------------------------------------------ */
    const HOST_ATTRIBUTE = 'data-dsh-active';

    /* Below SIDEBAR_AUTO_COLLAPSE the layout trades the sidebar column for a
       narrower rail. The stock layout keeps it in the grid; the mobile
       takeover pins it as a fixed overlay instead. Only the overlay case has
       to be dismissed after a tap — a column leaves the conversation visible
       and collapsing it there would just hide the sidebar for no reason. */
    const SIDEBAR_AUTO_COLLAPSE = 1024;

    /** @returns whether the sidebar currently floats over the conversation. */
    function sidebarOverlays() {
      try {
        if (window.innerWidth >= SIDEBAR_AUTO_COLLAPSE) return false;
        const host = document.querySelector(`[${HOST_ATTRIBUTE}]`);
        const column = host === null ? null : host.closest('[class*="sidebarCol"]');
        if (column === null) return false;
        return window.getComputedStyle(column).position === 'fixed';
      } catch {
        return false;
      }
    }

    /**
     * @returns the Session the workspace list marks as open, or null. The list
     *   is the only place that publishes this (`aria-selected` on the row).
     */
    function openSessionIdOf() {
      try {
        const selected = document.querySelector('[data-row-key^="session:"][aria-selected="true"]');
        const key = selected === null ? null : selected.getAttribute('data-row-key');
        if (typeof key !== 'string' || !key.startsWith('session:')) return null;
        return key.slice('session:'.length);
      } catch {
        return null;
      }
    }

    /** @returns the element with this `data-row-key`, or null. */
    function rowByKey(key) {
      try {
        for (const node of document.querySelectorAll('[data-row-key]')) {
          if (node.getAttribute('data-row-key') === key) return node;
        }
      } catch {
        /* the sidebar is not mounted */
      }
      return null;
    }

    /**
     * Bring one Session's row in the workspace list into view after the active
     * list opens it: expand the owning Workspace group when it is folded, click
     * through the row watermark ("Show more") until the row is rendered, then
     * scroll it into view. DSH keeps its own search reveal (the internal
     * `revealSessionId` state) private, so this drives the same DOM affordances
     * the list already exposes to the user. No-op when the sidebar is not
     * mounted (rail or phone drawer), the Session is archived, or the list is
     * in flat mode — there is no group to expand there.
     * @param sessionId - Session to reveal.
     * @param items - Workspace views (`workspaces.items`) naming the owner.
     */
    function revealSessionInSidebar(sessionId, items) {
      try {
        const shown = rowByKey(`session:${sessionId}`);
        if (shown !== null) {
          shown.scrollIntoView({ block: 'nearest' });
          return;
        }
        const key = workspaceGroupKeyOf(items, sessionId);
        if (rowByKey(`workspace:${key}`) === null) return;
        let attempts = 0;
        const step = () => {
          const found = rowByKey(`session:${sessionId}`);
          if (found !== null) {
            found.scrollIntoView({ block: 'nearest' });
            return;
          }
          if (attempts >= 40) return;
          attempts += 1;
          const header = rowByKey(`workspace:${key}`);
          if (header === null) return;
          if (header.getAttribute('aria-expanded') === 'false') {
            header.click();
            window.requestAnimationFrame(step);
            return;
          }
          /* Rows below the group's watermark are not rendered at all until
             "Show more" raises it; the button would collapse the overflow
             again once everything is shown, so never click it in that state. */
          const more = rowByKey(`overflow:${key}`);
          if (more === null || more.getAttribute('aria-expanded') === 'true') return;
          more.click();
          window.requestAnimationFrame(step);
        };
        step();
      } catch (error) {
        log('revealing the Session in the workspace list failed', error);
      }
    }

    /**
     * Create the host node and keep it attached where it belongs.
     *
     * @param options - `{ onAttach(node), onMiss(), missDelayMs }`.
     * @returns `{ dispose() }`.
     */
    function createAnchorKeeper(options) {
      const node = document.createElement('div');
      node.setAttribute(HOST_ATTRIBUTE, 'block');
      node.style.display = 'none';

      let attached = false;
      let stopped = false;
      let frame = 0;
      let missTimer = 0;
      let watchdog = 0;

      /** Cached placement, valid while `listArea.isConnected` holds. */
      let anchor = null;
      /** The layout frame element, learned once from a fold mutation — never queried per sync. */
      let frameElement = null;
      let collapsedNow = false;
      /** Observer scoped to the region that owns the block (plus one level up). */
      let scopedObserver = null;
      let scopedTargets = [];

      /** @returns the sidebar's scrolling list element, or null. */
      function findList() {
        const row = document.querySelector('[data-row-key]');
        if (row !== null) {
          let element = row.parentElement;
          while (element !== null && element !== document.body) {
            const overflowY = window.getComputedStyle(element).overflowY;
            if (overflowY === 'auto' || overflowY === 'scroll') return element;
            element = element.parentElement;
          }
        }
        return document.querySelector('[role="tree"]');
      }

      /**
       * Observe only the region that owns the block: a re-render of the browser
       * root replaces a direct child of `listArea`, and a remount replaces
       * `listArea` itself — both land on these two targets. Watching the whole
       * body subtree fired on every list row change for no benefit.
       * @param next - the freshly resolved anchor.
       */
      function watch(next) {
        const targets = [next.listArea, next.listArea.parentElement].filter((target) => target !== null);
        if (
          scopedObserver !== null &&
          targets.length === scopedTargets.length &&
          targets.every((target, index) => target === scopedTargets[index])
        ) {
          return;
        }
        if (scopedObserver !== null) scopedObserver.disconnect();
        scopedObserver = new MutationObserver(schedule);
        scopedTargets = targets;
        for (const target of targets) scopedObserver.observe(target, { childList: true });
      }

      /**
       * Resolve the anchor, reusing the cached one while it is still mounted.
       * The cached path does no `querySelector` and no `getComputedStyle`.
       * @returns `{ listArea, treeBody }` or null.
       */
      function anchorOf() {
        if (anchor !== null && anchor.listArea.isConnected) return anchor;
        anchor = null;
        const list = findList();
        if (list === null) return null;
        const treeBody = list.parentElement;
        const listArea = treeBody === null ? null : treeBody.parentElement;
        if (listArea === null) return null;
        anchor = { listArea, treeBody };
        watch(anchor);
        return anchor;
      }

      /** @returns whether the node sits where the cached anchor wants it. */
      function placed() {
        return (
          anchor !== null &&
          anchor.listArea.isConnected &&
          node.parentElement === anchor.listArea &&
          node.nextElementSibling === anchor.treeBody
        );
      }

      function applyVisibility() {
        node.style.display = anchor === null || collapsedNow ? 'none' : '';
      }

      /**
       * Refresh the collapse flag from the frame element. One document query,
       * on first use only: the fold observer hands us the element afterwards,
       * and the attribute is simply absent while the sidebar is expanded.
       * @param target - element from a fold mutation record, when there is one.
       */
      function refreshCollapse(target) {
        if (target !== null) frameElement = target;
        if (frameElement === null || !frameElement.isConnected) {
          frameElement = document.querySelector('[data-sidebar-collapsed]');
        }
        collapsedNow = frameElement !== null && frameElement.getAttribute('data-sidebar-collapsed') === 'true';
      }

      function sync() {
        frame = 0;
        if (stopped) return;
        /* Fast path: still mounted in the right slot — no queries, no style reads. */
        if (attached && placed()) {
          applyVisibility();
          return;
        }
        const next = anchorOf();
        if (next === null) {
          applyVisibility();
          return;
        }
        if (node.parentElement !== next.listArea || node.nextElementSibling !== next.treeBody) {
          next.listArea.insertBefore(node, next.treeBody);
        }
        refreshCollapse(null);
        applyVisibility();
        if (!attached) {
          attached = true;
          if (missTimer !== 0) {
            clearTimeout(missTimer);
            missTimer = 0;
          }
          try {
            options.onAttach(node);
          } catch (error) {
            log('attaching the sidebar block failed', error);
          }
        }
      }

      function schedule() {
        if (stopped || frame !== 0) return;
        frame = window.requestAnimationFrame(sync);
      }

      /* Fold state: the frame element carries the attribute only while collapsed,
         so a fold mutation also *teaches* us which element that is. */
      const foldObserver = new MutationObserver((records) => {
        let target = null;
        for (const record of records) {
          if (record.target instanceof Element) target = record.target;
        }
        refreshCollapse(target);
        applyVisibility();
        if (!collapsedNow && (anchor === null || !anchor.listArea.isConnected)) schedule();
      });
      foldObserver.observe(document.documentElement, {
        attributes: true,
        subtree: true,
        attributeFilter: ['data-sidebar-collapsed'],
      });

      missTimer = window.setTimeout(() => {
        missTimer = 0;
        if (!attached && !stopped) {
          log('sidebar anchor not found; the standalone panel takes over');
          try {
            options.onMiss?.();
          } catch (error) {
            log('fallback notification failed', error);
          }
        }
      }, Number(options.missDelayMs ?? 6000));

      /* Backstop for the one case the scoped observer cannot see: the whole
         sidebar region was replaced. Three O(1) checks per second. */
      watchdog = window.setInterval(() => {
        if (stopped || collapsedNow) return;
        if (anchor !== null && anchor.listArea.isConnected && node.isConnected) return;
        schedule();
      }, 1000);

      schedule();

      return {
        dispose() {
          stopped = true;
          if (frame !== 0) window.cancelAnimationFrame(frame);
          if (missTimer !== 0) clearTimeout(missTimer);
          if (watchdog !== 0) clearInterval(watchdog);
          if (scopedObserver !== null) scopedObserver.disconnect();
          foldObserver.disconnect();
          node.remove();
        },
      };
    }

    /* ------------------------------------------------------------------ *
     * Styles — token-driven, no hashed class names, no global resets
     * ------------------------------------------------------------------ */
    const STYLE_MARKER = 'dsh-active-sessions-style';
    const STYLE_TEXT = [
      /* A card, not a rule: the group sits pinned above the tree, so its edge
         has to read as the panel's own boundary rather than as one more row
         separator. The fill and the shadow are both mixed from label-primary —
         near-white in the dark theme, near-black in the light one — so one
         declaration becomes a white glow in dark mode and a soft drop shadow
         in light mode, without sniffing `data-ds-dark-theme`.
         The host mounts `listArea` 8px in from the column's left edge but
         flush against its right edge, so an even-looking card needs an
         uneven margin: 0 left, 8 right lands the card on the column's
         midline instead of hugging the sidebar border. The bottom gap stays
         tight (5px): the list scrolls under its own top edge right below the
         card, so extra space there reads as an empty dark strip between the
         glow and the first row. */
      '.dsh-as-group{display:flex;flex-direction:column;flex:none;min-height:0;margin:2px 8px 5px 0;',
      'padding:2px 4px 4px;border-radius:10px;',
      'background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);',
      'box-shadow:0 0 0 1px var(--dsw-alias-border-l1,rgba(128,128,128,.12)),',
      '0 6px 16px -10px color-mix(in srgb,var(--dsw-alias-label-primary) 40%,transparent)}',
      '.dsh-as-head{display:flex;align-items:center;gap:6px;height:32px;padding:0 6px;border-radius:var(--dsw-radius-sm,6px);',
      'cursor:pointer;user-select:none;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}',
      '.dsh-as-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
      '.dsh-as-head:focus-visible,.dsh-as-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#247bbf));outline-offset:-2px}',
      /* The leading slot mirrors a workspace row: a 16px line glyph at rest
         that turns into the expand/collapse chevron on hover or focus. */
      '.dsh-as-slot{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:20px;',
      'color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.7))}',
      '.dsh-as-logo,.dsh-as-toggle{display:inline-flex;align-items:center;justify-content:center}',
      '.dsh-as-toggle{display:none;color:var(--dsw-alias-label-caption,rgba(128,128,128,.8));transform:rotate(0deg);',
      'transition:transform .15s ease}',
      '.dsh-as-toggle[data-collapsed="false"]{transform:rotate(90deg)}',
      '.dsh-as-head:hover .dsh-as-logo,.dsh-as-head:focus-visible .dsh-as-logo,.dsh-as-head:focus-within .dsh-as-logo{display:none}',
      '.dsh-as-head:hover .dsh-as-toggle,.dsh-as-head:focus-visible .dsh-as-toggle,.dsh-as-head:focus-within .dsh-as-toggle{display:inline-flex}',
      '@media (prefers-reduced-motion: reduce){.dsh-as-toggle{transition:none}}',
      '.dsh-as-title{font-size:12px;font-weight:600;letter-spacing:.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-as-count{min-width:16px;height:16px;padding:0 4px;border-radius:8px;font-size:10px;line-height:16px;',
      'text-align:center;font-variant-numeric:tabular-nums;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18));',
      'color:var(--dsw-alias-label-secondary,rgba(140,140,140,.95))}',
      '.dsh-as-spacer{flex:1 1 auto;min-width:0}',
      '.dsh-as-hbtns{display:flex;gap:2px;flex:none;opacity:0;transition:opacity .12s ease}',
      '.dsh-as-head:hover .dsh-as-hbtns,.dsh-as-head:focus-within .dsh-as-hbtns{opacity:1}',
      '.dsh-as-btn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;',
      'border-radius:var(--dsw-radius-xs,4px);background:transparent;cursor:pointer;font-size:12px;line-height:1;',
      'color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.85))}',
      '.dsh-as-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18));',
      'color:var(--dsw-alias-label-primary,inherit)}',
      '.dsh-as-list{display:flex;flex-direction:column;gap:1px;min-height:0;overflow-y:auto;overflow-x:hidden;',
      'scrollbar-gutter:stable}',
      '.dsh-as-row{display:flex;align-items:center;gap:6px;height:32px;padding:0 6px;border-radius:var(--dsw-radius-md,8px);',
      'cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}',
      '.dsh-as-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
      '.dsh-as-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6))}',
      '.dsh-as-dot[data-kind="waiting"]{background:var(--dsw-alias-state-warning-primary,#d29922)}',
      '.dsh-as-dot[data-kind="running"]{background:var(--dsw-alias-state-business-primary,#247bbf);',
      'animation:dshAsPulse 1.4s ease-in-out infinite}',
      /* Started work still running (subagent / detached job) while the main
         turn is over: same hue and the same 1.4s pulse, drawn as a hollow
         ring instead of a solid dot — the same "queued, not sending"
         silhouette the composer uses. The static grey ring is a draft;
         this one is the accent colour and pulses. */
      '.dsh-as-dot[data-kind="running"][data-tasks="true"]{background:transparent;',
      'box-shadow:inset 0 0 0 1.5px var(--dsw-alias-state-business-primary,#247bbf)}',
      '.dsh-as-dot[data-kind="failed"]{background:var(--dsw-alias-state-error-primary,#d33)}',
      '.dsh-as-dot[data-kind="drafted"]{background:transparent;',
      'box-shadow:inset 0 0 0 2px var(--dsw-alias-label-secondary,#8b949e)}',
      '.dsh-as-dot[data-kind="done"]{background:var(--dsw-alias-state-success-primary,#2ea043)}',
      '.dsh-as-pin{flex:none;width:8px;height:8px;display:flex;align-items:center;justify-content:center;',
      'font-size:12px;line-height:1;opacity:.9}',
      '.dsh-as-recent{flex:none;width:8px;height:8px;display:flex;align-items:center;justify-content:center;',
      'font-size:11px;line-height:1;opacity:.75}',
      '.dsh-as-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'color:var(--dsw-alias-label-primary,inherit)}',
      '.dsh-as-gear{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.8))}',
      '.dsh-as-sub{flex:0 1 auto;max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.8))}',
      '.dsh-as-actions{display:none;flex:none;gap:2px}',
      '.dsh-as-row:hover .dsh-as-sub,.dsh-as-row:focus-visible .dsh-as-sub{display:none}',
      '.dsh-as-row:hover .dsh-as-actions,.dsh-as-row:focus-visible .dsh-as-actions{display:flex}',
      /* Touch screens never hover: the per-row buttons have to be visible on
         their own, and the subtitle gives up its space to them. */
      '@media (hover:none){.dsh-as-row .dsh-as-actions{display:flex}',
      '.dsh-as-row .dsh-as-sub{display:none}}',
      /* Resident empty state: same 32px rhythm and inset as a row, but no
         hover, no cursor and the caption tone — it reads as a placeholder,
         not as something to click. The line is centred in the list's content
         box so `scrollbar-gutter` cannot bias it: the caption sits on the
         panel's midline instead of hugging the row's left inset. */
      '.dsh-as-empty{display:flex;align-items:center;justify-content:center;height:32px;padding:0 6px;',
      'border-radius:var(--dsw-radius-md,8px);font-size:12px;line-height:20px;',
      'color:var(--dsw-alias-label-caption,rgba(128,128,128,.7));opacity:.8;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:none;pointer-events:none}',
      '.dsh-as-ver{flex:none;padding:0 5px;border-radius:999px;font-size:10px;line-height:16px;cursor:pointer;',
      'font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.8));',
      'border:1px solid var(--dsw-alias-border-s,rgba(128,128,128,.24))}',
      '.dsh-as-ver:hover{color:var(--dsw-alias-label-primary,inherit);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}',
      '.dsh-as-ver[data-state="available"]{color:var(--dsw-alias-state-success-primary,#2ea043);',
      'border-color:var(--dsw-alias-state-success-primary,#2ea043)}',
      '.dsh-as-ver[data-state="restart"]{color:var(--dsw-alias-state-business-primary,#247bbf);',
      'border-color:var(--dsw-alias-state-business-primary,#247bbf)}',
      '.dsh-as-ver[data-state="unknown"]{opacity:.7}',
      '.dsh-as-upd{display:flex;flex-direction:column;gap:6px;margin:2px 6px 6px;padding:8px;border-radius:var(--dsw-radius-md,8px);',
      'background:var(--dsw-alias-bg-skeleton,rgba(128,128,128,.12));font-size:11px;line-height:16px;',
      'color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}',
      '.dsh-as-upd-line{overflow-wrap:anywhere}',
      '.dsh-as-upd-actions{display:flex;flex-wrap:wrap;gap:6px}',
      '.dsh-as-upd-btn{padding:2px 8px;border-radius:var(--dsw-radius-sm,6px);cursor:pointer;font-size:11px;line-height:16px;',
      'border:1px solid var(--dsw-alias-border-s,rgba(128,128,128,.3));',
      'background:transparent;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}',
      '.dsh-as-upd-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));',
      'color:var(--dsw-alias-label-primary,inherit)}',
      '.dsh-as-upd-btn[data-primary="true"]{border-color:transparent;',
      'background:var(--dsw-alias-state-business-primary,#247bbf);color:#fff}',
      '.dsh-as-upd-btn:disabled{opacity:.5;cursor:default}',
      '.dsh-as-upd-msg{color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.85));overflow-wrap:anywhere}',
      '.dsh-as-upd-hint{color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.85));overflow-wrap:anywhere}',
      '.dsh-as-panel{display:flex;flex-direction:column;gap:8px;height:100%;min-height:0;padding:12px 16px;box-sizing:border-box}',
      '.dsh-as-panel .dsh-as-list{flex:1 1 auto;overflow-y:auto}',
      '.dsh-as-panel .dsh-as-row{font-size:14px}',
      '.dsh-as-note{font-size:12px;line-height:18px;padding:6px 8px;border-radius:var(--dsw-radius-sm,6px);',
      'background:var(--dsw-alias-bg-skeleton,rgba(128,128,128,.12));color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}',
      '@keyframes dshAsPulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '@media (prefers-reduced-motion: reduce){.dsh-as-dot[data-kind="running"]{animation:none}}',
      // Inert opener: 1x1, off the flow, never hit by a finger. It exists only
      // so a drawer takeover can find the host contract it clicks.
      '.dsh-as-opener{position:fixed;left:0;top:0;width:1px;height:1px;padding:0;border:0;',
      'background:transparent;opacity:0;overflow:hidden;pointer-events:none;',
      'appearance:none;-webkit-appearance:none}',
    ].join('');

    /** Inject the stylesheet once per document. */
    function ensureStyles() {
      if (document.getElementById(STYLE_MARKER) !== null) return;
      const style = document.createElement('style');
      style.id = STYLE_MARKER;
      style.textContent = STYLE_TEXT;
      (document.head ?? document.documentElement).appendChild(style);
    }

    /** Empty list state used when the hooks are unavailable. */
    const EMPTY_LIST_STATE = Object.freeze({
      ids: [],
      byId: {},
      phase: 'pending',
      projectionsBySession: {},
    });

    /** Placeholder selector hook: keeps the hook call count stable without a store. */
    const NO_HOOK = (select) => select(EMPTY_LIST_STATE);

    /**
     * The group's mark, drawn in the sidebar's own idiom: a 16px box, one 1px
     * `currentColor` stroke, no fill — the same vocabulary as the folder glyph
     * in front of a workspace row. The frame gives the mark the folder's visual
     * weight at this size; the trace inside marks the group as live activity
     * rather than another workspace.
     */
    function ActiveSessionsGlyph() {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('path', { d: 'M4.4 2.6h7.2c1 0 1.8.8 1.8 1.8v7.2c0 1-.8 1.8-1.8 1.8H4.4c-1 0-1.8-.8-1.8-1.8V4.4c0-1 .8-1.8 1.8-1.8Z' }),
      h('path', { d: 'M4.9 8h1.5l1-2.5 1.5 5 1-2.5h1.3' }));
    }

    /** Expand/collapse affordance, revealed where the mark sits. */
    function ActiveSessionsToggleGlyph() {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('path', { d: 'M6.1 4.2 10 8l-3.9 3.8' }));
    }

    /** One hover action button. */
    function IconButton(props) {
      return h('button', {
        type: 'button',
        className: 'dsh-as-btn',
        title: props.label,
        'aria-label': props.label,
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onClick();
        },
      }, props.glyph);
    }

    /* No `remote.activeSessions` in the static inject: this module mounts the
     * namespace itself, and waiting for it would deadlock the fiber (apply
     * never runs, so the service never appears). `remote` alone is injected. */
    return {
      inject: ['slots', 'locale', 'remote'],
      async apply(ctx) {
        ctx.effect(() => {
          ensureStyles();
          return () => { /* the sheet is shared and idempotent; leave it in place */ };
        });

        /* ---- Remote namespace (non-fatal: acks degrade to local) ---- */
        let unmountRemote = async () => {};
        try {
          unmountRemote = await ctx.remote.$mount(CONTRIBUTION);
          if (ctx.get('remote.activeSessions') === undefined) {
            log('remote.activeSessions did not materialize; acknowledgements stay local');
          }
        } catch (error) {
          log('mounting the remote namespace failed; acknowledgements stay local', error);
        }

        /** @returns the ack service when it exists. */
        function remoteOf() {
          try {
            return ctx.get('remote.activeSessions');
          } catch {
            return undefined;
          }
        }

        /** @returns the session navigation service when it exists. */
        function workspaceUiOf() {
          try {
            return ctx.get('uiWorkspace');
          } catch {
            return undefined;
          }
        }

        /** @returns the frame layout service, which owns the sidebar toggle. */
        function layoutOf() {
          try {
            return ctx.get('layout');
          } catch {
            return undefined;
          }
        }

        /* ---- Update channel ---- */

        /* Served by the host half on the same origin: a relative path keeps
           working behind whatever prefix the GUI is published under. */
        const UPDATE_ROOT = '/plugins/dsh-active-sessions';

        async function updateRequest(path, { method = 'GET', body } = {}) {
          const response = await fetch(`${UPDATE_ROOT}${path}`, {
            method,
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            credentials: 'same-origin',
          });
          const text = await response.text();
          let parsed;
          try {
            parsed = text === '' ? {} : JSON.parse(text);
          } catch {
            parsed = { ok: false, error: text.slice(0, 200) };
          }
          if (!response.ok) {
            return { ok: false, error: parsed?.error ?? `${response.status} ${response.statusText}` };
          }
          return parsed;
        }

        function normalizeUpdateInfo(info) {
          if (info === null || typeof info !== 'object') return { ok: false, error: 'the update channel returned nothing usable' };
          return info;
        }

        /* ---- Locale ---- */
        let t = (key) => DICT.zh[key] ?? key;
        try {
          ctx.locale.register('activeSessions', 'zh', DICT.zh);
          ctx.locale.register('activeSessions', 'en', DICT.en);
          const bound = ctx.locale.bind('activeSessions');
          if (typeof bound === 'function') t = bound;
        } catch (error) {
          log('locale registration failed; using the embedded copy', error);
        }

        /** Copy with `{count}` substitution. */
        function copy(key, replacements) {
          const template = String(t(key));
          if (replacements === undefined) return template;
          return template.replace(/\{(\w+)\}/g, (match, name) => (
            replacements[name] === undefined ? match : String(replacements[name])
          ));
        }

        /* Pending-interaction kind -> copy key. Open string by contract: unknown
           kinds fall back to a generic sentence, never throw. */
        const PENDING_COPY = {
          approval: 'waitingApproval',
          question: 'waitingQuestion',
          'plan-review': 'waitingPlan',
        };

        const PANEL_ID = 'active-sessions';
        let fallbackRegistered = false;

        /**
         * Register the standalone panel used when the sidebar anchor cannot be
         * found (layout drift): a global panel icon plus its keyed main panel.
         * Never throws — a degraded install must keep working without it.
         */
        function ensureFallbackPanel() {
          if (fallbackRegistered) return;
          fallbackRegistered = true;
          try {
            ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              label: t('title'),
            }, ActiveSessionsPanelIcon));
            ctx.slots.inject('main', () => ctx.slots.register({
              name: 'main',
              key: PANEL_ID,
              label: t('title'),
            }, ActiveSessionsPanel));
          } catch (error) {
            log('fallback panel registration failed', error);
          }
        }

        /* ------------------------------------------------------------------ *
         * Content: the block itself. Rendered twice at most — portalled into the
         * sidebar, and (only as a fallback) into the main panel.
         * ------------------------------------------------------------------ */
        function ActiveSessionsContent(props) {
          const mode = props.mode === 'panel' ? 'panel' : 'sidebar';
          const useSessionsHook = typeof props.useSessions === 'function' ? props.useSessions : NO_HOOK;
          const useStatusHook = typeof props.useSessionStatus === 'function' ? props.useSessionStatus : NO_HOOK;
          const useWorkspacesHook = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : NO_HOOK;
          const hooksMissing = typeof props.useSessions !== 'function'
            || typeof props.useSessionStatus !== 'function'
            || typeof props.useWorkspaces !== 'function';

          const list = useSessionsHook((state) => state);
          const statuses = useStatusHook((state) => state);
          const workspaces = useWorkspacesHook((state) => state);

          const [prefs, setPrefs] = useState(readPrefs);
          const [acked, setAcked] = useState({});
          /* `false` until the Host's ack map has actually been read: the group
             must not guess "unread" from an empty map. */
          const [ackedReady, setAckedReady] = useState(false);
          const [now, setNow] = useState(() => Date.now());
          const [focusedId, setFocusedId] = useState(null);
          const rowRefs = useRef(new Map());

          /* Unsent drafts live in the composer's own localStorage, one key per
             Session this browser has opened. The scan is memoized on the raw
             string, so the tick only parses what actually changed. */
          const [drafts, setDrafts] = useState({});
          const draftMemo = useRef(new Map());

          /* Update channel state. `null` means "not read yet": the chip only
             advertises a version once a check has actually answered. */
          const [updateInfo, setUpdateInfo] = useState(null);
          const [updateBusy, setUpdateBusy] = useState(false);
          const [updateOpen, setUpdateOpen] = useState(false);
          const [updateMsg, setUpdateMsg] = useState('');

          /* Relative times refresh on their own; nothing else needs a timer. */
          useEffect(() => {
            const timer = window.setInterval(() => setNow(Date.now()), 30000);
            return () => window.clearInterval(timer);
          }, []);

          /* Load the authoritative ack map. The namespace may materialize a beat
             after the first render, so a missing service retries briefly. */
          useEffect(() => {
            let cancelled = false;
            let timer = 0;
            let attempts = 0;
            const load = async () => {
              const service = remoteOf();
              if (service === undefined || typeof service.list !== 'function') {
                if (attempts < 8 && !cancelled) {
                  attempts += 1;
                  timer = window.setTimeout(load, 400);
                }
                return;
              }
              try {
                const result = await service.list();
                if (cancelled) return;
                if (!result?.ok) {
                  if (attempts < 8) {
                    attempts += 1;
                    timer = window.setTimeout(load, 400);
                  }
                  return;
                }
                const records = Array.isArray(result.value?.acks) ? result.value.acks : [];
                const next = {};
                for (const record of records) {
                  if (record === null || typeof record !== 'object') continue;
                  next[String(record.sessionId)] = Number(record.turnSeq);
                }
                setAcked(next);
                setAckedReady(true);
              } catch (error) {
                log('reading acknowledgements failed', error);
              }
            };
            void load();
            return () => {
              cancelled = true;
              if (timer !== 0) window.clearTimeout(timer);
            };
          }, []);

          /* Local preferences follow other tabs. */
          useEffect(() => {
            const onStorage = (event) => {
              if (event.key === STORAGE_KEY) setPrefs(readPrefs());
            };
            window.addEventListener('storage', onStorage);
            return () => window.removeEventListener('storage', onStorage);
          }, []);

          /* Watch the composer's drafts: another tab's `storage` event, a tab
             coming back to the foreground, and a one-second tick for the edits
             this tab itself makes (which fire no `storage` event). */
          useEffect(() => {
            const scan = () => {
              const result = collectDrafts(window.localStorage, DRAFT_KEY_PREFIX, draftMemo.current);
              draftMemo.current = result.memo;
              setDrafts((previous) => (sameDrafts(previous, result.drafts) ? previous : result.drafts));
            };
            scan();
            const timer = window.setInterval(scan, 1000);
            const onStorage = (event) => {
              if (event.key === null || (typeof event.key === 'string' && event.key.startsWith(DRAFT_KEY_PREFIX))) scan();
            };
            const onVisibility = () => {
              if (document.visibilityState !== 'visible') return;
              scan();
              /* Refresh the group on return: a turn that finished while the tab
                 was hidden has to be listed (or auto-acknowledged) right away,
                 not on the next 30-second tick. */
              setNow(Date.now());
            };
            window.addEventListener('storage', onStorage);
            document.addEventListener('visibilitychange', onVisibility);
            return () => {
              window.clearInterval(timer);
              window.removeEventListener('storage', onStorage);
              document.removeEventListener('visibilitychange', onVisibility);
            };
          }, []);

          /* Read the update channel once per page load. The Host caches the
             answer for `update.checkIntervalMs`, so this costs one request. */
          useEffect(() => {
            let cancelled = false;
            const read = async () => {
              try {
                const info = normalizeUpdateInfo(await updateRequest('/update'));
                if (!cancelled) setUpdateInfo(info);
              } catch (error) {
                if (!cancelled) setUpdateInfo({ ok: false, error: String(error?.message ?? error) });
              }
            };
            void read();
            return () => {
              cancelled = true;
            };
          }, []);

          const checkForUpdate = useCallback(async () => {
            setUpdateBusy(true);
            setUpdateMsg('');
            try {
              const info = normalizeUpdateInfo(await updateRequest('/update?force=1'));
              setUpdateInfo(info);
              if (info.ok !== true) setUpdateMsg(info.error ?? t('updateFailed'));
              else if (info.hasUpdate !== true) setUpdateMsg(t('upToDate'));
            } catch (error) {
              setUpdateMsg(`${t('updateFailed')} ${String(error?.message ?? error)}`);
            } finally {
              setUpdateBusy(false);
            }
          }, [t]);

          const runUpgrade = useCallback(async () => {
            setUpdateBusy(true);
            setUpdateMsg(t('updating'));
            try {
              const result = await updateRequest('/update/upgrade', {
                method: 'POST',
                body: updateInfo?.latest === undefined ? {} : { version: updateInfo.latest },
              });
              if (result?.ok === true) {
                setUpdateMsg(t('updated'));
                setUpdateInfo((previous) => (previous === null
                  ? previous
                  : { ...previous, hasUpdate: false, restartRequired: result.restartRequired === true }));
              } else {
                setUpdateMsg(result?.error ?? t('updateFailed'));
              }
            } catch (error) {
              setUpdateMsg(String(error?.message ?? error));
            } finally {
              setUpdateBusy(false);
            }
          }, [t, updateInfo]);

          const patchPrefs = useCallback((patch) => {
            setPrefs((previous) => {
              const next = { ...previous, ...patch };
              writePrefs(next);
              return next;
            });
          }, []);

          /* The Conversation is not necessarily what the main view shows:
             Plugins / Scheduled tasks and every other keyed `main` entry
             replace it in the same frame while the Host keeps the Session
             retained for `mainView`. Subscribe to the layout's panel
             selection so "on screen" keeps meaning "actually on screen";
             without it a turn that finishes behind a panel is acknowledged
             unseen and the row vanishes instead of waiting to be reviewed. */
          const panelInfo = layoutOf()?.panelInfo;
          const subscribePanel = useCallback((listener) => (
            typeof panelInfo?.subscribe === 'function' ? panelInfo.subscribe(listener) : () => {}
          ), [panelInfo]);
          const readPanelActive = useCallback(() => mainPanelActiveOf(
            typeof panelInfo?.getSnapshot === 'function' ? panelInfo.getSnapshot() : null,
          ), [panelInfo]);
          const panelActive = useSyncExternalStore(subscribePanel, readPanelActive);

          /* The Session currently on screen. The Host's retention counter is
             authoritative for the retained Session; the workspace row's
             `aria-selected` is the fallback for the older layout that does not
             publish `retainedBy`; a global panel covering the Conversation
             means nothing is on screen at all. */
          const openSessionId = panelActive
            ? null
            : (currentSessionIdOf(list) ?? openSessionIdOf());

          const rows = useMemo(() => deriveActiveRows({
            list,
            statuses,
            workspaces,
            acked,
            ackedReady,
            drafts,
            openSessionId,
            hidden: prefs.hidden,
            snooze: prefs.snooze,
            now,
          }), [list, statuses, workspaces, acked, ackedReady, drafts, openSessionId, prefs.hidden, prefs.snooze, now]);

          /** Acknowledge rows; the Host is the source of truth for the result. */
          const acknowledge = useCallback((entries) => {
            if (entries.length === 0) return;
            setAcked((previous) => {
              const next = { ...previous };
              for (const entry of entries) {
                if (entry.turnSeq < 0) continue;
                if (entry.turnSeq > (next[entry.sessionId] ?? -1)) next[entry.sessionId] = entry.turnSeq;
              }
              return next;
            });
            const service = remoteOf();
            if (service === undefined || typeof service.ackMany !== 'function') return;
            const payload = entries
              .filter((entry) => entry.turnSeq >= 0)
              .map((entry) => ({ sessionId: entry.sessionId, turnSeq: entry.turnSeq }));
            if (payload.length === 0) return;
            Promise.resolve(service.ackMany(payload)).then((result) => {
              if (!result?.ok) return;
              const records = Array.isArray(result.value?.acks) ? result.value.acks : [];
              const next = {};
              for (const record of records) next[String(record.sessionId)] = Number(record.turnSeq);
              setAcked(next);
              setAckedReady(true);
            }).catch((error) => log('writing acknowledgements failed', error));
          }, []);

          /** Acknowledge one row, falling back to a local mark without a Host projection. */
          const acknowledgeRow = useCallback((row) => {
            /* A live row has no finished turn to acknowledge. Opening a Session
               that is still generating (or waiting on you) must not write its
               in-flight sequence, or the completion that follows would be
               filtered out as already seen instead of surfacing as unread. */
            if (row.ackable !== true) return;
            if (row.turnSeq >= 0) {
              acknowledge([{ sessionId: row.id, turnSeq: row.turnSeq }]);
              return;
            }
            patchPrefs({ hidden: { ...prefs.hidden, [row.id]: row.updatedAt } });
          }, [acknowledge, patchPrefs, prefs.hidden]);

          /* A Session on screen is being read: when its turn finishes while the
             user is looking at it, acknowledge that turn here. Opening the row
             refuses to pre-ack a running turn, so without this the row would
             pop up as "done · unread" for a completion the user just watched.
             A hidden tab is not reading, and neither is a Conversation covered
             by a global panel (`openSessionId` is null there), so those
             completions stay unread until the Conversation is visible again. */
          useEffect(() => {
            if (openSessionId === null) return;
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            const finishedRow = rowToAcknowledgeInView(rows, openSessionId);
            if (finishedRow === null) return;
            acknowledgeRow(finishedRow);
          }, [rows, openSessionId, acknowledgeRow]);

          const openRow = useCallback((row) => {
            const workspaceUi = workspaceUiOf();
            try {
              workspaceUi?.openSession?.(row.id);
            } catch (error) {
              log('openSession failed', error);
            }
            /* On a phone the sidebar is a drawer over the conversation: leaving
               it open would keep the session the tap just opened behind it.
               There is no list to reveal in that state either. */
            if (sidebarOverlays()) {
              try {
                layoutOf()?.toggleSidebar?.();
              } catch (error) {
                log('collapsing the sidebar overlay failed', error);
              }
            } else {
              revealSessionInSidebar(row.id, workspaces?.items);
            }
            acknowledgeRow(row);
          }, [acknowledgeRow, workspaces]);

          const snoozeRow = useCallback((row) => {
            patchPrefs({ snooze: { ...prefs.snooze, [row.id]: Date.now() + 3600000 } });
          }, [patchPrefs, prefs.snooze]);

          const clearableRows = rows.filter((row) => row.kind === 'failed' || row.kind === 'done');
          const waitingCount = rows.filter((row) => row.kind === 'waiting').length;

          const acknowledgeAll = useCallback(() => {
            if (clearableRows.length === 0) return;
            const withSequence = clearableRows.filter((row) => row.turnSeq >= 0)
              .map((row) => ({ sessionId: row.id, turnSeq: row.turnSeq }));
            acknowledge(withSequence);
            const localOnly = { ...prefs.hidden };
            for (const row of clearableRows) {
              if (row.turnSeq < 0) localOnly[row.id] = row.updatedAt;
            }
            if (Object.keys(localOnly).length !== Object.keys(prefs.hidden).length) patchPrefs({ hidden: localOnly });
          }, [acknowledge, clearableRows, patchPrefs, prefs.hidden]);

          const snoozeAll = useCallback(() => {
            if (clearableRows.length === 0) return;
            const until = Date.now() + 3600000;
            const next = { ...prefs.snooze };
            for (const row of clearableRows) next[row.id] = until;
            patchPrefs({ snooze: next });
          }, [clearableRows, patchPrefs, prefs.snooze]);

          const toggleCollapsed = useCallback(() => {
            patchPrefs({ collapsed: !prefs.collapsed });
          }, [patchPrefs, prefs.collapsed]);

          /** @returns the human status word for one row. */
          const statusWordOf = (row) => {
            if (row.kind === 'waiting') {
              const key = PENDING_COPY[String(row.pendingKind)];
              return key === undefined ? t('waitingUnknown') : t(key);
            }
            if (row.kind === 'running') return row.waitingOnTasks === true ? t('waitingTasks') : t('running');
            if (row.kind === 'drafted') return t('drafted');
            if (row.kind === 'failed') return t('failedUnread');
            if (row.kind === 'pinned') return t('pinned');
            if (row.kind === 'recent') return t('recent');
            return t('doneUnread');
          };

          /** @returns "3 分钟前" style relative time. */
          const relativeOf = (timestamp) => {
            const bucket = relativeTimeKey(Date.now(), timestamp);
            if (bucket.unit === 'now') return t('justNow');
            if (bucket.unit === 'minute') return copy('minutesAgo', { count: bucket.count });
            if (bucket.unit === 'hour') return copy('hoursAgo', { count: bucket.count });
            return copy('daysAgo', { count: bucket.count });
          };

          /** @returns the row's trailing note: workspace name plus time or status. */
          const subtitleOf = (row) => {
            /* For a draft the text itself is the useful label: it is what lets
               the user recognise "the one I was writing" at a glance. */
            if (row.kind === 'drafted') {
              return `${t('draftPrefix')}${String(row.draft ?? '')}`;
            }
            /* A row that is live only because work it started is still running
               (a subagent or a detached job) has no generation of its own to
               timestamp: name the state. A resident pin has nothing newer to
               date either. */
            const tail = row.kind === 'waiting' || row.kind === 'pinned' || row.waitingOnTasks === true
              ? statusWordOf(row)
              : relativeOf(row.updatedAt);
            const workspaceTitle = row.workspaceTitle;
            return typeof workspaceTitle === 'string' && workspaceTitle !== '' ? `${workspaceTitle} · ${tail}` : tail;
          };

          const rowLabel = (row) => {
            const parts = [row.title];
            /* A pinned Session shown in an active bucket is still pinned:
               say so before the state word. The resident bucket's own state
               word is already "pinned", so it is not repeated. */
            if (row.pinned === true && row.kind !== 'pinned') parts.push(t('pinned'));
            parts.push(statusWordOf(row));
            if (typeof row.workspaceTitle === 'string' && row.workspaceTitle !== '') parts.push(row.workspaceTitle);
            return parts.join(' · ');
          };

          const focusRow = (id) => {
            setFocusedId(id);
            const element = rowRefs.current.get(id);
            if (element !== undefined) element.focus();
          };

          const onHeaderKeyDown = (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              toggleCollapsed();
              return;
            }
            if (event.key === 'ArrowDown' && rows.length > 0) {
              event.preventDefault();
              focusRow(rows[0].id);
            }
          };

          const onRowKeyDown = (event, index) => {
            if (event.key === 'ArrowDown') {
              if (index + 1 >= rows.length) return;
              event.preventDefault();
              focusRow(rows[index + 1].id);
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              if (index === 0) {
                setFocusedId(null);
                const header = event.currentTarget.parentElement?.parentElement?.querySelector('.dsh-as-head');
                if (header !== null && header !== undefined) header.focus();
                return;
              }
              focusRow(rows[index - 1].id);
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              if (event.shiftKey && rows[index].ackable === true) acknowledgeRow(rows[index]);
              else openRow(rows[index]);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          };

          const collapsed = prefs.collapsed;

          /* ---- Update chip + popover ---- */

          const updateAvailable = updateInfo?.hasUpdate === true;
          const needsRestart = updateInfo?.restartRequired === true;
          const updateVisible = updateAvailable || needsRestart;
          const loadedVersion = updateInfo?.loaded ?? updateInfo?.current;
          const versionText = loadedVersion === undefined || loadedVersion === null
            ? ''
            : `v${String(loadedVersion)}`;

          const updateStatusText = updateInfo === null
            ? t('checking')
            : updateInfo.ok !== true
              ? (updateInfo.error ?? t('updateUnavailable'))
              : updateAvailable
                ? `${t('updateAvailable')} v${String(updateInfo.latest)}`
                : needsRestart
                  ? t('restartRequired')
                  : t('upToDate');

          const toggleUpdate = (event) => {
            event.stopPropagation();
            setUpdateOpen((open) => !open);
          };

          const versionChip = updateInfo === null || versionText === ''
            ? null
            : h('span', {
              className: 'dsh-as-ver',
              'data-state': updateAvailable ? 'available' : needsRestart ? 'restart' : updateInfo.ok === false ? 'unknown' : 'current',
              role: 'button',
              tabIndex: 0,
              title: updateStatusText,
              'aria-label': updateStatusText,
              onClick: toggleUpdate,
              onKeyDown: (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                toggleUpdate(event);
              },
            }, updateAvailable ? `${versionText} ↑` : needsRestart ? `${versionText} ⟳` : versionText);

          const updatePanel = updateOpen === false ? null : h('div', {
            className: 'dsh-as-upd',
            role: 'group',
            'aria-label': t('update'),
          },
          h('div', { className: 'dsh-as-upd-line' }, updateStatusText),
          h('div', { className: 'dsh-as-upd-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-as-upd-btn',
              disabled: updateBusy,
              onClick: checkForUpdate,
            }, t('checkUpdate')),
            updateAvailable ? h('button', {
              type: 'button',
              className: 'dsh-as-upd-btn',
              'data-primary': 'true',
              disabled: updateBusy,
              onClick: runUpgrade,
            }, `${t('upgrade')} v${String(updateInfo.latest)}`) : null),
          needsRestart ? h('div', { className: 'dsh-as-upd-hint' }, t('restartHint')) : null,
          updateMsg === '' ? null : h('div', { className: 'dsh-as-upd-msg' }, updateMsg));

          const header = h('div', {
            className: 'dsh-as-head',
            role: 'button',
            tabIndex: 0,
            'aria-expanded': collapsed ? 'false' : 'true',
            'aria-label': waitingCount > 0 ? `${t('title')} ${waitingCount}` : t('title'),
            title: collapsed ? t('expand') : t('collapse'),
            onClick: toggleCollapsed,
            onKeyDown: onHeaderKeyDown,
          },
          h('span', { className: 'dsh-as-slot', 'aria-hidden': 'true' },
            h('span', { className: 'dsh-as-logo' }, h(ActiveSessionsGlyph)),
            h('span', {
              className: 'dsh-as-toggle',
              'data-collapsed': collapsed ? 'true' : 'false',
            }, h(ActiveSessionsToggleGlyph))),
          h('span', { className: 'dsh-as-title' }, t('title')),
          waitingCount > 0 ? h('span', { className: 'dsh-as-count' }, String(waitingCount)) : null,
          versionChip,
          h('span', { className: 'dsh-as-spacer' }),
          clearableRows.length > 0 ? h('span', { className: 'dsh-as-hbtns' },
            h(IconButton, { glyph: '✓', label: t('ackAll'), onClick: acknowledgeAll }),
            h(IconButton, { glyph: '⌛', label: t('snoozeAll'), onClick: snoozeAll }),
          ) : null);

          const body = rows.map((row, index) => h('div', {
            key: row.id,
            ref: (element) => {
              if (element === null) rowRefs.current.delete(row.id);
              else rowRefs.current.set(row.id, element);
            },
            className: 'dsh-as-row',
            role: 'listitem',
            tabIndex: focusedId === row.id || (focusedId === null && index === 0) ? 0 : -1,
            'data-dsh-active-row': row.id,
            'aria-label': rowLabel(row),
            title: row.kind === 'failed' && row.lastError !== null ? `${rowLabel(row)} — ${row.lastError}` : rowLabel(row),
            onClick: () => openRow(row),
            onKeyDown: (event) => onRowKeyDown(event, index),
            onFocus: () => setFocusedId(row.id),
          },
          /* The leading cell is one glyph wide, never two: the state's dot
             when the row has a state, 📌 when the row is a resident pin, a
             small clock for a recency shortcut. A pinned Session that is
             running or waiting keeps its state dot — the pin marker replaces
             the dot only when the pin is the row's whole state. */
          row.kind === 'recent'
            ? h('span', { className: 'dsh-as-recent', role: 'img', 'aria-label': t('recent'), title: t('recent') }, '🕘')
            : row.kind === 'pinned'
              ? h('span', { className: 'dsh-as-pin', role: 'img', 'aria-label': t('pinned'), title: t('pinned') }, '📌')
              : h('span', {
                className: 'dsh-as-dot',
                'data-kind': row.kind,
                /* A running row can mean two different things: the main agent
                   is generating, or its turn already ended and only subagents
                   or detached jobs are still working. The dot's shape tells
                   them apart without adding another glyph (solid vs hollow ring). */
                'data-tasks': row.waitingOnTasks === true ? 'true' : undefined,
                'aria-hidden': 'true',
              }),
          h('span', { className: 'dsh-as-name' }, row.title),
          row.subagents > 0
            ? h('span', {
              className: 'dsh-as-gear',
              title: copy('subagents', { count: row.subagents }),
              'aria-label': copy('subagents', { count: row.subagents }),
            }, `⚙ ${row.subagents}`)
            : null,
          h('span', { className: 'dsh-as-sub' }, subtitleOf(row)),
          h('span', { className: 'dsh-as-actions' },
            h(IconButton, { glyph: '→', label: t('open'), onClick: () => openRow(row) }),
            /* Only a finished turn can be marked read; a draft or a live turn
               has nothing to acknowledge, and acknowledging it would swallow
               the completion that has not happened yet. */
            row.ackable === true
              ? h(IconButton, { glyph: '✓', label: t('ack'), onClick: () => acknowledgeRow(row) })
              : null,
            /* A resident pin stays put: snoozing it would only hide its notice
               while the row itself remains, which reads as a broken snooze. A
               recency shortcut has no notice to hide either; snoozing it would
               only push it out of the shortcut list. */
            row.pinned === true || row.kind === 'recent'
              ? null
              : h(IconButton, { glyph: '⌛', label: t('snooze'), onClick: () => snoozeRow(row) }))));

          const listStyle = mode === 'panel'
            ? { flex: '1 1 auto', minHeight: 0 }
            : { maxHeight: `calc(min(${Math.max(96, prefs.heightPx)}px, 40vh) - 36px)` };

          /* The group is resident: with nothing to show it keeps its header and
             explains itself in place instead of vanishing. "No data source" is
             a different claim from "nothing needs you", so it gets its own
             line; the panel already carries the same note above the group. */
          const emptyText = hooksMissing ? t('dataUnavailable') : t('empty');

          const group = h('div', {
            className: 'dsh-as-group',
            role: 'group',
            'aria-label': t('groupLabel'),
            'data-dsh-active-group': 'true',
          },
          header,
          updatePanel,
          collapsed ? null : h('div', {
            className: 'dsh-as-list',
            role: rows.length === 0 ? undefined : 'list',
            style: listStyle,
          },
          rows.length === 0
            ? (updateVisible || (mode === 'panel' && hooksMissing)
              ? null
              : h('div', {
                className: 'dsh-as-empty',
                'data-dsh-active-empty': hooksMissing ? 'unavailable' : 'true',
              }, emptyText))
            : body));

          if (mode !== 'panel') return group;

          return h('div', { className: 'dsh-as-panel' },
            props.fallbackNote === true ? h('div', { className: 'dsh-as-note' }, t('panelFallback')) : null,
            hooksMissing ? h('div', { className: 'dsh-as-note' }, t('dataUnavailable')) : null,
            group);
        }

        /* ------------------------------------------------------------------ *
         * Overlay entry: owns the host node, portals the block into it.
         * ------------------------------------------------------------------ */
        function ActiveSessionsOverlay(props) {
          const [host, setHost] = useState(null);

          useEffect(() => {
            const keeper = createAnchorKeeper({
              onAttach: (node) => setHost(node),
              onMiss: () => ensureFallbackPanel(),
            });
            return () => keeper.dispose();
          }, []);

          if (host === null) return null;
          return createPortal(h(ActiveSessionsContent, props), host);
        }

        /**
         * The hidden-sidebar opener contract.
         *
         * A phone-sized window does not show the sidebar as a grid column: the
         * host keeps it collapsed and a takeover (dsh-mobile-upgrade's floating
         * button) is supposed to summon it. That takeover does not drive the
         * React layout itself — it looks for the host's published opener
         * (`[data-sidebar-opener]`, the seat a shell mounts for a hidden
         * sidebar) and clicks it. DSH 0.2.1-rc.2 publishes neither that
         * attribute nor `[data-sidebar-toggle]`, so the click finds nothing and
         * the drawer never opens — which is why this block, which lives inside
         * the workspace list, is unreachable on a phone.
         *
         * Shipping the missing element fixes that from our side: the takeover
         * gets a real target, the host expands through its own toggle, and the
         * list (and this block) mounts. It stays invisible and unfocusable so
         * the closed state looks exactly as it did, and it toggles through the
         * public `uiWorkspace`-sibling `layout` service rather than reaching
         * into anyone's DOM.
         */
        function SidebarOpener() {
          return h('button', {
            type: 'button',
            className: 'dsh-as-opener',
            'data-sidebar-opener': '',
            'aria-hidden': 'true',
            tabIndex: -1,
            onClick: () => {
              try {
                layoutOf()?.toggleSidebar?.();
              } catch (error) {
                log('opening the sidebar from the hidden opener failed', error);
              }
            },
          });
        }

        /** The opener rides along with the overlay entry, outside the portal. */
        function ActiveSessionsOverlayEntry(props) {
          return h(React.Fragment, null, h(SidebarOpener), h(ActiveSessionsOverlay, props));
        }

        /** Fallback main panel body. */
        function ActiveSessionsPanel(props) {
          return h(ActiveSessionsContent, { ...props, mode: 'panel', fallbackNote: true });
        }

        /** Fallback sidebar icon. */
        function ActiveSessionsPanelIcon(props) {
          const size = Number(props?.size ?? 18);
          return h('span', {
            'aria-hidden': 'true',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: size,
              height: size,
              fontSize: Math.round(size * 0.6),
              lineHeight: 1,
              opacity: props?.active === true ? 1 : 0.72,
            },
          }, '◉');
        }

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'active-sessions',
          order: 100,
        }, ActiveSessionsOverlayEntry));

        return async () => {
          try {
            await unmountRemote();
          } catch (error) {
            log('unmounting the remote namespace failed', error);
          }
        };
      },
    };
  },
});
