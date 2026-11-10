# dsh-active-sessions

A single fixed row at the top of the DSH sidebar that aggregates every session **waiting on you**, **still generating**, **finished with an error you have not looked at**, or **finished and not yet reviewed** — across all projects.

Click a row to jump there, mark it reviewed, or snooze it for an hour. What counts as reviewed is stored on the host, so it survives a refresh and is shared by every device connected to the same host.

## States and ordering

Each session appears once, with its highest-priority state.

| Priority | State | Rule | Visual | Copy |
|---|---|---|---|---|
| 1 | Waiting on you | `status.pendingInteraction != null` | still orange dot | Waiting for approval / question / plan review (unknown kinds fall back to a generic label) |
| 2 | Generating | `status.running === true`, or a subagent underneath this session is still running | pulsing accent dot | Generating… / Waiting for subagents |
| 3 | Draft not sent | this browser holds unsent composer text for the session | hollow dot | `Draft: <first 48 chars>` |
| 4 | Failed, unreviewed | turn ended with an error, not acknowledged | red dot | Turn failed, not reviewed (error summary on hover) |
| 5 | Done, unreviewed | turn completed, not acknowledged | green dot | Completed, not reviewed |

Inside a state, rows sort by `updatedAt` descending. Blank sessions, sub-sessions (`parentId` / `origin === 'subagent'`) and archived sessions are excluded. A parent row shows `⚙ N` when it has N running direct children.

A parent whose background subagent is still running counts as **generating**, not as a finished turn: accepting a child ends the parent's turn (`turn/end` → `completed`) while the host keeps waiting for its descendants, and `api-session/status` only reflects whether the agent itself is running — it is already idle. The turn projection alone would therefore report "done" for work that is still going on. The row's copy is `Waiting for subagents` rather than `Generating…`, `⚙ N` still counts direct children, a running grandchild keeps every ancestor live too, and a finished turn that was already acknowledged stays listed while a child runs — running is a live state, not a notice.

The block renders nothing at all when there is no active session.

## Why "reviewed" is a turn number

The host projection records `lastTurnSeq` for every session (the `seq` of that turn's `turn/start` event). Opening a row or marking it reviewed stores `acked[sessionId] = lastTurnSeq`, and "unreviewed" simply means `lastTurnSeq > acked`.

A timestamp comparison cannot work: the fact that a session stopped while the user was looking elsewhere never reaches the host, so a second tab or a second device would inherit a wrong verdict, and clock skew breaks the comparison outright. A turn number is precise ("I saw turn 61"), self-versioning (an old ack stops matching as soon as a new turn starts), and it comes from the host log, so it is stable across refreshes, tabs and devices.

`acks` holds user intent only and lives in its own storage domain; the projection holds log-derived facts, is rebuildable, and is never written to.

### The first-install baseline

The ack table starts empty while the store already holds thousands of long-finished sessions. Read literally, "`lastTurnSeq > acked` means unreviewed" would make every fresh client list **every historical session** as "done · unreviewed" — 93 rows on this machine. That is not a bug in the projection or the cache; it is a semantic migration: turns that ended before the plugin existed were never "unreviewed" in the first place.

So the host runs a baseline during the warm-up sweep: every session that **had already ended** before the sweep began (`lastTurn` is `done` or `failed`, and `endedAt` predates the sweep's start) and has no ack yet is acknowledged at its then-current `lastTurnSeq`. A running session is never swallowed by the baseline (its `lastTurn` is still `running`), and neither is a turn that ends during the sweep (its `endedAt` is newer than the sweep start). When the sweep finishes, a reserved key `#baseline` (`turnSeq: -1`, never returned to a client) is written and the baseline never runs again — turns that finish afterwards still raise the row, and a restart cannot swallow a live reminder.

The baseline is a migration, not an optimisation, so it also runs with `warm: false` (there just is nothing new to fold). It shows up as the last number of the sweep line: `projection warm-up: 6 folded, 5294 skipped, 0 failed, 93 baselined in 74s`.

### Two degraded situations

- **A host that died mid-turn** leaves a `turn/start` with no `turn/end`, so the projection says `running` forever. The client only treats an open turn as running when the session was active within the last two minutes; anything older is neither "running" nor invented as "done" — it is simply not listed. A live session has `status.running === true` and is never cut off by that bound.
- **An unreadable ack map**: when the remote `list()` fails, the client cannot know which finished turns were seen, so it shows only the waiting and running rows (which do not depend on acks) instead of reporting every historical session as unread. `list()` itself retries eight times, 400 ms apart.

## Unsent drafts (0.3.0)

The scenario: you type half a message in session A, switch to session B for something urgent, and when you come back A is nowhere to be found.

The host already persists every composer draft in localStorage under `dsh.conversation.<sessionId>` (`{ draft: { text, references }, view, … }`, `dsh-client-ui-conversation`'s `CONVERSATION_STORE_KEY`). So this needs no host change, no new storage and no hook inside the composer:

- The client scans that namespace once a second (memoized on the raw string, so only changed keys are parsed), and also listens to `storage` (another tab editing a draft) and `visibilitychange` (refresh the moment the tab returns).
- A session with a draft joins the "draft not sent" bucket, ranked after generating and before failed/done: it is your own unfinished work, so it deserves to be seen before the "come back and review" rows.
- The subtitle shows the first 48 characters (whitespace collapsed), which is what lets you recognise it at a glance.
- The row has **no ✓**: a draft is not unread, and `ack-by-turn` has nothing to acknowledge. It disappears when you send the text or clear the box (the next scan drops it). `⌛` still works.
- The session you are looking at right now is not listed (no point echoing what the composer already shows); the workspace row's `aria-selected` decides that.
- It is per-browser by nature: the draft text never left this browser, so another device legitimately shows nothing.

## Interaction

| Action | Effect |
|---|---|
| Click a row | Open the session and mark it reviewed (a draft row only opens) |
| Hover ✓ on a row | Mark reviewed without opening (draft rows have no ✓) |
| Hover ⌛ on a row | Snooze for one hour (failed / done / draft rows) |
| Header ✓ / ⌛ | Acknowledge or snooze all current failed + done rows (draft rows are never bulk-acknowledged) |
| Click the header | Collapse / expand (remembered locally) |
| Keyboard | On the header or a row: `↑/↓` move, `Enter` open, `Shift+Enter` mark reviewed (draft rows open instead), `Esc` blur |

The header badge counts only sessions waiting on you. The block is capped at `min(320px, 40vh)` and scrolls internally beyond eight rows.

## Mobile

Below a 1024px viewport the host trades the sidebar column for a rail, and a mobile plugin (such as `dsh-mobile-upgrade`) may take that rail over as a drawer floating above the conversation. The group follows the host:

- With the drawer shut the host does not render the session list at all (the rail has no `[data-row-key]` rows), so the group is absent rather than a 54px stub.
- With the drawer open the host lays out the wide sidebar, the list renders, and the group sits between the "workspaces" header row and the list — the same place as on the desktop.
- After a row is opened, if the sidebar is a **fixed overlay** (`innerWidth < 1024` and the sidebar column computes to `position: fixed`), the group calls the host's `layout.toggleSidebar()` so the drawer gets out of the way; leaving it open hides the session the tap just opened.
- Touch screens never hover, so the `→ ✓ ⌛` buttons are always shown through `@media (hover: none)` and the subtitle yields its space.
- The 768–1024px rail is a grid column, not an overlay, so opening a row there does not collapse anything.

### Why the drawer needs an opener from this plugin

A drawer takeover (`dsh-mobile-upgrade`'s floating button) does not drive the React layout itself: it looks for the host's published `[data-sidebar-opener]` (or `[data-sidebar-toggle]`) and clicks it. DSH 0.2.1-rc.2 publishes neither, so the click lands on nothing and the drawer never opens — and since the rail renders no list, the group can never be reached.

Since 0.2.3 this plugin ships the missing element itself: a 1×1, `opacity:0`, unfocusable (`tabIndex=-1`), `pointer-events:none` `button.dsh-as-opener[data-sidebar-opener]` that calls the host's `layout.toggleSidebar()` when clicked. The takeover finally has a real target; the sidebar expands, the list mounts, and the group appears with it. **No modification and no patch to `dsh-mobile-upgrade` is involved** — it never sees the element, it just stops clicking into the void.

## Install

The host profile lives at `$DSH_HOME/profiles/web` (default `~/.dsh/profiles/web`).

### One command (recommended)

```powershell
dsh plugin --profile web add https://github.com/zp96324511/dsh-active-sessions/releases/latest/download/dsh-active-sessions.tgz
```

`dsh plugin add` appends the package to `dsh.profile.bundles` on its own — no manifest editing. Then **restart the dsh Web Host** (it registers a projection, a storage domain, a remote service and the update routes). Client-only edits in `client.js` hot-swap without a restart.

Pin a version by swapping the URL for `releases/download/v0.2.1/dsh-active-sessions-0.2.1.tgz`. Without a `dsh` shim:

```powershell
node "$env:USERPROFILE\AppData\Local\Author Software\nvm\installs\v26.10.0\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile web add <tarball-url>
```

**Do not upgrade by re-running the `latest/download` command**: pnpm sees an unchanged dependency spec and skips resolution entirely (`Lockfile is up to date, resolution step is skipped`), leaving the old version installed. Upgrade through the version chip (its upgrade uses the versioned URL from `channel.json`, so the spec actually changes), or install a versioned URL by hand, e.g. `.../releases/download/v0.3.0/dsh-active-sessions.tgz`.

### Updates

A version chip sits at the right of the group header:

| Chip | Meaning | Opens |
|---|---|---|
| `v0.2.1` | up to date | check again / show channel |
| `v0.2.1 ↑` | newer release available | upgrade in place / check again |
| `v0.2.1 ⟳` | installed, restart pending | a reminder to restart the host yourself — the plugin never does it |
| `v0.2.1 ?` | channel unreachable | the reason |

Upgrades run `dsh plugin add <new tarball>` in a subprocess: in place, keeping the pnpm lockfile and the `engines` pre-check, and a failure leaves the existing install untouched. That is where the plugin stops — it never restarts the host. The process that started the host owns its command line (`--port`, `--public-url`, `--trusted-host`, environment, service-manager wrappers), so a relaunch reconstructed from `process.argv` could come back with different settings; the chip only tells you to restart. Job records land in `$DSH_HOME/storages/dsh-active-sessions-update.json`; an install interrupted by a reload is reported as failed rather than "running" forever.

The channel is derived from how the plugin was installed:

| Installed as | Channel |
|---|---|
| Release tarball URL | that repo's `releases/latest/download/channel.json` (tagged URLs also resolve to latest, so the channel never freezes at an old tag) |
| GitHub release page tgz | `releases/latest/download/channel.json` |
| Tarball next to a `channel.json` | that directory |
| `file:` / `link:` | **in-place upgrade refused** — no version to compare, the chip explains why |
| `github:` / git | **in-place upgrade refused** — it points at a branch tree |

A `file:` junction is therefore for development, not for exercising the update UI. To try the whole chain locally, run `npm run channel` + `npm run channel:serve` and install from `http://127.0.0.1:10600/dsh-active-sessions-<version>.tgz`.

To force a channel (for example so a local checkout still gets the update UI):

```yaml
- id: active-sessions
  name: dsh-active-sessions
  config:
    update:
      github: zp96324511/dsh-active-sessions   # or manifestUrl: https://…/channel.json
      registry: https://registry.npmjs.org
      checkIntervalMs: 21600000                 # cached check result, 6 hours by default
      timeoutMs: 8000                           # per-request timeout
      upgradeTimeoutMs: 900000                  # install subprocess timeout, 15 minutes
```

### Local development (directory junction)

```powershell
npm --prefix C:\Users\win10\.dsh\profiles\web install "file:C:\data\projects\dsh-active-sessions"
```

A `file:` install becomes a directory junction, so source edits take effect immediately. For distribution, pack a tarball instead:

```powershell
cd C:\data\projects\dsh-active-sessions
npm pack
npm --prefix C:\Users\win10\.dsh\profiles\web install --no-audit "file:C:\data\projects\dsh-active-sessions\dsh-active-sessions-0.2.1.tgz"
```

Uninstall: `dsh plugin --profile web remove dsh-active-sessions` (or `npm … uninstall dsh-active-sessions`), drop the bundle entry, restart.

## Data

| Data | Where | Notes |
|---|---|---|
| Acknowledgements | host storage domain `active_sessions`, table `acks` | Shared by all clients; writes are monotonic per session |
| Snooze / collapsed / height | `localStorage['dsh-active-sessions:v1']` | Browser-local UI preferences |
| Turn state | host projection `activeSessions` | Derived from the event log, rebuildable, never written |

If the storage domain cannot be opened, the host logs a warning and keeps acks in memory: everything still works, but acks are lost on restart.

## Performance

Three costs, each accounted for, so the block stays cheap on a large store.

**The fold is cheap.** The largest session log on this machine (5.11 MB compressed, 8412 events, of which only 50 are `turn/start`) costs 366 ms to read, 69 ms to decompress and 203 ms to parse — while folding this projection over it takes **1.33 ms** (0.07 ms for the median session). The projection only changes state on `turn/start` and `turn/end` and returns the identical state reference for every other event, so its cost grows with the number of turns, not with log size.

**A missing cache row costs the first paint nothing.** A session with no row for this plugin is summarised through `cachedSnapshot()` (memory only, zero I/O); the missing key is simply omitted instead of forcing a replay, and the client falls back to `completionUnread`. A real cold fold happens only when a session is materialized (opened, `stateOf`, `snapshot`), and only for that one key.

**Background warm-up.** So the host does something the hand-off spec does not mention: a while after startup (8 s by default, so the first paint wins) it sweeps stored sessions, and for every session **without a cache row for this plugin** it reads the log once, folds it and writes the checkpoint back. The sweep is chunked (6 sessions per tick, 150 ms rest), cancellable, fail-soft, skips sessions a live owner is writing (they checkpoint themselves at `turn/end`) and logs larger than `warmMaxBytes`, and finishes with one line: `projection warm-up: N folded, M skipped, K failed, B baselined in Xs` (`B` is the baseline migration, above). Tune it in `cordis.patch.yml`, targeted at `active-sessions`:

```yaml
- id: active-sessions
  config:
    warm: true
    warmDelayMs: 8000
    warmBatch: 6
    warmPauseMs: 150
    warmMaxBytes: 4194304
```

**The client no longer watches the whole page.** The anchor keeper used to observe `document.body`'s entire subtree and re-run `querySelector('[data-row-key]')` plus a walk of `getComputedStyle` on every sync. It now observes only the layer that owns the block (the scroll container's parent and that parent's parent), caches the resolved anchor until `listArea.isConnected` fails, and returns immediately from `sync()` when the node already sits in the right slot. The collapse flag is no longer queried document-wide on every sync: the `data-sidebar-collapsed` attribute observer *teaches* the keeper which element is the frame, after which it is one `getAttribute`. A 1-second O(1) watchdog covers the one case the scoped observer cannot see: the whole sidebar being replaced.

Measured on the live page (`test/browser-probe/` injects this repo's own `createAnchorKeeper`; 8784 nodes, 22 session rows): 3 idle seconds produced **0** anchor queries and **0** `getComputedStyle` calls, 40 rounds of list churn produced 0 of either, and re-appending the scroll container inside the region (a React rebuild) healed to the correct slot with 0 queries. The previous implementation did one `querySelector('[data-row-key]')` plus a 3-deep `getComputedStyle` walk per sync, and any list change triggered a sync.

## Fallback panel

The block is placed by DOM anchor: from any `[data-row-key]` row, walk up to the `overflow-y: auto` scroller and insert the block before the scroller's container, so it stays above the scrolling list and does not scroll away. A `MutationObserver` re-inserts it if React re-renders around it, and the block hides without leaving a gap when the sidebar collapses.

If no anchor is found within six seconds of startup, the plugin registers a `sidebar.panellist` icon plus a `main` panel (key `active-sessions`) and shows a note that the sidebar layout was not recognised — a version upgrade degrades instead of silently dropping the feature.

## Implementation notes

### What the six pre-flight checks established

1. **Session events**: `turn/start` carries `{ turn }`; `turn/end` carries `{ turn, reason }` where `reason` is a discriminated union (`completed`, `aborted`, `blocked`, `error`, `max-tokens`, `interrupted`, `forked`). Failure is therefore `reason.kind === 'error'`, with the message from `reason.error.message ?? reason.error.code`; there is no `data.error` field. The session log has no `agent/error` event (that is a Cordis runtime event, invisible to projections), so the projection only handles `turn/start` and `turn/end` and returns the same state reference for everything else.
2. **Projection wire**: `stateSchema` and `wire.viewSchema` accept zod instances directly; `wire.view` is compared by reference, so a `WeakMap` caches one view per state object.
3. **Storage domain**: `defineDomain({ name, version, layout: 'single', tables: { acks: domainTable(schema) } })` then `await ctx.storageDomain.open(spec)`; table reads are synchronous, writes are promise-based and already serialised per domain.
4. **Remote methods**: the client sees the descriptor's `exportName` (`list` / `ack` / `ackMany`) and receives an envelope `{ ok, value }` or `{ ok: false, error }`. The namespace must be mounted by the plugin's own client code via `ctx.remote.$mount(contribution)`; listing `remote.activeSessions` in the static `inject` deadlocks, because `apply` never runs to create it.
5. **Sidebar DOM**: `root > sectionHeader(36px) > listArea > treeBody > list(overflow-y: auto)`, with rows carrying `data-row-key`. Hashed class names are never referenced, and the root's `flex-direction` is never touched.
6. **Collapse flag**: `data-sidebar-collapsed` sits on the frame element and is `"true"` when collapsed — the attribute is removed, not set to `"false"`, when expanded.

### Module resolution: `file:` installs need `peerDependencies`

DSH intercepts Node's ESM and CJS resolution at boot so that platform packages (`@deepseek-ai/*`) resolve to the copies shipped with the installation. For a package physically inside the profile directory (a tarball install) this is unconditional. For a **linked root** — a `file:` install that becomes a junction with its real path outside the profile — the interception only applies when the importing package lists that name in its own `peerDependencies`; otherwise resolution falls back to Node's default and fails with `ERR_MODULE_NOT_FOUND`.

Hence the optional peers:

```json
"peerDependencies": {
  "@deepseek-ai/dsh-storage-domain": "*",
  "@deepseek-ai/dsh-typert-protocol": "*",
  "@deepseek-ai/schemastery": "*",
  "zod": "*"
}
```

They are marked optional in `peerDependenciesMeta` so npm never tries to fetch `@deepseek-ai/*` from the registry. `test/resolve-probe/` reproduces the host's interception and verifies that these four imports resolve and that `index.js` loads (development only, not shipped).

### What the warm-up will not do

The sweep only touches sessions that have **no cache row for this plugin**, and it writes them through the host's own `sessionProjectionCache.coldSnapshot(header, inheritedEventCount, events)` — the same cold-read entry the host uses when a user opens an old session. That call validates the previous checkpoint by identity, folds only the new events and writes the refreshed checkpoint back fail-soft, so the warm-up cannot invent values the normal path would not produce, and it cannot bypass the cache's identity check.

The price is that it reads the whole log store once (5402 sessions / 77 MB here, roughly one to two minutes chunked, yielding to the event loop throughout). Set `warm: false` to skip it — nothing breaks, an old session just folds once more the first time it is opened.

### Deviations from the hand-off spec

- The `promptError` badge (failed send / stop) is not implemented: `promptError` lives on `SessionSnapshot`, which a root-scope plugin cannot read for arbitrary sessions, so it would appear on some rows and not others.
- Acks travel over the wire as an array `[{ sessionId, turnSeq, at }]` rather than a map.
- `excludeCwdPrefixes` config was dropped: no use case, and it would be dead code.
- Row titles are 13px in the sidebar and 14px in the standalone panel.

## Acceptance checklist

1. No console errors; `document.querySelector('[data-dsh-active="block"]')` exists and is the previous sibling of the scroller.
2. Send a prompt: the session appears and pulses, then turns green ("Completed, not reviewed").
3. Click it: the session opens. Send another prompt: the row reappears (proves ack-by-turn).
4. Trigger an approval: orange dot, first in the group, "Waiting for approval".
5. Make a turn fail: red dot with the error on hover.
6. Create a subagent: the parent row shows `⚙ N`; the child never appears on its own.
7. Archive the session: the row disappears.
8. Refresh: identical content. A second browser against the same host: same acks.
9. Collapse the sidebar: the block hides without leaving a gap.
10. With nothing active: the block does not exist at all.
11. Open the same host in a browser that never loaded this plugin: only the genuinely unreviewed few appear, not the whole history (the baseline migration ran — the host log shows `... B baselined in ...`).

## Troubleshooting

- **No block**: check the host log for `dsh-active-sessions`, confirm the bundle entry, restart the host.
- **Block but no rows**: the projection has not reached the client. Inspect `useSessions(s => s).projectionsBySession` in the console — each session should carry `values.activeSessions`.
- **A fresh browser lists dozens of finished sessions**: the baseline never ran (host not restarted since the fix, or the `#baseline` marker write failed). Confirm the sweep line in the host log; without it every historic session is unread for a client whose ack map it cannot see.
- **A reviewed row comes back**: `remote.ack` did not land (host version mismatch or storage unavailable). The client falls back to local hiding and the row returns after a refresh; the host log has the warning.
- **Block sits inside the scrolling list**: the sidebar DOM changed and the anchor missed. The standalone panel takes over after six seconds; the probe result is logged to make fixing the anchor easy.

## License

MIT
