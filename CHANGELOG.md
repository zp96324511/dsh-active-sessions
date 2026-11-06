# 变更记录

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.3] - 2026-11-06

手机上「正在活跃」区块看不到的根因修复：不再依赖第三方抽屉插件找到宿主。

### 修复

- 窄屏时宿主把侧栏收成导轨，工作区列表根本不渲染，区块自然无处可挂；而把侧栏唤出来的抽屉接管（`dsh-mobile-upgrade` 的浮动按钮）要找宿主发布的 `[data-sidebar-toggle]` / `[data-sidebar-opener]` 再点它，DSH 0.2.1-rc.2 两个都不发布，于是抽屉永远打不开、区块永远不可达。本插件现在自带一个 1×1、不可聚焦、不可点击的 `[data-sidebar-opener]`（`button.dsh-as-opener`），点击时通过宿主的 `layout.toggleSidebar()` 展开侧栏——抽屉接管拿到真实目标，区块随列表一起出现。**不需要修改 dsh-mobile-upgrade**，它的行为完全不变。

## [0.2.2] - 2026-11-06

移动端（窄屏抽屉）适配。

### 修复

- 手机上点开会话后侧栏抽屉不收起，会话被抽屉挡在后面，看起来像「点了没反应」：当侧栏以固定浮层形态覆盖正文时（`innerWidth < 1024` 且侧栏列为 `position: fixed`），打开会话后调用宿主的 `layout.toggleSidebar()` 收起抽屉。桌面与 768–1024px 的导轨列不受影响。
- 触摸屏上每行的 `→ ✓ ⌛` 只在 `:hover` / `:focus-visible` 时显示，而触摸屏永远不触发 hover，三个动作按钮等于不存在：新增 `@media (hover: none)` 规则，按钮常驻，副标题让出空间。

## [0.2.1] - 2026-11-06

自更新通道。安装形态从「git 克隆 + 手动重启」升级为「Release tarball + 就地升级 + 自重启」，与 dsh-context-control 一致。0.2.0 未对外发布，0.2.1 是首个带自更新的版本。

### 修复

- 前缀路由把完整请求路径交给处理函数，导致 `/plugins/dsh-active-sessions/*` 全部回 `no route`：处理函数现在先剥掉挂载前缀再分发。

### 新增

- 宿主 `update.js`：更新渠道自动推导（Release tarball → 同目录 `channel.json`；GitHub → `releases/latest/download/channel.json`；registry → registry；`file:`/`link:`/git → 拒绝原地升级并给出指引），`/plugins/dsh-active-sessions/{ping,version,update,update/job,update/upgrade,update/restart}` 路由。
- 就地升级：子进程执行 `dsh plugin --profile <p> add <spec>`，保留 pnpm 锁与 `engines` 预检、失败不动现有安装；升级任务落 `$DSH_HOME/storages/dsh-active-sessions-update.json`，中途被重载打断会记成失败而不是永远「进行中」。
- `respawn.cjs`：等旧 PID 退出 → 等端口释放 → 同命令行拉起，重启后仍是原来的 `--profile` / `--port` / 环境。
- 客户端版本行：分组标题右侧显示 `v0.2.0`，有新版本 `↑`、待重启 `⟳`；点开是检查 / 升级 / 重启三个动作与状态文字，折叠状态下也看得到。
- `npm run channel` / `channel:serve`：本地生成并服务 `dist/`（tarball + `channel.json`，含 sha256），可在不发布的情况下走完升级链路。
- `.github/workflows/{ci,publish}.yml`：CI 校验清单、入口文件与临时 profile 试装；打 `v*` 标签发布三个资产（`dsh-active-sessions.tgz`、版本化 tgz、`channel.json`）。
- `scripts/check-manifest.mjs`：`files`/`exports`/版本/`locale` 键集合的一致性护栏，`npm run check` 第一步。

### 变更

- 安装方式改为一条命令：`dsh plugin --profile web add https://github.com/zp96324511/dsh-active-sessions/releases/latest/download/dsh-active-sessions.tgz`。本地 `file:` 目录联结仍可用于开发，但该形态不支持原地升级（渠道会明确说明原因）。
- `package.json` 新增 `./update`、`./respawn` 导出，`files` 收录 `update.js`、`respawn.cjs`。

## [0.1.0] - 2026-11-06

首个版本。宿主半侧与客户端半侧一起发布。

### 新增

- 侧栏「工作区 / 会话」标题下方、滚动列表上方的**固定**「正在活跃」分组，不随列表滚动，空态不渲染、不占位。
- 跨项目聚合四类会话：等待你（审批 / 回答 / 计划待审）、正在生成、轮次失败未确认、轮次完成未确认。同一会话只出现一次，按 `waiting → running → failed → done` 取最高状态，同状态内按 `updatedAt` 倒序。
- 点击直达会话；悬停 `✓` 标记已读、`⌛` 忽略 1 小时；表头 `✓` / `⌛` 对当前所有失败与完成行批量生效；`↑/↓` 选择、`Enter` 打开、`Shift+Enter` 标记已读。
- 父会话行显示 `⚙ N`（N 个正在运行的直接子任务）；子会话本身不单独列出。
- **ack-by-turn**：宿主投影记 `lastTurnSeq`（该轮 `turn/start` 的 `seq`），点开或标记已读写 `acked[id] = lastTurnSeq`，未读判定为 `lastTurnSeq > acked`。跨刷新、跨页签、跨设备一致，不依赖任何时钟比较。
- ack 存在宿主的 storage domain（`active_sessions`），可跨设备；`snooze`、折叠状态、区块高度存在浏览器本地。
- 降级面板：若侧栏 DOM 结构变化导致锚点注入失败，6 秒后自动启用独立面板（`sidebar.panellist` + `main` keyed 洞），并在面板顶部说明原因。

### 性能

- 宿主后台预热：启动 8 秒后分片扫描已存会话，为缺少本插件缓存行的会话读一次日志、折叠并写回投影缓存（默认每 6 个歇 150 ms、可取消、跳过活会话与超大日志）。该投影本身折叠成本与轮次数线性相关（本机最大会话 8412 事件仅 1.33 ms）。
- 客户端锚点守护不再监听整页：观察范围收窄到列表容器及其父级，锚点解析结果缓存到失效为止，`sync()` 命中「已在正确位置」直接返回；折叠状态由 `data-sidebar-collapsed` 属性观察器学习 frame 元素；另有 1 秒一次的 O(1) 看门狗兜住侧栏整体被替换。实测空闲 3 秒 0 次锚点查询、0 次 `getComputedStyle`。

### 修复

- 首次安装（或新设备首次打开）时，把库内所有历史会话都列为「完成 · 未查看」的问题：宿主在预热扫描时执行一次性基线迁移，把扫描开始前就已结束的轮次记为已看过，并写入保留键 `#baseline`，永不重跑。
- 宿主中途退出留下的未闭合轮次不再永远显示「正在生成」：客户端只把最近 2 分钟内有动静的未闭合轮次当作运行中，更久的既不显示为运行中、也不臆造为已完成。
- ack 表读取失败时客户端不再把所有会话当作未读，只显示不依赖 ack 的「等待你 / 生成中」；远端 `list()` 失败会重试 8 次。
