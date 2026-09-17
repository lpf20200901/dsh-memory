# dsh-memory

[English](README.md) | 中文

**给 AI 编码助手的、分层自动注入的跨会话记忆。**
一个 DSH 插件 + 一个零依赖的独立 CLI。借鉴 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 的
*规格 / 变更 / 归档* 纪律 —— 但走**推送**而不是拉取。

> 状态：**M1–M3 已完成并在真实 DSH 上实机验证**（差分注入 / 两个工具 / 蒸馏提醒）。
> 实机验证矩阵见下方「验证」。

## 为什么需要它

AI 编码助手有两个反复出现的毛病：

1. **新会话不记得任何事** —— 每个会话都要重新交代背景、偏好、结论。
2. **记住了也管不好** —— 全塞进一两个 Markdown，越写越大、越写越贵，而且**结论过时了没人删**。

已有的规格驱动工具（OpenSpec 等）解决的是"代码不跑偏"，但它们是**拉取式**：靠指令要求 AI 去读，
新会话不会主动想起来。dsh-memory 走**推送**：会话一开始就把该知道的塞进上下文，但**只推最精炼的部分**，
而且**只推变化的部分**，细节按需检索。

## 设计要点

```
        ┌─ PUSH：会话开始自动注入（字节预算硬约束）
        │    T0 身份与约定   用户偏好 / 机器环境 / 账号约定
        │    T1 索引与待办   接着办什么
库 ─────┤
        └─ PULL：按需检索（不占常驻预算）
             inbox/      候选条目 —— **模型默认只能写这里**
             facts/      当前真相（只有 status=active 参与注入）
             decisions/  决策与理由（只增不改）
             archive/    被取代条目的归档
             journal.md  流水（永不注入）
```

七条纪律：

- **推送的东西必须极小**：注入层里的内容每次会话都要花 token。所以流水、设计文档都不进注入层。
- **只推变化的部分**：每条条目带 12 位内容 hash，插件记住上一轮的状态，下一轮**只推新增/已更新/已失效**；
  **完全没变化时一个字都不注入**。（上游 `dsh-agent-instructions` 没有差分：文件一变就整篇重注入，
  实测一个会话里改 15 次某个 8.5 KB 的文件 ≈ 白烧 58k tokens。）
- **状态从会话历史恢复**：不存旁路状态文件，而是从自己发过的消息里读回 `{id: hash}` ——
  所以会话恢复 / 回放 / 压缩之后依然正确。
- **模型只写收件箱**：错误结论若静默进入常驻层，会被**反复注入**。提升需要显式 `promote`。
- **一个 key 一个真相**：事实/决策带语义键 `key`，同一个 `scope+key` 上**只能有一条 active**。
  新结论要进来，必须显式 `--supersedes` 旧的 —— 这是把"记忆腐化"挡在常驻层外的闸门。
- **结论有状态**：`active` / `superseded` / `expired`。被取代的打双向链接并归档，而不是无限追加。
- **纯 Markdown + frontmatter**：人可读、可 git diff、可 review、能像代码一样提交。

## 安装（作为 DSH 插件）

⚠️ 这段是**实机踩出来的**，两条弯路都别再走：

```text
❌ 往 package.json 的 dsh.profile.bundles 里加
   → DSH 启动时按市场注册表（.generations/desired.json）重新生成，未知条目被清掉

❌ 在 cordis.patch.yml 里写一个裸条目
   → 被静默忽略（patch 对不存在的 id 只做 config 覆盖/禁用）

✅ 在 cordis.patch.yml 里用 - insert: 包起来
```

**步骤**（`DSH_HOME` 通常是 `%APPDATA%\dsh-desktop\harness`）：

1. 把本包放进 profile 的 `node_modules`：

   ```
   <DSH_HOME>\profiles\web\node_modules\dsh-memory\
       package.json
       bin\mem.mjs
       src\plugin.mjs  src\hook.mjs  src\planner.mjs
   ```

2. 在 `<DSH_HOME>\profiles\web\cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: dsh-memory
         name: dsh-memory
         config:
           root: ''          # 留空 = 会话工作目录下的 memory/
           maxBytes: 3072    # baseline 注入的字节预算
           enabled: true
   ```

3. 保存即可 —— patch 层有 `watchUserPatches`，**会热加载，不需要重启**。

**卸载**：删掉 patch 里那段 `- insert:`，再删掉 `node_modules\dsh-memory` 目录。

> 官方分发渠道（插件市场）的发布流程我还没摸；目前是本机安装方式。

### 插件提供什么

| 能力 | 说明 |
| --- | --- |
| **差分注入** | 首次注入全部 active 条目（baseline）；之后每轮只推「新增 / 已更新 / 已失效」；无变化时零注入 |
| `memory_search` | 检索 facts / decisions / inbox / archive / journal |
| `memory_write` | 把候选条目写进 inbox —— **模型不允许直接改事实层** |
| 蒸馏提醒 | 会话跑过若干轮而记忆已是最新时，提醒模型把本次结论落到 inbox；每会话只提醒一次，且提醒消息**不带状态**，不污染差分基线 |

为什么插件**不去 spawn CLI**：DSH 沙箱禁止命名管道，捕获子进程输出会 EPERM；而且没必要 ——
插件直接 `import` 同一份 store 逻辑（`bin/mem.mjs` 只在被直接执行时才跑 CLI）。

## CLI 用法

```bash
# 初始化（默认 <cwd>/memory，可用 --root 或 $DSH_MEMORY_ROOT 改）
mem init --root ./memory --scope "workspace:/path/to/project"

# 记一条候选（落在 inbox，不注入）
#   --id  推荐显式给短 id；不给则从结论派生（压到 20 字符，撞车自动加序号）
#   --key 语义键：一个 scope+key 上只能有一个 active 真相
mem new --type fact --id win-update-cache --key disk-cleanup \
        --conclusion "清更新缓存实测收益为零" \
        --reason "目录删空但可用空间未变" --tags windows,disk --source session-abc

# 确认后提升到事实层；同 key 已有 active 时必须显式说明谁取代谁
mem promote win-update-cache
mem promote win-update-cache-v2 --supersedes win-update-cache

mem set <id> --key k --tags a,b --conclusion "…"   # 改已有条目（补 key / 改措辞 / 标 expired）
mem list --status active --tag windows
mem show <id>
mem validate [--fix]       # 格式/id/双向链接/环/同 key 冲突/索引/注入预算
mem index                  # 重建 index.md
mem inject [--json] [--budget 3072]   # 渲染应注入内容；--json 出带 hash 的差分载荷
mem recall <关键词>
mem journal add "流水一行"
```

## 验证（实机）

在真实 DSH 会话里逐项确认过：

| 能力 | 实机证据 |
| --- | --- |
| baseline 注入 | 会话收到全部 active 条目 |
| 无变化 → 零注入 | 下一步没有重复注入，只补了一次蒸馏提醒 |
| delta·新增 | "新增：<新条目>"，并注明"其余 N 条未变化" |
| delta·已更新 | 改一条后只推"已更新：<该条>" |
| `memory_search` / `memory_write` | 真机调用成功 |
| 写入只落 inbox | 写进去的候选**确实没进注入载荷**，promote 后才以 delta 出现 |

## 开发

```bash
npm test        # 173 个断言
```

| 套件 | 断言 | 覆盖 |
| --- | --- | --- |
| `test/run-tests.mjs` | 62 | CLI 端到端（含非 ASCII 路径回归） |
| `test/planner-tests.mjs` | 36 | 差分算法（纯逻辑） |
| `test/hook-tests.mjs` | 39 | 插件接线（假 agent / decision） |
| `test/plugin-tests.mjs` | 36 | 插件集成（桩 DSH 模块，真 apply） |

`test/plugin-tests.mjs` 用 `test/stubs/` 下的桩模块替换 4 个 `@deepseek-ai/*` 包，
通过 `test/stub-loader.mjs` **真正 `apply()` 这个插件并驱动它**，所以即使没有 DSH 也能验证插件行为。
另有 `test/preflight-import.mjs`：把包放进 profile 后用**真实** `@deepseek-ai/*` 模块跑一遍
（真实 `defineTool` 是否接受工具定义、真实 `schemastery` 是否接受配置 schema）。

几条从真实踩坑固化来的**回归测试**：

- 路径含**非 ASCII** 字符时，Node 的 `fs.rmSync` 会**静默失败**（配 `recursive` 时甚至崩进程），
  必须用 `unlinkSync`；
- DSH 沙箱禁止命名管道，`spawnSync` 默认的 `stdio:'pipe'` 会 EPERM，测试要把输出重定向到**文件**；
- 工具写出的条目 scope 必须跟随**会话工作区**，不能落到 harness 进程的 cwd。

## 路线图

- **M1 ✅** CLI + 结构化条目 + validate + 索引/注入预算
- **M2 ✅** 显式短 id、语义键与「一个 key 一个真相」、`inject --json` 差分载荷、`validate --fix`、`mem set`
- **M3 ✅** DSH 插件：差分注入 + 两个工具 + 蒸馏提醒（已实机验证）
- **M4** 发布（GitHub 主 / Gitee 镜像）

## 许可

MIT
