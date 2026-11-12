# dsh-active-sessions

在 DSH 侧栏顶部加一个**独占一行、固定不滚动**的「活跃会话」分组：跨项目聚合那些**等你回复 / 正在生成 / 轮次失败没看 / 轮次跑完没验收**的会话。点一下直达，标一下已读，「已验收」状态跨刷新、跨设备都记得。

多项目并行的日常痛点：会话铺满列表、项目折叠着，某个会话跑完了你根本不知道——这个分组就是把「需要你动手」的会话捞到最上面。

## 状态与排序

一个会话只出现一次，按优先级取最高状态。

| 优先级 | 状态 | 判定 | 视觉 | 文案 |
|---|---|---|---|---|
| 1 | 等待你 | `status.pendingInteraction != null` | 橙色静止圆点 | 等待审批 / 等待回答 / 计划待审（未知 kind → 等待你处理） |
| 2 | 生成中 | `status.running === true`，或其后代子会话 / 后台任务仍在运行 | 主色脉动圆点；主轮已结束、只在等子任务/后台任务时为主色空心环脉动 | 正在生成… / 等待子任务 |
| 3 | 草稿未发送 | 本浏览器里该会话的输入框留着没发出去的内容 | 空心圆点 | `草稿：<前 48 字>` |
| 4 | 失败未确认 | 该轮以错误结束，且未确认 | 红色圆点 | 轮次失败 · 未查看（悬停显示错误摘要） |
| 5 | 完成未确认 | 该轮正常结束，且未确认 | 绿色圆点 | 已完成 · 未查看 |
| 6 | 最近活跃 | 最近更新过、没有出现在上面任何一类、也不是当前打开的会话 | 小号时钟 🕘 | 最近活跃 |
| 7 | 已置顶（常驻） | 在宿主的 `pinnedSessionIds` 里，且没有更高优先级的活跃状态 | 📌 | 已置顶 |

同一状态内按 `updatedAt` 倒序；「最近活跃」取最近更新的 3 个，按 `updatedAt` 倒序，排在活跃状态之后；「已置顶」排在最后，桶内同样按 `updatedAt` 倒序（最新活跃的在前）——常驻入口不抢占需要你处理的行。排除：空白会话、子会话（`parentId` / `origin === 'subagent'`）、已归档会话。父会话行右侧显示 `⚙ N`，表示它有 N 个**正在运行**的直接子任务。

派了后台子任务的父会话算「生成中」，不算「完成」：子任务一被接受，父会话当轮就以 `turn/end`（`completed`）结束，而宿主还在等它的后代；`api-session/status` 只反映 agent 本身是否在跑，此时它已经 `idle`。只看轮次投影，就会把「还在等子任务」报成「已完成」。这一行的状态文案是「等待子任务」而不是「正在生成…」，圆点仍是主色蓝、同样的 1.4s 脉动，但画法不同：主智能体生成时是实心圆点，等子任务时是空心环（`◎`，和输入框里「待发送」的标记同一种形状）。色相和节奏保持一家，靠形状区分「这一行在忙，但忙的不是主智能体自己」；琥珀色常亮仍只表示「等待你」；`⚙ N` 仍数直接子任务；孙任务在跑时，它的每一层祖先都保持活跃；已经确认过的已完成轮次，只要还有子任务在跑也仍然列出——运行中是实时状态，不是待验收通知。

后台任务同样算「子任务」：`pwsh` / `bash` 的 `run_in_background`、terminal 的后台发送都会在会话日志里留下 `job/registered`，结束时补一条 `job/settled`。只要这条会话还有未 settle 的任务（例如一个一直开着的 Flask server），当轮结束后这一行仍算「生成中」、副标题同样是「等待子任务」，没有 `✓`、也不受「忽略 1 小时」影响；把进程杀掉后，投影收到 `job/settled`，该行才回到正常的完成/失败未读状态。子会话自己起的长任务也会让它保持活跃，从而让父会话继续显示 `⚙ N`。硬崩溃留下的孤儿 `job/registered`（没有 `settled`）按宿主进程启动时间过滤：任务不可能比启动它的进程活得更久，不会让会话永远卡在运行中；分叉会话从源会话继承的 `job` 事件按 `owner` 过滤，只算真正持有它的会话。

置顶的会话常驻：DSH 的「置顶」是全局的（不按工作区分），插件把置顶集合里的会话固定列在分组最后，作为常驻入口。一个置顶会话如果本身有活跃状态（等待你 / 生成中 / 草稿 / 失败 / 完成未读），仍然只出现那一条行，行首就是该状态的状态点（📌 被替换，不会并排出现第二个图标）；这一轮被标为已读或被「忽略 1 小时」时，行回退成「已置顶」常驻行而不是消失。常驻行没有 `✓`、也没有 `⌛`（忽略只会藏掉提示、行本身还在，读起来像坏掉的忽略），点行只打开。当前正打开的置顶会话同样保留常驻行——它是切换会话时的回程入口。

最近活跃：分组末尾（置顶行之前）再列最多 3 个最近更新过、且没有出现在上面任何一类的会话，行首一枚小号时钟 🕘，副标题是「工作区 · 3 分钟前」。它们只是回访入口：不写 ack、没有 `✓` 和 `⌛`，也不会和上面的行重复；超过 3 个时，更早的那条被更新的挤出列表。所以一轮跑完被标为已读后，行不是凭空消失，而是落到「最近活跃」里——需要它的那天还找得回来。当前正打开的会话不在这里重复出现（它已经在正文区）。

没有任何活跃会话时区块仍然常驻：标题行保留，列表位置显示一行弱化的「暂无活跃会话」占位，不消失、也不塌陷。

## 「已验收」用 turn 序号判定，不是时间窗

每个会话在宿主投影里记一个 `lastTurnSeq`（该轮 `turn/start` 事件的 `seq`）。你点开一个**已经结束**的轮次或标记已读时，宿主记 `acked[sessionId] = lastTurnSeq`；判定未读就是 `lastTurnSeq > acked`。

生成中的行、「等待你」的行、等子任务的行以及还有后台任务在跑的行点开只做跳转，不写 ack：一轮还没结束，不存在「这一轮我看过了」；等子任务/后台任务的行虽然自己那轮在派发任务时就结束了，但整条会话仍在进行中，同样不能算已验收。否则在它生成时点开、再切到别的会话，等它在后台跑完时会因为 seq 已被提前 ack 而直接从分组消失。反过来，正开着的会话在**页面可见**时跑完，客户端会补写 ack（人已经在看这条消息了），不会给自己弹一条「已完成 · 未查看」；后台标签页里跑完则保持未读。

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

## 草稿未发送（0.3.0）

场景：你在 A 会话里打了一半准备发，临时切到 B 去处理急事，回来就找不到 A 了。

宿主本来就把每个会话的输入框草稿落盘在 localStorage：键是 `dsh.conversation.<sessionId>`，值是 `{ draft: { text, references }, view, … }`（`dsh-client-ui-conversation` 的 `CONVERSATION_STORE_KEY = "dsh.conversation"`）。所以这一条不需要宿主改动、不需要新存储、也不需要在输入框上挂钩子：

- 客户端每一秒扫一遍这个命名空间（按原始字符串做 memo，只有变了的才 `JSON.parse`），另外监听 `storage` 事件（另一个标签页改草稿）与 `visibilitychange`（切回页面立刻刷新）。
- 有草稿的会话进「草稿未发送」桶，排在生成中之后、失败/完成之前——它是你自己的未完成工作，比「回头验收」更该先看到。
- 副标题直接显示草稿前 48 字（折叠换行），并高亮在列表里，一眼认出「就是那句」。
- 这一行**没有 ✓**：草稿不是未读，`ack-by-turn` 对它没有意义。它自动消失的方式是把内容发出去或清空输入框（下一轮扫描就没了）。`⌛` 仍然可用，忽略 1 小时。
- 当前正打开的那个会话不显示（否则你一边打字一边看自己在列表里）；判定依据是工作区行的 `aria-selected`。
- 只在**这个浏览器**里有效：草稿文本本来就没有上传，换设备看不到是正常的。

## 交互

| 操作 | 行为 |
|---|---|
| 点行 | 打开该会话并记为已验收（草稿行、生成中 / 等待你 / 等子任务 / 后台任务在跑的行、最近活跃行、置顶常驻行只打开，不写 ack）；同时让下方工作区列表展开并滚动到该会话 |
| 悬停行右侧 ✓ | 只标记已读，不打开（草稿行、生成中 / 等待你 / 等子任务 / 后台任务在跑的行、最近活跃行、置顶常驻行没有这个按钮） |
| 悬停行右侧 ⌛ | 忽略 1 小时（失败/完成/草稿行；置顶行没有这个按钮） |
| 组头 ✓ / ⌛ | 当前所有失败+完成行批量已读 / 批量忽略 1 小时（草稿行不参与批量已读） |
| 点组头 | 折叠 / 展开（折叠状态本地记住） |
| 键盘 | 组头或行聚焦后 `↑/↓` 移动、`Enter` 打开（同样展开/滚动工作区列表）、`Shift+Enter` 标记已读（草稿 / 生成中 / 等待你 / 等子任务 / 后台任务的行同样是打开）、`Esc` 失焦 |

组头徽标只统计「等待你」的条数；高度上限 `min(320px, 40vh)`，超过 8 行内部滚动。

点行打开会话时，下方工作区列表会跟着定位：所在工作区分组若被折叠就自动展开；该行在分组默认的 5 行水位线之外时，替用户点「显示更多」把它渲染出来；最后 `scrollIntoView({ block: 'nearest' })` 滚到可视区域。DSH 自己的搜索结果打开也走同一套 DOM 动作（它内部的 `revealSessionId` 不对外开放），所以行为与搜索跳转一致。侧栏收起成导轨、手机抽屉已关闭或列表处于平铺模式时没有可分组的列表，此时不做事。

## 移动端

窄屏（视口 < 1024px）下侧栏不再是一列，而是被宿主收缩成导轨；`dsh-mobile-upgrade` 之类的移动端插件再把导轨接管成覆盖正文的抽屉。分组跟着宿主走：

- 抽屉收起时宿主根本不渲染会话列表（导轨态没有 `[data-row-key]`），分组也就不存在——不做「只有 54px 宽」的残桩。
- 抽屉拉开时宿主展开为宽布局，列表照常渲染，分组出现在「工作区」标题行与列表之间，位置与桌面一致。
- 点击行之后，如果侧栏是**固定浮层**（`innerWidth < 1024` 且侧栏列 `position: fixed`），会调用宿主的 `layout.toggleSidebar()` 把抽屉收起来——否则刚打开的会话会被抽屉挡在后面，看起来像「点了没反应」。
- 触摸屏没有 hover，行右侧的 `→ ✓ ⌛` 通过 `@media (hover: none)` 常驻显示，副标题让出空间。
- 768–1024px 的导轨列不是浮层，点行不会收起侧栏。

### 抽屉为什么需要本插件提供一个「开门器」

移动端抽屉（`dsh-mobile-upgrade` 的浮动按钮）自己不去改宿主的布局，它按宿主发布的契约找 `[data-sidebar-opener]`（或 `[data-sidebar-toggle]`）再点一下。DSH 0.2.1-rc.2 这两个属性都不发布，于是那一下点在空气上，抽屉永远打不开——而导轨态宿主不渲染列表，分组也就永远不可达。

0.2.3 起本插件自带这个元素：一个 1×1、`opacity:0`、不可聚焦（`tabIndex=-1`）、`pointer-events:none` 的 `button.dsh-as-opener[data-sidebar-opener]`，点击时调用宿主的 `layout.toggleSidebar()`。抽屉接管拿到真实目标，侧栏展开、列表挂载、分组随之出现。**不需要修改、也不需要给 `dsh-mobile-upgrade` 打补丁**；它看不见这个元素，只是终于能点到东西。

## 安装

宿主 profile 位于 `$DSH_HOME/profiles/web`（默认 `~/.dsh/profiles/web`）。

### 一条命令（推荐）

```powershell
dsh plugin --profile web add https://github.com/zp96324511/dsh-active-sessions/releases/latest/download/dsh-active-sessions.tgz
```

`dsh plugin add` 会把包名自动追加进 profile 的 `dsh.profile.bundles`，不需要手改 `package.json`。装完**重启 dsh Web Host**（宿主半侧有投影、存储域、远程服务和更新路由，必须重启；只改 `client.js` 时保存即可热替换）。

固定版本就把 URL 里的版本换成 `releases/download/v0.2.1/dsh-active-sessions-0.2.1.tgz`。没有 `dsh` 命令时等价写法：

```powershell
node "$env:USERPROFILE\AppData\Local\Author Software\nvm\installs\v26.10.0\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile web add <tarball-url>
```

**注意**：升级不要重复执行上面那条 `latest/download` 命令——pnpm 看到 profile 里的依赖串没变，会直接跳过解析（`Lockfile is up to date, resolution step is skipped`），装完还是旧版本。升级有两条正路：

- 点分组标题右侧的 `↑` / 胶囊里的「升级」（内部用的是 `channel.json` 里带版本号的 URL，spec 变了才会真的换包）；
- 或者手动带版本号装一次，例如 `.../releases/download/v0.3.0/dsh-active-sessions.tgz`。

### 之后：自带更新

分组标题右侧有版本胶囊：

| 胶囊 | 含义 | 点开 |
|---|---|---|
| `v0.2.1` | 已是最新 | 检查更新 / 查看渠道 |
| `v0.2.1 ↑` | 有新版本 | 升级（就地换版本）/ 检查更新 |
| `v0.2.1 ⟳` | 已升级，待重启 | 重启提示（插件只提示，不代你重启） |
| `v0.2.1 ?` | 查不到渠道 | 显示失败原因 |

升级走 `dsh plugin add <新 tarball>`：原地替换、继承 pnpm 锁与 `engines` 预检，失败不动现有安装。到此为止——插件不会重启宿主。宿主的命令行归启动方所有（`--port`、`--public-url`、`--trusted-host`、环境变量、服务管理器/脚本包装的其他参数），按 `process.argv` 重建命令行的重启并不可靠；胶囊只提示你手动重启。任务记录落 `$DSH_HOME/storages/dsh-active-sessions-update.json`，中途被打断会记成失败而不是永远「进行中」。

更新渠道从**当前安装形态**自动推导，不需要配置：

| 安装形态 | 渠道 |
|---|---|
| Release tarball URL | 同仓库 `releases/latest/download/channel.json`（tagged URL 也解析到 latest，避免渠道被冻在旧 tag） |
| GitHub release 页里的 tgz | `releases/latest/download/channel.json` |
| 同目录 tarball | `<目录>/channel.json` |
| `file:` / `link:` | **拒绝原地升级**（没有版本可比），胶囊会说明原因 |
| `github:` / git | **拒绝原地升级**（指向的是分支树），同上 |

因此本地 `file:` 目录联结适合开发，但不适合验更新 UI；要在本地试更新链路，用 `npm run channel` + `npm run channel:serve`，再从 `http://127.0.0.1:10600/dsh-active-sessions-<版本>.tgz` 装。

需要强制指定渠道时（比如本地检出也想用更新 UI）：

```yaml
- id: active-sessions
  name: dsh-active-sessions
  config:
    update:
      github: zp96324511/dsh-active-sessions   # 或 manifestUrl: https://…/channel.json
      registry: https://registry.npmjs.org
      checkIntervalMs: 21600000                 # 检查结果缓存，默认 6 小时
      timeoutMs: 8000                           # 单次 HTTP 超时
      upgradeTimeoutMs: 900000                  # 升级子进程超时，默认 15 分钟
```

### 本地开发（目录联结）

插件源码在 `C:\data\projects\dsh-active-sessions`，用 `file:` 安装到 web profile：

```powershell
npm --prefix C:\Users\win10\.dsh\profiles\web install "file:C:\data\projects\dsh-active-sessions"
```

`file:` 安装出来的是目录联结（junction），改插件源码即时生效，适合开发。发布给别人时用 tarball：

```powershell
cd C:\data\projects\dsh-active-sessions
npm pack
npm --prefix C:\Users\win10\.dsh\profiles\web install --no-audit "file:C:\data\projects\dsh-active-sessions\dsh-active-sessions-0.2.1.tgz"
```

卸载：

```powershell
dsh plugin --profile web remove dsh-active-sessions
# 或 npm --prefix "$env:USERPROFILE\.dsh\profiles\web" uninstall dsh-active-sessions
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
10. 无活跃会话 → 分组仍常驻，列表位置显示一行弱化的「暂无活跃会话」占位。
11. 在一个**从未打开过本插件**的浏览器里打开同一宿主 → 只看到真正未验收的少数会话，不会把历史会话全列出来（基线迁移生效；宿主日志里应有 `... B baselined in ...`）。
12. 在任意工作区置顶一个会话 → 它出现在分组末尾（📌、「已置顶」）；标为已读后仍在，取消置顶后消失；置顶会话正在生成时只出现一条行，行首是状态点而不是 📌。

## 排障

- **分组没出现**：先看宿主日志有没有 `dsh-active-sessions`；再确认 `dsh.profile.bundles` 里有本包并已重启宿主。
- **有区块但没有行**：多为投影没到客户端。控制台查 `useSessions(s => s).projectionsBySession`，每个会话的 `values.activeSessions` 应该有 `{ lastTurnSeq, lastTurn }`。
- **点了已读又重新出现**：说明 `remote.ack` 没成功（宿主版本不匹配或存储域不可用）。此时客户端会退回本地隐藏，刷新后会重新亮起，宿主日志里会有告警。
- **区块跑到列表外面 / 不固定**：侧栏 DOM 变了，锚点没命中。等 6 秒会自动启用独立面板，同时把探测结果打到控制台便于修锚点。

## 许可

MIT
