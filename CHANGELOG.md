# 变更记录

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.3] - 2026-11-10

### 变更

- `resolveDshHome()` 补齐 `~` 展开：`~`、`~/x`、`~\x` 都按 DSH 本体的 `expandHomePath` 解析到用户主目录；仍然先 trim `DSH_HOME`，空白值回退 `~/.dsh`，其余交给 `path.resolve()`。
- README 与 README.zh 的 profile 位置改为 `$DSH_HOME/profiles/web`（默认 `~/.dsh/profiles/web`），不再把 `~/.dsh` 写成唯一路径，并去掉写死的 Windows 用户目录示例。
- `test/update.test.mjs` 新增回归用例：`~/` 与 `~\` 展开、空白 `DSH_HOME` 回退、`DSH_HOME` 带尾部分隔符时 `findProfile` 不产生重复分隔符。

## [0.4.2] - 2026-11-09

### 变更

- 升级后不再提供「重启服务」：删除 `/plugins/dsh-active-sessions/update/restart` 路由、`respawn.cjs` 与 `update.restart` 配置项。
- 胶囊变 `⟳` 时只显示「已安装，重启宿主后生效」和一段手动重启提示，不再代用户拉起宿主。宿主的启动方式不归插件管：`--port`、`--public-url`、`--trusted-host`、环境变量以及服务管理器 / 脚本包装的额外参数都在启动方手里，按 `process.argv` 重建命令行重启并不可靠，还会中断该宿主上正在进行的会话。
- `package.json` 去掉 `./respawn` 导出与 `respawn.cjs` 的 `files` 条目，`npm run check` 同步去掉 `node --check respawn.cjs`。

## [0.4.1] - 2026-11-08

### 修复

- 去掉标题后面常驻的那个折叠箭头。它和悬停（或键盘聚焦）时出现在标题前的箭头是两套指示，在触屏或 `(hover: none)` 的设备上会同时出现两个。现在只保留与宿主工作区分组一致的那一套：静止显示线条图标，悬停或聚焦时在原位换成箭头。

## [0.4.0] - 2026-11-08

### 变更

- 分组标题改名：中文「正在活跃」→「活跃会话」，英文 `Active now` → `Active sessions`（独立面板回退组名同步为「活跃会话」）。
- 分组标题「活跃会话」前面的标记，从一个小圆点换成与工作区分组同一规格的纯线条图标：16px 网格、1px 描边、`currentColor`（沿用 `--dsw-alias-label-tertiary`），方框里一段脉冲线，缩到 16px 仍然看得清。
- 同一个位置现在兼作展开/收起指示，行为与宿主的工作区分组一致：静止显示图标，悬停或键盘聚焦时换成箭头（展开朝下，收起朝右）；触屏设备没有悬停，箭头常显在标题右侧。

## [0.3.0] - 2026-11-06

新增「草稿未发送」状态：在某个会话里打了一半、切走之后就找不回来的那个会话，现在会被列出来。

### 新增

- 第四种状态 `drafted`，插在「生成中」与「失败未确认」之间。判定来自宿主本来就落盘的输入框草稿（localStorage `dsh.conversation.<sessionId>` 的 `draft.text` / `draft.references`），因此不需要宿主改动、不需要新存储、也不需要在输入框上挂钩子。
- 行副标题直接显示草稿前 48 字（空白折叠），一眼认出是哪句；圆点是空心环，与四种实心状态区分。
- 草稿行只有 `→` 与 `⌛`，没有 `✓`：草稿不是未读，`ack-by-turn` 对它没有意义；发出去或清空输入框后，下一次扫描自动消失。
- 扫描按原始字符串做 memo（只解析变化过的键），并监听 `storage` 与 `visibilitychange`；当前正打开的那个会话不列（依据工作区行的 `aria-selected`）。
- 两个新文案键 `drafted` / `draftPrefix`，`locale/zh.json` 与 `locale/en.json` 同步。

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
