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
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
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
        title: '正在活跃',
        expand: '展开',
        collapse: '收起',
        waitingApproval: '等待审批',
        waitingQuestion: '等待回答',
        waitingPlan: '计划待审',
        waitingUnknown: '等待你处理',
        running: '正在生成…',
        failedUnread: '轮次失败 · 未查看',
        doneUnread: '已完成 · 未查看',
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
        groupLabel: '正在活跃会话',
        update: '插件更新',
        checking: '正在检查更新…',
        checkUpdate: '检查更新',
        updateFailed: '检查更新失败',
        updateUnavailable: '无法读取更新渠道',
        upToDate: '已是最新版本',
        updateAvailable: '有新版本',
        restartRequired: '已安装，重启宿主后生效',
        updating: '正在安装…',
        updated: '安装完成',
        restarting: '正在重启…',
        restartManual: '请手动重启 dsh Web Host',
        upgrade: '升级到',
        restart: '重启服务',
      },
      en: {
        title: 'Active now',
        expand: 'Expand',
        collapse: 'Collapse',
        waitingApproval: 'Waiting for approval',
        waitingQuestion: 'Waiting for an answer',
        waitingPlan: 'Plan awaiting review',
        waitingUnknown: 'Waiting for you',
        running: 'Generating…',
        failedUnread: 'Turn failed · unread',
        doneUnread: 'Done · unread',
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
        updating: 'Installing…',
        updated: 'Installed',
        restarting: 'Restarting…',
        restartManual: 'Restart the dsh Web Host manually',
        upgrade: 'Upgrade to',
        restart: 'Restart service',
      },
    };

    /* #region pure */
    /* ---- Pure derivation (framework-free; covered by test/derive.test.mjs) ---- */

    /** Bucket order: who needs the user first. */
    const KIND_RANK = Object.freeze({ waiting: 0, running: 1, failed: 2, done: 3 });

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
     * Derive the visible rows of the "正在活跃" group.
     *
     * One Session appears at most once, in its highest-precedence bucket:
     * waiting > running > failed-unread > done-unread. Finished buckets are
     * filtered by the turn-sequence ack (and by the local snooze window);
     * waiting/running are never hidden — they are live states, not notices.
     *
     * @param input - `{ list, statuses, workspaces, acked, ackedReady, hidden, snooze, now }`.
     * @returns rows sorted by bucket, then newest first.
     */
    function deriveActiveRows(input) {
      const list = input?.list;
      const ids = Array.isArray(list?.ids) ? list.ids : [];
      const byId = list?.byId ?? {};
      const projections = list?.projectionsBySession ?? {};
      const workspaces = input?.workspaces;
      const statuses = input?.statuses;
      const acked = input?.acked ?? {};
      const hidden = input?.hidden ?? {};
      const snooze = input?.snooze ?? {};
      const now = Number(input?.now) || 0;
      /* Until the Host answers with its ack map, "unread" is unknowable. Showing
         the optimistic default would list every finished Session in the store. */
      const ackedReady = input?.ackedReady !== false;

      const archived = new Set(Array.isArray(workspaces?.archivedSessionIds) ? workspaces.archivedSessionIds : []);
      const workspaceOf = buildSessionWorkspaceIndex(workspaces?.items);

      /* Running direct subagents, counted on their parent: the child Session
         never becomes a row of its own, it shows up as ⚙ N on the parent. */
      const subagentsRunning = new Map();
      for (const id of ids) {
        const row = byId[id];
        const parentId = row?.parentId;
        if (parentId === undefined || parentId === null) continue;
        if (readStatus(statuses, id).running !== true) continue;
        subagentsRunning.set(parentId, (subagentsRunning.get(parentId) ?? 0) + 1);
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

        let kind = null;
        let pendingKind;
        if (status.pendingInteraction !== undefined && status.pendingInteraction !== null) {
          kind = 'waiting';
          pendingKind = status.pendingInteraction.kind;
        } else if (running) {
          kind = 'running';
        } else if (view !== undefined && view.lastTurn === 'running') {
          /* The log is ahead of the UI status: the turn is still open. Bounded
             by recency, because a turn abandoned by a dead Host never closes --
             and an abandoned turn is neither running nor finished, so it is
             listed nowhere rather than invented as a result. */
          if (now - Number(row.updatedAt ?? 0) < STALE_TURN_MS) kind = 'running';
          else continue;
        } else {
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
        if (kind === null) continue;

        if (kind === 'failed' || kind === 'done') {
          /* Without the Host's ack map a finished Session cannot be placed on
             the read side of the line, so it is not listed at all. */
          if (!ackedReady && view !== undefined) continue;
          if (view !== undefined && lastTurnSeq >= 0 && lastTurnSeq <= ackSeq) continue;
          if (Number(snooze[id] ?? 0) > now) continue;
        }

        rows.push({
          id,
          kind,
          title: String(row.displayTitle ?? row.id),
          updatedAt: Number(row.updatedAt ?? 0),
          workspaceTitle: workspaceOf.get(id)?.title,
          subagents: subagentsRunning.get(id) ?? 0,
          pendingKind,
          lastError: typeof view?.lastError === 'string' ? view.lastError : null,
          /* Sequence to write when this row is acknowledged (open / mark read). */
          turnSeq: view !== undefined ? lastTurnSeq : -1,
        });
      }

      rows.sort((left, right) => (KIND_RANK[left.kind] - KIND_RANK[right.kind]) || (right.updatedAt - left.updatedAt));
      return rows;
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
      '.dsh-as-group{display:flex;flex-direction:column;flex:none;min-height:0;padding:0 4px 2px;',
      'border-bottom:1px solid var(--dsw-alias-border-s,rgba(128,128,128,.16))}',
      '.dsh-as-head{display:flex;align-items:center;gap:6px;height:32px;padding:0 6px;border-radius:var(--dsw-radius-sm,6px);',
      'cursor:pointer;user-select:none;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}',
      '.dsh-as-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
      '.dsh-as-head:focus-visible,.dsh-as-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#247bbf));outline-offset:-2px}',
      '.dsh-as-chevron{font-size:10px;line-height:1;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.7));',
      'transition:transform .12s ease}',
      '.dsh-as-chevron[data-collapsed="true"]{transform:rotate(-90deg)}',
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
      '.dsh-as-dot[data-kind="failed"]{background:var(--dsw-alias-state-error-primary,#d33)}',
      '.dsh-as-dot[data-kind="done"]{background:var(--dsw-alias-state-success-primary,#2ea043)}',
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
      '.dsh-as-empty{padding:6px;font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.8))}',
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
      '.dsh-as-panel{display:flex;flex-direction:column;gap:8px;height:100%;min-height:0;padding:12px 16px;box-sizing:border-box}',
      '.dsh-as-panel .dsh-as-list{flex:1 1 auto;overflow-y:auto}',
      '.dsh-as-panel .dsh-as-row{font-size:14px}',
      '.dsh-as-note{font-size:12px;line-height:18px;padding:6px 8px;border-radius:var(--dsw-radius-sm,6px);',
      'background:var(--dsw-alias-bg-skeleton,rgba(128,128,128,.12));color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}',
      '@keyframes dshAsPulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '@media (prefers-reduced-motion: reduce){.dsh-as-dot[data-kind="running"]{animation:none}}',
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

          const runRestart = useCallback(async () => {
            setUpdateBusy(true);
            setUpdateMsg(t('restarting'));
            try {
              const result = await updateRequest('/update/restart', { method: 'POST' });
              if (result?.ok !== true) setUpdateMsg(result?.error ?? t('restartManual'));
            } catch (error) {
              setUpdateMsg(`${t('restartManual')} ${String(error?.message ?? error)}`);
            } finally {
              setUpdateBusy(false);
            }
          }, [t]);

          const patchPrefs = useCallback((patch) => {
            setPrefs((previous) => {
              const next = { ...previous, ...patch };
              writePrefs(next);
              return next;
            });
          }, []);

          const rows = useMemo(() => deriveActiveRows({
            list,
            statuses,
            workspaces,
            acked,
            ackedReady,
            hidden: prefs.hidden,
            snooze: prefs.snooze,
            now,
          }), [list, statuses, workspaces, acked, ackedReady, prefs.hidden, prefs.snooze, now]);

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
            if (row.turnSeq >= 0) {
              acknowledge([{ sessionId: row.id, turnSeq: row.turnSeq }]);
              return;
            }
            patchPrefs({ hidden: { ...prefs.hidden, [row.id]: row.updatedAt } });
          }, [acknowledge, patchPrefs, prefs.hidden]);

          const openRow = useCallback((row) => {
            const workspaceUi = workspaceUiOf();
            try {
              workspaceUi?.openSession?.(row.id);
            } catch (error) {
              log('openSession failed', error);
            }
            /* On a phone the sidebar is a drawer over the conversation: leaving
               it open would keep the session the tap just opened behind it. */
            if (sidebarOverlays()) {
              try {
                layoutOf()?.toggleSidebar?.();
              } catch (error) {
                log('collapsing the sidebar overlay failed', error);
              }
            }
            acknowledgeRow(row);
          }, [acknowledgeRow]);

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
            if (row.kind === 'running') return t('running');
            if (row.kind === 'failed') return t('failedUnread');
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
            const tail = row.kind === 'waiting' ? statusWordOf(row) : relativeOf(row.updatedAt);
            const workspaceTitle = row.workspaceTitle;
            return typeof workspaceTitle === 'string' && workspaceTitle !== '' ? `${workspaceTitle} · ${tail}` : tail;
          };

          const rowLabel = (row) => {
            const parts = [row.title, statusWordOf(row)];
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
              if (event.shiftKey) acknowledgeRow(rows[index]);
              else openRow(rows[index]);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          };

          if (hooksMissing && mode === 'sidebar') return null;

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
            }, `${t('upgrade')} v${String(updateInfo.latest)}`) : null,
            needsRestart ? h('button', {
              type: 'button',
              className: 'dsh-as-upd-btn',
              'data-primary': 'true',
              disabled: updateBusy,
              onClick: runRestart,
            }, t('restart')) : null),
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
          h('span', { className: 'dsh-as-chevron', 'data-collapsed': collapsed ? 'true' : 'false', 'aria-hidden': 'true' }, '▾'),
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
          h('span', { className: 'dsh-as-dot', 'data-kind': row.kind, 'aria-hidden': 'true' }),
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
            h(IconButton, { glyph: '✓', label: t('ack'), onClick: () => acknowledgeRow(row) }),
            h(IconButton, { glyph: '⌛', label: t('snooze'), onClick: () => snoozeRow(row) }))));

          const listStyle = mode === 'panel'
            ? { flex: '1 1 auto', minHeight: 0 }
            : { maxHeight: `calc(min(${Math.max(96, prefs.heightPx)}px, 40vh) - 36px)` };

          const group = h('div', {
            className: 'dsh-as-group',
            role: 'group',
            'aria-label': t('groupLabel'),
            'data-dsh-active-group': 'true',
          },
          header,
          updatePanel,
          collapsed ? null : h('div', { className: 'dsh-as-list', role: 'list', style: listStyle },
            rows.length === 0
              ? (updateVisible ? null : h('div', { className: 'dsh-as-empty' }, t('empty')))
              : body));

          /* Empty group: render nothing at all (no placeholder, no gap) — unless
             the only thing to say is "there is a new version". */
          if (mode === 'sidebar' && rows.length === 0 && updateVisible === false) return null;

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
        }, ActiveSessionsOverlay));

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
