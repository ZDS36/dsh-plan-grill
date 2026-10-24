# dsh-plan-grill · 计划盘问模式

给 DeepSeek Harness（DSH）的 Web 对话界面增加一个「计划」菜单：先逐题澄清需求，
再提交有证据的计划供你评审，批准后进入实现。适合希望在改代码之前把方案问清楚的任务。

**盘问方法参考并改编自 [KAIXUAN-zhang-bot/grillme-skill](https://github.com/KAIXUAN-zhang-bot/grillme-skill)**，
其来源进一步追溯至 [mattpocock/skills](https://github.com/mattpocock/skills)。
完整致谢、改编范围与原始 MIT 版权见 [第三方声明](THIRD_PARTY_NOTICES.md)。

## 能做什么

- 在输入框左侧选择三种模式，悬停或聚焦菜单项可查看适用场景和预期产出。
- 要求模型一次只问一个问题，给出推荐项与理由；可查明的代码事实由模型自行核实。
- 引导模型先明确目标、边界和验收标准，再沿决策依赖逐项讨论。
- 用 `plan_grill_review` 提交 Markdown 计划、证据、待验证假设及文件路径。
- 在 DSH 提问通道展示完整计划，并提供「批准，按计划执行」和「继续盘问」。
- 模式按会话保存于内存；批准、手动关闭或到期后，Host 停止注入本插件的计划提示。

## 三种模式

| 模式 | 适用场景 | 批准前的文档行为 | 预期产出 |
| --- | --- | --- | --- |
| A · 盘问 `grill-me` | 中小改动、一次性任务、先澄清 bug 假设 | 提示模型只读，不写工作区文件 | 对话共识与待批准计划 |
| B · 盘问 + 文档 `grill-with-docs` | 长期项目、术语和重要决策需要留档 | 允许模型边问边写规划文档 | `CONTEXT.md` 术语表、必要的 `docs/adr/NNNN-*.md` 与计划 |
| C · 决策地图 `wayfinder` | 跨模块重构、方向模糊、一次会话装不下的工程 | 允许模型写地图与票据 | `WAYFINDER.md`、`wayfinder/*.md` 与下一步计划 |

模式 B 只在决策同时满足「难逆转、缺少背景会让人惊讶、当时存在真实替代方案与权衡」时建议写 ADR。
模式 C 先确定 Destination，再整理未知项和依赖，一次处理一个票据。
这些行为由提示词指导模型完成，插件本身不提供文档生成器。

**批准前不实现是一项模型工作协议，并非工具权限沙箱。** 插件不会拦截所有文件写入或命令执行。
模式 B/C 本来就允许写规划文档；重要项目应同时使用 DSH 自身的权限与审批机制。

## 安装

### 环境要求

- 使用提供插件组合包、Web UI 插槽、`systemPrompt`、`tools`、`webServer`、`fs`、
  `workingDirectory` 和 `userQuestions` 服务的 DSH。
- 读取记录依赖 Host 发出 `fs/observed` 事件；完整计划卡片依赖 Client 支持 `plan-review` 提问意图。
- 包内为原生 JavaScript，没有额外运行依赖，也不需要编译。
- 本项目没有声明精确的最低 DSH 版本。开发自测使用 Node.js 24；其他宿主版本需自行验证。
  它作为 DSH 组合包加载，不能用 `node index.js` 启动成独立应用。

### 通过 DSH 安装 GitHub 组合包

在 DSH 的侧边栏「插件」页，使用安装组合包入口输入：

```text
https://github.com/ZDS36/dsh-plan-grill.git
```

也可让 DSH 的 `plugin_manager` 工具执行下列参数；这是工具参数，不是终端命令。
先以关闭状态安装，检查包名和版本后再开启：

```json
{
  "action": "install_bundle",
  "target": "https://github.com/ZDS36/dsh-plan-grill.git",
  "enabled": false
}
```

```json
{
  "action": "set_bundle",
  "target": "@local/dsh-plan-grill",
  "enabled": true
}
```

按插件管理器返回的 `nextStep` 操作；需要时重启 DSH 并刷新 Web 界面。
本包保留 `private: true`，用于阻止误发布到 npm，不影响通过 GitHub 或本地目录安装。
若当前 profile 已安装同名本地组合包，先查看它的来源与管理器提示，避免无意替换正在使用的版本。

### 本地开发

```sh
git clone https://github.com/ZDS36/dsh-plan-grill.git
cd dsh-plan-grill
npm run check
npm test
```

通过 DSH 插件页安装克隆目录的完整路径，或将该路径作为 `install_bundle.target`。
无需单独执行依赖安装；UI 和 React 由宿主提供。使用管理器，不要手改运行中的 profile 或复制 `node_modules`。
安装/启用会影响同一 profile 的会话；普通选择模式只影响指定会话。

## 一次完整的使用流程

1. 打开一个 DSH 会话，点击输入框左侧「计划」，选 A/B/C；已有对话中也可以开启。
2. 输入需求，例如「定位重复触发定时任务的根因，先把修复方案问清楚」。
3. 模型先读代码、查证事实，再逐题提出会影响计划的决策，由你选择。
4. 达成共识后，模型调用 `plan_grill_review`，提交计划和证据。
5. Host 完成下述检查后，经 DSH 提问通道展示计划；你可批准或提出修改意见。
6. 批准后 Host 清除该会话的模式，模型从下一步开始执行；继续盘问则保留模式。

插件不额外注册 `/grill-me`、`/grill-with-docs`、`/wayfinder` 斜杠命令，请通过菜单选择模式。
与内置 `/plan` 同时开启时，提示词要求优先使用本插件的评审流程；
批准只清除本插件状态，内置计划模式仍由 DSH 管理，必要时自行关闭。

## 证据检查实际做了什么

`plan_grill_review` 检查以下输入：

- `plan` 以一级标题开头，至少包含三个二级标题；具体章节内容仍需人工评审。
- `evidence` 包含至少 `minEvidence` 条非空 `claim` / `proof`。
- 每条非空 `assumptions` 都提供 `verify` 验证动作；插件不自动执行这些验证动作。
- 默认要求 `read_pass` 至少给出一个路径，并调用 DSH 的 `fs.lstat` 核对路径是否存在。
- 对有本会话读取记录的路径，将记录的版本与当前版本比较；版本变化则拒绝提交。
- 默认开启 `enforceReadEvidence`：全部路径都没有读取记录时拒绝提交。

**当前实现的限制：**

- 核对的是路径元数据与读取事件记录，不会重新读取文件正文，也不会判断证据内容是否足以支持结论。
- 读取检查只要求列表中至少一个路径有记录；混合提交已读和未读路径仍可通过，未读项会显示在评审附录。
- 版本检查依赖宿主版本标识；未记录路径或宿主没有提供版本时，不能据此证明内容最新。
- 路径匹配会统一大小写并允许后缀匹配，同名文件和大小写敏感环境可能产生歧义。
- 工具声明的 JSON Schema 根为 `object`；包内没有另外实现一套加载期 Schema 校验器。

因此这是一道辅助评审检查，不能保证模型已读完所有文件、找对根因或绝不会提前写入。
请检查计划中的关键路径、证据和风险。默认设置下，纯讨论任务也会因空 `read_pass` 被拒绝；
确实不涉及代码时，可按下表关闭该要求，并在计划中明确说明讨论依据。

## 配置

配置属于 bundle 内的 `plan-grill` 条目。仓库的 `cordis.patch.yml` 给出默认值，
运行时修改请使用当前 DSH 提供的插件配置方式，避免手改共享 profile patch。

| 配置键 | 默认 | 范围与行为 |
| --- | --- | --- |
| `enforceReadEvidence` | `true` | 全部路径无读取记录时拒绝；关闭后仍检查存在性与已有记录的版本 |
| `requireReadPass` | `true` | 是否要求至少一个非空读取路径 |
| `minEvidence` | `2` | 最少证据条目数；数值截断到整数并限制到 0–20 |
| `ttlMinutes` | `480` | 从选择模式起的有效分钟数；数值截断到整数并限制到 5–1440，不随对话续期 |

错误类型的值回退到默认值；未知配置键会报错。状态最多保留 200 个会话，
每个会话最多保留 600 条路径读取记录，超过时淘汰最早记录。

## 隐私、状态与已知限制

- 插件没有自己的 API key、账户登录或第三方上传逻辑；前端只请求当前 DSH 的 `/plan-grill/api`。
  模型请求、会话保存和日志仍由 DSH 及所用模型服务处理。
- 模式与读取记录不由插件落盘；DSH 重启后丢失，fork 出的新会话需要重新选择模式。
- 现有前端没有审批后的实时状态订阅，同一会话的按钮标记可能暂未刷新；以 Host 状态为准，
  可切换会话后返回，或手动关闭。再次选择会启动新的计划周期。
- 回环 HTTP 连接被路由直接信任，路由自身没有身份认证或会话归属校验；依赖 DSH 的访问控制。
  不要将该端口直接开放给不可信网络。
- 界面菜单有中英文文案，Host 盘问提示与评审按钮以中文为主；没有验证所有 DSH 版本的兼容性。
- 注册使用 `plan-grill:policy`、`plan_grill_review`、`/plan-grill/api`、
  `plan-grill.mode` 与 `plan-grill.menu`，不占用内置 `conversation.input.plan`。

更多运行边界、脱敏建议及问题报告方式见 [SECURITY.md](SECURITY.md)。

## 常见问题

| 现象 | 排查方向 |
| --- | --- |
| 没有「计划」按钮 | 查看组合包是否启用、插件加载错误及所需 UI 插槽；按管理器提示重启并刷新 |
| 提交提示没有读取记录 | 用宿主能发出 `fs/observed` 的读取工具重读文件；不能假定任意 shell 输出都会产生记录 |
| 提示文件证据过期 | 重读变更后的文件并更新计划；检查 Host 的版本记录 |
| 没有评审卡片 | 检查 `userQuestions` 服务、Client 的 `plan-review` 支持和插件加载日志 |
| 批准后仍处在内置计划模式 | 单独检查 DSH 的 `/plan` 状态；本插件只清除自身状态 |

## 关闭与卸载

临时关闭当前会话：打开菜单，点击「关闭计划模式」。
停用整个 bundle：在 DSH 插件页关闭 `@local/dsh-plan-grill`；需要时按管理器提示重启。
移除请使用插件页或 `plugin_manager` 的 `remove_bundle`，不要直接删除被安装引用的本地目录。
模型已经写入的文档或代码不会因停用/卸载而自动撤销。

## 开发与验证

维护者已在 **DSH 0.2.1-rc.2（Windows）** 中完成安装和实际操作，确认插件可用（2026-10-24 反馈）。
逐项实测范围尚未记录，其他宿主版本的兼容性仍需验证。

`npm run check` 检查两个 JavaScript 入口的语法；`npm test` 使用 Node 内置测试，
以模拟 Host 验证会话隔离、计划输入、读取记录、版本变化、批准与继续盘问等行为。
自动化测试使用模拟 Host，不启动真实 DSH、不连接模型、不写入宿主配置；
上面的真实环境验证来自维护者的安装和实操反馈。

| 文件 | 用途 |
| --- | --- |
| `index.js` | Host 状态、盘问提示、HTTP 路由、计划工具与证据检查 |
| `client.js` | Web 输入框按钮和模式菜单 |
| `cordis.patch.yml` | bundle 插件条目及默认配置 |
| `locale/`、`icon.svg` | 插件展示元信息与图标 |
| `test/` | 不依赖真实 DSH 的 Host 自测 |
| `THIRD_PARTY_NOTICES.md`、`LICENSES/` | 上游来源及完整第三方许可 |

## 来源与许可

本项目自有代码沿用 [MIT License](LICENSE)，Copyright (c) 2026 ZDS36。
盘问原语与三模式约定改编自 [grillme-skill](https://github.com/KAIXUAN-zhang-bot/grillme-skill)，
其 README 声明整合自 [mattpocock/skills](https://github.com/mattpocock/skills)。
保留 Matt Pocock 与 KAIXUAN-zhang-bot 的原始版权及 MIT 全文，
详见 [第三方声明](THIRD_PARTY_NOTICES.md) 和 [上游许可](LICENSES/grillme-skill-MIT.txt)。
