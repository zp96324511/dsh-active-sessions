# 任务

在**这套** DSH 里安装并完整验证 `dsh-active-sessions` 插件（侧栏「活跃会话」分组）。

插件把四类活跃会话聚合成侧栏顶部一个固定分组（不随列表滚动）：等待你回复 / 正在生成 / 轮次失败未确认 / 轮次完成未确认；分组末尾再列最多 3 个「最近活跃」的回访入口，最后是置顶会话的常驻入口。点行 = 打开（已结束的轮次同时标记已读；生成中 / 等待你的行只打开，不写 ack），⊘ = 忽略 1 小时，「已读」以 turn 序号记录在**宿主侧**，所以跨浏览器、跨设备一致。

**本机前提：DSH 的安装目录与数据目录都可能被改到非默认位置。所以本提示词的第一步不是安装，而是解析环境。绝对不要假设 `~/.dsh`，也不要依赖 PATH 上的 `dsh`。**

---

# 第 1 步：解析环境（不做完这一步不要安装）

## 1.1 找到正在运行的宿主进程

Windows (pwsh):

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'dsh[\\/]lib[\\/]bin\.js' } |
  Select-Object ProcessId, CommandLine | Format-List
```

POSIX:

```bash
ps -eo pid,args | grep -E 'dsh/lib/bin\.js' | grep -v grep
```

从命令行里读出：

- `<install>` = 命令行中 `\lib\bin.js`（或 `/lib/bin.js`）之前的绝对路径；
- `PROFILE` = `--profile <name>` 的值，没有则默认 `web`；
- `PORT` = `--port` 的值，没有则默认 `10550`。

如果找不到这样的进程，说明宿主当前没在跑：向用户确认它的启动方式（快捷方式 / 脚本 / systemd / 计划任务），从那里取同样的三条信息。

## 1.2 解析数据目录 DSH_HOME

优先级：宿主进程实际继承的环境变量 → 启动脚本里显式设置的 `DSH_HOME` → 默认值。

Windows:

```powershell
$home = $env:DSH_HOME
if (-not $home) { $home = Join-Path $env:USERPROFILE '.dsh' }
```

POSIX:

```bash
home="${DSH_HOME:-$HOME/.dsh}"
```

**校验（三条都成立才认定 `$home` 正确）：**

```powershell
Test-Path "$home\profiles"                          # True
Test-Path "$home\profiles\$PROFILE\package.json"    # True
(Get-Content "$home\profiles\$PROFILE\package.json" -Raw | ConvertFrom-Json).dsh.profile.bundles  # 非空数组
```

若宿主以服务/其他用户身份运行，`DSH_HOME` 可能在服务定义里，`$env:DSH_HOME` 读不到——此时用上面「三条校验」反推：在候选目录（默认目录、`--profile` 指向的目录、启动脚本里出现的路径）中找出三条全中的那个。

## 1.3 确认 DSH 版本与 Node

```powershell
node "<install>\lib\bin.js" --version   # 必须 >= 0.2.0-rc.2
node -v                                # 必须 >= 20
```

不要用 PATH 上的 `dsh`：PATH 可能指向另一套安装，版本不符会白装。

## 1.4 后续所有命令统一带上同一个数据目录

```powershell
$env:DSH_HOME = $home            # Windows
export DSH_HOME="$home"          # POSIX
```

插件的以下文件全部落在 `$home` 下，宿主进程与 CLI 必须指向同一个，否则会把插件装进一套新建的空 profile：

| 文件 | 内容 |
| --- | --- |
| `$home/storages/active_sessions.json` | 已读状态（acks 表）+ `#baseline` 基线标记 |
| `$home/storages/session_projcache/` | 各会话投影缓存（含本插件的 `activeSessions` 行） |
| `$home/storages/dsh-active-sessions-update.json` | 升级 job 记录 |
| `$home/sessions/` | 会话日志（预热会读它） |
| `$home/logs/` | 宿主日志（验证基线/预热是否跑过） |

---

# 第 2 步：安装（一条命令，不要手改 bundles）

```powershell
node "<install>\lib\bin.js" plugin --profile $PROFILE add `
  https://github.com/zp96324511/dsh-active-sessions/releases/latest/download/dsh-active-sessions.tgz
```

`dsh plugin add` 会自动把包名追加进 profile 的 `dsh.profile.bundles`，**不需要**手改 `package.json`。

**绝对不要用这两种方式安装：**

- `npm install file:<本地目录>` —— 目录联结形态，是开发用的；插件会把渠道判定为 `local`，更新胶囊只会显示「本地目录，无法比较版本」，且拒绝就地升级。
- `npm install github:...` —— git 形态；同样没有版本可比较，无法自更新。

装完立刻确认**装到了正确的那套 profile**：

```powershell
$inst = "$home\profiles\$PROFILE\node_modules\dsh-active-sessions"
Test-Path "$inst\package.json"                                   # True
(Get-Content "$inst\package.json" -Raw | ConvertFrom-Json).version   # 应为当前最新版
Get-ChildItem $inst -File | Select-Object Name                   # 应含 index.js client.js update.js
(Get-Content "$home\profiles\$PROFILE\package.json" -Raw | ConvertFrom-Json) |
  Select-Object -ExpandProperty dependencies |
  Select-Object -Property 'dsh-active-sessions'                  # 应是该 tgz URL
```

若 dependencies 里出现 `file:` 或 `github:`，说明用错了安装命令，删掉重装。

---

# 第 3 步：重启宿主（必须）

坚守的规则：**宿主的半侧（投影注册、存储域、远程服务、更新路由）只在启动时加载**。只刷新页面、只重载客户端是不够的。

重启时**沿用该机器原本的启动方式**（快捷方式 / 脚本 / 服务），命令行参数（`--host`、`--port`、`--public-url`、`--trusted-host`）保持原样。不要抄别的机器的参数：`--public-url` 和 `--trusted-host` 改错会导致移动端访问和反向代理失效。插件自己升级后也只提示重启，不代你重启——理由相同：启动参数只有启动方知道。

⚠️ 重启会中断该宿主上正在进行的会话。若重启命令是你在当前会话里执行的，先告知用户。

---

# 第 4 步：首次启动的两个一次性动作（会自动跑，不要手工干预）

插件**不需要**你先手工建缓存。首次启动时它自己会做两件事，都只跑一次：

**A. 基线迁移**——把「安装之前就已经结束」的历史会话一次性标记为已读。否则一台新浏览器打开会看到几百行历史未读，看起来完全像 bug。

- 日志行：`projection baseline: N earlier sessions marked reviewed`
- 标记位置：`$home/storages/active_sessions.json` 的 `acks` 表，键名 `#baseline`
- 该键一旦存在就永不重跑；它在折叠**之前**先跑一遍，折叠完再补跑一遍（只补这期间结束的轮次，且不吞正在跑的轮次）

**B. 后台预热**——给「还没有本插件投影缓存」的历史会话补算一次投影并写回缓存，让老会话第一次出现在列表里时不用现场重放日志。

- 日志行：`projection warm-up: N folded, M skipped, K failed, B baselined in Xs`
- 默认：启动 8 秒后开始，每 6 个会话暂停 150ms，跳过正在运行的会话和超过 4MiB 的日志

**这两步缺失或失败都不会让功能不可用**，只是：A 缺失 → 列表里多出历史未读；B 缺失 → 打开老会话多几百毫秒。**不要把「日志里没有这两行」判定为安装失败。**

## 是否要调小/关掉预热

数据目录被改过的机器往往会话日志也很大，先量一下规模：

```powershell
$logs = Get-ChildItem "$home\sessions" -Recurse -Filter 'session.v4.jsonl.zstd' -ErrorAction SilentlyContinue
"count: $($logs.Count)  total: $([math]::Round(($logs | Measure-Object Length -Sum).Sum/1MB,1)) MB"
```

- < 200 个会话：默认配置即可，几秒跑完，不用管。
- 上千个会话 / 上百 MB：在 `$home/profiles/$PROFILE/cordis.patch.yml` 里加配置（只关预热，基线仍会跑）：

```yaml
- id: active-sessions
  config:
    warm: false
    warmDelayMs: 30000
    warmBatch: 2
    warmPauseMs: 500
    warmMaxBytes: 4194304
```

改完需要再重启一次宿主；`warm: false` 之后再想补缓存，把它改回 `true` 重启即可。

---

# 第 5 步：验证

## 5.1 宿主侧

```powershell
Invoke-RestMethod "http://127.0.0.1:$PORT/plugins/dsh-active-sessions/ping"
# 期望 version 与 loaded 相同，且等于安装的版本号

Invoke-RestMethod "http://127.0.0.1:$PORT/plugins/dsh-active-sessions/update?force=1" |
  Select-Object version,loaded,stale,channel,canUpgrade,hasUpdate
# 期望 channel.kind = manifest，canUpgrade = true，hasUpdate = false，stale = false
# 若 404：插件没被加载（八成是没重启宿主，或装到了另一套 profile）
```

## 5.2 页面侧

1. 侧栏「工作区」标题行下方出现「活跃会话」分组，**位置在会话列表上方，滚动列表时它不动**。
2. 空态：没有任何活跃会话时分组仍常驻，列表位置显示一行弱化的「暂无活跃会话」占位（类似输入框 placeholder）；侧栏折叠时隐藏且不占位。

## 5.3 验收清单（逐条确认，不要只看「装上了」）

1. 分组存在，且是会话列表滚动容器的**前一个兄弟节点**（滚动会话列表时分组不动）。
2. 会话跑完一轮 → 行由「正在生成」变绿点（已完成未查看）；点开后绿点行消失，转为分组末尾的「最近活跃」行；让它再跑一轮 → 重新出现绿点（已读按 turn 序号判定，不是时间）。**回归**：在一轮生成中时点开该行，再切到别的会话；它在后台跑完后应变成绿点「已完成 · 未查看」，而不是直接消失。
3. 出现审批 / 提问等待时显示橙点，副标题「等待审批 / 等待回答 / 计划待审」。
4. 轮次失败未确认显示红点，确认后消失。
5. 父会话派驻后台子任务后：行内出现 `⚙N`，且该行保持「运行中」（副标题「等待子任务」），**不会**在父会话当轮结束时变成绿点「已完成 · 未查看」；子任务结束后才按轮次正常进入完成/失败状态。
6. 后台任务：让某个会话在后台起一个长驻进程（例如 `pwsh` 里 `run_in_background` 启动 `python -m http.server`），当轮结束后该行仍应是「运行中」（副标题「等待子任务」），没有 `✓`，`⌛` 也不会把它隐藏；杀掉该进程后，行才变成绿点「已完成 · 未查看」。
7. 归档该会话后，它从分组里消失。
8. 刷新页面、换另一个浏览器打开 → 已读状态一致（acks 在宿主）。
9. 手机/窄屏：视口 < 1024px 时宿主把侧栏收成导轨且**不渲染会话列表**，分组因此不存在（宿主行为，不是 bug）；用移动端抽屉把侧栏拉起来后，分组应出现在列表上方。触摸屏没有 hover，行右侧的 `→ ✓ ⊘` 应常驻显示。
10. 升级胶囊：标题右侧显示 `v<版本>`；有新版本时变 `↑`，点击可就地升级；升级完成后胶囊变 `⟳`，提示「已安装，重启宿主后生效」——插件只提示，不代你重启，按第 3 步的方式自行重启即可。
11. 置顶常驻：在任意工作区置顶一个会话 → 分组最后出现该会话（📌、「已置顶」），点击可直达；多个置顶时按最近更新时间倒序（新活跃的在前）；标为已读后它仍在，取消置顶后消失。置顶会话正在生成时只出现一条行，行首是状态点而不是 📌（📌 只在常驻行出现，不与其他状态点并排）。
12. 最近活跃：分组末尾（置顶行之前）最多 3 个最近更新、且不在上面任何一类的会话，行首 `🕘`、副标题是相对时间；点开后不会重复出现；在更多会话里活动，最早的一条会被挤出。
13. 列表定位：先手动折叠该会话所在的工作区分组（点工作区标题行收起），再点「活跃会话」里它的行 → 分组自动展开、列表滚动到该行；若该行在分组 5 行水位线之外，应自动点「显示更多」把它显示出来。侧栏收起成导轨或手机抽屉关闭时不报错、不做事。

---

# 第 6 步：排障

| 现象 | 判断与处理 |
| --- | --- |
| `/plugins/dsh-active-sessions/ping` 返回 404 | 插件没被加载 → 检查是否重启过宿主；检查是不是装到了另一套 profile（回到 1.2 的三条校验）。 |
| `plugin --profile ... add` 全绿，但真实宿主上没变化 | 装进了默认目录的空 profile：CLI 与宿主 `DSH_HOME` 不一致。重新带上 `$env:DSH_HOME` 安装。 |
| 页面上一堆历史会话都是未读 | 基线没跑完：等日志出现 `projection baseline:`；或重启一次让它先于折叠执行。 |
| 打开老会话很慢 | 预热还没跑到它，或已用 `warm: false` 关掉；属预期，不影响正确性。 |
| 窄屏/手机上看不到分组 | 先确认抽屉能拉开（侧栏被拉起来才有列表）；本插件自带 1×1 的 `[data-sidebar-opener]` 供抽屉插件定位，**不需要改 dsh-mobile-upgrade**。 |
| `loaded` 比 `version` 旧、`stale: true` | 装了新版本但没重启宿主：重启。 |
| 更新胶囊显示「本地目录，无法比较版本」 | 安装形态是 `file:`/`link:`：按第 2 步换成 release tarball。 |

---

# 不要做的事

- 不要手改 profile 的 `package.json` 或 `dsh.profile.bundles`（`dsh plugin add` 会自己维护）。
- 不要用 `uninstall + install` 来升级：中途失败会留下一个没有插件的 profile。升级只用 `plugin --profile <p> add <tgz>`，或点版本胶囊。
- 不要给 `dsh-mobile-upgrade` 等第三方插件打补丁。
- 不要手工删改 `$home/storages/session_projcache/`：那是宿主与多个插件共用的投影缓存目录。
- 不要把 `$home` 写成固定的 `~/.dsh` 或 `C:\Users\<name>\.dsh`——本机这两个目录都被额外指定过。
