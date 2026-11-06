# dsh-active-sessions

在 DSH 侧栏顶部加一个**独占一行、固定不滚动**的「正在活跃」分组：跨项目聚合那些**等你回复 / 正在生成 / 轮次失败没看 / 轮次跑完没验收**的会话。点一下直达，标一下已读，「已验收」状态跨刷新、跨设备都记得。

多项目并行的日常痛点：会话铺满列表、项目折叠着，某个会话跑完了你根本不知道——这个分组就是把「需要你动手」的会话捞到最上面。

## 状态与排序

一个会话只出现一次，按优先级取最高状态。

| 优先级 | 状态 | 判定 | 视觉 | 文案 |
|---|---|---|---|---|
| 1 | 等待你 | `status.pendingInteraction != null` | 橙色静止圆点 | 等待审批 / 等待回答 / 计划待审（未知 kind → 等待你处理） |
| 2 | 生成中 | `status.running === true` | 主色脉动圆点 | 正在生成… |
| 3 | 失败未确认 | 该轮以错误结束，且未确认 | 红色圆点 | 轮次失败 · 未查看（悬停显示错误摘要） |
| 4 | 完成未确认 | 该轮正常结束，且未确认 | 绿色圆点 | 已完成 · 未查看 |

同一状态内按 `updatedAt` 倒序。排除：空白会话、子会话（`parentId` / `origin === 'subagent'`）、已归档会话。父会话行右侧显示 `⚙ N`，表示它有 N 个**正在运行**的直接子任务。

没有任何活跃会话时整块不渲染，不占位。

## 「已验收」用 turn 序号判定，不是时间窗

每个会话在宿主投影里记一个 `lastTurnSeq`（该轮 `turn/start` 事件的 `seq`）。你点开或标记已读时，宿主记 `acked[sessionId] = lastTurnSeq`；判定未读就是 `lastTurnSeq > acked`。

| 场景 | 时间戳方案 | turn 序号方案 |
|---|---|---|
| 两个页签，只在 A 里看过 | 提醒被一起吞掉 | 一致 |
| 换设备打开 | 看过的记录带不过去 | 一致 |
| 时钟漂移 / 跨时区 | 比较结果错乱 | 不受影响 |
| 看过之后又跑了一轮 | 需要额外清理逻辑 | `lastTurnSeq` 变大，自动重新出现 |

好处是语义精确（「这一轮我看过了」）、自带版本号（旧 ack 自动失效）、来自宿主日志（跨刷新/跨设备/跨页签稳定），且不依赖任何时钟比较。

`acks` 只存用户行为，和日志派生的投影严格分开：投影可重建、禁止写入；ack 单独进 storage domain。

### 首次安装的基线迁移

ack 表初始是空的，而库里已经有几千个早就结束的历史会话。若照字面执行「`lastTurnSeq > acked` 才算未读」，任何一个新客户端第一次打开都会把**所有历史会话**当成「完成 · 未查看」——实测本机是 93 行。这不是缓存或投影的 bug，是语义迁移问题：插件装上之前结束的轮次，用户当然没有「未验收」这件事。

所以宿主在预热扫描时先做一次基线：把**扫描开始那一刻之前就已经结束**（`lastTurn` 是 `done` / `failed`，且 `endedAt` 早于扫描起点）、且还没有 ack 的会话，按它当时的 `lastTurnSeq` 记一条 ack，等价于「这些更早的轮次算作已看过」。正在跑的会话不会被基线吞掉（它的 `lastTurn` 还是 `running`），扫描期间才结束的轮次也不会（它们的 `endedAt` 晚于扫描起点）。跑完在 `acks` 表里写一个保留键 `#baseline`（`turnSeq: -1`，不会被当作会话 id 返回给客户端），之后**永不重跑**——所以基线之后产生的新轮次照常提醒，重启也不会把新提醒吞掉。

基线是迁移不是优化，`warm: false` 也会执行（只是没有预热就不会折叠出新的历史行）。日志里表现为第二行的数字：`projection warm-up: 6 folded, 5294 skipped, 0 failed, 93 baselined in 74s`。

### 两个退化情形

- **宿主死在半轮**：日志里留下一个永不闭合的 `turn/start`，投影永远是 `running`。客户端只把「最近 2 分钟内有动静」的未闭合轮次当作正在生成；更久的既不算运行中、也不臆造「已完成」，直接不列。真正活着的会话有 `status.running === true`，不受这个时限影响。
- **ack 表读不到**：远端 `list()` 失败时客户端不知道哪些已完成轮次已读，此时**只显示等待你 / 生成中**这两类（它们不依赖 ack），不再把所有历史会话当成未读。`list()` 本身会重试 8 次 × 400 ms。

## 交互

| 操作 | 行为 |
|---|---|
| 点行 | 打开该会话并记为已验收 |
| 悬停行右侧 ✓ | 只标记已读，不打开 |
| 悬停行右侧 ⌛ | 忽略 1 小时（只对失败/完成行） |
| 组头 ✓ / ⌛ | 当前所有失败+完成行批量已读 / 批量忽略 1 小时 |
| 点组头 | 折叠 / 展开（折叠状态本地记住） |
| 键盘 | 组头或行聚焦后 `↑/↓` 移动、`Enter` 打开、`Shift+Enter` 标记已读、`Esc` 失焦 |

组头徽标只统计「等待你」的条数；高度上限 `min(320px, 40vh)`，超过 8 行内部滚动。

## 安装

插件本体在 `C:\data\projects\dsh-active-sessions`，安装到 web profile：

```powershell
npm --prefix C:\Users\win10\.dsh\profiles\web install "file:C:\data\projects\dsh-active-sessions"
```

然后在 `C:\Users\win10\.dsh\profiles\web\package.json` 的 `dsh.profile.bundles` 末尾追加 `"dsh-active-sessions"`：

```json
"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "...", "dsh-active-sessions"]
```

**重启 dsh Web Host**（宿主半侧新增了投影、存储域和远程服务，必须重启；只改 `client.js` 时保存即可热替换）。

`file:` 安装出来的是目录联结（junction），改插件源码即时生效，适合开发。发布给别人时用 tarball：

```powershell
cd C:\data\projects\dsh-active-sessions
npm pack
npm --prefix C:\Users\win10\.dsh\profiles\web install --no-audit "file:C:\data\projects\dsh-active-sessions\dsh-active-sessions-0.1.0.tgz"
```

卸载：

```powershell
npm --prefix C:\Users\win10\.dsh\profiles\web uninstall dsh-active-sessions
# 再从 dsh.profile.bundles 里删掉 "dsh-active-sessions"，重启宿主
```

## 数据存放

| 数据 | 位置 | 说明 |
|---|---|---|
| 已验收（ack） | 宿主 storage domain `active_sessions`，表 `acks` | 跨设备一致；`put` 单调，乱序不会回退 |
| 忽略 1 小时 / 折叠 / 高度 | 浏览器 `localStorage['dsh-active-sessions:v1']` | 纯 UI 偏好，按浏览器各自保存 |
| 轮次状态投影 | 宿主 session projection `activeSessions` | 日志派生，可重建，不写入 |

存储域打不开时（后端未配置等）宿主会告警并退回内存 Map，功能照常，只是重启后 ack 丢失。

## 性能

这个分组要在大库上也不拖慢列表，三条成本各有着落：

**折叠本身很便宜。** 本机最大的会话日志（5.11 MB 压缩、8412 个事件、其中只有 50 个 `turn/start`）读盘 366 ms、解压 69 ms、JSON 解析 203 ms，而本插件这条投影的折叠只要 **1.33 ms**（中位会话 0.07 ms）。投影只对 `turn/start` / `turn/end` 动状态，其余事件直接返回同一份 state 引用，所以成本约等于日志里轮次数的线性函数，与日志总长无关。

**缺缓存不影响首屏。** 没有本插件这一行的会话，列表读取走 `cachedSnapshot()`（纯内存、零 I/O），缺行就**省略这个 key**，不会为了补上它去重放日志——客户端看到 key 缺席就退回 `completionUnread`。真正的冷折叠只在会话被「材质化」（打开、`stateOf`、`snapshot`）时为它一个 key 折一遍。

**宿主后台预热。** 于是本项目额外做了一件交接文档没写的事：宿主启动后（默认等 8 秒让首屏 I/O 先走完）在后台扫描已存会话，对**没有本插件缓存行**的那些读一次日志、折叠并写回缓存。分片进行（默认每 6 个歇 150 ms）、可取消、失败只计数不抛错、跳过正在运行的会话（它们会在 `turn/end` 自己写回）与超过 `warmMaxBytes` 的大日志，结束时打一行 `projection warm-up: N folded, M skipped, K failed, B baselined in Xs`（`B` 是基线迁移数，见上）。配置在 `cordis.patch.yml` 里定向到 `active-sessions`：

```yaml
- id: active-sessions
  config:
    warm: true
    warmDelayMs: 8000
    warmBatch: 6
    warmPauseMs: 150
    warmMaxBytes: 4194304
```

**客户端不再监听整页。** 锚点守护从「`MutationObserver` 观察 `document.body` 全子树 + 每次 sync 都 `querySelector('[data-row-key]')` 并逐级 `getComputedStyle`」改成：观察范围收缩到真正拥有区块的那一层（滚动容器的容器 + 它的父级），锚点解析结果缓存到 `listArea.isConnected` 失效为止，`sync()` 命中「已在正确位置」就直接返回。折叠状态不再每次全文档查询，而是由 `data-sidebar-collapsed` 的属性观察器把 frame 元素**教**给我们，之后只读一个 `getAttribute`。另加一个 1 秒一次的 O(1) 看门狗兜住「整个侧栏被替换」这种观察不到的情况。

实测（在真实页面上用 `test/browser-probe/` 注入本仓库的 `createAnchorKeeper`，页面 8784 节点、22 个会话行）：空闲 3 秒 **0 次**锚点查询、**0 次** `getComputedStyle`；列表行 churn 40 轮 0 次；把滚动容器重新挂到区域内（模拟 React 重建）时用 0 次查询就自愈回位。改动前的实现每次 sync 是 1 次 `querySelector('[data-row-key]')` + 沿祖先链逐级 `getComputedStyle`（实测 3 次），且任何一次列表变化都会触发。

## 降级面板

侧栏结构随 DSH 升级可能变化，所以写入位置靠 DOM 锚点：从任意 `[data-row-key]` 行向上找 `overflow-y: auto` 的滚动容器，把区块插到它的容器之前（滚动区上方、不随滚动）。用 `MutationObserver` 自愈重插，侧栏收起时整块隐藏且不占位。

启动后 6 秒内始终找不到锚点时，自动注册 `sidebar.panellist` 图标 + `main` 面板（同名 key `active-sessions`），面板顶部提示「侧栏结构不兼容，已启用独立面板」。一次版本升级不会让功能直接消失。

## 实现备注

### §11 六项前置验证的结论

1. **会话事件字段**：`turn/start` 的 data 是 `{ turn }`；`turn/end` 是 `{ turn, reason }`，`reason` 是带 `kind` 的判别联合（`completed` / `aborted` / `blocked` / `error` / `max-tokens` / `interrupted` / `forked`）。因此失败判定看 `reason.kind === 'error'`，错误文案取 `reason.error.message ?? reason.error.code`；交接文档里猜的 `data.error` 不存在。会话日志里**没有** `agent/error` 事件（那是 Cordis 运行时事件，投影收不到），所以投影只处理 `turn/start` 与 `turn/end`，其余事件一律 `return state` 保持引用不变。
2. **投影 wire**：`stateSchema` / `wire.viewSchema` 直接接收 zod 实例；`wire.view` 以引用比较，故用 `WeakMap` 缓存「同一 state 对应同一 view」，避免每次变更都让客户端全量重算。
3. **storage domain**：`defineDomain({ name, version, layout: 'single', tables: { acks: domainTable(zodSchema) } })` + `await ctx.storageDomain.open(spec)`，表 API 是同步 `get`、异步 `put/update/delete`，写入按域内单链串行，不需要自己再加锁。
4. **远程方法**：客户端 `ctx.get('remote.activeSessions')` 暴露的是描述符里的 `exportName`（`list` / `ack` / `ackMany`），返回值是信封 `{ ok, value }` / `{ ok: false, error }`。命名空间必须由插件客户端自己 `ctx.remote.$mount(contribution)` 挂载，且**不能**把 `remote.activeSessions` 写进静态 `inject`（会死锁：apply 不运行 → 服务不存在）。
5. **侧栏 DOM**：`root > sectionHeader(36px) > listArea > treeBody > list(overflow-y:auto)`，行元素带 `data-row-key`（工作区 `workspace:<key>`、会话 `session:<id>`）。不能引用 hash 类名（跨版本不稳定），也不能改 `root` 的 `flex-direction`。
6. **侧栏收起**：`data-sidebar-collapsed` 挂在 frame 元素上，收起为 `"true"`、展开时属性直接移除（不是 `"false"`）。

### 模块解析：`file:` 安装必须声明 `peerDependencies`

DSH 启动时在本进程内接管 Node 的 ESM/CJS 解析，把 `@deepseek-ai/*` 这类平台包指向安装目录自带的副本。对**在 profile 目录内**的包（tarball 装出来的真实目录）这一步是无条件的；对**链接根**（`file:` 装出来的 junction，真实路径在 profile 之外）则要求导入方的 `package.json` 的 `peerDependencies` 里列出该包名，否则回落到原生解析并失败（`ERR_MODULE_NOT_FOUND`）。

所以本包声明了可选 peer：

```json
"peerDependencies": {
  "@deepseek-ai/dsh-storage-domain": "*",
  "@deepseek-ai/dsh-typert-protocol": "*",
  "@deepseek-ai/schemastery": "*",
  "zod": "*"
}
```

用 `peerDependenciesMeta` 标成 optional，避免 npm 去 registry 拉不存在的 `@deepseek-ai/*`。仓库内 `test/resolve-probe/` 可以复现宿主的解析接管并验证这四个包能否解析、`index.js` 能否加载（开发用，不随包发布）。

### 后台预热的边界

预热只写「本插件这条 key 缺失」的会话，且用宿主的 `sessionProjectionCache.coldSnapshot(header, inheritedEventCount, events)`——这是宿主自己的冷读入口，它内部按 identity 校验旧行、只补折新事件、再把刷新后的检查点 fail-soft 写回。所以预热做的事和「用户打开一个老会话」完全同构，不会写入别处没有的值，也不会绕过缓存的身份校验。

代价是按需付费：它会替用户把全库日志读一遍（本机 5402 个会话 / 77 MB，分片跑约一到两分钟，全程让出事件循环）。不想要就 `warm: false`，功能不受影响，只是老会话第一次被打开时多折一次。

### 与交接文档的偏离

- **未做** `promptError`（发送/停止失败）红色角标：`promptError` 只在 `SessionSnapshot` 上，根作用域插件拿不到任意会话的快照，只有打开过的会话才有，做出来会是「有的行有、有的行没有」的随机效果。
- ack 的 wire 形状用数组 `[{ sessionId, turnSeq, at }]`，不是 map：跨通道校验和序列化都更省事。
- 未实现 `excludeCwdPrefixes` 配置：没有实际用例，避免死代码。
- 行标题字号：侧栏 13px、独立面板 14px（窄栏可读性）。

## 验收清单

1. 控制台无异常；`document.querySelector('[data-dsh-active="block"]')` 存在，且是滚动容器（`overflow-y: auto` 的列表）的**前一个兄弟节点**。
2. 发一条 prompt → 出现在分组、脉动；完成后变绿点「已完成 · 未查看」。
3. 点该行 → 跳到对话；再发一条 → 该会话**重新出现**（验证 ack-by-turn）。
4. 触发一次审批 → 橙点、排最前、文案「等待审批」。
5. 让一轮失败 → 红点，悬停可见错误摘要。
6. 造一个 subagent → 父行显示 `⚙ N`，子会话本身不单独出现。
7. 归档该会话 → 从分组消失。
8. 刷新页面内容一致（跨刷新）；另一个浏览器连同一宿主时 ack 一致（跨设备）。
9. 折叠侧栏 → 区块隐藏且不占位；展开恢复。
10. 无活跃会话 → 区块完全不存在（不占位）。
11. 在一个**从未打开过本插件**的浏览器里打开同一宿主 → 只看到真正未验收的少数会话，不会把历史会话全列出来（基线迁移生效；宿主日志里应有 `... B baselined in ...`）。

## 排障

- **分组没出现**：先看宿主日志有没有 `dsh-active-sessions`；再确认 `dsh.profile.bundles` 里有本包并已重启宿主。
- **有区块但没有行**：多为投影没到客户端。控制台查 `useSessions(s => s).projectionsBySession`，每个会话的 `values.activeSessions` 应该有 `{ lastTurnSeq, lastTurn }`。
- **点了已读又重新出现**：说明 `remote.ack` 没成功（宿主版本不匹配或存储域不可用）。此时客户端会退回本地隐藏，刷新后会重新亮起，宿主日志里会有告警。
- **区块跑到列表外面 / 不固定**：侧栏 DOM 变了，锚点没命中。等 6 秒会自动启用独立面板，同时把探测结果打到控制台便于修锚点。

## 许可

MIT
